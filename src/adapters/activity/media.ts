import { z } from "zod";
import type { UpstreamClient, UpstreamQuery } from "../../http/client.js";
import type { MediaApplication, MediaRef } from "../library/model.js";
import { mediaRef } from "../library/model.js";
import {
  type AdapterPage,
  type PageWindow,
  pageNumberFor,
  projectPage,
} from "../library/paging.js";
import {
  count,
  flag,
  languageList,
  languageNames,
  optionalUpstreamId,
  pagedEnvelope,
  present,
  upstreamId,
  upstreamNumber,
  upstreamText,
} from "../library/parse.js";
import type { DetailLevel } from "../library/requests.js";
import type {
  BlocklistRecord,
  DiskCondition,
  HistoryRecord,
  QueueItem,
  QueueItemKind,
  QueueStatusMessage,
  QueueSummary,
} from "./model.js";
import { queueStatuses, trackedDownloadStates, trackedDownloadStatuses } from "./model.js";
import {
  closedWord,
  downloadIdentity,
  maxTitleLength,
  optionalClosedWord,
  parseActivity,
  qualityName,
  qualitySchema,
  safeLabel,
  safeText,
} from "./parse.js";
import { type ActivityRequestFor, withinWindow } from "./requests.js";
import {
  filteredUpstreamPage,
  type HistoryUpstream,
  historyEventType,
  mediaHistoryData,
  readHistory,
} from "./shared.js";

/**
 * The Sonarr and Radarr activity read adapters.
 *
 * The two applications answer these routes with the same payload shape and
 * differ only in which media record a row is associated with — a series and an
 * episode on Sonarr, a movie on Radarr — and in the names of the include flags
 * their queue endpoint accepts. So the schemas and the readers are written once
 * and the differences are supplied by a {@link MediaProfile}, rather than
 * duplicating every mapping twice with two field names changed.
 *
 * Every route here is a GET. No queue mutation, blocklist removal, or command
 * creation is reachable from this module: those are changes 0006 and 0010.
 */

export const mediaRoutes = {
  queue: "queue",
  queueStatus: "queue/status",
  queueDetails: "queue/details",
  blocklist: "blocklist",
  diskSpace: "diskspace",
  historySeries: "history/series",
  historyMovie: "history/movie",
} as const;

/** How one application names the things the shared payloads have in common. */
export interface MediaProfile {
  readonly application: MediaApplication;
  /** Extra include flags the queue and queue-detail endpoints accept. */
  readonly queueInclude: UpstreamQuery;
  /** The route and parameter that answer one media record's history. */
  readonly history: { readonly route: string; readonly parameter: string };
  readonly detailParameter: string;
}

export const sonarrProfile: MediaProfile = {
  application: "sonarr",
  queueInclude: { includeUnknownSeriesItems: true, includeSeries: true, includeEpisode: true },
  history: { route: mediaRoutes.historySeries, parameter: "seriesId" },
  detailParameter: "seriesId",
};

export const radarrProfile: MediaProfile = {
  application: "radarr",
  queueInclude: { includeUnknownMovieItems: true, includeMovie: true },
  history: { route: mediaRoutes.historyMovie, parameter: "movieId" },
  detailParameter: "movieId",
};

export function profileFor(application: MediaApplication): MediaProfile {
  return application === "sonarr" ? sonarrProfile : radarrProfile;
}

const statusMessageSchema = z.object({
  title: upstreamText,
  messages: z.array(z.string()).nullish(),
});

const queueRecordSchema = z.object({
  id: upstreamId,
  title: upstreamText,
  status: upstreamText,
  trackedDownloadStatus: upstreamText,
  trackedDownloadState: upstreamText,
  statusMessages: z.array(statusMessageSchema).nullish(),
  errorMessage: upstreamText,
  size: upstreamNumber,
  sizeleft: upstreamNumber,
  timeleft: upstreamText,
  estimatedCompletionTime: upstreamText,
  added: upstreamText,
  protocol: upstreamText,
  indexer: upstreamText,
  downloadClient: upstreamText,
  downloadId: upstreamText,
  quality: qualitySchema,
  languages: languageList,
  seriesId: optionalUpstreamId,
  episodeId: optionalUpstreamId,
  movieId: optionalUpstreamId,
});

type QueueUpstream = z.infer<typeof queueRecordSchema>;

const queueStatusSchema = z.object({
  totalCount: z.number().int(),
  count: z.number().int(),
  unknownCount: z.number().int(),
  errors: z.boolean(),
  warnings: z.boolean(),
  unknownErrors: z.boolean(),
  unknownWarnings: z.boolean(),
});

