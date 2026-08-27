import {
  blocklistRecordState,
  blocklistRemovalEffects,
  checkHistoryFailure,
  type FailureHandlingPolicy,
  failurePolicyState,
  type HistoryRecordLookup,
  historyFailureEffects,
  historyRecordState,
  type MutationEffects,
  markHistoryFailed,
  type Reconciliation,
  type RecordLookup,
  readBlocklistRecord,
  readFailureHandlingPolicy,
  readHistoryRecord,
  reconcileBlocklistRemoval,
  reconcileHistoryFailure,
  removeBlocklistRecord,
} from "../adapters/activity/changes.js";
import { profileFor } from "../adapters/activity/media.js";
import type { BlocklistRecord, HistoryRecord } from "../adapters/activity/model.js";
import type { MediaApplication } from "../adapters/library/model.js";
import { isMediaApplication } from "../adapters/library/model.js";
import type { PreconditionRead, ReadSetObservation } from "../state/plans.js";
import { resolveBlocklistReference, resolveHistoryReference } from "./activity-references.js";
import {
  createToolError,
  type ToolError,
  toolErrorForThrown,
  toolErrorProvesNoEffect,
} from "./errors.js";
import type { OperationHandler, OperationInvocation, PreconditionReader } from "./operations.js";
import type { Effect, ItemOutcome } from "./results.js";
import { type ActivityChangeIntent, activityChangeIntentSchema } from "./schemas/activity.js";

/**
 * The `arr_activity_change` handlers.
 *
 * The division of labour is the one `arr_library_change` established, and it is
 * what makes these two mutations unreachable without their current-state
 * validation: everything that decides whether a mutation may run happens in the
 * precondition reader — references become upstream identities, each record is
 * re-read from the instance, and a history record that is not a grab is refused
 * — and the dispatcher hands the handler exactly what that reader resolved. The
 * handler below never asks whether it may send, only what to send.
 *
 * Both intents act on one record at a time upstream. A selection of several is
 * therefore several requests, reported per item and explicitly not atomic; no
 * bulk or clear-all route is reachable from here.
 */

const contextKind = "activity-change";

/** One selected record, once its reference and current state have been read. */
interface ValidatedHistoryItem {
  readonly reference: string;
  readonly record: HistoryRecord;
  /**
   * The download-failure events already recorded against this download when the
   * mutation was validated. It is the baseline reconciliation compares against,
   * so a failure that predates this call cannot be read as evidence that this
   * call applied.
   */
  readonly priorFailureIds: readonly number[];
}

interface ValidatedBlocklistItem {
  readonly reference: string;
  readonly record: BlocklistRecord;
}

type ItemValidation<TItem> =
  | ({ readonly status: "ok" } & TItem)
  | { readonly status: "error"; readonly reference: string; readonly error: ToolError };

interface HistoryContext {
  readonly kind: typeof contextKind;
  readonly intent: "mark_history_failed";
  readonly application: MediaApplication;
  readonly items: readonly ItemValidation<ValidatedHistoryItem>[];
  /** The instance's failed-download handling, which decides the follow-on. */
  readonly policy: FailureHandlingPolicy;
  readonly effects: MutationEffects;
}

interface BlocklistContext {
  readonly kind: typeof contextKind;
  readonly intent: "remove_blocklist_record";
  readonly application: MediaApplication;
  readonly items: readonly ItemValidation<ValidatedBlocklistItem>[];
  readonly effects: MutationEffects;
}

type ActivityChangeContext = HistoryContext | BlocklistContext;

function isActivityChangeContext(value: unknown): value is ActivityChangeContext {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === contextKind
  );
}

function invalid(invocation: OperationInvocation, message: string): ToolError {
  return createToolError({
    code: "invalid_input",
    message: `${invocation.application}: ${message}`,
    application: invocation.application,
  });
}

function conflict(invocation: OperationInvocation, message: string): ToolError {
  return createToolError({
    code: "conflict",
    message: `${invocation.application}: ${message}`,
    application: invocation.application,
  });
}

