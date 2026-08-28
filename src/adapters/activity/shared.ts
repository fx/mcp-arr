import { z } from "zod";
import type { ApplicationId } from "../../applications.js";
import type { UpstreamClient, UpstreamQuery } from "../../http/client.js";
import {
  type AdapterPage,
  type PageWindow,
  pageNumberFor,
  projectPage,
} from "../library/paging.js";
import {
  count,
  optionalUpstreamId,
  pagedEnvelope,
  present,
  upstreamFlag,
  upstreamId,
  upstreamText,
} from "../library/parse.js";
import type {
  CommandActivity,
  HealthCheck,
  HistoryData,
  HistoryEventType,
  HistoryRecord,
} from "./model.js";
import { commandStatuses, healthSeverities, historyEventTypes } from "./model.js";
import { closedWord, parseActivity, qualitySchema, safeLabel, safeText } from "./parse.js";
import { type ActivityRequestFor, withinWindow } from "./requests.js";

/**
 * The activity reads every application answers.
 *
 * History, health, and command activity have the same shape on Sonarr, Radarr,
 * and Prowlarr, so the payload schemas, the routing, and the paging live here
 * once. What differs between them — which media or indexer a history record is
 * associated with, and which members of the upstream `data` bag are safe to
 * map — is supplied by the caller, because those are exactly the parts that
 * cannot be shared.
 *
 * Every route in this module is a GET. Nothing here starts a command, and no
 * mutation path is reachable from it.
 */

export const sharedRoutes = {
  history: "history",
  historySince: "history/since",
  health: "health",
  command: "command",
} as const;

export const historyRecordSchema = z.object({
  id: upstreamId,
  eventType: upstreamText,
  date: upstreamText,
  sourceTitle: upstreamText,
  downloadId: upstreamText,
  successful: upstreamFlag,
  quality: qualitySchema,
  seriesId: optionalUpstreamId,
  episodeId: optionalUpstreamId,
  movieId: optionalUpstreamId,
  indexerId: optionalUpstreamId,
  data: z.record(z.string(), z.unknown()).nullish(),
});

export type HistoryUpstream = z.infer<typeof historyRecordSchema>;

export type HistoryDataBag = HistoryUpstream["data"];

/**
 * Reads one allowlisted member of an upstream `data` bag as text.
 *
 * The bag is never copied wholesale: upstream fills it with download URLs,
 * dropped and imported canonical paths, and torrent info hashes, so a member is
 * only ever read by a name written in this repository. What the key allowlists
 * below leave out is the first line of defence here; `safeLabel` is the second.
 * See {@link mediaHistoryData}.
 */
export function dataText(data: HistoryDataBag, key: string): string | undefined {
  const value = data?.[key];
  return typeof value === "string" ? safeLabel(value) : undefined;
}

/**
 * Reads one allowlisted member as a number.
 *
 * The *arr APIs serialize every member of the bag as a string, so a numeric
 * member arrives as `"1234"`; a value that is not a finite number in either
 * form is absent rather than zero.
 */
