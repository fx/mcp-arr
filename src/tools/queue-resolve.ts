import {
  type MediaProfile,
  profileFor,
  readMediaHistory,
  readQueueDetails,
} from "../adapters/activity/media.js";
import type {
  HistoryEventType,
  QueueItem,
  QueueStatus,
  TrackedDownloadState,
} from "../adapters/activity/model.js";
import {
  compileQueueTransition,
  type ObservedQueueItem,
  type QueueResolveIntent,
  type QueueTransition,
  queueIntentItemKind,
  type ReplacementSearch,
} from "../adapters/activity/transitions.js";
import { isMediaApplication, type MediaApplication } from "../adapters/library/model.js";
import type { UpstreamClient } from "../http/client.js";
import type {
  ApplyReconciliation,
  ApplyRecord,
  ApplySettlement,
  BeginApplyInput,
} from "../state/apply-records.js";
import type { PreconditionRead, ReadSetObservation } from "../state/plans.js";
import { resolveQueueReference } from "./activity-references.js";
import {
  createToolError,
  type ToolError,
  toolErrorForThrown,
  toolErrorProvesNoEffect,
} from "./errors.js";
import type { OperationHandler, OperationInvocation, PreconditionReader } from "./operations.js";
import type { Effect, ItemOutcome } from "./results.js";
import { type QueueResolveIntentInput, queueResolveIntentSchema } from "./schemas/activity.js";

/**
 * The `arr_queue_resolve` plan, apply, and reconciliation behavior.
 *
 * The division of labour matches `arr_library_change`, and for the same reason.
 * Everything that decides whether a mutation may run happens in the precondition
 * reader: references become upstream identities, the row's *current* state is
 * read back from the instance, and the transition is compiled from what was just
 * read. The dispatcher fingerprints that read for a plan and compares it again
 * before a planned apply, so the handler never asks whether it may send — only
 * what to send, against the state the reader validated.
 *
 * Two things are particular to the queue.
 *
 * **The transition is compiled from the fresh read, never from the reference.**
 * A queue reference retains the status it was minted with, which is what lets a
 * wrong-kind intent be refused without any upstream request. It is not evidence
 * of what the row is *now*, and a mutation compiled from a stale snapshot would
 * be compiled against a download that has since finished, failed, or gone.
 *
 * **Nothing here is transactional.** Every selected row is compiled, sent, and
 * reported on its own, because the upstream bulk actions are not transactional
 * and skip stale identifiers silently. One row's refusal decides nothing about
 * the others.
 */

const contextKind = "queue-resolve";

/** One selected row, once its reference and current upstream state have been read. */
interface ValidatedItem {
  readonly reference: string;
  readonly transition: QueueTransition;
  /** The row as the reader just observed it, which is what was compiled from. */
  readonly observed: ObservedQueueItem;
  /**
   * The row's salted download digest, kept for reconciliation alone.
   *
   * It is deliberately not part of {@link ObservedQueueItem}: compilation must
   * not see a download identifier in any form, and this one exists only so a
   * lost outcome can be tied to the download it was about.
   */
  readonly downloadIdentity?: string | undefined;
}

type ItemValidation =
  | ({ readonly status: "ok" } & ValidatedItem)
  | { readonly status: "error"; readonly reference: string; readonly error: ToolError };

interface QueueResolveContext {
  readonly kind: typeof contextKind;
  readonly intent: QueueResolveIntent;
  readonly application: MediaApplication;
  readonly items: readonly ItemValidation[];
  readonly effects: readonly Effect[];
  readonly warnings: readonly string[];
  readonly replacementSearch?: ReplacementSearch | undefined;
}

function isQueueResolveContext(value: unknown): value is QueueResolveContext {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === contextKind
  );
}

function toolError(
  code: "invalid_input" | "unsupported_capability" | "conflict" | "stale_reference",
  application: MediaApplication,
  message: string,
): ToolError {
  return createToolError({ code, message: `${application}: ${message}`, application });
}

function blocked(error: ToolError): PreconditionRead {
  return { status: "blocked", error };
}

/* -------------------------------------------------------------------------- */
/* Preconditions                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The row as the reader just read it, reduced to what a transition depends on.
 *
 * This is both what the compiler is fed and what the plan's read set observes,
 * and the two being the same set is deliberate: a plan goes stale exactly when
 * something the transition was compiled from moved, and never because an
 * unrelated field did.
 */
