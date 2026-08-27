import { z } from "zod";
import type { UpstreamClient } from "../../http/client.js";
import type {
  CalendarEvent,
  LookupResult,
  MediaDetail,
  MediaFile,
  MediaItem,
  WantedItem,
} from "./model.js";
import { configurationPointer, mediaRef, seasonRef } from "./model.js";
import {
  type AdapterPage,
  type PageWindow,
  pageNumberFor,
  projectPage,
  upstreamPage,
} from "./paging.js";
import {
  count,
  customFormatList,
  endOf,
  flag,
  languageList,
  languageNames,
  mediaInfo,
  mediaInfoSchema,
  optionalUpstreamId,
  pagedEnvelope,
  parseUpstream,
  present,
  qualityWrapper,
  text,
  textList,
  upstreamFlag,
  upstreamId,
  upstreamNumber,
  upstreamText,
} from "./parse.js";
import type { DetailLevel, LibraryRequestFor } from "./requests.js";

/**
 * The Sonarr library read adapters.
 *
 * Each function owns one view: it names its own upstream route, maps the
 * response into the normalized model, and returns a bounded page. None of them
 * writes anything — every route here is a GET, and no add, edit, monitor, or
 * delete path is reachable from this module.
 */

const application = "sonarr" as const;

export const sonarrRoutes = {
  series: "series",
  seriesLookup: "series/lookup",
  episode: "episode",
  episodeFile: "episodefile",
  wantedMissing: "wanted/missing",
  wantedCutoff: "wanted/cutoff",
  calendar: "calendar",
} as const;

const statisticsSchema = z
  .object({
    seasonCount: upstreamNumber,
    episodeCount: upstreamNumber,
    episodeFileCount: upstreamNumber,
    totalEpisodeCount: upstreamNumber,
    sizeOnDisk: upstreamNumber,
  })
  .nullish();

const seasonSchema = z.object({
  seasonNumber: upstreamId,
  monitored: upstreamFlag,
  statistics: statisticsSchema,
});

const seriesSchema = z.object({
  id: upstreamId,
  title: z.string(),
  sortTitle: upstreamText,
  status: upstreamText,
  ended: upstreamFlag,
  overview: upstreamText,
  network: upstreamText,
  year: upstreamNumber,
  runtime: upstreamNumber,
  path: upstreamText,
  rootFolderPath: upstreamText,
  qualityProfileId: upstreamNumber,
  monitored: upstreamFlag,
  tvdbId: upstreamNumber,
  seriesType: upstreamText,
  certification: upstreamText,
  genres: z.array(z.string()).nullish(),
  tags: z.array(upstreamId).nullish(),
  added: upstreamText,
  seasons: z.array(seasonSchema).nullish(),
  statistics: statisticsSchema,
});

type SonarrSeries = z.infer<typeof seriesSchema>;

/**
 * A lookup result is a series resource whose `id` is 0 until it is added, so
 * only its optionality is relaxed here. It stays the same integer identifier
 * `seriesSchema` models, because it is what a media reference is built from.
 */
const lookupSchema = seriesSchema.extend({ id: optionalUpstreamId });

const episodeSchema = z.object({
  id: upstreamId,
  seriesId: upstreamId,
  seasonNumber: upstreamId,
  episodeNumber: upstreamId,
  absoluteEpisodeNumber: optionalUpstreamId,
  title: upstreamText,
  airDate: upstreamText,
  airDateUtc: upstreamText,
  runtime: upstreamNumber,
  overview: upstreamText,
  hasFile: upstreamFlag,
  monitored: upstreamFlag,
  finaleType: upstreamText,
  series: seriesSchema.nullish(),
});

type SonarrEpisode = z.infer<typeof episodeSchema>;

const episodeFileSchema = z.object({
  id: upstreamId,
  seriesId: upstreamId,
  seasonNumber: optionalUpstreamId,
  episodeIds: z.array(upstreamId).nullish(),
  relativePath: upstreamText,
  path: upstreamText,
  size: upstreamNumber,
  dateAdded: upstreamText,
  releaseGroup: upstreamText,
  languages: languageList,
  quality: qualityWrapper.nullish(),
  mediaInfo: mediaInfoSchema,
  customFormats: customFormatList,
  customFormatScore: upstreamNumber,
});