function unsupported(invocation: OperationInvocation, message: string): ToolError {
  return createToolError({
    code: "unsupported_capability",
    message: `${invocation.application}: ${message}`,
    application: invocation.application,
  });
}

function stale(application: MediaApplication, message: string): ToolError {
  return createToolError({
    code: "stale_reference",
    message: `${application}: ${message}`,
    application,
  });
}

function blocked(error: ToolError): PreconditionRead {
  return { status: "blocked", error };
}

/**
 * Turns one record lookup into either the record or the error that describes
 * why it cannot be acted on.
 *
 * The three lookup answers map to two different codes on purpose. A record the
 * instance no longer holds is a `stale_reference`, whose remedy is to read the
 * view again; a record further back than this server will page for is a
 * `conflict`, because the reference is not stale — the record is simply out of
 * reach, and telling a caller to re-read would send it round a loop that ends
 * the same way.
 */
function recordOrError<TRecord>(
  application: MediaApplication,
  lookup: RecordLookup<TRecord>,
  subject: string,
):
  | { readonly ok: true; readonly record: TRecord }
  | { readonly ok: false; readonly error: ToolError } {
  switch (lookup.status) {
    case "found":
      return { ok: true, record: lookup.record };
    case "absent":
      return {
        ok: false,
        error: stale(application, `that ${subject} is no longer held by this instance`),
      };
    default:
      return {
        ok: false,
        error: createToolError({
          code: "conflict",
          message: `${application}: that ${subject} is further back than this server will page for; act on it through the instance directly`,
          application,
        }),
      };
  }
}

function mediaApplicationOf(
  invocation: OperationInvocation,
):
  | { readonly ok: true; readonly value: MediaApplication }
  | { readonly ok: false; readonly error: ToolError } {
  return isMediaApplication(invocation.application)
    ? { ok: true, value: invocation.application }
    : {
        ok: false,
        error: unsupported(invocation, "this application has no history or blocklist to change"),
      };
}

function parseIntent(
  invocation: OperationInvocation,
):
  | { readonly ok: true; readonly value: ActivityChangeIntent }
  | { readonly ok: false; readonly error: ToolError } {
  const parsed = activityChangeIntentSchema.safeParse(invocation.input);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : {
        ok: false,
        error: invalid(
          invocation,
          "the arguments do not match the arr_activity_change input schema",
        ),
      };
}

/**
 * Reads the instance's failed-download handling, degrading rather than blocking.
 *
 * An instance that will not answer this route has not made the mutation
 * impossible — it has made one of its disclosed effects uncertain, which the
 * effect mapping already has a third answer for. Blocking the call would refuse
 * a mutation the caller is entitled to make because a *disclosure* could not be
 * read, so the failure becomes a warning and the prediction says the search may
 * follow.
 */
async function readPolicy(
  invocation: OperationInvocation,
  application: MediaApplication,
): Promise<{ readonly policy: FailureHandlingPolicy; readonly warnings: readonly string[] }> {
  try {
    return {
      policy: await readFailureHandlingPolicy(invocation.adapter.client, application),
      warnings: [],
    };
  } catch {
    return {
      policy: { application },
      warnings: [
        "this instance did not answer for its failed-download handling, so whether a replacement search follows could not be established",
      ],
    };
  }
}

/**
 * Validates a mark-failed before anything is sent.
 *
 * Each reference is resolved, its record re-read through the media-scoped route
 * the reference retained, and held to being a grab. A reference that fails any
 * of those fails that item alone: a selection of several records is several
 * upstream requests and explicitly not transactional, so blocking the call
 * would hide the outcome of every other item.
 */