function observedFrom(item: QueueItem): ObservedQueueItem {
  return {
    application: item.application,
    queueItemId: item.context.queueItemId,
    itemKind: item.kind,
    status: item.evidence.status,
    trackedState: item.evidence.trackedState,
    mediaId: item.context.mediaId,
  };
}

/**
 * What one selected row contributes to the plan's read set.
 *
 * Deliberately narrow. The row's title, its progress, its remaining bytes, and
 * its estimated completion all move for reasons no transition depends on, and
 * observing them would expire valid plans on a schedule — which teaches a caller
 * to re-plan reflexively instead of reading why a plan went stale. What is here
 * is what compilation branched on, plus the identity it branched about.
 *
 * A row that could not be read is observed too, as the reason it could not. A
 * plan reports such a row as unresolvable and leaves it out of its predicted
 * effects, so a row that became readable in the meantime has to make the plan
 * stale rather than silently widening what applying it would touch.
 */
function itemObservations(items: readonly ItemValidation[]): readonly ReadSetObservation[] {
  return items.map((item) => ({
    key: `queue:${item.reference}`,
    value:
      item.status === "ok"
        ? {
            queueItemId: item.observed.queueItemId,
            itemKind: item.observed.itemKind,
            status: item.observed.status,
            trackedState: item.observed.trackedState ?? null,
            mediaId: item.observed.mediaId ?? null,
          }
        : { unreadable: item.error.code },
  }));
}

/**
 * Reads one selected row's current state and compiles its transition.
 *
 * The read is the focused one: `queue/details` scoped to the media record the
 * reference retained, which is why that association is retained at all. A row
 * that is no longer there is a stale reference rather than a conflict — the
 * remedy is to run the query that produced the reference again.
 */
async function readItem(
  invocation: OperationInvocation,
  application: MediaApplication,
  profile: MediaProfile,
  version: string,
  intent: QueueResolveIntentInput,
  reference: string,
): Promise<ItemValidation> {
  const resolved = resolveQueueReference(invocation.state.references, reference, application, {
    requireKind: queueIntentItemKind(intent.intent),
    property: "items",
  });
  if (!resolved.ok) {
    return { status: "error", reference, error: resolved.error };
  }

  let current: QueueItem | undefined;
  try {
    current = await readQueueDetails(
      invocation.adapter.client,
      {
        view: "queue_details",
        detail: "summary",
        paging: { pageSize: 1 },
        queueItemId: resolved.value.queueItemId,
        mediaId: resolved.value.mediaId,
      },
      profile,
    );
  } catch (error) {
    return { status: "error", reference, error: toolErrorForThrown(error, application) };
  }

  if (current === undefined) {
    return {
      status: "error",
      reference,
      error: toolError(
        "stale_reference",
        application,
        "that queue item is no longer in this instance's queue",
      ),
    };
  }

  const observed = observedFrom(current);
  const compilation = compileQueueTransition({
    application,
    version,
    intent: intent.intent,
    observed,
    ...("replacementSearch" in intent ? { replacementSearch: intent.replacementSearch } : {}),
  });
  return compilation.status === "compiled"
    ? {
        status: "ok",
        reference,
        transition: compilation.transition,
        observed,
        downloadIdentity: current.origin?.downloadIdentity,
      }
    : { status: "error", reference, error: compilation.error };
}

/**
 * Reads everything a queue resolution depends on.
 *
 * The dispatcher runs this before plan mode and again before a planned apply, so
 * it is both the facts a plan is fingerprinted against and the immediate
 * current-state validation a direct apply performs. Nothing here mutates
 * anything: every call it makes is a GET.
 */