type SonarrEpisodeFile = z.infer<typeof episodeFileSchema>;

type SonarrSeriesDetailFields = Pick<
  SonarrSeries,
  "overview" | "genres" | "runtime" | "certification" | "path"
>;

function seriesDetail(series: SonarrSeriesDetailFields): MediaDetail {
  return {
    overview: text(series.overview),
    genres: textList(series.genres),
    runtimeMinutes: count(series.runtime),
    certification: text(series.certification),
    path: text(series.path),
  };
}

function seriesMonitoring(series: SonarrSeries) {
  const seasons = series.seasons ?? undefined;
  return {
    monitored: flag(series.monitored) ?? false,
    monitoredChildren: seasons?.filter((season) => flag(season.monitored) === true).length,
    totalChildren: seasons?.length,
  };
}

function mapSeries(series: SonarrSeries, detail: DetailLevel): MediaItem {
  const rootFolderPath = text(series.rootFolderPath);
  const qualityProfileId = count(series.qualityProfileId);
  return {
    application,
    ref: mediaRef(application, "series", series.id),
    title: series.title,
    sortTitle: text(series.sortTitle),
    year: count(series.year),
    monitoring: seriesMonitoring(series),
    status: text(series.status),
    added: text(series.added),
    // Omitted rather than zeroed: a series whose instance reported no
    // statistics has an unknown file count, and `fileCount: 0` would state
    // that it has no files.
    statistics: present({
      fileCount: count(series.statistics?.episodeFileCount),
      sizeOnDiskBytes: count(series.statistics?.sizeOnDisk),
    }),
    qualityProfile:
      qualityProfileId === undefined
        ? undefined
        : configurationPointer(application, "quality_profile", qualityProfileId),
    rootFolder:
      detail === "full" && rootFolderPath !== undefined
        ? configurationPointer(application, "root_folder", rootFolderPath)
        : undefined,
    tags: (series.tags ?? undefined)?.map((tag) => configurationPointer(application, "tag", tag)),
    detail: detail === "full" ? present(seriesDetail(series)) : undefined,
    sonarr: {
      kind: "series",
      seriesType: text(series.seriesType),
      network: text(series.network),
      tvdbId: count(series.tvdbId),
      ended: flag(series.ended),
      seasonCount: count(series.statistics?.seasonCount) ?? series.seasons?.length,
    },
  };
}

function mapSeason(series: SonarrSeries, season: z.infer<typeof seasonSchema>): MediaItem {
  return {
    application,
    ref: seasonRef(application, series.id, season.seasonNumber),
    title: `${series.title} — Season ${season.seasonNumber}`,
    monitoring: { monitored: flag(season.monitored) ?? false },
    statistics: present({
      fileCount: count(season.statistics?.episodeFileCount),
      sizeOnDiskBytes: count(season.statistics?.sizeOnDisk),
    }),
    sonarr: {
      kind: "season",
      seriesId: series.id,
      seasonNumber: season.seasonNumber,
      episodeCount: count(season.statistics?.episodeCount),
      episodeFileCount: count(season.statistics?.episodeFileCount),
    },
  };
}

function mapEpisode(episode: SonarrEpisode, detail: DetailLevel): MediaItem {
  const series = episode.series ?? undefined;
  return {
    application,
    ref: mediaRef(application, "episode", episode.id),
    title: text(episode.title) ?? `Episode ${episode.episodeNumber}`,
    monitoring: { monitored: flag(episode.monitored) ?? false },
    detail:
      detail === "full"
        ? present({ overview: text(episode.overview), runtimeMinutes: count(episode.runtime) })
        : undefined,
    sonarr: {
      kind: "episode",
      seriesId: episode.seriesId,
      seriesTitle: series?.title,
      // Aired numbering and absolute numbering are both kept whenever the
      // instance reports both; an anime episode is identified by either.
      seasonNumber: episode.seasonNumber,
      episodeNumber: episode.episodeNumber,
      absoluteEpisodeNumber: count(episode.absoluteEpisodeNumber),
      airDate: text(episode.airDate),
      airDateUtc: text(episode.airDateUtc),
      hasFile: flag(episode.hasFile) ?? false,
      finaleType: text(episode.finaleType),
    },
  };
}