const blocklistRecordSchema = z.object({
  id: upstreamId,
  sourceTitle: upstreamText,
  date: upstreamText,
  protocol: upstreamText,
  indexer: upstreamText,
  message: upstreamText,
  quality: qualitySchema,
  seriesId: optionalUpstreamId,
  episodeIds: z.array(upstreamId).nullish(),
  movieId: optionalUpstreamId,
});

const diskSpaceSchema = z.object({
  path: upstreamText,
  label: upstreamText,
  freeSpace: upstreamNumber,
  totalSpace: upstreamNumber,
});

/** The upstream identifier of the series or movie a row is associated with. */
function mediaIdOf(
  profile: MediaProfile,
  record: {
    readonly seriesId?: number | null | undefined;
    readonly movieId?: number | null | undefined;
  },
): number | undefined {
  const value = profile.application === "sonarr" ? record.seriesId : record.movieId;
  const id = count(value);
  // Upstream reports zero for a row it could not associate with anything — an
  // unknown download-client item — and zero is not an identifier.
  return id === undefined || id <= 0 ? undefined : id;
}

function mediaAssociation(profile: MediaProfile, id: number | undefined): MediaRef | undefined {
  if (id === undefined) {
    return undefined;
  }
  return mediaRef(profile.application, profile.application === "sonarr" ? "series" : "movie", id);
}

function episodeAssociation(
  profile: MediaProfile,
  value: number | null | undefined,
): MediaRef | undefined {
  const id = count(value);
  if (profile.application !== "sonarr" || id === undefined || id <= 0) {
    return undefined;
  }
  return mediaRef("sonarr", "episode", id);
}

/**
 * Every episode a record names, for the payloads that name more than one.
 *
 * A blocklist record for a season pack lists each episode it covered, and
 * keeping only the first would understate what re-allowing the release brings
 * back — so the whole list is mapped, and an empty one is absent rather than
 * reported as a record that names no episode at all.
 */
function episodeAssociations(
  profile: MediaProfile,
  values: readonly number[] | null | undefined,
): readonly MediaRef[] | undefined {
  if (!Array.isArray(values)) {
    return undefined;
  }
  const refs = values
    .map((value) => episodeAssociation(profile, value))
    .filter((ref): ref is MediaRef => ref !== undefined);
  return refs.length === 0 ? undefined : refs;
}

/**
 * How many status-message groups and messages one row may carry.
 *
 * Status messages are the richest evidence a blocked import produces and also
 * the part of the payload an unfriendly release name reaches verbatim, so the
 * count is bounded as well as the content: a row cannot turn one queue page
 * into an unbounded payload by carrying hundreds of them.
 */
const maxStatusMessageGroups = 20;
const maxStatusMessages = 20;

/**
 * The language names upstream reported, through the sanitizer like every other
 * upstream string.
 *
 * These are conventional words in practice, but "in practice" is not the rule:
 * every piece of text this module publishes comes from an instance this server
 * does not control, and one exception is how a sanitizer stops being a
 * guarantee and becomes a habit.
 */
function safeLanguages(languages: z.infer<typeof languageList>): readonly string[] | undefined {
  const names = languageNames(languages);
  if (names === undefined) {
    return undefined;
  }
  const cleaned = names
    .map((name) => safeLabel(name))
    .filter((name): name is string => name !== undefined);
  return cleaned.length === 0 ? undefined : cleaned;
}

function statusMessages(
  groups: z.infer<typeof statusMessageSchema>[] | null | undefined,
): readonly QueueStatusMessage[] {
  if (!Array.isArray(groups)) {
    return [];
  }
  return groups.slice(0, maxStatusMessageGroups).map((group) => ({
    title: safeText(group.title, maxTitleLength),
    messages: (group.messages ?? [])
      .slice(0, maxStatusMessages)
      .map((message) => safeText(message))
      .filter((message): message is string => message !== undefined),
  }));
}

/**
 * What kind of row this is.
 *
 * `delay` and `fallback` are the two statuses Sonarr and Radarr use for a
 * release they are holding rather than a download they are tracking, and they
 * are the only two: a row with any other status has a download-client item
 * behind it. Deciding it here once is what lets change 0006 validate an intent
 * against a discriminant instead of re-reading a status word.
 */
function queueItemKind(status: string): QueueItemKind {
  return status === "delay" || status === "fallback" ? "pending_release" : "tracked_download";
}

