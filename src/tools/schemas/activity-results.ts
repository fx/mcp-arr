import { z } from "zod";
import {
  commandStatuses,
  healthSeverities,
  historyEventTypes,
  queueItemKinds,
  queueStatuses,
  trackedDownloadStates,
  trackedDownloadStatuses,
} from "../../adapters/activity/model.js";
import {
  applicationIdSchema,
  blocklistReferenceSchema,
  historyReferenceSchema,
  mediaApplicationSchema,
  queueReferenceSchema,
} from "./common.js";
import { mediaIdentitySchema } from "./library-results.js";

/**
 * The published shapes `arr_activity_query` returns.
 *
 * They mirror the normalized activity model rather than any upstream payload,
 * with the same deliberate difference the library results already make: an
 * upstream identity becomes an opaque process-local reference plus the
 * application's own identifier, so a caller can act through the first and line
 * a row up against the application's own interface with the second.
 *
 * Two things this contract does not have a field for, and that is the point.
 * There is no canonical filesystem path anywhere in it, and no download-client
 * identifier — {@link queueOriginSchema} carries a salted digest that
 * correlates two rows describing one download and discloses nothing about which
 * download that is. A reader that started mapping either would have nowhere to
 * put it.
 *
 * Every enumerated value is drawn from the adapter model's own closed set, so a
 * status the adapter narrows and a status this schema admits cannot drift
 * apart. Structure is strict and unions are discriminated; individual values
 * are otherwise unconstrained, because the envelope is validated before it
 * leaves the process and a needlessly narrow bound would replace a real result
 * with a generic failure.
 */

const queueStatusMessageSchema = z.strictObject({
  title: z.string().optional(),
  messages: z.array(z.string()),
});

/**
 * What a later decision reasons over.
 *
 * Status messages arrive here already sanitized: paths, URLs, and opaque
 * identifiers redacted, format and control characters removed, length and count
 * bounded. They are evidence a caller reads, not a payload it can be steered
 * by.
 */
const queueEvidenceSchema = z.strictObject({
  status: z.enum(queueStatuses),
  trackedStatus: z.enum(trackedDownloadStatuses).optional(),
  trackedState: z.enum(trackedDownloadStates).optional(),
  statusMessages: z.array(queueStatusMessageSchema),
  errorMessage: z.string().optional(),
});

const queueProgressSchema = z.strictObject({
  sizeBytes: z.number().optional(),
  remainingBytes: z.number().optional(),
  timeLeft: z.string().optional(),
  estimatedCompletionTime: z.string().optional(),
  added: z.string().optional(),
});

/**
 * Where a row came from.
 *
 * `downloadIdentity` is a process-salted digest, never the download client's
 * own identifier. Two rows that name the same download agree on it — which is
 * how a queue item and the history record that grabbed it are correlated —
 * while the identifier itself never leaves the adapter.
 */
const queueOriginSchema = z.strictObject({
  protocol: z.string().optional(),
  indexer: z.string().optional(),
  downloadClient: z.string().optional(),
  downloadIdentity: z.string().optional(),
});

export const activityQueueItemSchema = z.strictObject({
  /** The opaque reference `arr_queue_resolve` accepts for this row. */
  reference: queueReferenceSchema,
  /** The application's own identifier, for correlating with its interface. */
  id: z.string(),
  application: mediaApplicationSchema,
  /**
   * Whether this is a tracked download-client item or a pending delayed or
   * fallback release. The two accept disjoint sets of resolution intents.
   */
  kind: z.enum(queueItemKinds),
  title: z.string(),
  media: mediaIdentitySchema.optional(),
  episode: mediaIdentitySchema.optional(),
  quality: z.string().optional(),
  evidence: queueEvidenceSchema,
  progress: queueProgressSchema.optional(),
  origin: queueOriginSchema.optional(),
  /** Present at `full` detail only. */
  languages: z.array(z.string()).optional(),
});

export type ActivityQueueItem = z.infer<typeof activityQueueItemSchema>;

export const activityQueueSummarySchema = z.strictObject({
  application: mediaApplicationSchema,
  totalCount: z.number(),
  count: z.number(),
  unknownCount: z.number(),
  errors: z.boolean(),
  warnings: z.boolean(),
  unknownErrors: z.boolean(),
  unknownWarnings: z.boolean(),
});

/**
 * A Prowlarr indexer, named by the identifier its own records key on.
 *
 * The application is the literal and not the wider identifier union, because
 * only Prowlarr models an indexer as a record: Sonarr and Radarr name theirs by
 * label alone, and those labels are published as the plain strings they are.
 * The three views that carry this shape — Prowlarr history, indexer status, and
 * indexer statistics — are Prowlarr's alone, so a wider field would advertise a
 * value no result can hold.
 */
const indexerIdentitySchema = z.strictObject({
  application: z.literal("prowlarr"),
  indexerId: z.number(),
  name: z.string().optional(),
});

/**
 * The allowlisted members of an upstream history `data` bag.
 *
 * Upstream fills that bag with whatever the event produced, including download
 * URLs, dropped and imported canonical paths, and torrent info hashes. None of
 * those is read, and none has a field here.
 */
const historyDataSchema = z.strictObject({
  reason: z.string().optional(),
  indexer: z.string().optional(),
  releaseGroup: z.string().optional(),
  sizeBytes: z.number().optional(),
  publishedDate: z.string().optional(),
  protocol: z.string().optional(),
  downloadClient: z.string().optional(),
  message: z.string().optional(),
  queryType: z.string().optional(),
  queryResults: z.number().optional(),
  elapsedTimeMs: z.number().optional(),
});

