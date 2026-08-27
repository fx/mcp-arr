import type {
  BlocklistRecord,
  CommandActivity,
  DiskCondition,
  HealthCheck,
  HistoryRecord,
  IndexerRef,
  QueueItem,
} from "../adapters/activity/model.js";
import type { ActivityQueryRequest } from "../adapters/activity/requests.js";
import { type ActivityViewData, runActivityQuery } from "../adapters/activity/service.js";
import type { MediaKind, MediaRecordKind, MediaRef } from "../adapters/library/model.js";
import { isMediaApplication, mediaRefKey } from "../adapters/library/model.js";
import { queryDigest } from "../adapters/library/paging.js";
import type { ReferenceStore } from "../state/references.js";
import {
  mintBlocklistReference,
  mintHistoryReference,
  mintQueueReference,
  resolveQueueReference,
} from "./activity-references.js";
import { createToolError, type ToolError, toolErrorForReferenceFailure } from "./errors.js";
import type { OperationHandler, OperationInvocation } from "./operations.js";
import { type ActivityQueryInput, activityQueryInputSchema } from "./schemas/activity.js";
import type {
  ActivityBlocklistRecord,
  ActivityHistoryRecord,
  ActivityQueueItem,
  ActivityViewResult,
} from "./schemas/activity-results.js";

/**
 * The `arr_activity_query` operation handler.
 *
 * It is the join between the published tool contract and the activity service,
 * and it plays the same role `arr_library_query`'s handler does: it re-narrows
 * the caller's already-validated arguments, turns every opaque reference back
 * into the upstream identifier it stands for, runs the bounded query, and
 * publishes the normalized result with fresh references of its own. It builds
 * no envelope and normalizes no error — the shared dispatcher owns both.
 *
 * Every operation it can run is a read. Nothing beneath it sends anything but a
 * GET, so no query reachable from this handler can change upstream state.
 */

type Resolved<TValue> =
  | { readonly ok: true; readonly value: TValue }
  | { readonly ok: false; readonly error: ToolError };

function invalid(invocation: OperationInvocation, message: string): ToolError {
  return createToolError({
    code: "invalid_input",
    message: `${invocation.application}: ${message}`,
    application: invocation.application,
  });
}

function list<TValue>(values: readonly TValue[] | undefined): TValue[] | undefined {
  return values === undefined ? undefined : [...values];
}

/**
 * Digests one activity record's identity and the state a caller acts on.
 *
 * The parts are listed in a fixed, code-authored order and exclude everything a
 * detail level changes, so the same row fingerprints alike whether it was read
 * at `summary` or at `full`. Progress is excluded too: a download whose
 * remaining bytes moved is the same row, and a fingerprint that changed every
 * second would make every plan built on it stale.
 */
function identityFingerprint(ref: MediaRef): string {
  return queryDigest([mediaRefKey(ref)]);
}

function isAllowedKind<TKind extends MediaRecordKind>(
  kind: MediaKind,
  allowed: readonly TKind[],
): kind is TKind {
  return (allowed as readonly MediaKind[]).includes(kind);
}

/**
 * The kinds each association a row publishes may actually name.
 *
 * A row is associated with the top-level record — a Sonarr series or a Radarr
 * movie — and, on Sonarr, with the episode it is for. Nothing else: not a
 * season, not a collection, and never a file. The published schema declares the
 * same two sets, so what a minter accepts and what the contract admits are one
 * decision rather than two that can drift.
 */
const associatedRecordKinds = ["series", "movie"] as const;
const associatedEpisodeKinds = ["episode"] as const;

/**
 * Mints the media references one query's results carry.
 *
 * Identities are deduplicated by the model's own key, so a queue page whose
 * rows all belong to one series mints exactly one reference for it, and nothing
 * a caller supplied can influence what two identities collapse to. Every
 * identity an activity result names is named rather than read — a queue row
 * reports which series it is for, it does not return the series — so the
 * fingerprint covers the identity alone. Inventing state for it would be a
 * false snapshot.
 */
