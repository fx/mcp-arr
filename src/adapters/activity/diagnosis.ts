import type { ApplicationId } from "../../applications.js";
import type { UpstreamClient } from "../../http/client.js";
import { type ToolError, toolErrorForThrown } from "../../tools/errors.js";
import { isMediaApplication, type MediaApplication } from "../library/model.js";
import type { DetailLevel } from "../library/requests.js";
import type {
  BlocklistRecord,
  DiskCondition,
  HealthCheck,
  HistoryRecord,
  QueueItem,
  QueueSummary,
} from "./model.js";
import type { ActivityQueryRequest, ActivityView } from "./requests.js";
import { type ActivityViewData, runActivityQuery } from "./service.js";

/**
 * The bounded activity diagnosis.
 *
 * Its whole job is to answer "why is this not working" by reading, and the
 * shape of the answer is the point: observed **evidence** and suggested
 * **candidate actions** are separate fields, never merged into a narrative that
 * would blur which is which. Nothing here mutates anything — every read goes
 * through {@link runActivityQuery}, which sends only GETs — and a candidate is
 * the *name* of a declared tool intent plus the record it would apply to, never
 * a call. An agent decides whether to run one; this module never does.
 *
 * It is also deliberately tolerant. A diagnosis that fails because one of three
 * instances is down is useless exactly when it is most needed, so every read is
 * attempted independently and a failure becomes a recorded
 * {@link DiagnosisFailure} beside whatever else came back. The report says
 * plainly whether it is complete.
 */

/** One application to diagnose, and the client that reaches it. */
export interface DiagnosisTarget {
  readonly application: ApplicationId;
  readonly client: UpstreamClient;
}

/**
 * The one queue row a diagnosis is about, when the caller named one.
 *
 * It comes from a resolved queue reference, so it is already an upstream
 * identifier by the time it arrives here. Naming one narrows the queue read
 * from a page to that single row — which is both cheaper and the difference
 * between "what is wrong with my instance" and "what is wrong with this
 * download".
 */
export interface DiagnosisFocus {
  readonly application: MediaApplication;
  readonly queueItemId: number;
  readonly mediaId?: number | undefined;
}

export interface DiagnosisRequest {
  readonly detail: DetailLevel;
  readonly pageSize: number;
  readonly focus?: DiagnosisFocus | undefined;
  /** A lower bound on the history the diagnosis reads back through. */
  readonly since?: string | undefined;
}

/** What one application answered, with each part absent if its read failed. */
export interface ApplicationEvidence {
  readonly application: ApplicationId;
  readonly queueSummary?: QueueSummary | undefined;
  readonly queue: readonly QueueItem[];
  readonly history: readonly HistoryRecord[];
  readonly blocklist: readonly BlocklistRecord[];
  readonly health: readonly HealthCheck[];
  readonly disk: readonly DiskCondition[];
}

/**
 * One read that did not answer.
 *
 * The view is named alongside the error so a caller can tell a whole instance
 * being unreachable from one view being unsupported on it, which have different
 * remedies and different consequences for how much of the report to trust.
 */
export interface DiagnosisFailure {
  readonly application: ApplicationId;
  readonly view: ActivityView;
  readonly error: ToolError;
}

/**
 * A queue-resolution intent, as `arr_queue_resolve` declares it.
 *
 * The list is closed and mirrors that tool's published input schema; a test
 * feeds every member of it to the real schema, so a name that drifted apart
 * from the tool would fail rather than reaching a caller as advice for an
 * intent nothing accepts.
 */
export const queueResolveIntents = [
  "ignore_tracking",
  "remove_from_client_and_delete_data",
  "blocklist_and_remove",
  "change_category_mark_imported",
  "route_to_manual_import",
  "force_pending_grab",
  "remove_pending",
  "blocklist_pending",
] as const;

export type QueueResolveIntent = (typeof queueResolveIntents)[number];

export const activityChangeIntents = ["mark_history_failed", "remove_blocklist_record"] as const;

export type ActivityChangeIntent = (typeof activityChangeIntents)[number];

/**
 * One suggested next step.
 *
 * Every member is a value this server authored. The record it points at is an
 * adapter context, which the tool layer mints an opaque reference from, so a
 * candidate names an upstream identifier no more than a mapped record does. The
 * reason is written here rather than assembled from upstream text: a status
 * message is evidence a caller reads, not a sentence this server repeats as its
 * own advice.
 */
