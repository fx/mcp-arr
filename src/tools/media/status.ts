import {
  type MediaProfile,
  profileFor,
  readMediaHistory,
  readQueue,
  readQueueForMedia,
} from "../../adapters/activity/media.js";
import type { HistoryEventType, HistoryRecord, QueueItem } from "../../adapters/activity/model.js";
import { readQualityProfiles } from "../../adapters/library/changes.js";
import { defaultScanLimit } from "../../adapters/library/paging.js";
import { runLibraryQuery } from "../../adapters/library/service.js";
import {
  type EpisodeState,
  type LibraryTitle,
  readEpisodeFileResolutions,
  readEpisodeStates,
  readLibraryTitles,
} from "../../adapters/library/titles.js";
import type { ApplicationAdapter } from "../../adapters/registry.js";
import type { UpstreamClient } from "../../http/client.js";
import { maxPageSize } from "../schemas/common.js";
import type { MediaContext } from "./context.js";
import {
  classifyDownload,
  type Download,
  downloadEpisodes,
  downloadReasons,
  type EpisodeNumbers,
  episodeNumbersOf,
  episodesLabel,
  groupDownloads,
  type ImportGuard,
  importClaimed,
  importingOthers,
  type Judgement,
  judgeDownload,
  refreshImports,
  reportDownload,
} from "./downloads.js";
import {
  distinctErrors,
  type MediaError,
  mediaError,
  mediaErrorFor,
  mediaErrorForCode,
} from "./errors.js";
import { kindRoutes, type TitleKind, titleKinds } from "./kinds.js";
import { configuredKinds, kindAdapter } from "./probe.js";
import { publishedText } from "./published-text.js";
import { profileResolution, type Resolution, resolutionOf, resolutions } from "./resolution.js";
import {
  type DatedTitle,
  maxListedEntries,
  type ReportedDownload,
  type StatusResult,
} from "./schemas.js";
import { namedTitle, resolveTitle } from "./titles.js";

const day = 24 * 60 * 60 * 1000;

/** How far back the overview looks for imports. */
export const importedWindowDays = 7;

/** How far ahead the overview looks for what is due. */
export const upcomingWindowDays = 14;

/** The history events that put a file into the library. */
const importEvents: ReadonlySet<HistoryEventType> = new Set([
  "download_folder_imported",
  "series_folder_imported",
]);

const unassociatedWarning = (count: number): string =>
  `${count} download(s) in the queue belong to no title in the library and are not listed`;

/**
 * Warned when the queue was longer than the overview reads: the total then
 * counts exactly the downloads among the entries read.
 */
const partialQueueWarning =
  `the queue holds more than ${defaultScanLimit} entries, so downloads_total counts only ` +
  `the downloads among the first ${defaultScanLimit}; more may exist beyond them`;

const partialHistoryWarning =
  "the history was longer than could be read, so the imported list may be incomplete";

const partialCalendarWarning =
  "more is due than could be read, so the upcoming list may be incomplete";

const truncatedRowsWarning =
  "this title has more queue entries than could be read, so its downloads may be incomplete";

const uncheckedWarning = "a download's files could not be checked, so its remedy is none";

const unreadProfileWarning =
  "the resolution this title targets could not be read, so none is reported";

const unreadFilesWarning =
  "the resolutions of this title's files could not be read, so none are reported";

/** A download beside everything needed to report it, before the list is cut. */
interface Candidate {
  readonly kind: TitleKind;
  readonly adapter: ApplicationAdapter;
  readonly record: LibraryTitle;
  readonly externalId: number;
  readonly title: string | undefined;
  readonly download: Download;
  readonly judgement: Judgement;
  /** The download's place in its own queue read. */
  readonly position: number;
}

/** The most history pages the overview reads looking for the week's imports. */
export const maxHistoryPages = 5;

/**
 * The history records back to an instant, newest first, through the paged
 * history read a recorded fixture covers.
 *
 * Pages are read until one holds a record older than the instant, or the
 * history ends, and at most {@link maxHistoryPages} of them. `complete` says
 * whether the read reached the instant; where the bound stopped it, older
 * imports inside the window may be missing.
 */
