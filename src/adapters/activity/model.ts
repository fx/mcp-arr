import type { ApplicationId } from "../../applications.js";
import type { MediaApplication, MediaRef } from "../library/model.js";

/**
 * The normalized activity model.
 *
 * Three rules hold everywhere in this file, and they are what later changes
 * depend on. Every enumerated upstream word is narrowed to a closed set here,
 * because change 0006 compiles a queue intent from the item's kind and tracked
 * state and a state machine cannot branch on an open string. Every identity a
 * follow-up action needs is carried in a `context` record that the tool layer
 * mints an opaque reference from, so no upstream identifier ever has to reach a
 * caller. And nothing here has a field for a canonical filesystem path, a
 * download URL, or a download-client identifier: {@link QueueOrigin} carries a
 * salted digest of the last of those and no field at all for the first two.
 *
 * Optional properties are declared as `?: T | undefined` rather than omitted,
 * for the same reason the library model does it: a mapping reads an upstream
 * field that may legitimately be absent, and an absent value disappears when
 * the envelope is serialized.
 */

/**
 * What a queue row actually is.
 *
 * Sonarr and Radarr return tracked download-client items and pending delayed or
 * fallback releases through the same endpoint, and the two accept disjoint sets
 * of resolution intents. Deciding which one a row is happens once, here, so
 * change 0006 validates an intent against a discriminant rather than
 * re-deriving it from a status word.
 */
export const queueItemKinds = ["tracked_download", "pending_release"] as const;

export type QueueItemKind = (typeof queueItemKinds)[number];

/**
 * The queue row's own status.
 *
 * `delay` and `fallback` are the two upstream statuses that mark a pending
 * release rather than a tracked download, which is what {@link QueueItemKind}
 * is derived from. An upstream word this server does not know becomes
 * `unknown` instead of widening the set.
 */
export const queueStatuses = [
  "unknown",
  "queued",
  "paused",
  "downloading",
  "completed",
  "failed",
  "warning",
  "delay",
  "download_client_unavailable",
  "fallback",
] as const;

export type QueueStatus = (typeof queueStatuses)[number];

/** Whether the application is happy with the tracked download. */
export const trackedDownloadStatuses = ["ok", "warning", "error", "unknown"] as const;

export type TrackedDownloadStatus = (typeof trackedDownloadStatuses)[number];

/**
 * Where the tracked download is in its import lifecycle. This is the field a
 * blocked import is diagnosed from, so every state the applications report is
 * named rather than collapsed.
 */
export const trackedDownloadStates = [
  "unknown",
  "downloading",
  "import_blocked",
  "import_pending",
  "importing",
  "imported",
  "failed_pending",
  "failed",
  "ignored",
] as const;

export type TrackedDownloadState = (typeof trackedDownloadStates)[number];

/**
 * One group of upstream status messages.
 *
 * The title and the messages are upstream text this server did not author, so
 * both have been through the sanitizer: paths, URLs, and opaque identifiers are
 * redacted, control and bidirectional-formatting characters are removed, and
 * the length is bounded. What survives is evidence a caller can read, not a
 * payload it can be steered by.
 */
export interface QueueStatusMessage {
  readonly title?: string | undefined;
  readonly messages: readonly string[];
}

/** Everything a later decision reasons over, and nothing a caller acts through. */
export interface QueueEvidence {
  readonly status: QueueStatus;
  readonly trackedStatus?: TrackedDownloadStatus | undefined;
  readonly trackedState?: TrackedDownloadState | undefined;
  readonly statusMessages: readonly QueueStatusMessage[];
  readonly errorMessage?: string | undefined;
}

export interface QueueProgress {
  readonly sizeBytes?: number | undefined;
  readonly remainingBytes?: number | undefined;
  readonly timeLeft?: string | undefined;
  readonly estimatedCompletionTime?: string | undefined;
  readonly added?: string | undefined;
}

/**
 * Where the item came from.
 *
 * `downloadIdentity` is a process-salted digest of the download-client
 * identifier, never the identifier itself: two rows that name the same download
 * — a queue item and the history record for it — digest alike, which is the
 * correlation diagnosis needs, while the hash the client uses stays inside this
 * process.
 */
export interface QueueOrigin {
  readonly protocol?: string | undefined;
  readonly indexer?: string | undefined;
  readonly downloadClient?: string | undefined;
  readonly downloadIdentity?: string | undefined;
}

/**
 * The adapter context one queue row's opaque reference is minted from.
 *
 * `mediaId` is retained because it is what keeps a later focused read bounded:
 * queue details for an item with a media association are fetched scoped to that
 * series or movie rather than by scanning the queue.
 */
export interface QueueItemContext {
  readonly application: MediaApplication;
  readonly kind: QueueItemKind;
  readonly queueItemId: number;
  readonly mediaId?: number | undefined;
}

/**
 * One queue row.
 *
 * `media` names the series or movie and `episode` the episode, both as the same
 * application-qualified {@link MediaRef} the library model uses, so a queue row
 * and a library record are joined by identity rather than by title.
 */
export interface QueueItem {
  readonly application: MediaApplication;
  readonly kind: QueueItemKind;
  readonly context: QueueItemContext;
  readonly title: string;
  readonly media?: MediaRef | undefined;
  readonly episode?: MediaRef | undefined;
  readonly quality?: string | undefined;
  readonly evidence: QueueEvidence;
  readonly progress?: QueueProgress | undefined;
  readonly origin?: QueueOrigin | undefined;
  /** Populated at `full` detail only. */
  readonly languages?: readonly string[] | undefined;
}