export type CandidateAction =
  | {
      readonly tool: "arr_queue_resolve";
      readonly intent: QueueResolveIntent;
      readonly target: { readonly kind: "queue"; readonly item: QueueItem };
      readonly reason: string;
    }
  | {
      readonly tool: "arr_activity_change";
      readonly intent: "mark_history_failed";
      readonly target: { readonly kind: "history"; readonly record: HistoryRecord };
      readonly reason: string;
    }
  | {
      readonly tool: "arr_activity_change";
      readonly intent: "remove_blocklist_record";
      readonly target: { readonly kind: "blocklist"; readonly record: BlocklistRecord };
      readonly reason: string;
    };

export interface DiagnosisReport {
  readonly evidence: readonly ApplicationEvidence[];
  readonly failures: readonly DiagnosisFailure[];
  readonly candidates: readonly CandidateAction[];
  /** False when any read failed, whatever else came back. */
  readonly complete: boolean;
  readonly warnings: readonly string[];
}

/**
 * The ceiling on how many candidates one report carries.
 *
 * A queue of a thousand blocked downloads would otherwise produce a suggestion
 * list nobody can read, which is the same failure as returning nothing. The
 * bound is reported as a warning rather than applied silently.
 */
export const maxCandidates = 50;

interface ReadOutcome {
  readonly data?: ActivityViewData | undefined;
  readonly failure?: DiagnosisFailure | undefined;
}

/**
 * Runs one view for one application, converting any failure into a record.
 *
 * The service already normalizes upstream failures into a {@link ToolError}
 * rather than throwing, so the catch is for a defect in this process, not for
 * an unreachable instance. It is here anyway, because the one thing this
 * function must never do is propagate: a diagnosis that aborts on the first
 * problem is the failure mode the whole module exists to avoid.
 */
async function read(target: DiagnosisTarget, request: ActivityQueryRequest): Promise<ReadOutcome> {
  try {
    const outcome = await runActivityQuery(target.application, target.client, request);
    return outcome.status === "ok"
      ? { data: outcome.data }
      : {
          failure: {
            application: target.application,
            view: request.view,
            error: outcome.error,
          },
        };
  } catch (error) {
    return {
      failure: {
        application: target.application,
        view: request.view,
        error: toolErrorForThrown(error, target.application),
      },
    };
  }
}

/** Narrows one read's payload to the view it was asked for, or gives nothing. */
function itemsOf<TView extends ActivityViewData["view"]>(
  outcome: ReadOutcome,
  view: TView,
): Extract<ActivityViewData, { view: TView }> | undefined {
  const data = outcome.data;
  return data !== undefined && data.view === view
    ? (data as Extract<ActivityViewData, { view: TView }>)
    : undefined;
}

/**
 * The reads one application contributes.
 *
 * Prowlarr has no queue, blocklist, or disk view, so asking it for one would
 * produce an `unsupported_capability` failure that says nothing — the report
 * would be permanently incomplete for a reason that is not a problem. Support
 * is therefore decided here rather than discovered from the error.
 */
function requestsFor(
  target: DiagnosisTarget,
  request: DiagnosisRequest,
): readonly ActivityQueryRequest[] {
  const paging = { pageSize: request.pageSize };
  const base = { detail: request.detail, paging } as const;
  const requests: ActivityQueryRequest[] = [{ ...base, view: "health" }];

  if (!isMediaApplication(target.application)) {
    requests.push({ ...base, view: "history", since: request.since });
    return requests;
  }

  const focus =
    request.focus !== undefined && request.focus.application === target.application
      ? request.focus
      : undefined;

  requests.push({ ...base, view: "queue_status" });
  requests.push(
    focus === undefined
      ? { ...base, view: "queue" }
      : {
          ...base,
          view: "queue_details",
          queueItemId: focus.queueItemId,
          mediaId: focus.mediaId,
        },
  );
  requests.push({
    ...base,
    view: "history",
    since: request.since,
    mediaIds: focus?.mediaId === undefined ? undefined : [focus.mediaId],
  });
  requests.push({
    ...base,
    view: "blocklist",
    mediaIds: focus?.mediaId === undefined ? undefined : [focus.mediaId],
  });
  requests.push({ ...base, view: "disk_space" });
  return requests;
}

interface TargetResult {
  readonly evidence: ApplicationEvidence;
  readonly failures: readonly DiagnosisFailure[];
}