async function readRecentHistory(
  client: UpstreamClient,
  profile: MediaProfile,
  since: number,
): Promise<{ readonly records: readonly HistoryRecord[]; readonly complete: boolean }> {
  const records: HistoryRecord[] = [];
  for (let page = 0; page < maxHistoryPages; page += 1) {
    const read = await readMediaHistory(
      client,
      { offset: page * maxPageSize, pageSize: maxPageSize },
      { view: "history", detail: "summary", paging: { pageSize: maxPageSize } },
      profile,
    );
    records.push(...read.items);
    const older = read.items.some(
      (record) => record.date !== undefined && Date.parse(record.date) < since,
    );
    if (older || !read.hasMore) {
      return { records, complete: true };
    }
  }
  return { records, complete: false };
}

/** A list cut to the result bound, with the total it was cut from where it was cut. */
function bounded<TItem>(
  items: readonly TItem[],
  total: number = items.length,
): { readonly items: TItem[]; readonly total?: number } {
  const kept = items.slice(0, maxListedEntries);
  return total > kept.length ? { items: kept, total } : { items: kept };
}

function iso(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

/**
 * Judges a download as `media_fix` would, except that a failure to check an
 * import's files makes its remedy `none` here rather than failing the read:
 * status reports what a fix would do, and a fix that cannot check the files
 * imports nothing.
 */
async function judgeForStatus(
  context: MediaContext,
  adapter: ApplicationAdapter,
  kind: TitleKind,
  mediaId: number,
  download: Download,
  siblings: { readonly downloads: readonly Download[]; readonly complete: boolean },
  warnings: string[],
): Promise<Judgement> {
  const claimed = importClaimed(context, download.key);
  // Status acts on nothing, so it reserves nothing: it asks only whether a
  // fix would find another download holding one of the import's targets.
  const guard: ImportGuard = {
    others: importingOthers(context, siblings.downloads, download),
    complete: siblings.complete,
    reserve: (targets) =>
      targets.every((target) => !context.claims.targetHeldByOther(download.key, target)),
  };
  try {
    return await judgeDownload(adapter, kind, mediaId, download, claimed, guard);
  } catch {
    if (!warnings.includes(uncheckedWarning)) {
      warnings.push(uncheckedWarning);
    }
    return { state: "stuck", remedy: "none", reason: downloadReasons.checkFailed };
  }
}

/**
 * Judges a listed download whose remedy may be `import` against the title's
 * own queue, read the way `media_fix` reads it, so the overview reports the
 * remedy a fix would apply: the queue page the overview listed it from holds
 * every title's rows and stops at its bound, and is not the read a fix
 * decides from.
 */
async function judgeListedImport(
  context: MediaContext,
  candidate: Candidate,
  warnings: string[],
): Promise<Judgement> {
  let siblings: { readonly downloads: readonly Download[]; readonly complete: boolean };
  try {
    const rows = await readQueueForMedia(
      candidate.adapter.client,
      candidate.record.id,
      profileFor(kindRoutes[candidate.kind].application),
      "summary",
    );
    siblings = { downloads: groupDownloads(rows.items), complete: !rows.truncated };
  } catch {
    if (!warnings.includes(uncheckedWarning)) {
      warnings.push(uncheckedWarning);
    }
    return { state: "stuck", remedy: "none", reason: downloadReasons.checkFailed };
  }
  return judgeForStatus(
    context,
    candidate.adapter,
    candidate.kind,
    candidate.record.id,
    candidate.download,
    siblings,
    warnings,
  );
}

/** Downloads ordered stuck first, then by kind, then as their queues listed them. */
function byReportingOrder(left: Candidate, right: Candidate): number {
  const stuck =
    Number(right.judgement.state === "stuck") - Number(left.judgement.state === "stuck");
  return (
    stuck ||
    titleKinds.indexOf(left.kind) - titleKinds.indexOf(right.kind) ||
    left.position - right.position
  );
}

/**
 * Every queue row of one kind, page by page, up to the scan bound the rest of
 * the activity layer reads under, so the overview can count downloads rather
 * than rows. `complete` says whether the read reached the
 * queue's end; where the bound stopped it, rows beyond it were not read.
 */
async function readWholeQueue(
  client: UpstreamClient,
  profile: MediaProfile,
): Promise<{ readonly items: readonly QueueItem[]; readonly complete: boolean }> {
  const items: QueueItem[] = [];
  const seen = new Set<number>();
  for (let offset = 0; offset < defaultScanLimit; offset += maxPageSize) {
    const page = await readQueue(
      client,
      { offset, pageSize: maxPageSize },
      { view: "queue", detail: "summary", paging: { pageSize: maxPageSize } },
      profile,
    );
    // A queue that moved between pages can list a row twice; it is one row.
    for (const item of page.items) {
      if (!seen.has(item.context.queueItemId)) {
        seen.add(item.context.queueItemId);
        items.push(item);
      }
    }
    if (!page.hasMore) {
      return { items, complete: true };
    }
  }
  return { items, complete: false };
}

interface KindOverview {
  readonly candidates: readonly Candidate[];
  /** Whether the queue was read to its end, so the candidates are every download in it. */
  readonly complete: boolean;
  readonly imported: readonly DatedTitle[];
  readonly upcoming: readonly DatedTitle[];
  readonly warnings: readonly string[];
}

/**
 * Everything the overview reports about one kind.
 *
 * Every read here is a GET. A download's remedy is decided without the
 * import confirmation, which runs only for the downloads the overview
 * actually lists; the order the list is cut in needs only the state.
 */
async function overviewOfKind(
  context: MediaContext,
  kind: TitleKind,
): Promise<
  | { readonly ok: true; readonly value: KindOverview }
  | { readonly ok: false; readonly error: MediaError }
> {
  const served = await kindAdapter(context, kind);
  if (!served.ok) {
    return served;
  }
  const adapter = served.adapter;
  await refreshImports(context, adapter);
  const application = kindRoutes[kind].application;
  const profile = profileFor(application);
  const now = context.clock.now();
  const warnings: string[] = [];

  try {
    const [queue, titles, history, calendar] = await Promise.all([
      readWholeQueue(adapter.client, profile),
      readLibraryTitles(adapter.client, application),
      readRecentHistory(adapter.client, profile, now - importedWindowDays * day),
      runLibraryQuery(application, adapter.client, {
        view: "calendar",
        detail: "summary",
        paging: { pageSize: maxPageSize },
        start: iso(now),
        end: iso(now + upcomingWindowDays * day),
      }),
    ]);
    if (calendar.status === "error") {
      return { ok: false, error: mediaErrorForCode(kind, calendar.error.code) };
    }

    const byId = new Map(titles.map((title) => [title.id, title]));
    const recordOf = (mediaId: number | undefined) =>
      mediaId === undefined ? undefined : byId.get(mediaId);
    const titleOf = (record: LibraryTitle) =>
      record.title === undefined ? undefined : publishedText(context, record.title);

    const associated: QueueItem[] = [];
    const unassociated: QueueItem[] = [];
    for (const item of queue.items) {
      (recordOf(item.context.mediaId)?.externalId === undefined ? unassociated : associated).push(
        item,
      );
    }
    // Counted as downloads, like everything else the overview counts.
    const strays = groupDownloads(unassociated).length;
    if (strays > 0) {
      warnings.push(unassociatedWarning(strays));
    }

    const candidates: Candidate[] = [];
    for (const [position, download] of groupDownloads(associated).entries()) {
      const record = recordOf(download.rows[0]?.context.mediaId);
      if (record?.externalId === undefined) {
        continue;
      }
      const claimed = importClaimed(context, download.key);
      candidates.push({
        kind,
        adapter,
        record,
        externalId: record.externalId,
        title: titleOf(record),
        download,
        // Provisional: an `import` is confirmed only for a listed download.
        judgement: provisionalJudgement(download, claimed),
        position,
      });
    }
    if (!queue.complete) {
      warnings.push(partialQueueWarning);
    }

    // One entry per title, at its latest import, newest first.
    const latest = new Map<number, { record: LibraryTitle; at: number }>();
    for (const event of history.records) {
      const record = recordOf(event.context.mediaId);
      const at = event.date === undefined ? Number.NaN : Date.parse(event.date);
      if (
        !importEvents.has(event.eventType) ||
        record?.externalId === undefined ||
        event.date === undefined ||
        Number.isNaN(at) ||
        at < now - importedWindowDays * day
      ) {
        continue;
      }
      const seen = latest.get(record.id);
      if (seen === undefined || at > seen.at) {
        latest.set(record.id, { record, at });
      }
    }
    if (!history.complete) {
      warnings.push(partialHistoryWarning);
    }
    const imported = [...latest.values()]
      .sort((left, right) => right.at - left.at)
      .map(({ record, at }) => ({
        ...namedTitle(kind, record.externalId as number, titleOf(record)),
        date: iso(at),
      }));

    // One entry per title and day, at the earliest instant that day.
    const due = new Map<
      string,
      {
        record: LibraryTitle;
        at: number;
        episodes: { seasonNumber: number; episodeNumber: number }[];
      }
    >();
    const items = calendar.data.view === "calendar" ? calendar.data.items : [];
    for (const event of items) {
      const media = event.media;
      const mediaId =
        media.application === "sonarr" && media.sonarr.kind === "episode"
          ? media.sonarr.seriesId
          : media.application === "radarr"
            ? Number(media.ref.id)
            : undefined;
      const record = recordOf(mediaId);
      const at = event.start === undefined ? Number.NaN : Date.parse(event.start);
      if (
        record?.externalId === undefined ||
        event.start === undefined ||
        Number.isNaN(at) ||
        at < now ||
        at > now + upcomingWindowDays * day
      ) {
        continue;
      }
      const key = `${record.id}\u0000${iso(at).slice(0, 10)}`;
      const entry = due.get(key) ?? { record, at, episodes: [] };
      entry.at = Math.min(entry.at, at);
      if (media.application === "sonarr" && media.sonarr.kind === "episode") {
        entry.episodes.push({
          seasonNumber: media.sonarr.seasonNumber,
          episodeNumber: media.sonarr.episodeNumber,
        });
      }
      due.set(key, entry);
    }
    if (calendar.continuation.hasMore || calendar.warnings.length > 0) {
      warnings.push(partialCalendarWarning);
    }
    const upcoming = [...due.values()]
      .sort((left, right) => left.at - right.at)
      .map(({ record, at, episodes }) => {
        const label = episodesLabel(episodes);
        return {
          ...namedTitle(kind, record.externalId as number, titleOf(record)),
          ...(label === undefined ? {} : { episodes: label }),
          date: iso(at),
        };
      });

    return {
      ok: true,
      value: { candidates, complete: queue.complete, imported, upcoming, warnings },
    };
  } catch (error) {
    return { ok: false, error: mediaErrorFor(kind, error) };
  }
}

/**
 * The judgement a download is ordered by: its classification, with a
 * provisional `import` standing in until {@link judgeForStatus} confirms or
 * refuses it. Only the state decides the order, and a provisional `import` is
 * stuck either way.
 */
function provisionalJudgement(download: Download, claimed: boolean): Judgement {
  const classified = classifyDownload(download, claimed);
  if (classified.state === "stuck" && classified.remedy === "import") {
    return { state: "stuck", remedy: "import", reason: downloadReasons.importable, files: [] };
  }
  return classified;
}

/** Labels for the series downloads a list reports, one episode read per series. */
async function episodeNumbersFor(
  candidates: readonly Candidate[],
): Promise<ReadonlyMap<number, EpisodeNumbers | undefined>> {
  const series = new Map<number, ApplicationAdapter>();
  for (const candidate of candidates) {
    if (candidate.kind === "series") {
      series.set(candidate.record.id, candidate.adapter);
    }
  }
  const numbers = new Map<number, EpisodeNumbers | undefined>();
  await Promise.all(
    [...series].map(async ([seriesId, adapter]) => {
      try {
        numbers.set(seriesId, episodeNumbersOf(await readEpisodeStates(adapter.client, seriesId)));
      } catch {
        numbers.set(seriesId, undefined);
      }
    }),
  );
  return numbers;
}

/** The overview: every kind this deployment serves, each failing on its own. */
async function overview(context: MediaContext): Promise<StatusResult> {
  const kinds = configuredKinds(context, titleKinds);
  if (kinds.length === 0) {
    return {
      warnings: [],
      errors: titleKinds.map((kind) => mediaError(kind, "unconfigured_application")),
    };
  }

  const overviews = await Promise.all(kinds.map((kind) => overviewOfKind(context, kind)));
  const warnings: string[] = [];
  const errors: MediaError[] = [];
  const candidates: Candidate[] = [];
  const imported: DatedTitle[] = [];
  const upcoming: DatedTitle[] = [];
  for (const outcome of overviews) {
    if (!outcome.ok) {
      errors.push(outcome.error);
      continue;
    }
    candidates.push(...outcome.value.candidates);
    imported.push(...outcome.value.imported);
    upcoming.push(...outcome.value.upcoming);
    warnings.push(...outcome.value.warnings);
  }

  if (errors.length === overviews.length) {
    // No kind answered, so there is nothing to list, not an empty list.
    return { kinds, warnings: [], errors: distinctErrors(errors) };
  }

  const ordered = [...candidates].sort(byReportingOrder);
  const listed = ordered.slice(0, maxListedEntries);
  const numbers = await episodeNumbersFor(listed);
  const downloads: ReportedDownload[] = [];
  for (const candidate of listed) {
    const judgement =
      candidate.judgement.state === "stuck" && candidate.judgement.remedy === "import"
        ? await judgeListedImport(context, candidate, warnings)
        : candidate.judgement;
    const episodes =
      candidate.kind === "series"
        ? downloadEpisodes(candidate.download, numbers.get(candidate.record.id), warnings)
        : undefined;
    downloads.push(
      reportDownload(
        namedTitle(candidate.kind, candidate.externalId, candidate.title),
        candidate.download,
        judgement,
        episodes,
      ),
    );
  }

  // Downloads, never rows: a season pack listed once per episode counts once.
  const cutDownloads = bounded(downloads, ordered.length);
  // Imports newest first and what is due soonest first, across both kinds.
  const cutImported = bounded(
    [...imported].sort((left, right) => Date.parse(right.date) - Date.parse(left.date)),
  );
  const cutUpcoming = bounded(
    [...upcoming].sort((left, right) => Date.parse(left.date) - Date.parse(right.date)),
  );
  return {
    kinds,
    downloads: cutDownloads.items,
    ...(cutDownloads.total === undefined ? {} : { downloads_total: cutDownloads.total }),
    imported: cutImported.items,
    ...(cutImported.total === undefined ? {} : { imported_total: cutImported.total }),
    upcoming: cutUpcoming.items,
    ...(cutUpcoming.total === undefined ? {} : { upcoming_total: cutUpcoming.total }),
    warnings: [...new Set(warnings)],
    errors: distinctErrors(errors),
  };
}

/** Whether an instant has passed, for a value that may not be one. */
function passed(value: string | undefined, now: number): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : at <= now;
}