function createMediaMinter(references: ReferenceStore) {
  const minted = new Map<string, string>();

  return <TKind extends MediaRecordKind>(ref: MediaRef, allowed: readonly TKind[]) => {
    // Checked before anything is minted, the way the library handler checks the
    // kind a view may publish, and against the kinds this particular field
    // admits rather than merely against records in general — an adapter that
    // mapped a file, a season, or a movie where an episode belongs fails here,
    // naming what it produced, instead of surfacing a layer later as a result
    // that merely did not conform. Checking first is what keeps the failure
    // clean: a reference minted for a kind this call then refuses would outlive
    // the failed call in the store.
    if (!isAllowedKind(ref.kind, allowed)) {
      throw new Error(
        `an activity view named a ${ref.kind} where only ${allowed.join(" or ")} can appear`,
      );
    }

    const key = mediaRefKey(ref);
    let reference = minted.get(key);
    if (reference === undefined) {
      reference = references.mint({
        kind: "media",
        applications: [ref.application],
        payload: () => ({
          kind: "domain",
          snapshot: {
            upstreamId: ref.id,
            fingerprint: identityFingerprint(ref),
            detail: { kind: ref.kind },
          },
        }),
      }).reference;
      minted.set(key, reference);
    }
    return { reference, application: ref.application, kind: ref.kind, id: ref.id };
  };
}

type MediaMinter = ReturnType<typeof createMediaMinter>;

function publishIndexer(indexer: IndexerRef) {
  return { application: indexer.application, indexerId: indexer.indexerId, name: indexer.name };
}

function publishQueueItem(
  item: QueueItem,
  references: ReferenceStore,
  media: MediaMinter,
): ActivityQueueItem {
  return {
    reference: mintQueueReference(references, item),
    id: String(item.context.queueItemId),
    application: item.application,
    kind: item.kind,
    title: item.title,
    media: item.media === undefined ? undefined : media(item.media, associatedRecordKinds),
    episode: item.episode === undefined ? undefined : media(item.episode, associatedEpisodeKinds),
    quality: item.quality,
    evidence: {
      status: item.evidence.status,
      trackedStatus: item.evidence.trackedStatus,
      trackedState: item.evidence.trackedState,
      statusMessages: item.evidence.statusMessages.map((group) => ({
        title: group.title,
        messages: [...group.messages],
      })),
      errorMessage: item.evidence.errorMessage,
    },
    progress: item.progress,
    origin: item.origin,
    languages: list(item.languages),
  };
}

function publishHistoryRecord(
  record: HistoryRecord,
  references: ReferenceStore,
  media: MediaMinter,
): ActivityHistoryRecord {
  return {
    reference: mintHistoryReference(references, record),
    id: String(record.context.historyRecordId),
    application: record.application,
    eventType: record.eventType,
    date: record.date,
    title: record.title,
    media: record.media === undefined ? undefined : media(record.media, associatedRecordKinds),
    episode:
      record.episode === undefined ? undefined : media(record.episode, associatedEpisodeKinds),
    quality: record.quality,
    indexer: record.indexer === undefined ? undefined : publishIndexer(record.indexer),
    downloadIdentity: record.downloadIdentity,
    successful: record.successful,
    data: record.data,
  };
}

function publishBlocklistRecord(
  record: BlocklistRecord,
  references: ReferenceStore,
  media: MediaMinter,
): ActivityBlocklistRecord {
  return {
    reference: mintBlocklistReference(references, record),
    id: String(record.context.blocklistRecordId),
    application: record.application,
    title: record.title,
    date: record.date,
    media: record.media === undefined ? undefined : media(record.media, associatedRecordKinds),
    episodes: record.episodes?.map((ref) => media(ref, associatedEpisodeKinds)),
    quality: record.quality,
    protocol: record.protocol,
    indexer: record.indexer,
    message: record.message,
  };
}

function publishHealthCheck(check: HealthCheck) {
  return {
    application: check.application,
    severity: check.severity,
    source: check.source,
    message: check.message,
  };
}

function publishCommand(command: CommandActivity) {
  return {
    application: command.application,
    id: String(command.context.commandId),
    name: command.name,
    status: command.status,
    queued: command.queued,
    started: command.started,
    ended: command.ended,
    trigger: command.trigger,
    message: command.message,
  };
}

function publishDisk(volume: DiskCondition) {
  return {
    application: volume.application,
    label: volume.label,
    freeBytes: volume.freeBytes,
    totalBytes: volume.totalBytes,
  };
}