function mapEpisodeFile(file: SonarrEpisodeFile, detail: DetailLevel): MediaFile {
  return {
    application,
    ref: mediaRef(application, "episode_file", file.id),
    parent: mediaRef(application, "series", file.seriesId),
    relativePath: text(file.relativePath),
    sizeBytes: count(file.size),
    dateAdded: text(file.dateAdded),
    quality: text(file.quality?.quality?.name),
    languages: languageNames(file.languages),
    releaseGroup: text(file.releaseGroup),
    detail:
      detail === "full"
        ? present({
            path: text(file.path),
            customFormats: textList((file.customFormats ?? []).map((format) => format.name)),
            customFormatScore: count(file.customFormatScore),
            mediaInfo: mediaInfo(file.mediaInfo),
          })
        : undefined,
    sonarr: {
      seriesId: file.seriesId,
      seasonNumber: count(file.seasonNumber),
      episodeIds: file.episodeIds ?? [],
    },
  };
}

function airedAt(episode: SonarrEpisode): string | undefined {
  return text(episode.airDateUtc) ?? text(episode.airDate);
}

/**
 * A runtime long enough to give an event an end. Zero is how Sonarr says it
 * does not know a runtime, so it has to fall through to the series' own rather
 * than being taken as a real length of zero.
 */
function runtimeOf(value: number | null | undefined): number | undefined {
  const runtime = count(value);
  return runtime !== undefined && runtime > 0 ? runtime : undefined;
}

async function readList<TSchema extends z.ZodType>(
  client: UpstreamClient,
  route: string,
  query: Parameters<UpstreamClient["get"]>[1],
  schema: TSchema,
): Promise<z.infer<TSchema>[]> {
  const body = await client.get(route, query);
  return parseUpstream(z.array(schema), body, application, route);
}

/**
 * Metadata lookup. It reads `series/lookup` and nothing else: a result carries
 * the library record it already matches when Sonarr reports one, and adding a
 * result is not reachable from here.
 */
export async function lookupSeries(
  client: UpstreamClient,
  window: PageWindow,
  request: LibraryRequestFor<"lookup">,
): Promise<AdapterPage<LookupResult>> {
  const results = await readList(
    client,
    sonarrRoutes.seriesLookup,
    { term: request.term },
    lookupSchema,
  );

  return projectPage({
    source: results,
    window,
    map: (result): LookupResult => {
      const existingId = count(result.id);
      const tvdbId = count(result.tvdbId);
      return {
        application,
        ref: tvdbId === undefined ? undefined : mediaRef(application, "series_lookup", tvdbId),
        title: result.title,
        sortTitle: text(result.sortTitle),
        year: count(result.year),
        status: text(result.status),
        existing:
          existingId === undefined || existingId <= 0
            ? undefined
            : mediaRef(application, "series", existingId),
        detail: request.detail === "full" ? present(seriesDetail(result)) : undefined,
        sonarr: {
          tvdbId,
          seriesType: text(result.seriesType),
          network: text(result.network),
        },
      };
    },
  });
}

/** Every series, filtered and bounded here because `series` has no paging. */
export async function listSeries(
  client: UpstreamClient,
  window: PageWindow,
  request: LibraryRequestFor<"series">,
): Promise<AdapterPage<MediaItem>> {
  const series = await readList(client, sonarrRoutes.series, undefined, seriesSchema);
  const wanted = request.ids === undefined ? undefined : new Set(request.ids);

  return projectPage({
    source: series,
    window,
    include: (record) =>
      (wanted === undefined || wanted.has(record.id)) &&
      (request.monitored === undefined || (flag(record.monitored) ?? false) === request.monitored),
    map: (record) => mapSeries(record, request.detail),
  });
}

/** One series' seasons, which Sonarr models only as children of the series. */
export async function listSeasons(
  client: UpstreamClient,
  window: PageWindow,
  request: LibraryRequestFor<"seasons">,
): Promise<AdapterPage<MediaItem>> {
  const route = `${sonarrRoutes.series}/${request.seriesId}`;
  const series = parseUpstream(seriesSchema, await client.get(route), application, route);

  return projectPage({
    source: series.seasons ?? [],
    window,
    include: (season) =>
      request.monitored === undefined || (flag(season.monitored) ?? false) === request.monitored,
    map: (season) => mapSeason(series, season),
  });
}