export function mapQueueItem(
  profile: MediaProfile,
  record: QueueUpstream,
  detail: DetailLevel,
): QueueItem {
  const application = profile.application;
  const status = closedWord(record.status, queueStatuses, "unknown");
  const kind = queueItemKind(status);
  const mediaId = mediaIdOf(profile, record);
  return {
    application,
    kind,
    context: { application, kind, queueItemId: record.id, mediaId },
    title: safeText(record.title, maxTitleLength) ?? `queue item ${record.id}`,
    media: mediaAssociation(profile, mediaId),
    episode: episodeAssociation(profile, record.episodeId),
    quality: qualityName(record.quality),
    evidence: {
      status,
      trackedStatus: optionalClosedWord(
        record.trackedDownloadStatus,
        trackedDownloadStatuses,
        "unknown",
      ),
      trackedState: optionalClosedWord(
        record.trackedDownloadState,
        trackedDownloadStates,
        "unknown",
      ),
      statusMessages: statusMessages(record.statusMessages),
      errorMessage: safeText(record.errorMessage),
    },
    progress: present({
      sizeBytes: count(record.size),
      remainingBytes: count(record.sizeleft),
      timeLeft: safeLabel(record.timeleft),
      estimatedCompletionTime: safeLabel(record.estimatedCompletionTime),
      added: safeLabel(record.added),
    }),
    // The download-client identifier itself is never mapped; what survives is
    // the salted digest of it, which is enough to recognize the same download
    // in a history record and nothing more.
    origin: present({
      protocol: safeLabel(record.protocol),
      indexer: safeLabel(record.indexer),
      downloadClient: safeLabel(record.downloadClient),
      downloadIdentity: downloadIdentity(record.downloadId),
    }),
    languages: detail === "full" ? safeLanguages(record.languages) : undefined,
  };
}

/** The queue's own counters, which upstream answers in a single small object. */
export async function readQueueStatus(
  client: UpstreamClient,
  profile: MediaProfile,
): Promise<QueueSummary> {
  const body = await client.get(mediaRoutes.queueStatus);
  const status = parseActivity(
    queueStatusSchema,
    body,
    profile.application,
    mediaRoutes.queueStatus,
  );
  return { application: profile.application, ...status };
}

/**
 * One bounded page of the queue.
 *
 * The window is applied by the instance: `queue` is server-paged, and this
 * adapter asks for the page it wants rather than fetching the queue and
 * slicing it. Neither application filters the queue by media record, so a media
 * filter is applied to the records that page returned, and `hasMore` still
 * comes from the total the instance reported.
 */
export async function readQueue(
  client: UpstreamClient,
  window: PageWindow,
  request: ActivityRequestFor<"queue">,
  profile: MediaProfile,
): Promise<AdapterPage<QueueItem>> {
  const body = await client.get(mediaRoutes.queue, {
    ...profile.queueInclude,
    page: pageNumberFor(window),
    pageSize: window.pageSize,
    sortKey: "timeleft",
    sortDirection: "ascending",
  });
  const envelope = parseActivity(
    pagedEnvelope(queueRecordSchema),
    body,
    profile.application,
    mediaRoutes.queue,
  );
  const wanted = request.mediaIds === undefined ? undefined : new Set(request.mediaIds);
  const records = envelope.records.filter((record) => {
    const mediaId = mediaIdOf(profile, record);
    return wanted === undefined || (mediaId !== undefined && wanted.has(mediaId));
  });

  return filteredUpstreamPage(
    records.map((record) => mapQueueItem(profile, record, request.detail)),
    window,
    envelope.records.length,
    count(envelope.totalRecords),
  );
}

/**
 * Focused detail for one queue row.
 *
 * The read is scoped to the media record the queue reference retained, which is
 * what keeps it bounded: `queue/details` answers one series or movie rather
 * than the whole queue. A row that upstream never associated with a media
 * record has no such scope, and then the endpoint's unscoped answer is searched
 * under the projection's scan bound instead. Either way exactly one row can
 * come back, and a row that is no longer there is reported as absent so the
 * service can turn it into a stale reference.
 */
export async function readQueueDetails(
  client: UpstreamClient,
  request: ActivityRequestFor<"queue_details">,
  profile: MediaProfile,
): Promise<QueueItem | undefined> {
  const body = await client.get(mediaRoutes.queueDetails, {
    ...profile.queueInclude,
    ...(request.mediaId === undefined ? {} : { [profile.detailParameter]: request.mediaId }),
  });
  const records = parseActivity(
    z.array(queueRecordSchema),
    body,
    profile.application,
    mediaRoutes.queueDetails,
  );
  const page = projectPage({
    source: records,
    window: { offset: 0, pageSize: 1 },
    include: (record) => record.id === request.queueItemId,
    map: (record) => mapQueueItem(profile, record, request.detail),
  });
  return page.items[0];
}