export const queueResolvePreconditions: PreconditionReader = async (invocation) => {
  const application = invocation.application;
  if (!isMediaApplication(application)) {
    return blocked(
      toolError(
        "unsupported_capability",
        // Narrowed for the message only; Prowlarr has no queue and the registry
        // declares these variants for the media applications alone.
        "sonarr",
        "this application has no managed-download queue",
      ),
    );
  }

  const parsed = queueResolveIntentSchema.safeParse(invocation.input);
  if (!parsed.success) {
    return blocked(
      toolError(
        "invalid_input",
        application,
        "the arguments do not match the arr_queue_resolve input schema",
      ),
    );
  }
  const intent = parsed.data;

  // Probed here because the compiled flags are gated on the instance's own
  // version and the invocation does not carry the one the dispatcher already
  // read. It is a single bounded GET on a mutation path, and compiling against
  // the recorded minimum instead would defeat the gate entirely: that value is
  // newer than every flag minimum, so every instance would pass.
  const capability = await invocation.adapter.probe();
  if (capability.status === "unavailable") {
    return blocked(
      createToolError({
        code: "unavailable_application",
        message: `${application}: ${capability.failure.message}`,
        application,
      }),
    );
  }

  const profile = profileFor(application);
  const items: ItemValidation[] = [];
  for (const reference of intent.items) {
    items.push(
      await readItem(invocation, application, profile, capability.version, intent, reference),
    );
  }

  const compiled = items.filter(
    (item): item is { status: "ok" } & ValidatedItem => item.status === "ok",
  );
  const unresolvable = items.length - compiled.length;
  const context: QueueResolveContext = {
    kind: contextKind,
    intent: intent.intent,
    application,
    items,
    // Every selected row compiles the same intent, so the effects are the
    // intent's rather than each row's; the count of rows they apply to is said
    // separately instead of repeating one sentence per item.
    effects: compiled[0]?.transition.effects ?? [],
    warnings: [
      ...(compiled.length === 0
        ? []
        : [`${String(compiled.length)} queue item(s) will be resolved, each independently`]),
      ...(unresolvable === 0
        ? []
        : [
            `${String(unresolvable)} selected queue item(s) cannot be resolved; see the per-item outcomes`,
          ]),
      ...(compiled[0]?.transition.warnings ?? []),
    ],
    ...("replacementSearch" in intent ? { replacementSearch: intent.replacementSearch } : {}),
  };

  return { status: "ok", validated: context, observations: itemObservations(items) };
};

/* -------------------------------------------------------------------------- */
/* Apply                                                                       */
/* -------------------------------------------------------------------------- */

function itemOutcome(
  reference: string,
  error: ToolError | undefined,
  warnings: readonly string[],
): ItemOutcome {
  return {
    reference,
    status: error === undefined ? "ok" : "error",
    warnings: [...warnings],
    ...(error === undefined ? {} : { error }),
  };
}

/**
 * The note a routed manual import carries.
 *
 * It names the tool to call next and nothing else. The caller already holds the
 * queue reference this transition was compiled from, so the route needs no
 * identifier of its own — and a canonical path, which is what an import
 * inspection is really about, must never appear in a mutation result.
 */
const manualImportNote =
  "nothing was sent for this item; inspect it with arr_import_inspect using the same queue reference, then execute the import separately";

interface AppliedItems {
  readonly outcomes: readonly ItemOutcome[];
  /** The failure, if any, that leaves this mutation's outcome unknown. */
  readonly unresolved?: ToolError | undefined;
  /**
   * How many upstream requests were actually dispatched.
   *
   * Counted rather than inferred, because it is the one thing that can prove
   * nothing was sent. "Every item errored" does not prove it: a single request
   * that timed out produces exactly that, and it was sent.
   */
  readonly dispatched: number;
}

/**
 * Sends one transition and reports that row's own outcome.
 *
 * A routed manual import sends nothing at all and is still a success: it is a
 * transition whose whole effect is to answer where to look next. That is why it
 * is reported `ok` with a note rather than counted as a dispatch — counting it
 * would let a selection of nothing but manual-import routes look like a
 * mutation that was attempted.
 */
async function sendTransition(
  client: UpstreamClient,
  transition: QueueTransition,
): Promise<{ error?: ToolError; warnings: readonly string[]; dispatched: boolean }> {
  const action = transition.action;
  if (action.kind === "inspect") {
    return { warnings: [manualImportNote], dispatched: false };
  }

  try {
    if (action.method === "DELETE") {
      await client.delete(action.path, action.query);
    } else {
      // The grab route binds its identifier from the path and reads no body;
      // the empty object is what the client's `post` requires to send one.
      await client.post(action.path, {}, action.query);
    }
    return { warnings: [], dispatched: true };
  } catch (error) {
    return {
      error: toolErrorForThrown(error, transition.application),
      warnings: [],
      dispatched: true,
    };
  }
}