/**
 * Reads one application's evidence.
 *
 * The reads run concurrently because they are independent GETs against one
 * instance and a diagnosis that took six round trips in series would be slow
 * exactly where latency already hurts. `Promise.all` is safe here only because
 * {@link read} cannot reject — were that to change, one failure would cancel
 * the siblings and take their evidence with it.
 */
async function readTarget(
  target: DiagnosisTarget,
  request: DiagnosisRequest,
): Promise<TargetResult> {
  const outcomes = await Promise.all(
    requestsFor(target, request).map((query) => read(target, query)),
  );

  const failures = outcomes
    .map((outcome) => outcome.failure)
    .filter((failure): failure is DiagnosisFailure => failure !== undefined);

  const queueDetail = outcomes
    .map((outcome) => itemsOf(outcome, "queue_details"))
    .find((value) => value !== undefined);
  const queuePage = outcomes
    .map((outcome) => itemsOf(outcome, "queue"))
    .find((value) => value !== undefined);

  return {
    evidence: {
      application: target.application,
      queueSummary: outcomes
        .map((outcome) => itemsOf(outcome, "queue_status"))
        .find((value) => value !== undefined)?.summary,
      queue: queueDetail !== undefined ? [queueDetail.item] : (queuePage?.items ?? []),
      history:
        outcomes.map((outcome) => itemsOf(outcome, "history")).find((value) => value !== undefined)
          ?.items ?? [],
      blocklist:
        outcomes
          .map((outcome) => itemsOf(outcome, "blocklist"))
          .find((value) => value !== undefined)?.items ?? [],
      health:
        outcomes.map((outcome) => itemsOf(outcome, "health")).find((value) => value !== undefined)
          ?.items ?? [],
      disk:
        outcomes
          .map((outcome) => itemsOf(outcome, "disk_space"))
          .find((value) => value !== undefined)?.items ?? [],
    },
    failures,
  };
}

/**
 * Whether a tracked download has stopped making progress on its own.
 *
 * These are the states where the application is waiting for someone to decide
 * something, as distinct from `downloading`, where the answer is to wait.
 */
function isStalled(item: QueueItem): boolean {
  const state = item.evidence.trackedState;
  return (
    state === "import_blocked" ||
    state === "import_pending" ||
    state === "failed" ||
    state === "failed_pending" ||
    item.evidence.status === "failed" ||
    item.evidence.status === "download_client_unavailable"
  );
}

function hasFailed(item: QueueItem): boolean {
  const state = item.evidence.trackedState;
  return state === "failed" || state === "failed_pending" || item.evidence.status === "failed";
}

/**
 * The intents that apply to one queue row.
 *
 * Every branch is keyed on the item kind first, because that is the split
 * change 0006's state machine enforces: an intent valid only for a pending
 * release must never be suggested for a tracked download. Beyond that the
 * ordering within each list is the order a caller would most likely want them,
 * least destructive first — ignoring the tracking changes nothing upstream,
 * deleting the client's payload data changes the most.
 */
function queueCandidates(item: QueueItem): readonly CandidateAction[] {
  const candidate = (intent: QueueResolveIntent, reason: string): CandidateAction => ({
    tool: "arr_queue_resolve",
    intent,
    target: { kind: "queue", item },
    reason,
  });

  if (item.kind === "pending_release") {
    return [
      candidate("force_pending_grab", "this release is being held and can be grabbed now"),
      candidate("remove_pending", "this release can be discarded without touching a download"),
      candidate("blocklist_pending", "this release can be discarded and not offered again"),
    ];
  }

  if (hasFailed(item)) {
    return [
      candidate("ignore_tracking", "the failed download can be left alone and untracked"),
      candidate(
        "blocklist_and_remove",
        "the failed download can be removed and its release not offered again",
      ),
      candidate(
        "remove_from_client_and_delete_data",
        "the failed download and the client's payload data can both be removed",
      ),
    ];
  }

  if (item.evidence.trackedState === "import_blocked") {
    return [
      candidate("route_to_manual_import", "the import is blocked and can be resolved by hand"),
      candidate(
        "change_category_mark_imported",
        "the download can be marked imported by category without removing it",
      ),
      candidate("ignore_tracking", "the blocked import can be left alone and untracked"),
    ];
  }

  // An unreachable download client is not a stuck import, and advising a
  // manual import for it would be advice that cannot work: there is nothing to
  // import from until the client answers again. The only intent that applies is
  // the one that changes nothing upstream.
  if (item.evidence.status === "download_client_unavailable") {
    return [
      candidate(
        "ignore_tracking",
        "the download client is unreachable, so this row can be left alone until it returns",
      ),
    ];
  }

  if (isStalled(item)) {
    return [
      candidate(
        "route_to_manual_import",
        "the import has not completed and can be resolved by hand",
      ),
      candidate("ignore_tracking", "the stalled download can be left alone and untracked"),
    ];
  }

  return [];
}