export async function listEpisodes(
  client: UpstreamClient,
  window: PageWindow,
  request: LibraryRequestFor<"episodes">,
): Promise<AdapterPage<MediaItem>> {
  const episodes = await readList(
    client,
    sonarrRoutes.episode,
    { seriesId: request.seriesId, seasonNumber: request.seasonNumber },
    episodeSchema,
  );

  return projectPage({
    source: episodes,
    window,
    include: (episode) =>
      request.monitored === undefined || (flag(episode.monitored) ?? false) === request.monitored,
    map: (episode) => mapEpisode(episode, request.detail),
  });
}

export async function listEpisodeFiles(
  client: UpstreamClient,
  window: PageWindow,
  request: LibraryRequestFor<"episode_files">,
): Promise<AdapterPage<MediaFile>> {
  const files = await readList(
    client,
    sonarrRoutes.episodeFile,
    { seriesId: request.seriesId },
    episodeFileSchema,
  );

  return projectPage({
    source: files,
    window,
    include: (file) =>
      request.seasonNumber === undefined || count(file.seasonNumber) === request.seasonNumber,
    map: (file) => mapEpisodeFile(file, request.detail),
  });
}

async function readWanted(
  client: UpstreamClient,
  route: string,
  window: PageWindow,
  monitored: boolean | undefined,
): Promise<{ records: SonarrEpisode[]; totalRecords: number | undefined }> {
  const body = await client.get(route, {
    page: pageNumberFor(window),
    pageSize: window.pageSize,
    includeSeries: true,
    monitored,
  });
  const envelope = parseUpstream(pagedEnvelope(episodeSchema), body, application, route);
  return { records: envelope.records, totalRecords: count(envelope.totalRecords) };
}

/**
 * Missing and cutoff-unmet episodes, both served by an upstream-paged endpoint,
 * so the window is applied by the instance rather than projected here.
 *
 * Omitting the monitored filter leaves the instance's own default in force,
 * which returns monitored records only; ask for it explicitly to widen that.
 */
export async function listWantedEpisodes(
  client: UpstreamClient,
  window: PageWindow,
  request: LibraryRequestFor<"missing_episodes"> | LibraryRequestFor<"cutoff_unmet_episodes">,
): Promise<AdapterPage<WantedItem>> {
  const route =
    request.view === "missing_episodes" ? sonarrRoutes.wantedMissing : sonarrRoutes.wantedCutoff;
  const reason = request.view === "missing_episodes" ? "missing" : "cutoff_unmet";
  const { records, totalRecords } = await readWanted(client, route, window, request.monitored);

  return upstreamPage(
    records.map(
      (episode): WantedItem => ({
        media: mapEpisode(episode, request.detail),
        wanted: { reason, expectedAt: airedAt(episode) },
      }),
    ),
    window,
    totalRecords,
  );
}

/**
 * The dated episode window. Sonarr returns only monitored records unless
 * `unmonitored` is set, so an unfiltered query asks for both and a
 * monitored-state filter is applied on top of what comes back.
 */
export async function listCalendar(
  client: UpstreamClient,
  window: PageWindow,
  request: LibraryRequestFor<"calendar">,
): Promise<AdapterPage<CalendarEvent>> {
  const episodes = await readList(
    client,
    sonarrRoutes.calendar,
    {
      start: request.start,
      end: request.end,
      includeSeries: true,
      unmonitored: request.monitored !== true,
    },
    episodeSchema,
  );

  return projectPage({
    source: episodes,
    window,
    include: (episode) =>
      request.monitored === undefined || (flag(episode.monitored) ?? false) === request.monitored,
    map: (episode): CalendarEvent => {
      const start = airedAt(episode);
      return {
        media: mapEpisode(episode, request.detail),
        start,
        end: endOf(start, runtimeOf(episode.runtime) ?? runtimeOf(episode.series?.runtime)),
        hasFile: flag(episode.hasFile) ?? false,
      };
    },
  });
}