async function readHistoryPreconditions(
  invocation: OperationInvocation,
  application: MediaApplication,
  intent: Extract<ActivityChangeIntent, { intent: "mark_history_failed" }>,
): Promise<PreconditionRead> {
  const profile = profileFor(application);
  const selection = distinctReferences(intent.records);
  const items: ItemValidation<ValidatedHistoryItem>[] = [];

  for (const reference of selection.references) {
    const resolved = resolveHistoryReference(invocation.state.references, reference, application);
    if (!resolved.ok) {
      items.push({ status: "error", reference, error: resolved.error });
      continue;
    }

    let lookup: HistoryRecordLookup;
    try {
      lookup = await readHistoryRecord(invocation.adapter.client, profile, {
        historyRecordId: resolved.value.historyRecordId,
        mediaId: resolved.value.mediaId,
      });
    } catch (error) {
      items.push({ status: "error", reference, error: toolErrorForThrown(error, application) });
      continue;
    }

    const record = recordOrError(application, lookup, "history record");
    if (!record.ok) {
      items.push({ status: "error", reference, error: record.error });
      continue;
    }

    const usable = checkHistoryFailure(record.record);
    if (usable.status === "blocked") {
      items.push({ status: "error", reference, error: conflict(invocation, usable.reason) });
      continue;
    }
    items.push({
      status: "ok",
      reference,
      record: record.record,
      priorFailureIds: lookup.status === "found" ? lookup.priorFailureIds : [],
    });
  }

  // Described from every record this call will actually write, not from the
  // first of them: an effect naming one release while the mutation acts on four
  // is false about the one thing a plan exists to state.
  const usable = items.flatMap((item) => (item.status === "ok" ? [item.record] : []));

  // The follow-on policy is read only when there is a mutation to apply it to.
  // A call that will send nothing does not depend on it, so reading it would
  // cost a request nothing uses, warn about a search that cannot follow, and —
  // the part with teeth — fingerprint state into the read set of a plan whose
  // mutation does not rest on it, which is a plan that goes stale for reasons
  // that were never about it.
  const { policy, warnings } =
    usable.length === 0
      ? { policy: { application } as FailureHandlingPolicy, warnings: [] as readonly string[] }
      : await readPolicy(invocation, application);

  const context: HistoryContext = {
    kind: contextKind,
    intent: "mark_history_failed",
    application,
    items,
    policy,
    effects:
      usable.length === 0
        ? { requested: [], predicted: [], warnings: [] }
        : historyFailureEffects(usable, policy),
  };

  return {
    status: "ok",
    validated: context,
    warnings: [...selection.warnings, ...warnings, ...context.effects.warnings],
    observations: [
      ...itemObservations(items, historyRecordState),
      ...(usable.length === 0 ? [] : [policyObservation(policy)]),
    ],
  };
}

async function readBlocklistPreconditions(
  invocation: OperationInvocation,
  application: MediaApplication,
  intent: Extract<ActivityChangeIntent, { intent: "remove_blocklist_record" }>,
): Promise<PreconditionRead> {
  const profile = profileFor(application);
  const selection = distinctReferences(intent.records);
  const items: ItemValidation<ValidatedBlocklistItem>[] = [];

  for (const reference of selection.references) {
    const resolved = resolveBlocklistReference(invocation.state.references, reference, application);
    if (!resolved.ok) {
      items.push({ status: "error", reference, error: resolved.error });
      continue;
    }

    let lookup: RecordLookup<BlocklistRecord>;
    try {
      lookup = await readBlocklistRecord(
        invocation.adapter.client,
        profile,
        resolved.value.blocklistRecordId,
      );
    } catch (error) {
      items.push({ status: "error", reference, error: toolErrorForThrown(error, application) });
      continue;
    }

    const record = recordOrError(application, lookup, "blocklist record");
    if (!record.ok) {
      items.push({ status: "error", reference, error: record.error });
      continue;
    }
    items.push({ status: "ok", reference, record: record.record });
  }

  const usable = items.flatMap((item) => (item.status === "ok" ? [item.record] : []));
  const context: BlocklistContext = {
    kind: contextKind,
    intent: "remove_blocklist_record",
    application,
    items,
    effects:
      usable.length === 0
        ? { requested: [], predicted: [], warnings: [] }
        : blocklistRemovalEffects(application, usable),
  };

  return {
    status: "ok",
    validated: context,
    warnings: [...selection.warnings, ...context.effects.warnings],
    observations: itemObservations(items, blocklistRecordState),
  };
}