/**
 * The history record that grabbed one queue row, if the evidence holds it.
 *
 * The match is on the salted download digest, which is exactly what that digest
 * exists for: two rows describing the same download agree on it, while the
 * identifier the download client uses never leaves the adapter. Falling back to
 * a title comparison would be worse than no match — release titles repeat
 * across seasons and qualities.
 */
function grabFor(item: QueueItem, history: readonly HistoryRecord[]): HistoryRecord | undefined {
  const identity = item.origin?.downloadIdentity;
  if (identity === undefined) {
    return undefined;
  }
  return history.find(
    (record) => record.downloadIdentity === identity && record.eventType === "grabbed",
  );
}

/**
 * The blocklist records that already block a row's own release.
 *
 * Both the title and the media association have to agree, and both have to be
 * present. A title alone repeats across series; a media association alone would
 * suggest re-allowing every blocked release for a show because one episode
 * failed; and comparing two absent associations would make a row upstream could
 * not associate match a blocklist record that names nothing either — a pair
 * with no evidence of being related at all.
 */
function blocksFor(
  item: QueueItem,
  blocklist: readonly BlocklistRecord[],
): readonly BlocklistRecord[] {
  const media = item.media;
  if (media === undefined || item.title === "") {
    return [];
  }
  return blocklist.filter((record) => record.title === item.title && record.media?.id === media.id);
}

/**
 * Derives every candidate from the evidence, in one pass per application.
 *
 * Suggestions are only ever produced for a row that is actually stuck. A
 * download that is simply downloading needs no advice, and offering some would
 * make the list longer without making it more useful.
 */
function candidatesFor(evidence: ApplicationEvidence): readonly CandidateAction[] {
  const candidates: CandidateAction[] = [];

  for (const item of evidence.queue) {
    if (item.kind === "tracked_download" && !isStalled(item)) {
      continue;
    }
    candidates.push(...queueCandidates(item));

    const grab = hasFailed(item) ? grabFor(item, evidence.history) : undefined;
    if (grab !== undefined) {
      candidates.push({
        tool: "arr_activity_change",
        intent: "mark_history_failed",
        target: { kind: "history", record: grab },
        reason: "the grab for this download can be recorded as failed",
      });
    }

    for (const record of blocksFor(item, evidence.blocklist)) {
      candidates.push({
        tool: "arr_activity_change",
        intent: "remove_blocklist_record",
        target: { kind: "blocklist", record },
        reason: "this release is blocked, and removing the record lets it be considered again",
      });
    }
  }

  return candidates;
}

/**
 * Correlates one bounded diagnosis across every application it was given.
 *
 * The applications are read concurrently and independently: one that is
 * unreachable contributes its failures and no evidence, and every other
 * application's evidence is unaffected. The report is returned even when
 * nothing could be read at all — `complete: false` with the failures that
 * explain it is a more useful answer than an error, and it is the only answer
 * that lets a caller see which instance is at fault.
 */
export async function runActivityDiagnosis(
  targets: readonly DiagnosisTarget[],
  request: DiagnosisRequest,
): Promise<DiagnosisReport> {
  const results = await Promise.all(targets.map((target) => readTarget(target, request)));

  const evidence = results.map((result) => result.evidence);
  const failures = results.flatMap((result) => result.failures);
  const derived = evidence.flatMap((entry) => candidatesFor(entry));

  const warnings: string[] = [];
  if (failures.length > 0) {
    warnings.push(
      "some activity reads did not answer; this diagnosis is based on partial evidence",
    );
  }
  const candidates = derived.slice(0, maxCandidates);
  if (derived.length > candidates.length) {
    warnings.push(
      `only the first ${String(maxCandidates)} suggested actions are listed; narrow the diagnosis to see the rest`,
    );
  }

  return {
    evidence,
    failures,
    candidates,
    complete: failures.length === 0,
    warnings,
  };
}
