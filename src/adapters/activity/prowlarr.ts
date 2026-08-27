import { z } from "zod";
import type { UpstreamClient } from "../../http/client.js";
import { type AdapterPage, type PageWindow, projectPage } from "../library/paging.js";
import {
  count,
  optionalUpstreamId,
  present,
  upstreamId,
  upstreamNumber,
  upstreamText,
} from "../library/parse.js";
import type {
  HistoryData,
  HistoryRecord,
  IndexerRef,
  IndexerStatistic,
  IndexerStatus,
} from "./model.js";
import { downloadIdentity, maxTitleLength, parseActivity, safeLabel, safeText } from "./parse.js";
import type { ActivityRequestFor } from "./requests.js";
import {
  dataNumber,
  dataText,
  type HistoryDataBag,
  type HistoryUpstream,
  historyEventType,
  readHistory,
} from "./shared.js";

/**
 * The Prowlarr activity read adapters.
 *
 * Prowlarr has no media library, no queue, and no blocklist. What it
 * contributes is the record of which indexers were queried and how that went,
 * and its history `data` bag is the most sensitive payload this server reads:
 * upstream fills it with the address a request came from and the client that
 * made it. Neither is mapped, and that is structural rather than incidental —
 * the bag is read one allowlisted key at a time and never copied.
 *
 * The same applies to the statistics aggregate below, which upstream also
 * breaks down by caller host and by user agent: the schema declares only the
 * per-indexer rows, unknown properties are dropped, and {@link IndexerStatistic}
 * has no field either breakdown could occupy.
 *
 * Every route here is a GET.
 */

const application = "prowlarr" as const;

export const prowlarrRoutes = {
  indexerStatus: "indexerstatus",
  indexerStats: "indexerstats",
} as const;

const indexerStatusSchema = z.object({
  id: upstreamId,
  indexerId: optionalUpstreamId,
  disabledTill: upstreamText,
  initialFailure: upstreamText,
  mostRecentFailure: upstreamText,
});

/**
 * The allowlisted indexer aggregate.
 *
 * This is the whole of what the statistics view publishes. The upstream body
 * also carries `hosts` and `userAgents` arrays, which aggregate the same
 * counters by the address that made the request and by the client that made it;
 * the schema does not declare them, unknown properties are dropped, and
 * {@link IndexerStatistic} has no field either could occupy. Adding one would
 * have to be a deliberate edit in three places, which is the point.
 */
const indexerStatisticSchema = z.object({
  indexerId: optionalUpstreamId,
  indexerName: upstreamText,
  numberOfQueries: upstreamNumber,
  numberOfGrabs: upstreamNumber,
  numberOfRssQueries: upstreamNumber,
  numberOfAuthQueries: upstreamNumber,
  numberOfFailedQueries: upstreamNumber,
  numberOfFailedGrabs: upstreamNumber,
  numberOfFailedRssQueries: upstreamNumber,
  numberOfFailedAuthQueries: upstreamNumber,
  averageResponseTime: upstreamNumber,
});

const indexerStatsSchema = z.object({
  indexers: z.array(indexerStatisticSchema).nullish(),
});

export function indexerRef(id: number | null | undefined, name?: string | undefined): IndexerRef {
  return {
    application,
    // Zero stands for "no indexer" upstream, and the reference keeps it rather
    // than inventing one: a row that names no indexer is still a row a caller
    // can see, and it must not masquerade as indexer one.
    indexerId: count(id) ?? 0,
    name,
  };
}

/**
 * The members of Prowlarr's history `data` bag this server maps.
 *
 * `host` and `url` are the two that name where a request came from and where it
 * went, and neither is read. The search term itself is not read either: it is
 * caller-authored text that adds nothing to a failure diagnosis the query type
 * and result count do not already say.
 */
function prowlarrHistoryData(data: HistoryDataBag): HistoryData | undefined {
  return present({
    queryType: dataText(data, "queryType"),
    queryResults: dataNumber(data, "queryResults"),
    elapsedTimeMs: dataNumber(data, "elapsedTime"),
    publishedDate: dataText(data, "publishedDate"),
  });
}

/**
 * One bounded page of Prowlarr history.
 *
 * Prowlarr's history is not associated with a media record, so the media filter
 * a media application honors has nothing to apply to here; the shared routing
 * still chooses between the server-paged route and the since-scoped one.
 */
export async function readProwlarrHistory(
  client: UpstreamClient,
  window: PageWindow,
  request: ActivityRequestFor<"history">,
): Promise<AdapterPage<HistoryRecord>> {
  const map = (record: HistoryUpstream): HistoryRecord => ({
    application,
    context: { application, historyRecordId: record.id },
    eventType: historyEventType(record.eventType),
    date: safeLabel(record.date),
    title: safeText(record.sourceTitle, maxTitleLength),
    indexer: count(record.indexerId) === undefined ? undefined : indexerRef(record.indexerId),
    downloadIdentity: downloadIdentity(record.downloadId),
    successful: record.successful ?? undefined,
    data: request.detail === "full" ? prowlarrHistoryData(record.data) : undefined,
  });

  return readHistory(client, window, request, { application, map });
}

/**
 * Which indexers are failing, and until when.
 *
 * `disabledTill` is the field a failed search is diagnosed from: an indexer
 * upstream has taken out of rotation cannot have answered the search that
 * returned nothing.
 */
export async function readIndexerStatus(
  client: UpstreamClient,
  window: PageWindow,
): Promise<AdapterPage<IndexerStatus>> {
  const body = await client.get(prowlarrRoutes.indexerStatus);
  const records = parseActivity(
    z.array(indexerStatusSchema),
    body,
    application,
    prowlarrRoutes.indexerStatus,
  );
  return projectPage({
    source: records,
    window,
    map: (record): IndexerStatus => ({
      application,
      indexer: indexerRef(record.indexerId),
      disabledUntil: safeLabel(record.disabledTill),
      initialFailure: safeLabel(record.initialFailure),
      mostRecentFailure: safeLabel(record.mostRecentFailure),
    }),
  });
}

/**
 * Per-indexer performance aggregates over a date window.
 *
 * The window is passed to the instance, which is the only place it can be
 * applied: the endpoint aggregates server-side and there is nothing to filter
 * afterwards. The result is projected into a bounded page because upstream
 * returns one row per indexer with no paging of its own.
 */
export async function readIndexerStatistics(
  client: UpstreamClient,
  window: PageWindow,
  request: ActivityRequestFor<"indexer_statistics">,
): Promise<AdapterPage<IndexerStatistic>> {
  const body = await client.get(prowlarrRoutes.indexerStats, {
    startDate: request.since,
    endDate: request.until,
  });
  const stats = parseActivity(indexerStatsSchema, body, application, prowlarrRoutes.indexerStats);
  return projectPage({
    source: stats.indexers ?? [],
    window,
    map: (record): IndexerStatistic => ({
      application,
      indexer: indexerRef(record.indexerId, safeLabel(record.indexerName)),
      queries: count(record.numberOfQueries),
      grabs: count(record.numberOfGrabs),
      rssQueries: count(record.numberOfRssQueries),
      authQueries: count(record.numberOfAuthQueries),
      failedQueries: count(record.numberOfFailedQueries),
      failedGrabs: count(record.numberOfFailedGrabs),
      failedRssQueries: count(record.numberOfFailedRssQueries),
      failedAuthQueries: count(record.numberOfFailedAuthQueries),
      averageResponseTimeMs: count(record.averageResponseTime),
    }),
  });
}