/**
 * One observation per selected record, including the ones that failed.
 *
 * A failed item is fingerprinted too, for the reason the library mutations
 * already record: a plan reports such an item as unchangeable and leaves it out
 * of its predicted effects, so an item that became readable between planning and
 * applying would otherwise be mutated by a plan that said it would not touch it.
 */
function itemObservations<TRecord>(
  items: readonly ItemValidation<{ reference: string; record: TRecord }>[],
  state: (record: TRecord) => Readonly<Record<string, unknown>>,
): readonly ReadSetObservation[] {
  return items.map((item) => ({
    key: `record:${item.reference}`,
    value: item.status === "ok" ? state(item.record) : { unreadable: item.error.code },
  }));
}

/**
 * The follow-on policy, fingerprinted so a plan does not survive it changing.
 *
 * A plan that predicted no replacement search must not apply unchanged once the
 * instance has been reconfigured to redownload failed grabs, because the effect
 * it disclosed would no longer be the effect it produces.
 */
function policyObservation(policy: FailureHandlingPolicy): ReadSetObservation {
  return { key: "policy:failed-download-handling", value: failurePolicyState(policy) };
}

/**
 * The selection with repeats removed, in the order the caller first named them.
 *
 * A reference names one upstream record, so naming it twice asks for the same
 * mutation twice — and these are not idempotent: a grab failed twice can record
 * a second failure and start a second search, and a blocklist record removed
 * twice answers the second attempt with a `404` that reads as a real failure.
 * The receipt collapses a repeated *call* into one mutation; this is the same
 * protection inside a single call, applied before any state is read so a
 * duplicate costs no upstream request either.
 */
function distinctReferences(references: readonly string[]): {
  readonly references: readonly string[];
  readonly warnings: readonly string[];
} {
  const seen = new Set<string>();
  const distinct = references.filter((reference) => {
    if (seen.has(reference)) {
      return false;
    }
    seen.add(reference);
    return true;
  });
  return {
    references: distinct,
    warnings:
      distinct.length === references.length
        ? []
        : [
            `${references.length - distinct.length} repeated record reference(s) were named once each; a record is not mutated twice by naming it twice`,
          ],
  };
}

export const activityChangePreconditions: PreconditionReader = async (invocation) => {
  const application = mediaApplicationOf(invocation);
  if (!application.ok) {
    return blocked(application.error);
  }
  const intent = parseIntent(invocation);
  if (!intent.ok) {
    return blocked(intent.error);
  }

  return intent.value.intent === "mark_history_failed"
    ? readHistoryPreconditions(invocation, application.value, intent.value)
    : readBlocklistPreconditions(invocation, application.value, intent.value);
};

function itemOutcome(
  reference: string,
  error: ToolError | undefined,
  warnings: readonly string[] = [],
): ItemOutcome {
  return {
    reference,
    status: error === undefined ? "ok" : "error",
    warnings: [...warnings],
    ...(error === undefined ? {} : { error }),
  };
}

interface AppliedItems {
  readonly outcomes: readonly ItemOutcome[];
  /** The failure, if any, that leaves this mutation's outcome unknown. */
  readonly unresolved?: ToolError | undefined;
  /**
   * The error the receipt settles from when the call is shown to have had no
   * effect, stating which showing that was.
   *
   * It is built from what this loop counted, never picked out of the per-item
   * outcomes. Reusing an item's error would attach one selection's transport
   * failure to a statement about the whole call — and where that item failed
   * with a timeout, it would say the call was never attempted *because* of a
   * timeout, which is two untrue things at once.
   */
  readonly noEffect?: ToolError | undefined;
  /**
   * Whether this server can show that the call as a whole had no effect.
   *
   * True only when nothing succeeded and every failure is one it can show did
   * nothing — a selection that failed validation before a request went out, an
   * upstream refusal that proves the instance did not act, or a lost answer a
   * re-read established did not apply. One item succeeding is enough to make it
   * false, because settling the receipt as retryable would then licence
   * re-sending the write that did land.
   */
  readonly provenNoEffect: boolean;
}