/**
 * Sends every compiled transition, one at a time, and reports each outcome.
 *
 * Sequential rather than concurrent, and that is the specification's rule rather
 * than a simplification: bulk pending grabs must report each *sequential*
 * outcome, because a caller has to be able to say which of its selections
 * happened. It also keeps a burst of deletes from arriving at one instance at
 * once.
 */
async function applyItems(
  invocation: OperationInvocation,
  context: QueueResolveContext,
): Promise<AppliedItems> {
  const outcomes: ItemOutcome[] = [];
  let unresolved: ToolError | undefined;
  let dispatched = 0;

  for (const item of context.items) {
    if (item.status === "error") {
      outcomes.push(itemOutcome(item.reference, item.error, []));
      continue;
    }

    const claim = perItemClaim(invocation, context, item.reference);
    let record: string | undefined;
    if (claim !== undefined) {
      const attempt = invocation.state.applies.begin(claim);
      if (attempt.status === "replayed") {
        // This exact single-item mutation already has a receipt, so nothing is
        // sent for it again and its recorded outcome is repeated. Which outcome
        // that is decides the whole call: a receipt that is not terminal is not
        // a success, and a selection carrying one must not close.
        const replayed = replayedItemOutcome(item.reference, attempt.record);
        if (replayed.unresolved !== undefined && unresolved === undefined) {
          unresolved = replayed.unresolved;
        }
        outcomes.push(replayed.outcome);
        continue;
      }
      record = attempt.record.reference;
    }

    const sent = await sendTransition(invocation.adapter.client, item.transition);
    if (sent.dispatched) {
      dispatched += 1;
    }

    // A failure the instance demonstrably refused is that item's error and
    // nothing more. One that does not prove the request was ignored leaves the
    // outcome unknown — and that is the case worth asking upstream about, right
    // now, while this call still holds the state the mutation was compiled
    // against.
    if (sent.error !== undefined && !toolErrorProvesNoEffect(sent.error.code)) {
      const settled = await reconcileLostItem(invocation, context, item, sent.error);
      if (settled.unresolved !== undefined && unresolved === undefined) {
        unresolved = settled.unresolved;
      }
      if (record !== undefined) {
        invocation.state.applies.settle(record, settled.settlement);
      }
      outcomes.push(settled.outcome);
      continue;
    }

    if (record !== undefined) {
      invocation.state.applies.settle(record, settlementForItem(sent.error));
    }
    outcomes.push(itemOutcome(item.reference, sent.error, sent.warnings));
  }

  return { outcomes, unresolved, dispatched };
}

/**
 * Asks authoritative state what a lost request actually did.
 *
 * This is where reconciliation is reached in production. It runs the moment a
 * request's answer is lost, which is the moment this server knows most: the
 * state the mutation was compiled against is still in hand, so the row can be
 * compared to it rather than to a second, later reading of itself.
 *
 * The three verdicts settle three different ways, and none of them rounds
 * toward the convenient answer. A row that has left the queue settles the item
 * succeeded. A row still queued exactly as it was settles it failed, which is
 * the one state a later identical attempt may reuse — nothing moved, so nothing
 * arrived. Anything else keeps the item outcome-unknown and returns the failure
 * that keeps the whole call's receipt reconcilable.
 */
