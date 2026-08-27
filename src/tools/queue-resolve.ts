import {
  type MediaProfile,
  profileFor,
  readBlocklist,
  readMediaHistory,
  readQueueDetails,
} from "../adapters/activity/media.js";
import type { QueueItem, QueueStatus, TrackedDownloadState } from "../adapters/activity/model.js";
import { readCommands } from "../adapters/activity/shared.js";
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
import type { ApplyReconciliation, ApplyRecord } from "../state/apply-records.js";
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
    ? { status: "ok", reference, transition: compilation.transition, observed }
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

    const sent = await sendTransition(invocation.adapter.client, item.transition);
    if (sent.dispatched) {
      dispatched += 1;
    }
    if (sent.error !== undefined && unresolved === undefined) {
      // Only a failure that does not prove the instance ignored the request
      // leaves the outcome unknown. One the instance demonstrably refused is
      // that item's error and nothing more.
      if (!toolErrorProvesNoEffect(sent.error.code)) {
        unresolved = sent.error;
      }
    }
    outcomes.push(itemOutcome(item.reference, sent.error, sent.warnings));
  }

  return { outcomes, unresolved, dispatched };
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
 * Whether a blocklist record now exists for the media this row belonged to.
 *
 * Consulted only for the intents that ask for one, and only when the queue read
 * was ambiguous. It can raise a verdict to succeeded and can never lower one to
 * failed, which is what keeps a coincidence — a record blocked for the same
 * series by something else — from turning an unknown outcome into a false
 * failure.
 */
async function hasBlocklistRecord(
  options: QueueReconciliationOptions,
  mediaId: number,
): Promise<boolean> {
  try {
    const page = await readBlocklist(
      options.client,
      { offset: 0, pageSize: corroborationPageSize },
      { view: "blocklist", detail: "summary", paging: { pageSize: corroborationPageSize } },
      profileFor(options.application),
    );
    return page.items.some((record) => record.media?.id === String(mediaId));
  } catch {
    return false;
  }
}

/**
 * Whether the application recorded an event that only the transition produces.
 *
 * A grab records `grabbed`; ignoring or failing a tracked download records
 * `download_ignored` or `download_failed`. None of these is read as evidence on
 * its own — the queue read has to have been ambiguous first.
 */
async function hasHistoryEvent(
  options: QueueReconciliationOptions,
  mediaId: number,
  events: readonly string[],
): Promise<boolean> {
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
    return page.items.some((record) => events.includes(record.eventType));
  } catch {
    return false;
  }
}

/**
 * Whether a search command is running or has run.
 *
 * Only consulted for a blocklisting that allowed a replacement search, because
 * that is the only queue transition whose effect reaches the command list at
 * all: the application starts the search itself once it has processed the
 * removal, so a search command is evidence the removal was processed.
 */
async function hasSearchCommand(options: QueueReconciliationOptions): Promise<boolean> {
  try {
    const page = await readCommands(
      options.client,
      { offset: 0, pageSize: corroborationPageSize },
      options.application,
    );
    return page.items.some((command) => command.name.toLowerCase().includes("search"));
  } catch {
    return false;
  }
}

/**
 * Corroborates an ambiguous row against the records a transition leaves behind.
 *
 * Reached only when the row is still in the queue but no longer in the state the
 * mutation was compiled against — so something happened, and the question is
 * whether it was this mutation.
 */
async function corroborate(
  options: QueueReconciliationOptions,
  target: QueueReconciliationTarget,
): Promise<TargetVerdict> {
  const mediaId = target.mediaId;
  if (mediaId === undefined) {
    return "indeterminate";
  }

  switch (options.intent) {
    case "blocklist_and_remove":
      if (options.replacementSearch === "allow" && (await hasSearchCommand(options))) {
        return "succeeded";
      }
      return (await hasBlocklistRecord(options, mediaId)) ? "succeeded" : "indeterminate";
    case "blocklist_pending":
      return (await hasBlocklistRecord(options, mediaId)) ? "succeeded" : "indeterminate";
    case "ignore_tracking":
      return (await hasHistoryEvent(options, mediaId, ["download_ignored"]))
        ? "succeeded"
        : "indeterminate";
    case "remove_from_client_and_delete_data":
      return (await hasHistoryEvent(options, mediaId, ["download_failed", "download_ignored"]))
        ? "succeeded"
        : "indeterminate";
    case "force_pending_grab":
      return (await hasHistoryEvent(options, mediaId, ["grabbed", "release_grabbed"]))
        ? "succeeded"
        : "indeterminate";
    default:
      // A category change and a pending removal leave no record of their own
      // that this server can attribute, so an ambiguous row stays unknown
      // rather than being guessed into a verdict.
      return "indeterminate";
  }
}

/**
 * What authoritative state says about one row.
 *
 * The ladder is deliberate. The queue answers first and decisively where it can:
 * gone means the request arrived, and still there in exactly the state the
 * mutation was compiled against means it did not. Only the middle case — still
 * there, but changed — reaches the corroborating reads, and only they can raise
 * a verdict. Nothing here can produce `failed` from corroboration, because a
 * missing record is not proof that nothing happened.
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
    }));
}