/**
 * Sends one write per selected record and reports each outcome as its own.
 *
 * A write whose failure does not prove the instance ignored it is reconciled
 * against upstream state before it is reported, because a lost answer is not a
 * failure: the record is re-read, and only what that read establishes is
 * reported. Where it confirms the mutation, the item succeeds with a note
 * saying how that was established; where it shows the mutation did not apply,
 * the item fails and stays retryable; where it establishes neither, the call's
 * outcome is left unknown so the receipt stays reconcilable.
 */
async function applyItems(
  invocation: OperationInvocation,
  context: ActivityChangeContext,
): Promise<AppliedItems> {
  const application = context.application;
  const profile = profileFor(application);
  const client = invocation.adapter.client;

  // Narrowed once, here, rather than per item. The context is discriminated by
  // its intent, so branching at the top gives each loop below correctly typed
  // records — where branching inside one shared loop would need a cast at every
  // use, and a cast is exactly how a history record would one day be handed to
  // the blocklist route.
  return context.intent === "mark_history_failed"
    ? applyEach(
        context.items,
        application,
        (item) => markHistoryFailed(client, item.record.context.historyRecordId),
        (item) => reconcileHistoryFailure(client, profile, item.record, item.priorFailureIds),
      )
    : applyEach(
        context.items,
        application,
        (item) => removeBlocklistRecord(client, item.record.context.blocklistRecordId),
        (item) => reconcileBlocklistRemoval(client, profile, item.record.context.blocklistRecordId),
      );
}

/**
 * Sends one write per usable record and settles each outcome on its own.
 *
 * The write and the reconciliation are supplied by the caller because they are
 * the only two things that differ between the intents; everything else — the
 * dispatch count, which failures reconcile, and how each answer becomes an item
 * outcome — is the same and is written once.
 */
async function applyEach<TItem extends { readonly reference: string }>(
  items: readonly ItemValidation<TItem>[],
  application: MediaApplication,
  write: (item: TItem) => Promise<void>,
  reconcile: (item: TItem) => Promise<Reconciliation>,
): Promise<AppliedItems> {
  const outcomes: ItemOutcome[] = [];
  let unresolved: ToolError | undefined;
  let succeeded = 0;
  let dispatched = 0;
  let notApplied = 0;
  // Counted rather than inferred from the outcomes: a failure this server
  // cannot show had no effect is what keeps the whole call from being reported
  // as one that never happened.
  let unproven = 0;

  for (const item of items) {
    if (item.status === "error") {
      // Nothing was dispatched for a selection that failed validation, so its
      // failure is one this server can show had no effect.
      outcomes.push(itemOutcome(item.reference, item.error));
      continue;
    }

    dispatched += 1;
    try {
      await write(item);
      succeeded += 1;
      outcomes.push(itemOutcome(item.reference, undefined));
    } catch (error) {
      const failure = toolErrorForThrown(error, application);
      if (toolErrorProvesNoEffect(failure.code)) {
        outcomes.push(itemOutcome(item.reference, failure));
        continue;
      }

      // The answer was lost rather than refused, so what happened is a question
      // for the instance rather than for this process. A reconciliation that
      // itself fails answers nothing, which is `unconfirmed` — never a licence
      // to report the mutation as not having happened.
      const settled = await reconcile(item).catch(() => ({ status: "unconfirmed" }) as const);
      if (settled.status === "confirmed") {
        succeeded += 1;
        outcomes.push(
          itemOutcome(item.reference, undefined, [
            "the answer to this write was lost, and re-reading the instance confirmed it applied",
          ]),
        );
        continue;
      }
      if (settled.status === "not_applied") {
        notApplied += 1;
        // The original failure is the symptom that made the answer unknown, and
        // it stopped being the finding the moment the re-read settled the
        // question. What the caller is owed is what reconciliation established;
        // the transport failure survives only as the reason a re-read was
        // needed at all.
        outcomes.push(
          itemOutcome(
            item.reference,
            createToolError({
              code: "conflict",
              message: `${application}: this write was sent, its answer was lost (${failure.code}), and re-reading the instance established that it did not apply`,
              application,
            }),
            ["this record is unchanged, so this item may be retried"],
          ),
        );
        continue;
      }
      outcomes.push(itemOutcome(item.reference, failure));
      unproven += 1;
      unresolved ??= failure;
    }
  }

  const provenNoEffect = outcomes.length > 0 && succeeded === 0 && unproven === 0;
  return {
    outcomes,
    unresolved,
    provenNoEffect,
    ...(provenNoEffect
      ? { noEffect: describeNoEffect(application, dispatched, notApplied, outcomes.length) }
      : {}),
  };
}