/**
 * The queue's own counters.
 *
 * Every member is required because `queue/status` always reports all of them;
 * an instance that omits one is an unexpected response rather than a summary
 * with a hole in it.
 */
export interface QueueSummary {
  readonly application: MediaApplication;
  readonly totalCount: number;
  readonly count: number;
  readonly unknownCount: number;
  readonly errors: boolean;
  readonly warnings: boolean;
  readonly unknownErrors: boolean;
  readonly unknownWarnings: boolean;
}

/**
 * The history events this server names.
 *
 * The list is the union of what Sonarr, Radarr, and Prowlarr report, mapped
 * from their camel-cased upstream words. It is closed for the same reason the
 * queue statuses are: an event type decides which typed follow-up intent
 * applies, and an unrecognized word becomes `unknown`.
 */
export const historyEventTypes = [
  "unknown",
  "grabbed",
  "series_folder_imported",
  "download_folder_imported",
  "download_failed",
  "download_ignored",
  "episode_file_deleted",
  "episode_file_renamed",
  "movie_file_deleted",
  "movie_file_renamed",
  "release_grabbed",
  "indexer_query",
  "indexer_rss",
  "indexer_auth",
] as const;

export type HistoryEventType = (typeof historyEventTypes)[number];

/**
 * The allowlisted members of an upstream history `data` bag.
 *
 * Upstream fills that bag with whatever the event produced, including download
 * URLs, dropped and imported canonical paths, and torrent info hashes. It is
 * therefore never copied: each member below is read by name, and a field a
 * newer release adds is dropped until it is named here deliberately.
 */
export interface HistoryData {
  readonly reason?: string | undefined;
  readonly indexer?: string | undefined;
  readonly releaseGroup?: string | undefined;
  readonly sizeBytes?: number | undefined;
  readonly publishedDate?: string | undefined;
  readonly protocol?: string | undefined;
  readonly downloadClient?: string | undefined;
  readonly message?: string | undefined;
  /** Prowlarr query aggregates; never the query text, caller host, or agent. */
  readonly queryType?: string | undefined;
  readonly queryResults?: number | undefined;
  readonly elapsedTimeMs?: number | undefined;
}

export interface HistoryRecordContext {
  readonly application: ApplicationId;
  readonly historyRecordId: number;
}

export interface HistoryRecord {
  readonly application: ApplicationId;
  readonly context: HistoryRecordContext;
  readonly eventType: HistoryEventType;
  readonly date?: string | undefined;
  readonly title?: string | undefined;
  readonly media?: MediaRef | undefined;
  readonly episode?: MediaRef | undefined;
  readonly quality?: string | undefined;
  readonly indexer?: IndexerRef | undefined;
  readonly downloadIdentity?: string | undefined;
  readonly successful?: boolean | undefined;
  /** Populated at `full` detail only. */
  readonly data?: HistoryData | undefined;
}

export interface BlocklistRecordContext {
  readonly application: MediaApplication;
  readonly blocklistRecordId: number;
}

/**
 * One blocked release. Removing such a record re-allows the release; it deletes
 * no media and no download, which is why the record names neither.
 *
 * `episodes` is a list where a queue row has one `episode`, because that is the
 * shape upstream reports: a season pack is blocked as a single record naming
 * every episode it covered, and keeping only the first would understate what
 * re-allowing it would bring back.
 */
export interface BlocklistRecord {
  readonly application: MediaApplication;
  readonly context: BlocklistRecordContext;
  readonly title?: string | undefined;
  readonly date?: string | undefined;
  readonly media?: MediaRef | undefined;
  readonly episodes?: readonly MediaRef[] | undefined;
  readonly quality?: string | undefined;
  readonly protocol?: string | undefined;
  readonly indexer?: string | undefined;
  readonly message?: string | undefined;
}

export const healthSeverities = ["ok", "notice", "warning", "error", "unknown"] as const;

export type HealthSeverity = (typeof healthSeverities)[number];

/**
 * One health check. The upstream wiki link is deliberately not mapped: it is an
 * outbound URL, and the check's source and message already say what is wrong.
 */
export interface HealthCheck {
  readonly application: ApplicationId;
  readonly severity: HealthSeverity;
  readonly source?: string | undefined;
  readonly message: string;
}

export const commandStatuses = [
  "unknown",
  "queued",
  "started",
  "completed",
  "failed",
  "aborted",
  "cancelled",
  "orphaned",
] as const;

export type CommandStatus = (typeof commandStatuses)[number];

export interface CommandContext {
  readonly application: ApplicationId;
  readonly commandId: number;
}

/**
 * One upstream command, read only. Nothing in this module starts one: only the
 * allowlisted semantic workflows of later changes create commands.
 */
export interface CommandActivity {
  readonly application: ApplicationId;
  readonly context: CommandContext;
  readonly name: string;
  readonly status: CommandStatus;
  readonly queued?: string | undefined;
  readonly started?: string | undefined;
  readonly ended?: string | undefined;
  readonly trigger?: string | undefined;
  readonly message?: string | undefined;
}

/**
 * One volume's free space.
 *
 * The mount's canonical path is not mapped. The upstream label names the volume
 * well enough to act on, and where an instance reports no label the path's last
 * segment stands in — a name, not a location on the operator's disk.
 */
export interface DiskCondition {
  readonly application: MediaApplication;
  readonly label?: string | undefined;
  readonly freeBytes?: number | undefined;
  readonly totalBytes?: number | undefined;
}

/** A Prowlarr indexer, named by the identifier its own records key on. */
export interface IndexerRef {
  readonly application: ApplicationId;
  readonly indexerId: number;
  readonly name?: string | undefined;
}