/**
 * Publishes one view's payload.
 *
 * The switch is exhaustive over the service's closed view union, so a view
 * added there without a published shape fails to compile rather than reaching a
 * caller as a payload the declared output schema would reject.
 */
function publishViewData(
  data: ActivityViewData,
  references: ReferenceStore,
  media: MediaMinter,
): ActivityViewResult {
  switch (data.view) {
    case "queue_status":
      return { view: "queue_status", summary: data.summary };
    case "queue":
      return {
        view: "queue",
        items: data.items.map((item) => publishQueueItem(item, references, media)),
      };
    case "queue_details":
      return { view: "queue_details", item: publishQueueItem(data.item, references, media) };
    case "history":
      return {
        view: "history",
        items: data.items.map((record) => publishHistoryRecord(record, references, media)),
      };
    case "blocklist":
      return {
        view: "blocklist",
        items: data.items.map((record) => publishBlocklistRecord(record, references, media)),
      };
    case "health":
      return { view: "health", items: data.items.map(publishHealthCheck) };
    case "commands":
      return { view: "commands", items: data.items.map(publishCommand) };
    case "disk_space":
      return { view: "disk_space", items: data.items.map(publishDisk) };
    case "indexer_status":
      return {
        view: "indexer_status",
        items: data.items.map((status) => ({
          application: status.application,
          indexer: publishIndexer(status.indexer),
          disabledUntil: status.disabledUntil,
          initialFailure: status.initialFailure,
          mostRecentFailure: status.mostRecentFailure,
        })),
      };
    case "indexer_statistics":
      return {
        view: "indexer_statistics",
        items: data.items.map((statistic) => ({
          application: statistic.application,
          indexer: publishIndexer(statistic.indexer),
          queries: statistic.queries,
          grabs: statistic.grabs,
          rssQueries: statistic.rssQueries,
          authQueries: statistic.authQueries,
          failedQueries: statistic.failedQueries,
          failedGrabs: statistic.failedGrabs,
          failedRssQueries: statistic.failedRssQueries,
          failedAuthQueries: statistic.failedAuthQueries,
          averageResponseTimeMs: statistic.averageResponseTimeMs,
        })),
      };
  }
}

/**
 * The library record kind a media filter names on each application.
 *
 * A queue, history, or blocklist row is associated with the top-level record —
 * a Sonarr series or a Radarr movie — so an episode reference supplied as a
 * media filter is refused rather than sent as a series identifier.
 */
function mediaFilterKind(invocation: OperationInvocation): "series" | "movie" | undefined {
  if (invocation.application === "sonarr") {
    return "series";
  }
  return invocation.application === "radarr" ? "movie" : undefined;
}

/**
 * Turns one media reference back into the upstream identifier it stands for.
 *
 * The shared dispatcher already rejected a forged, expired, previous-lifetime,
 * or wrong-kind reference before any instance was probed. What is left is what
 * only this tool knows: that the reference names the kind of record this
 * application's activity rows are actually associated with.
 */
function resolveMediaId(invocation: OperationInvocation, token: string): Resolved<number> {
  const expected = mediaFilterKind(invocation);
  if (expected === undefined) {
    return {
      ok: false,
      error: invalid(invocation, "media does not name a record on this application"),
    };
  }

  const resolution = invocation.state.references.resolve(token, "media");
  if (!resolution.ok) {
    return {
      ok: false,
      error: toolErrorForReferenceFailure(resolution.reason, "media", invocation.application),
    };
  }

  const entry = resolution.entry;
  if (!entry.applications.includes(invocation.application)) {
    return { ok: false, error: invalid(invocation, "media names a different application") };
  }
  if (entry.payload.kind !== "domain" || entry.payload.snapshot.detail?.kind !== expected) {
    return { ok: false, error: invalid(invocation, `media must name a ${expected} record`) };
  }

  // Matched before it is converted, because `Number` answers several strings
  // that are not a plain identifier by quietly changing them — `""` becomes 0,
  // `" 12 "` becomes 12, `"0x0c"` becomes 12.
  const upstreamId = entry.payload.snapshot.upstreamId;
  const id = /^\d+$/u.test(upstreamId) ? Number(upstreamId) : Number.NaN;
  if (!Number.isSafeInteger(id)) {
    return { ok: false, error: invalid(invocation, "media does not name a single record") };
  }
  return { ok: true, value: id };
}