/**
 * The earliest of these instants still to come, written by this server: a
 * date is published as the instant it parses to, never as the text an
 * instance sent.
 */
function earliestAfter(values: readonly (string | undefined)[], now: number): string | undefined {
  let best: number | undefined;
  for (const value of values) {
    const at = value === undefined ? Number.NaN : Date.parse(value);
    if (!Number.isNaN(at) && at > now && (best === undefined || at < best)) {
      best = at;
    }
  }
  return best === undefined ? undefined : iso(best);
}

function distinctResolutions(pixels: readonly number[]): Resolution[] {
  const found = new Set(pixels.map(resolutionOf).filter((value) => value !== undefined));
  return resolutions.filter((resolution) => found.has(resolution));
}

/** One title's status. Every read is a GET, and a title not in the library is an answer. */
async function titleStatus(
  context: MediaContext,
  kind: TitleKind,
  id: number,
): Promise<StatusResult> {
  const resolved = await resolveTitle(context, kind, id);
  if (!resolved.ok) {
    return { warnings: [], errors: [resolved.error] };
  }
  const record = resolved.record;
  if (record === undefined) {
    return { kind, id, in_library: false, warnings: [], errors: [] };
  }
  const adapter = resolved.adapter;
  await refreshImports(context, adapter);
  const application = kindRoutes[kind].application;
  const now = context.clock.now();
  const warnings: string[] = [];

  let rows: Awaited<ReturnType<typeof readQueueForMedia>>;
  let episodes: readonly EpisodeState[] = [];
  try {
    [rows, episodes] = await Promise.all([
      readQueueForMedia(adapter.client, record.id, profileFor(application), "summary"),
      kind === "series" ? readEpisodeStates(adapter.client, record.id) : Promise.resolve([]),
    ]);
  } catch (error) {
    return {
      ...namedTitle(kind, id, resolved.title),
      warnings: [],
      errors: [mediaErrorFor(kind, error)],
    };
  }
  if (rows.truncated) {
    warnings.push(truncatedRowsWarning);
  }

  const [target, files] = await Promise.all([
    (async () => {
      try {
        const profiles = await readQualityProfiles(adapter.client, application);
        const profile = profiles.find((candidate) => candidate.id === record.qualityProfileId);
        if (profile === undefined) {
          warnings.push(unreadProfileWarning);
          return undefined;
        }
        return profileResolution(profile);
      } catch {
        warnings.push(unreadProfileWarning);
        return undefined;
      }
    })(),
    (async () => {
      try {
        // A movie's one file is described by its own library record.
        const pixels =
          kind === "movie"
            ? record.fileResolution === undefined
              ? []
              : [record.fileResolution]
            : await readEpisodeFileResolutions(adapter.client, record.id);
        return distinctResolutions(pixels);
      } catch {
        warnings.push(unreadFilesWarning);
        return undefined;
      }
    })(),
  ]);

  let have = 0;
  let missing = 0;
  let nextDue: string | undefined;
  if (kind === "movie") {
    have = record.hasFile === true ? 1 : 0;
    missing = record.hasFile === false && record.isAvailable === true ? 1 : 0;
    nextDue = earliestAfter(record.releaseDates, now);
  } else {
    for (const episode of episodes) {
      if (episode.hasFile === true) {
        have += 1;
      } else if (episode.hasFile === false && passed(episode.airDateUtc, now) === true) {
        missing += 1;
      }
    }
    nextDue = earliestAfter(
      episodes.map((episode) => episode.airDateUtc),
      now,
    );
  }

  const numbers = episodeNumbersOf(episodes);
  const downloads = groupDownloads(rows.items);
  const reported: ReportedDownload[] = [];
  for (const download of downloads.slice(0, maxListedEntries)) {
    const judgement = await judgeForStatus(
      context,
      adapter,
      kind,
      record.id,
      download,
      { downloads, complete: !rows.truncated },
      warnings,
    );
    reported.push(
      reportDownload(
        namedTitle(kind, id, resolved.title),
        download,
        judgement,
        kind === "series" ? downloadEpisodes(download, numbers, warnings) : undefined,
      ),
    );
  }
  const cut = bounded(reported, downloads.length);

  return {
    ...namedTitle(kind, id, resolved.title),
    in_library: true,
    ...(record.monitored === undefined ? {} : { monitored: record.monitored }),
    ...(target === undefined ? {} : { resolution: target }),
    ...(files === undefined ? {} : { file_resolutions: files }),
    have,
    missing,
    ...(nextDue === undefined ? {} : { next_due: nextDue }),
    downloads: cut.items,
    ...(cut.total === undefined ? {} : { downloads_total: cut.total }),
    warnings,
    errors: [],
  };
}

export interface StatusRequest {
  readonly kind?: TitleKind | undefined;
  readonly id?: number | undefined;
}

/** The overview, or one title's status. Nothing here changes anything upstream. */
export function readStatus(
  context: MediaContext,
  request: { readonly kind: TitleKind; readonly id: number } | undefined,
): Promise<StatusResult> {
  return request === undefined ? overview(context) : titleStatus(context, request.kind, request.id);
}