async function reconcileLostItem(
  invocation: OperationInvocation,
  context: QueueResolveContext,
  item: { readonly status: "ok" } & ValidatedItem,
  lost: ToolError,
): Promise<{
  outcome: ItemOutcome;
  settlement: ApplySettlement;
  unresolved?: ToolError | undefined;
}> {
  const verdict = await reconcileTarget(
    {
      client: invocation.adapter.client,
      application: context.application,
      intent: context.intent,
      targets: [],
      ...(context.replacementSearch === undefined
        ? {}
        : { replacementSearch: context.replacementSearch }),
    },
    {
      queueItemId: item.observed.queueItemId,
      mediaId: item.observed.mediaId,
      observedStatus: item.observed.status,
      observedTrackedState: item.observed.trackedState,
      downloadIdentity: item.downloadIdentity,
    },
  );

  if (verdict === "succeeded") {
    return {
      outcome: itemOutcome(item.reference, undefined, [
        "the answer to this request was lost, and upstream state confirms it was applied",
      ]),
      settlement: { status: "succeeded" },
    };
  }

  // A `failed` verdict is deliberately not acted on here, and this is the one
  // place the ladder is read more conservatively than it is written. Reaching it
  // means the row still looks untouched — but this runs moments after the answer
  // was lost, which is exactly when an instance that did process the request may
  // not yet answer its queue any differently. `failed` is the one settlement a
  // later identical attempt may reuse, so acting on it here would license
  // re-sending a mutation that may already have applied. The record stays
  // outcome-unknown instead, and the same verdict is safe for the store's own
  // reconciliation later, once that race has passed.
  return {
    outcome: itemOutcome(item.reference, lost, [
      "the answer to this request was lost and upstream state could not establish what it did",
    ]),
    settlement: { status: "outcome_unknown", error: lost },
    unresolved: lost,
  };
}

/**
 * The claim one item's own apply record is created from, or `undefined` where
 * it needs none.
 *
 * Two cases need none. A transition that sends nothing — the routed manual
 * import — performs no egress at all, and a receipt for it would record a
 * mutation that never existed. And a selection of exactly one item is already
 * covered: the dispatcher's own record is keyed on that same single-item intent,
 * so creating a second one here would collide with it, be answered as a replay,
 * and stop the mutation being sent at all.
 *
 * For everything else the key is the calling intent narrowed to this one item,
 * which is deliberately the identical key a caller would produce by applying
 * that item on its own. That is what makes the two reach one receipt: an item
 * already resolved inside a bulk call is not sent again when it is later named
 * alone.
 */
function perItemClaim(
  invocation: OperationInvocation,
  context: QueueResolveContext,
  reference: string,
): BeginApplyInput | undefined {
  // Decided by how many items the *selection* names, not by how many of them
  // will send. Those are different questions, and using the second one left a
  // selection of one valid row beside one stale row with no record for the row
  // that did send — so a later direct apply of it, whose key differs from this
  // call's, would have sent it a second time.
  if (context.items.length < 2) {
    return undefined;
  }
  const input = invocation.input;
  return {
    tool: "arr_queue_resolve",
    variant: context.intent,
    application: context.application,
    intent:
      typeof input === "object" && input !== null
        ? { ...(input as Record<string, unknown>), items: [reference] }
        : { items: [reference] },
  };
}

const replayedNote =
  "this item was already applied by this server; its existing receipt is repeated and nothing was sent again";

/**
 * How a replayed per-item receipt is reported, and whether it holds the call
 * open.
 *
 * Only a terminal success is reported as one. The two non-terminal states are
 * the reason this is a function rather than a ternary:
 *
 * - `outcome_unknown` means an earlier attempt at this exact item may have
 *   applied and nobody established what it did. Reporting it as this call's
 *   success would close a selection containing an unresolved mutation, so it is
 *   reported as an error *and* returned as the failure that keeps the call's own
 *   receipt outcome-unknown. That precedence is the project's rule, not a local
 *   choice: an unknown outcome outranks every other settlement.
 * - `applying` means another attempt is in flight right now. Nothing about it is
 *   established either, so it is treated exactly the same way. It carries no
 *   stored error of its own, which is precisely why reading `record.error` and
 *   calling an absent one a success would have been wrong.
 */
function replayedItemOutcome(
  reference: string,
  record: ApplyRecord,
): { outcome: ItemOutcome; unresolved?: ToolError | undefined } {
  if (record.state === "succeeded") {
    return { outcome: itemOutcome(reference, undefined, [replayedNote]) };
  }

  const error =
    record.error ??
    createToolError({
      code: "conflict",
      message: `${record.application}: another apply of this exact queue item is still in flight, so its outcome is not established`,
      application: record.application,
    });
  return {
    outcome: itemOutcome(reference, error, [replayedNote]),
    // A `failed` receipt is the one terminal refusal, and `begin` would have
    // let this attempt proceed rather than replaying it — so anything reaching
    // here is unresolved by definition.
    unresolved: error,
  };
}