function resolveMediaIds(
  invocation: OperationInvocation,
  tokens: readonly string[] | undefined,
): Resolved<readonly number[] | undefined> {
  if (tokens === undefined) {
    return { ok: true, value: undefined };
  }
  const ids: number[] = [];
  for (const token of tokens) {
    const resolved = resolveMediaId(invocation, token);
    if (!resolved.ok) {
      return resolved;
    }
    ids.push(resolved.value);
  }
  return { ok: true, value: ids };
}

/**
 * Builds the adapter-facing request from validated tool arguments.
 *
 * The published input and the adapter request are deliberately different
 * shapes: this is the only place a caller's opaque reference becomes an
 * upstream identifier, and the switch is exhaustive over the published view
 * union so a new view cannot reach an adapter unmapped.
 */
function buildRequest(
  invocation: OperationInvocation,
  input: ActivityQueryInput,
): Resolved<ActivityQueryRequest> {
  const base = { detail: input.detail, paging: { pageSize: input.pageSize, cursor: input.cursor } };

  switch (input.view) {
    case "queue_status":
    case "health":
    case "commands":
    case "disk_space":
    case "indexer_status":
      return { ok: true, value: { ...base, view: input.view } };
    case "queue": {
      const ids = resolveMediaIds(invocation, input.media);
      return ids.ok ? { ok: true, value: { ...base, view: "queue", mediaIds: ids.value } } : ids;
    }
    case "queue_details": {
      if (!isMediaApplication(invocation.application)) {
        return { ok: false, error: invalid(invocation, "this application has no queue") };
      }
      // The reference carries the media association it was minted with, which
      // is what keeps the focused read bounded: the detail is fetched scoped to
      // that series or movie rather than by scanning the queue.
      const queue = resolveQueueReference(
        invocation.state.references,
        input.queue,
        invocation.application,
      );
      return queue.ok
        ? {
            ok: true,
            value: {
              ...base,
              view: "queue_details",
              queueItemId: queue.value.queueItemId,
              mediaId: queue.value.mediaId,
            },
          }
        : { ok: false, error: queue.error };
    }
    case "history": {
      const ids = resolveMediaIds(invocation, input.media);
      return ids.ok
        ? {
            ok: true,
            value: {
              ...base,
              view: "history",
              mediaIds: ids.value,
              since: input.since,
              until: input.until,
            },
          }
        : ids;
    }
    case "blocklist": {
      const ids = resolveMediaIds(invocation, input.media);
      return ids.ok
        ? {
            ok: true,
            value: {
              ...base,
              view: "blocklist",
              mediaIds: ids.value,
              since: input.since,
              until: input.until,
            },
          }
        : ids;
    }
    case "indexer_statistics":
      return {
        ok: true,
        value: { ...base, view: "indexer_statistics", since: input.since, until: input.until },
      };
  }
}

/**
 * Answers one bounded activity query for one application.
 *
 * The arguments are re-validated against the tool's own published schema rather
 * than cast, so the handler works on a value the contract vouches for whether
 * it arrived through the MCP transport or from an internal caller. One
 * application's failure never leaves this handler as anything but that
 * application's error; the dispatcher decides what the envelope says about it.
 */
export const activityQueryHandler: OperationHandler = async (invocation) => {
  const parsed = activityQueryInputSchema.safeParse(invocation.input);
  if (!parsed.success) {
    return {
      status: "error",
      error: invalid(invocation, "the arguments do not match the arr_activity_query input schema"),
    };
  }

  const request = buildRequest(invocation, parsed.data as ActivityQueryInput);
  if (!request.ok) {
    return { status: "error", error: request.error };
  }

  const outcome = await runActivityQuery(
    invocation.application,
    invocation.adapter.client,
    request.value,
  );
  if (outcome.status === "error") {
    return { status: "error", error: outcome.error };
  }

  const references = invocation.state.references;
  return {
    status: "ok",
    data: publishViewData(outcome.data, references, createMediaMinter(references)),
    continuation: outcome.continuation,
    warnings: outcome.warnings,
  };
};