/**
 * One bounded page of the blocklist.
 *
 * `blocklist` is server-paged and accepts no media or date filter, so both are
 * applied to the page the instance returned. Nothing here removes a record:
 * re-allowing a blocked release is a typed mutation owned by change 0010.
 */
export async function readBlocklist(
  client: UpstreamClient,
  window: PageWindow,
  request: ActivityRequestFor<"blocklist">,
  profile: MediaProfile,
): Promise<AdapterPage<BlocklistRecord>> {
  const body = await client.get(mediaRoutes.blocklist, {
    page: pageNumberFor(window),
    pageSize: window.pageSize,
    sortKey: "date",
    sortDirection: "descending",
  });
  const envelope = parseActivity(
    pagedEnvelope(blocklistRecordSchema),
    body,
    profile.application,
    mediaRoutes.blocklist,
  );
  const wanted = request.mediaIds === undefined ? undefined : new Set(request.mediaIds);
  const application = profile.application;

  const records = envelope.records.filter((record) => {
    const mediaId = mediaIdOf(profile, record);
    return (
      (wanted === undefined || (mediaId !== undefined && wanted.has(mediaId))) &&
      withinWindow(safeLabel(record.date), request)
    );
  });

  return filteredUpstreamPage(
    records.map((record): BlocklistRecord => {
      const mediaId = mediaIdOf(profile, record);
      return {
        application,
        context: { application, blocklistRecordId: record.id },
        title: safeText(record.sourceTitle, maxTitleLength),
        date: safeLabel(record.date),
        media: mediaAssociation(profile, mediaId),
        episodes: episodeAssociations(profile, record.episodeIds),
        quality: qualityName(record.quality),
        protocol: safeLabel(record.protocol),
        indexer: safeLabel(record.indexer),
        message: safeText(record.message),
      };
    }),
    window,
    envelope.records.length,
    count(envelope.totalRecords),
  );
}

/**
 * Free space per volume.
 *
 * The mount's canonical path is not mapped. The upstream label names the volume
 * well enough to act on, and where an instance reports no label the path's last
 * segment stands in — a name, not a location on the operator's disk.
 */
export async function readDiskSpace(
  client: UpstreamClient,
  window: PageWindow,
  profile: MediaProfile,
): Promise<AdapterPage<DiskCondition>> {
  const body = await client.get(mediaRoutes.diskSpace);
  const volumes = parseActivity(
    z.array(diskSpaceSchema),
    body,
    profile.application,
    mediaRoutes.diskSpace,
  );
  return projectPage({
    source: volumes,
    window,
    map: (volume): DiskCondition => ({
      application: profile.application,
      label: safeLabel(volume.label) ?? safeLabel(volume.path?.split(/[\\/]/u).at(-1)),
      freeBytes: count(volume.freeSpace),
      totalBytes: count(volume.totalSpace),
    }),
  });
}

/**
 * One bounded page of history for a media application.
 *
 * A request naming exactly one media record is answered by that record's own
 * history route, which is the bounded way to ask the question; anything else
 * falls through to the shared routing.
 */
export async function readMediaHistory(
  client: UpstreamClient,
  window: PageWindow,
  request: ActivityRequestFor<"history">,
  profile: MediaProfile,
): Promise<AdapterPage<HistoryRecord>> {
  const application = profile.application;
  const only = request.mediaIds?.length === 1 ? request.mediaIds[0] : undefined;
  const wanted = request.mediaIds === undefined ? undefined : new Set(request.mediaIds);

  const map = (record: HistoryUpstream): HistoryRecord => {
    const mediaId = mediaIdOf(profile, record);
    return {
      application,
      context: { application, historyRecordId: record.id },
      eventType: historyEventType(record.eventType),
      date: safeLabel(record.date),
      title: safeText(record.sourceTitle, maxTitleLength),
      media: mediaAssociation(profile, mediaId),
      episode: episodeAssociation(profile, record.episodeId),
      quality: qualityName(record.quality),
      downloadIdentity: downloadIdentity(record.downloadId),
      successful: flag(record.successful),
      data: request.detail === "full" ? mediaHistoryData(record.data) : undefined,
    };
  };

  return readHistory(client, window, request, {
    application,
    scoped:
      only === undefined
        ? undefined
        : {
            route: profile.history.route,
            query: { [profile.history.parameter]: only },
          },
    include:
      wanted === undefined
        ? undefined
        : (record) => {
            const mediaId = mediaIdOf(profile, record);
            return mediaId !== undefined && wanted.has(mediaId);
          },
    map,
  });
}
