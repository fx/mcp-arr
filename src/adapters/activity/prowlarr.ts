import type { UpstreamClient } from "../../http/client.js";
import type { AdapterPage, PageWindow } from "../library/paging.js";
import { count, present } from "../library/parse.js";
import type { HistoryData, HistoryRecord, IndexerRef } from "./model.js";
import { downloadIdentity, maxTitleLength, safeLabel, safeText } from "./parse.js";
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
 * The indexer status and statistics readers are the third task of change 0004
 * and land separately.
 *
 * Every route here is a GET.
 */

const application = "prowlarr" as const;

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
