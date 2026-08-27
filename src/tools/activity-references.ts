import type {
  BlocklistRecord,
  HistoryRecord,
  QueueItem,
  QueueItemKind,
  QueueStatus,
  TrackedDownloadState,
} from "../adapters/activity/model.js";
import {
  queueItemKinds,
  queueStatuses,
  trackedDownloadStates,
} from "../adapters/activity/model.js";
import type { MediaApplication } from "../adapters/library/model.js";
import { queryDigest } from "../adapters/library/paging.js";
import type { ApplicationId } from "../applications.js";
import type { ReferenceStore } from "../state/references.js";
import { createToolError, type ToolError, toolErrorForReferenceFailure } from "./errors.js";
import type { ReferenceKind } from "./schemas/common.js";

/**
 * The opaque references activity records are named by.
 *
 * A queue row, a history record, and a blocklist record are the three things a
 * later change acts on — change 0006 resolves a queue item into one upstream
 * flag combination, change 0010 fails a history record or re-allows a blocked
 * release — and none of them may be named to a caller by its upstream
 * identifier. This module is the only place that identity becomes a token and
 * the only place a token becomes an identity again.
 *
 * Two properties hold for every reference minted here.
 *
 * It is **opaque**: the token is random, carries nothing but a kind prefix and
 * this process's lifetime segment, and is resolved by lookup rather than by
 * decoding. Nothing about the object it stands for can be read out of it or
 * guessed into existence, so a caller can neither forge a reference for a row
 * this server never returned nor learn an upstream identifier from one it did.
 *
 * And it **retains what a later transition needs and nothing more**. A queue
 * reference carries the item kind, the row's status, its tracked state, and the
 * media record it is associated with — the evidence change 0006's state machine
 * branches on. It deliberately carries no download-client identifier and no
 * canonical path: those are the two things the readers refuse to map, and a
 * reference that smuggled them back would defeat that at the last step.
 */

/** What a resolved queue reference tells a later transition. */
export interface QueueReferenceContext {
  readonly application: MediaApplication;
  readonly queueItemId: number;
  /**
   * Whether the row is a tracked download-client item or a pending delayed or
   * fallback release. The two accept disjoint sets of resolution intents, and
   * this is what lets change 0006 reject an intent before any upstream request
   * rather than discovering the mismatch from an upstream error.
   */
  readonly itemKind: QueueItemKind;
  readonly status: QueueStatus;
  readonly trackedState?: TrackedDownloadState | undefined;
  /** The series or movie the row is associated with, where upstream named one. */
  readonly mediaId?: number | undefined;
}

export interface HistoryReferenceContext {
  readonly application: ApplicationId;
  readonly historyRecordId: number;
}

export interface BlocklistReferenceContext {
  readonly application: MediaApplication;
  readonly blocklistRecordId: number;
}

export type ReferenceResolved<TValue> =
  | { readonly ok: true; readonly value: TValue }
  | { readonly ok: false; readonly error: ToolError };

/**
 * The discriminant stored beside each snapshot.
 *
 * The token prefix already separates the kinds, and the store already refuses a
 * token whose stored kind differs from the one asked for. This is the third
 * check, and it is the one that catches a bug rather than a caller: a reference
 * minted with the right prefix but the wrong payload shape — by a future change
 * reusing this module carelessly — is rejected instead of being read as a
 * record it is not.
 */
const detailKinds = {
  queue: "queue_item",
  history: "history_record",
  blocklist: "blocklist_record",
} as const;

/**
 * Digests one queue row's identity and the state a later transition depends on.
 *
 * The parts are listed here in a fixed, code-authored order, and every one of
 * them is a value this server derived — never upstream free text, whose
 * sanitization would otherwise decide whether two reads of the same row
 * fingerprint alike. Progress is excluded for the same reason it would be
 * useless: a download whose remaining bytes changed is the same queue row, and
 * a fingerprint that moved every second would make every plan stale.
 */
function queueFingerprint(item: QueueItem): string {
  return queryDigest([
    item.application,
    item.context.queueItemId,
    item.kind,
    item.evidence.status,
    item.evidence.trackedStatus,
    item.evidence.trackedState,
    item.context.mediaId,
  ]);
}

function historyFingerprint(record: HistoryRecord): string {
  return queryDigest([
    record.application,
    record.context.historyRecordId,
    record.eventType,
    record.date,
    record.successful,
  ]);
}