/**
 * How one item's own record settles.
 *
 * The same three answers the call-level receipt uses, decided per item because
 * that is the whole point of having one per item: a request that was sent and
 * whose answer was lost stays reconcilable on its own, rather than being
 * absorbed into a batch verdict that says nothing about which item it was.
 */
function settlementForItem(error: ToolError | undefined): ApplySettlement {
  if (error === undefined) {
    return { status: "succeeded" };
  }
  return toolErrorProvesNoEffect(error.code)
    ? { status: "failed", error }
    : { status: "outcome_unknown", error };
}

/**
 * Plans and applies queue transitions.
 *
 * Plan mode discloses what an apply would request and predicts only what the
 * state it just read says will follow. Apply mode sends the transitions the
 * precondition reader compiled, so each row is acted on exactly as it was
 * validated.
 */
export const queueResolveHandler: OperationHandler = async (invocation) => {
  const context = invocation.validated;
  if (!isQueueResolveContext(context)) {
    return {
      status: "error",
      error: createToolError({
        code: "conflict",
        message: `${invocation.application}: the current state of this mutation was not validated`,
        application: invocation.application,
      }),
    };
  }

  const compiled = context.items.filter((item) => item.status === "ok").length;

  if (invocation.mode === "plan") {
    return {
      status: "ok",
      plan: {
        requestedEffects: context.effects,
        // Nothing is predicted when no selected row can be resolved: an apply
        // would send nothing, and predicting the effects anyway would overstate
        // what the plan is going to do.
        predictedEffects: compiled === 0 ? [] : context.effects,
        warnings: context.warnings,
      },
      items: context.items.map((item) =>
        item.status === "error"
          ? itemOutcome(item.reference, item.error, [])
          : itemOutcome(
              item.reference,
              undefined,
              item.transition.action.kind === "inspect" ? [manualImportNote] : [],
            ),
      ),
    };
  }

  const applied = await applyItems(invocation, context);
  // Recorded as never having happened only when this server can show it: no
  // request was dispatched at all, and every selection failed before one could
  // be. Both halves are needed, because "every item errored" is equally true of
  // one write that timed out — and rounding that to "definitely did not happen"
  // is the one direction a receipt must never take.
  const unattempted =
    applied.dispatched === 0 &&
    applied.outcomes.length > 0 &&
    applied.outcomes.every((item) => item.status === "error")
      ? applied.outcomes[0]?.error
      : undefined;

  return {
    status: "ok",
    items: applied.outcomes,
    effects: context.effects,
    warnings: context.warnings,
    ...(applied.unresolved === undefined ? {} : { outcomeUnknown: applied.unresolved }),
    ...(unattempted === undefined ? {} : { unattempted }),
  };
};

/* -------------------------------------------------------------------------- */
/* Reconciliation                                                              */
/* -------------------------------------------------------------------------- */

/**
 * One row a lost apply may or may not have resolved.
 *
 * The state the apply observed immediately before sending is carried here, and
 * that is what makes reconciliation decidable without comparing this process's
 * clock to the instance's: the question is whether the row moved from what the
 * mutation was compiled against, not whether something happened after some
 * timestamp.
 */
export interface QueueReconciliationTarget {
  readonly queueItemId: number;
  readonly mediaId?: number | undefined;
  readonly observedStatus: QueueStatus;
  readonly observedTrackedState?: TrackedDownloadState | undefined;
  /**
   * The salted digest of the download-client identifier this row named, where
   * upstream named one.
   *
   * It is what ties a history record to *this* download rather than to the
   * series it belongs to, and it is the only reason corroboration can claim
   * anything at all. It is a process-local digest, never the identifier itself,
   * and it lives only in this reader's closure — nothing here reaches a tool
   * result, a plan, or a receipt.
   */
  readonly downloadIdentity?: string | undefined;
}

export interface QueueReconciliationOptions {
  readonly client: UpstreamClient;
  readonly application: MediaApplication;
  readonly intent: QueueResolveIntent;
  readonly targets: readonly QueueReconciliationTarget[];
  readonly replacementSearch?: ReplacementSearch | undefined;
}

/** What authoritative state says about one row of a lost apply. */
type TargetVerdict = "succeeded" | "failed" | "indeterminate";