/**
 * States which showing established that the call had no effect.
 *
 * The two are different facts and a caller acts on them differently: nothing
 * was sent, or everything was sent and re-reading the instance found none of it
 * applied. Both are safe to retry, which is why they settle the same way — but
 * saying which one happened is the difference between a receipt a caller can
 * reason about and one that merely asserts.
 */
function describeNoEffect(
  application: MediaApplication,
  dispatched: number,
  notApplied: number,
  total: number,
): ToolError {
  const detail =
    dispatched === 0
      ? `no upstream request was sent: all ${total} selected record(s) failed validation before one could be`
      : notApplied === dispatched
        ? `all ${dispatched} write(s) were sent and re-reading the instance established that none of them applied`
        : `nothing was applied: ${dispatched} write(s) were sent, of which ${notApplied} were shown by a re-read not to have applied, and the rest were refused`;
  return createToolError({
    code: "conflict",
    message: `${application}: ${detail}; the per-item outcomes say why each record failed`,
    application,
  });
}

function planFor(context: ActivityChangeContext): {
  requestedEffects: readonly Effect[];
  predictedEffects: readonly Effect[];
  warnings: readonly string[];
} {
  const usable = context.items.filter((item) => item.status === "ok").length;
  const failing = context.items.length - usable;
  return {
    requestedEffects: context.effects.requested,
    // Nothing is predicted for a selection nothing can act on: an apply would
    // send no request at all, and predicting the effect anyway would overstate
    // what the plan is going to do.
    predictedEffects: usable === 0 ? [] : context.effects.predicted,
    warnings: [
      ...(usable === 0 ? ["no selected record can be changed; see the per-item outcomes"] : []),
      ...(failing === 0 || usable === 0
        ? []
        : [`${failing} selected record(s) cannot be changed; see the per-item outcomes`]),
    ],
  };
}

/**
 * Marks history records failed and removes blocklist records.
 *
 * Plan mode discloses what an apply would request and predicts only what the
 * state it just read says will follow. Apply mode sends one request per record,
 * so every item reports its own outcome and a failure part-way through neither
 * hides the records that succeeded nor claims the ones that did not.
 */
export const activityChangeHandler: OperationHandler = async (invocation) => {
  const context = invocation.validated;
  if (!isActivityChangeContext(context)) {
    return {
      status: "error",
      error: conflict(invocation, "the current state of this mutation was not validated"),
    };
  }

  if (invocation.mode === "plan") {
    return {
      status: "ok",
      plan: planFor(context),
      items: context.items.map((item) =>
        item.status === "error"
          ? itemOutcome(item.reference, item.error)
          : itemOutcome(item.reference, undefined),
      ),
    };
  }

  const applied = await applyItems(invocation, context);
  // A mutation may be recorded as having had no effect only where this server
  // can show that of every selection: nothing succeeded, and each failure is
  // one it observed rather than inferred — a selection refused before a request
  // went out, an upstream refusal that proves the instance did not act, or a
  // lost answer a re-read established did not apply. "Every item errored" alone
  // never qualifies, because that is equally true of a single write that timed
  // out, and recording that would turn "we may have written and do not know"
  // into "we definitely did not".
  const unattempted = applied.noEffect;

  return {
    status: "ok",
    items: applied.outcomes,
    effects: context.effects.requested,
    warnings: context.effects.warnings,
    ...(applied.unresolved === undefined ? {} : { outcomeUnknown: applied.unresolved }),
    ...(unattempted === undefined ? {} : { unattempted }),
  };
};