function blocklistFingerprint(record: BlocklistRecord): string {
  return queryDigest([
    record.application,
    record.context.blocklistRecordId,
    record.date,
    record.protocol,
  ]);
}

/**
 * Mints the reference one queue row is named by.
 *
 * The retained detail is assembled here rather than copied from the row, so
 * what a reference carries is a decision made in one place instead of whatever
 * the mapped model happened to hold. `origin`, which is where the salted
 * download digest lives, is not among it.
 */
export function mintQueueReference(references: ReferenceStore, item: QueueItem): string {
  return references.mint({
    kind: "queue",
    applications: [item.application],
    payload: () => ({
      kind: "domain",
      snapshot: {
        upstreamId: String(item.context.queueItemId),
        fingerprint: queueFingerprint(item),
        detail: {
          kind: detailKinds.queue,
          itemKind: item.kind,
          status: item.evidence.status,
          trackedState: item.evidence.trackedState,
          mediaId: item.context.mediaId,
        },
      },
    }),
  }).reference;
}

export function mintHistoryReference(references: ReferenceStore, record: HistoryRecord): string {
  return references.mint({
    kind: "history",
    applications: [record.application],
    payload: () => ({
      kind: "domain",
      snapshot: {
        upstreamId: String(record.context.historyRecordId),
        fingerprint: historyFingerprint(record),
        detail: { kind: detailKinds.history, eventType: record.eventType },
      },
    }),
  }).reference;
}

export function mintBlocklistReference(
  references: ReferenceStore,
  record: BlocklistRecord,
): string {
  return references.mint({
    kind: "blocklist",
    applications: [record.application],
    payload: () => ({
      kind: "domain",
      snapshot: {
        upstreamId: String(record.context.blocklistRecordId),
        fingerprint: blocklistFingerprint(record),
        detail: { kind: detailKinds.blocklist },
      },
    }),
  }).reference;
}

function invalid(application: ApplicationId, message: string): ToolError {
  return createToolError({
    code: "invalid_input",
    message: `${application}: ${message}`,
    application,
  });
}

interface ResolveOptions {
  readonly kind: ReferenceKind;
  readonly detailKind: string;
  /** The input property the reference arrived in, for the caller's message. */
  readonly property: string;
}

/**
 * The checks every activity reference has to pass before it names anything.
 *
 * They run in a deliberate order: the store first, because a forged, expired,
 * previous-lifetime, or wrong-kind token must be refused without this module
 * looking at anything; then the application binding, so a reference minted
 * against Sonarr cannot be applied to Radarr; then the payload shape; then the
 * identifier itself. Every one of them happens before any upstream request.
 */
function resolveRecord(
  references: ReferenceStore,
  token: string,
  application: ApplicationId,
  options: ResolveOptions,
): ReferenceResolved<{ id: number; detail: Readonly<Record<string, unknown>> }> {
  const resolution = references.resolve(token, options.kind);
  if (!resolution.ok) {
    return {
      ok: false,
      error: toolErrorForReferenceFailure(resolution.reason, options.kind, application),
    };
  }

  const entry = resolution.entry;
  if (!entry.applications.includes(application)) {
    return {
      ok: false,
      error: invalid(application, `${options.property} names a different application`),
    };
  }

  const payload = entry.payload;
  if (payload.kind !== "domain" || payload.snapshot.detail?.kind !== options.detailKind) {
    return {
      ok: false,
      error: invalid(application, `${options.property} does not name an activity record`),
    };
  }

  // Matched before it is converted, for the reason the library resolver already
  // records: `Number` quietly answers several strings that are not a plain
  // identifier — `""` becomes 0, `" 12 "` becomes 12, `"0x0c"` becomes 12.
  const upstreamId = payload.snapshot.upstreamId;
  const id = /^\d+$/u.test(upstreamId) ? Number(upstreamId) : Number.NaN;
  if (!Number.isSafeInteger(id)) {
    return {
      ok: false,
      error: invalid(application, `${options.property} does not name a single record`),
    };
  }
  return { ok: true, value: { id, detail: payload.snapshot.detail } };
}