/**
 * How many corroborating records one reconciliation reads.
 *
 * Small on purpose: corroboration only ever has to find a record about one media
 * association, and a reconciliation that paged through a long history would cost
 * more than the mutation it is explaining.
 */
const corroborationPageSize = 50;

/**
 * Reads the queue row a target names, or says the read itself failed.
 *
 * `absent` is the decisive answer. Every queue transition that sends anything
 * removes the row from the queue, so a row that is gone is the instance's own
 * confirmation that the request arrived.
 */
async function readTargetRow(
  options: QueueReconciliationOptions,
  target: QueueReconciliationTarget,
): Promise<
  { status: "present"; item: QueueItem } | { status: "absent" } | { status: "unreadable" }
> {
  try {
    const item = await readQueueDetails(
      options.client,
      {
        view: "queue_details",
        detail: "summary",
        paging: { pageSize: 1 },
        queueItemId: target.queueItemId,
        mediaId: target.mediaId,
      },
      profileFor(options.application),
    );
    return item === undefined ? { status: "absent" } : { status: "present", item };
  } catch {
    return { status: "unreadable" };
  }
}

/**
 * Whether the application recorded an event naming *this* download.
 *
 * Attribution is the whole difficulty, and the download identity is what
 * supplies it. A history event for the same series proves nothing: series have
 * many downloads and histories are long, so a record from last week would read
 * as evidence for a mutation sent a minute ago. The identity is the salted
 * digest of the download-client identifier — the same correlation the bounded
 * diagnosis already joins on — so an event carrying it is an event about the
 * download this row stands for and no other.
 *
 * The read is still scoped to the media record, because that is what keeps it
 * bounded; the identity decides, and the scope only decides how much is read.
 */
async function hasDownloadEvent(
  options: QueueReconciliationOptions,
  target: QueueReconciliationTarget,
  events: readonly HistoryEventType[],
): Promise<boolean> {
  const mediaId = target.mediaId;
  const identity = target.downloadIdentity;
  if (mediaId === undefined || identity === undefined) {
    return false;
  }

  try {
    const page = await readMediaHistory(
      options.client,
      { offset: 0, pageSize: corroborationPageSize },
      {
        view: "history",
        detail: "summary",
        paging: { pageSize: corroborationPageSize },
        mediaIds: [mediaId],
      },
      profileFor(options.application),
    );
    return page.items.some(
      (record) => record.downloadIdentity === identity && events.includes(record.eventType),
    );
  } catch {
    return false;
  }
}

/**
 * Corroborates an ambiguous row against the records a transition leaves behind.
 *
 * Reached only when the row is still in the queue but no longer in the state the
 * mutation was compiled against — so something happened, and the question is
 * whether this mutation did it.
 *
 * Only history is consulted, and only by download identity. The other two
 * authoritative sources were considered and are deliberately not read here,
 * because neither can be tied to this apply:
 *
 * - A **blocklist** record carries no download identity, and the only other
 *   things that could match it are the release title and the media association.
 *   The title is upstream text this server does not retain, and the media
 *   association alone would let a release blocked for the same series last week
 *   settle an unknown outcome from a minute ago.
 * - A **command** is instance-wide. A search running now may have been started
 *   by a scheduled task, by another caller, or by an unrelated grab, and "a
 *   search exists" is true of most instances most of the time.
 *
 * Reading either and calling it corroboration would manufacture confidence
 * rather than establish it, and an unknown outcome reported as a success is the
 * one direction a receipt must never round in.
 */
async function corroborate(
  options: QueueReconciliationOptions,
  target: QueueReconciliationTarget,
): Promise<TargetVerdict> {
  switch (options.intent) {
    case "ignore_tracking":
      return (await hasDownloadEvent(options, target, ["download_ignored"]))
        ? "succeeded"
        : "indeterminate";
    case "remove_from_client_and_delete_data":
    case "blocklist_and_remove":
      return (await hasDownloadEvent(options, target, ["download_failed", "download_ignored"]))
        ? "succeeded"
        : "indeterminate";
    case "force_pending_grab":
      return (await hasDownloadEvent(options, target, ["grabbed", "release_grabbed"]))
        ? "succeeded"
        : "indeterminate";
    default:
      // A category change, a pending removal, and a pending blocklisting leave
      // no record this server can attribute to this download, so an ambiguous
      // row stays unknown rather than being guessed into a verdict.
      return "indeterminate";
  }
}