export function dataNumber(data: HistoryDataBag, key: string): number | undefined {
  const value = data?.[key];
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function historyEventType(value: string | null | undefined): HistoryEventType {
  return closedWord(value, historyEventTypes, "unknown");
}

/**
 * The members of a media application's history `data` bag this server maps.
 *
 * `downloadUrl`, `nzbInfoUrl`, `torrentInfoHash`, `droppedPath`, and
 * `importedPath` are all present upstream and all deliberately absent here: the
 * first two are outbound URLs, the third is the raw download identifier, and
 * the last two are canonical paths on the operator's disk.
 *
 * **This list is a security control, not a convenience.** It is what decides
 * whether a canonical path is read at all, and adding a path-bearing key to it
 * moves that path onto the published surface, where only the sanitizer stands
 * between it and the caller. Today the sanitizer holds: every key here goes
 * through `safeLabel`, which redacts any token carrying a path separator, so the
 * allowlist is the outer of two independent defences rather than the only one.
 * It stops being belt-and-braces the moment a value it admits is put through a
 * tolerant sanitizer instead — `safeTaxonomyLabel` publishes a two-segment
 * separator-joined name as it stands, and nothing here may use it. A contributor
 * adding a key should assume the allowlist is the whole defence and add nothing
 * that names a location on the operator's disk.
 */
export function mediaHistoryData(data: HistoryDataBag): HistoryData | undefined {
  return present({
    reason: dataText(data, "reason"),
    indexer: dataText(data, "indexer"),
    releaseGroup: dataText(data, "releaseGroup"),
    sizeBytes: dataNumber(data, "size"),
    publishedDate: dataText(data, "publishedDate"),
    protocol: dataText(data, "protocol"),
    downloadClient: dataText(data, "downloadClient"),
    message: safeText(typeof data?.message === "string" ? data.message : undefined),
  });
}

interface HistoryReadOptions {
  readonly application: ApplicationId;
  /**
   * A route that answers the history of one record directly, when the request
   * named exactly one. It is what keeps a media-scoped history read bounded
   * without paging through everything that happened to every other record.
   */
  readonly scoped?: { readonly route: string; readonly query: UpstreamQuery } | undefined;
  readonly include?: ((record: HistoryUpstream) => boolean) | undefined;
  readonly map: (record: HistoryUpstream) => HistoryRecord;
}

/**
 * Wraps an upstream page whose records were filtered after they arrived.
 *
 * The instance already applied the window, so `hasMore` has to be decided from
 * what it sent rather than from what survived the filter — otherwise a page
 * that filtered everything out would read as the end of the collection while
 * further records exist. The service advances a cursor by whole pages, so a
 * short page is expected and safe.
 */
export function filteredUpstreamPage<TItem>(
  items: readonly TItem[],
  window: PageWindow,
  upstreamCount: number,
  totalRecords: number | undefined,
): AdapterPage<TItem> {
  return {
    items,
    hasMore:
      totalRecords === undefined
        ? upstreamCount === window.pageSize
        : window.offset + upstreamCount < totalRecords,
  };
}

async function readList<TSchema extends z.ZodType>(
  client: UpstreamClient,
  application: ApplicationId,
  route: string,
  query: UpstreamQuery | undefined,
  schema: TSchema,
): Promise<z.infer<TSchema>[]> {
  const body = await client.get(route, query);
  return parseActivity(z.array(schema), body, application, route);
}

/**
 * One bounded page of history.
 *
 * Which upstream route answers depends on what was asked, because the *arr APIs
 * expose three different ones and only one of them is right for each question.
 * A request scoped to a single media record uses that record's own history
 * route; a request with a lower date bound uses `history/since`, which is the
 * endpoint built for it; anything else uses the server-paged `history` route.
 * The first two are unpaged upstream and are projected into a page here, under
 * the projection's own scan bound.
 */
export async function readHistory(
  client: UpstreamClient,
  window: PageWindow,
  request: ActivityRequestFor<"history">,
  options: HistoryReadOptions,
): Promise<AdapterPage<HistoryRecord>> {
  const include = (record: HistoryUpstream): boolean =>
    withinWindow(safeLabel(record.date), request) &&
    (options.include === undefined || options.include(record));

  if (options.scoped !== undefined) {
    const records = await readList(
      client,
      options.application,
      options.scoped.route,
      options.scoped.query,
      historyRecordSchema,
    );
    return projectPage({ source: records, window, include, map: options.map });
  }

  if (request.since !== undefined) {
    const records = await readList(
      client,
      options.application,
      sharedRoutes.historySince,
      { date: request.since },
      historyRecordSchema,
    );
    return projectPage({ source: records, window, include, map: options.map });
  }

  const body = await client.get(sharedRoutes.history, {
    page: pageNumberFor(window),
    pageSize: window.pageSize,
    sortKey: "date",
    sortDirection: "descending",
  });
  const envelope = parseActivity(
    pagedEnvelope(historyRecordSchema),
    body,
    options.application,
    sharedRoutes.history,
  );
  return filteredUpstreamPage(
    envelope.records.filter(include).map(options.map),
    window,
    envelope.records.length,
    count(envelope.totalRecords),
  );
}

const healthSchema = z.object({
  source: upstreamText,
  type: upstreamText,
  message: upstreamText,
});

/**
 * The instance's own health checks.
 *
 * The upstream `wikiUrl` is not mapped: it is an outbound URL, and the source
 * and message already say what is wrong. A check whose message the instance
 * omitted is kept with a stated placeholder rather than dropped, because the
 * fact that a check is failing is itself the evidence.
 */
export async function readHealth(
  client: UpstreamClient,
  window: PageWindow,
  application: ApplicationId,
): Promise<AdapterPage<HealthCheck>> {
  const checks = await readList(client, application, sharedRoutes.health, undefined, healthSchema);
  return projectPage({
    source: checks,
    window,
    map: (check): HealthCheck => ({
      application,
      severity: closedWord(check.type, healthSeverities, "unknown"),
      source: safeLabel(check.source),
      message: safeText(check.message) ?? "the instance reported a health check with no message",
    }),
  });
}

const commandSchema = z.object({
  id: upstreamId,
  name: upstreamText,
  commandName: upstreamText,
  status: upstreamText,
  queued: upstreamText,
  started: upstreamText,
  ended: upstreamText,
  trigger: upstreamText,
  message: upstreamText,
});

/**
 * The commands the instance is running or has recently run.
 *
 * This is a read: it lists what upstream already started. Creating a command is
 * owned by the allowlisted semantic workflows of later changes, and no path
 * from here reaches one.
 */
export async function readCommands(
  client: UpstreamClient,
  window: PageWindow,
  application: ApplicationId,
): Promise<AdapterPage<CommandActivity>> {
  const commands = await readList(
    client,
    application,
    sharedRoutes.command,
    undefined,
    commandSchema,
  );
  return projectPage({
    source: commands,
    window,
    map: (command): CommandActivity => ({
      application,
      context: { application, commandId: command.id },
      name: safeLabel(command.name) ?? safeLabel(command.commandName) ?? "unnamed command",
      status: closedWord(command.status, commandStatuses, "unknown"),
      queued: safeLabel(command.queued),
      started: safeLabel(command.started),
      ended: safeLabel(command.ended),
      trigger: safeLabel(command.trigger),
      message: safeText(command.message),
    }),
  });
}