/**
 * A field read back out of a stored snapshot.
 *
 * The three answers are kept apart because collapsing them is how corruption
 * becomes silence. A field this module never wrote is legitimately `absent`; a
 * field it wrote is `present`; and a field holding something it would never
 * have written is `invalid` — and that last one has to be refused rather than
 * coerced, or a later transition would be handed a plausible-looking state that
 * nothing vouches for. Defaulting a malformed status to `unknown` would do
 * exactly that.
 */
type StoredField<TValue> =
  | { readonly state: "present"; readonly value: TValue }
  | { readonly state: "absent" }
  | { readonly state: "invalid" };

function storedWord<TWord extends string>(
  value: unknown,
  allowed: readonly TWord[],
): StoredField<TWord> {
  if (value === undefined || value === null) {
    return { state: "absent" };
  }
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? { state: "present", value: value as TWord }
    : { state: "invalid" };
}

function storedId(value: unknown): StoredField<number> {
  if (value === undefined || value === null) {
    return { state: "absent" };
  }
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? { state: "present", value }
    : { state: "invalid" };
}

export interface QueueResolveOptions {
  /**
   * The item kind the caller's intent is valid for.
   *
   * Change 0006's intents are split by kind — five apply only to a tracked
   * download-client item and three only to a pending release — and this is what
   * lets it refuse a mismatch here, before anything is sent upstream, rather
   * than after an upstream error that would be harder to explain.
   */
  readonly requireKind?: QueueItemKind | undefined;
  readonly property?: string | undefined;
}

/**
 * Turns one queue reference back into the context a transition needs.
 *
 * A reference whose stored item kind is not the one the caller requires is
 * refused with a message naming both, because that is the distinction a caller
 * has to act on: it asked for something only a pending release accepts, and the
 * reference names a tracked download, or the other way round.
 */
export function resolveQueueReference(
  references: ReferenceStore,
  token: string,
  application: MediaApplication,
  options: QueueResolveOptions = {},
): ReferenceResolved<QueueReferenceContext> {
  const property = options.property ?? "queue";
  const record = resolveRecord(references, token, application, {
    kind: "queue",
    detailKind: detailKinds.queue,
    property,
  });
  if (!record.ok) {
    return record;
  }

  const detail = record.value.detail;
  const itemKind = storedWord(detail.itemKind, queueItemKinds);
  const status = storedWord(detail.status, queueStatuses);
  const trackedState = storedWord(detail.trackedState, trackedDownloadStates);
  const mediaId = storedId(detail.mediaId);

  // The item kind and the status are always written, so absent is as wrong as
  // malformed for those two. A tracked state and a media association are not: a
  // pending release has no tracked state, and upstream does not always
  // associate a row with a media record.
  const corrupt =
    itemKind.state !== "present" ||
    status.state !== "present" ||
    trackedState.state === "invalid" ||
    mediaId.state === "invalid";
  if (corrupt) {
    return { ok: false, error: invalid(application, `${property} does not name a queue item`) };
  }

  if (options.requireKind !== undefined && itemKind.value !== options.requireKind) {
    return {
      ok: false,
      error: invalid(
        application,
        `${property} names a ${describeKind(itemKind.value)}, and that is only valid for a ${describeKind(options.requireKind)}`,
      ),
    };
  }

  return {
    ok: true,
    value: {
      application,
      queueItemId: record.value.id,
      itemKind: itemKind.value,
      status: status.value,
      trackedState: trackedState.state === "present" ? trackedState.value : undefined,
      mediaId: mediaId.state === "present" ? mediaId.value : undefined,
    },
  };
}

function describeKind(kind: QueueItemKind): string {
  return kind === "tracked_download" ? "tracked download" : "pending release";
}

export function resolveHistoryReference(
  references: ReferenceStore,
  token: string,
  application: ApplicationId,
  property = "records",
): ReferenceResolved<HistoryReferenceContext> {
  const record = resolveRecord(references, token, application, {
    kind: "history",
    detailKind: detailKinds.history,
    property,
  });
  return record.ok
    ? { ok: true, value: { application, historyRecordId: record.value.id } }
    : record;
}

export function resolveBlocklistReference(
  references: ReferenceStore,
  token: string,
  application: MediaApplication,
  property = "records",
): ReferenceResolved<BlocklistReferenceContext> {
  const record = resolveRecord(references, token, application, {
    kind: "blocklist",
    detailKind: detailKinds.blocklist,
    property,
  });
  return record.ok
    ? { ok: true, value: { application, blocklistRecordId: record.value.id } }
    : record;
}