/**
 * What authoritative state says about one row.
 *
 * The ladder is deliberate.
 *
 * **Gone from the queue is read as succeeded**, and that is a decision worth
 * stating rather than assuming. It is not proof that *this* request removed the
 * row: another caller, or an operator at the application's own interface, could
 * have removed it inside the window between the lost answer and this read. It is
 * read as success anyway because it is exactly as much as a delivered response
 * would have established — every one of these transitions asks for the row to
 * leave the queue, and an acknowledged 200 says the application accepted that
 * request, never that the download client acted on it. Refusing to settle here
 * would leave every lost outcome permanently unknown, which is the same as
 * having no reconciliation at all.
 *
 * **Still there, in exactly the state the mutation was compiled against, is read
 * as failed.** Nothing moved, so nothing arrived. This is the only path to
 * `failed`, and it rests on the row itself rather than on the absence of a
 * corroborating record — because a record that is missing is not evidence that
 * nothing happened.
 *
 * **Still there but moved** is the ambiguous case, and only it reaches
 * {@link corroborate}, which can raise the verdict to succeeded and can never
 * lower it.
 */
async function reconcileTarget(
  options: QueueReconciliationOptions,
  target: QueueReconciliationTarget,
): Promise<TargetVerdict> {
  const row = await readTargetRow(options, target);
  if (row.status === "unreadable") {
    return "indeterminate";
  }
  if (row.status === "absent") {
    return "succeeded";
  }

  const observed = observedFrom(row.item);
  const unchanged =
    observed.status === target.observedStatus &&
    observed.trackedState === target.observedTrackedState;
  return unchanged ? "failed" : await corroborate(options, target);
}

/**
 * The queue's reconciliation reader.
 *
 * Supplied here because this is the change that knows where to look, which is
 * what {@link ApplyReconciliation} says such a reader is for. It is only ever
 * run against an outcome-unknown record: the store refuses to re-open a settled
 * one, and re-reads the record after the awaits below so a concurrent settlement
 * that observed the mutation itself is never overwritten by one that observed
 * only its aftermath.
 *
 * A bulk apply settles only when every row agrees. One row succeeding and
 * another failing is a partial outcome, and there is no honest single verdict
 * for it — so it stays `indeterminate`, and the record stays reconcilable rather
 * than being rounded to whichever answer came first.
 */
export function createQueueReconciliationReader(
  options: QueueReconciliationOptions,
): (record: ApplyRecord) => Promise<ApplyReconciliation> {
  return async (_record: ApplyRecord): Promise<ApplyReconciliation> => {
    if (options.targets.length === 0) {
      return { status: "indeterminate" };
    }

    const verdicts: TargetVerdict[] = [];
    for (const target of options.targets) {
      verdicts.push(await reconcileTarget(options, target));
    }

    if (verdicts.every((verdict) => verdict === "succeeded")) {
      return { status: "succeeded" };
    }
    if (verdicts.every((verdict) => verdict === "failed")) {
      return {
        status: "failed",
        error: toolError(
          "conflict",
          options.application,
          "every selected queue item is still queued in the state this mutation was compiled against, so the request did not take effect",
        ),
      };
    }
    return { status: "indeterminate" };
  };
}

/**
 * The reconciliation targets one validated selection stands for.
 *
 * Built from the precondition reader's own context, so what reconciliation
 * compares against is exactly what the mutation was compiled from rather than a
 * second, later reading of the same rows.
 */
export function reconciliationTargetsFor(validated: unknown): readonly QueueReconciliationTarget[] {
  if (!isQueueResolveContext(validated)) {
    return [];
  }
  return validated.items
    .filter((item): item is { status: "ok" } & ValidatedItem => item.status === "ok")
    .filter((item) => item.transition.action.kind === "upstream")
    .map((item) => ({
      queueItemId: item.observed.queueItemId,
      mediaId: item.observed.mediaId,
      observedStatus: item.observed.status,
      observedTrackedState: item.observed.trackedState,
      downloadIdentity: item.downloadIdentity,
    }));
}