export const activityHistoryRecordSchema = z.strictObject({
  /** The opaque reference `arr_activity_change` accepts for this record. */
  reference: historyReferenceSchema,
  id: z.string(),
  application: applicationIdSchema,
  eventType: z.enum(historyEventTypes),
  date: z.string().optional(),
  title: z.string().optional(),
  media: mediaIdentitySchema.optional(),
  episode: mediaIdentitySchema.optional(),
  quality: z.string().optional(),
  indexer: indexerIdentitySchema.optional(),
  downloadIdentity: z.string().optional(),
  successful: z.boolean().optional(),
  /** Present at `full` detail only. */
  data: historyDataSchema.optional(),
});

export type ActivityHistoryRecord = z.infer<typeof activityHistoryRecordSchema>;

/**
 * One blocked release. Removing such a record re-allows the release; it deletes
 * no media and no download, which is why the record names neither.
 */
export const activityBlocklistRecordSchema = z.strictObject({
  reference: blocklistReferenceSchema,
  id: z.string(),
  application: mediaApplicationSchema,
  title: z.string().optional(),
  date: z.string().optional(),
  media: mediaIdentitySchema.optional(),
  /**
   * Every episode the record names. It is a list where a queue row has one,
   * because a season pack is blocked as a single record covering all of them.
   */
  episodes: z.array(mediaIdentitySchema).optional(),
  quality: z.string().optional(),
  protocol: z.string().optional(),
  indexer: z.string().optional(),
  message: z.string().optional(),
});

export type ActivityBlocklistRecord = z.infer<typeof activityBlocklistRecordSchema>;

/** One health check. The upstream wiki link is deliberately not published. */
export const activityHealthCheckSchema = z.strictObject({
  application: applicationIdSchema,
  severity: z.enum(healthSeverities),
  source: z.string().optional(),
  message: z.string(),
});

/**
 * One upstream command, read only. Nothing on this tool starts one: creating a
 * command is owned by the allowlisted semantic workflows of later changes.
 */
export const activityCommandSchema = z.strictObject({
  application: applicationIdSchema,
  id: z.string(),
  name: z.string(),
  status: z.enum(commandStatuses),
  queued: z.string().optional(),
  started: z.string().optional(),
  ended: z.string().optional(),
  trigger: z.string().optional(),
  message: z.string().optional(),
});

/**
 * One volume's free space. The mount's canonical path is not published; the
 * upstream label names the volume, and where an instance reports none the
 * path's last segment stands in — a name, not a location on the operator's
 * disk.
 */
export const activityDiskConditionSchema = z.strictObject({
  application: mediaApplicationSchema,
  label: z.string().optional(),
  freeBytes: z.number().optional(),
  totalBytes: z.number().optional(),
});

export const activityIndexerStatusSchema = z.strictObject({
  application: z.literal("prowlarr"),
  indexer: indexerIdentitySchema,
  disabledUntil: z.string().optional(),
  initialFailure: z.string().optional(),
  mostRecentFailure: z.string().optional(),
});

/**
 * One indexer's performance aggregate.
 *
 * Upstream also breaks the same counters down by the address that made each
 * request and by the client that made it. Neither is read by the adapter, and
 * neither has a field here — publishing one would take a deliberate edit in
 * both places.
 */
export const activityIndexerStatisticSchema = z.strictObject({
  application: z.literal("prowlarr"),
  indexer: indexerIdentitySchema,
  queries: z.number().optional(),
  grabs: z.number().optional(),
  rssQueries: z.number().optional(),
  authQueries: z.number().optional(),
  failedQueries: z.number().optional(),
  failedGrabs: z.number().optional(),
  failedRssQueries: z.number().optional(),
  failedAuthQueries: z.number().optional(),
  averageResponseTimeMs: z.number().optional(),
});

/**
 * What one view answers with, discriminated by the view the caller asked for.
 *
 * Each view declares the shape it can actually return, not the widest one it
 * belongs to — the whole point of validating the envelope before it leaves the
 * process. Two views deliberately answer with something other than a list: the
 * queue's counters are a single summary, and a focused queue read is exactly
 * one row. The members mirror the adapter service's own view union one for one,
 * so a view added there without a published shape fails to compile rather than
 * being rejected at runtime.
 */
export const activityViewResultSchema = z.discriminatedUnion("view", [
  z.strictObject({ view: z.literal("queue_status"), summary: activityQueueSummarySchema }),
  z.strictObject({ view: z.literal("queue"), items: z.array(activityQueueItemSchema) }),
  z.strictObject({ view: z.literal("queue_details"), item: activityQueueItemSchema }),
  z.strictObject({ view: z.literal("history"), items: z.array(activityHistoryRecordSchema) }),
  z.strictObject({ view: z.literal("blocklist"), items: z.array(activityBlocklistRecordSchema) }),
  z.strictObject({ view: z.literal("health"), items: z.array(activityHealthCheckSchema) }),
  z.strictObject({ view: z.literal("commands"), items: z.array(activityCommandSchema) }),
  z.strictObject({ view: z.literal("disk_space"), items: z.array(activityDiskConditionSchema) }),
  z.strictObject({
    view: z.literal("indexer_status"),
    items: z.array(activityIndexerStatusSchema),
  }),
  z.strictObject({
    view: z.literal("indexer_statistics"),
    items: z.array(activityIndexerStatisticSchema),
  }),
]);

export type ActivityViewResult = z.infer<typeof activityViewResultSchema>;
