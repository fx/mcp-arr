import { z } from "zod";
import type { UpstreamClient } from "../../http/client.js";
import { qualityResolution, qualitySchema } from "../activity/parse.js";
import type { MediaApplication } from "./model.js";
import {
  count,
  flag,
  optionalUpstreamId,
  parseUpstream,
  text,
  upstreamFlag,
  upstreamId,
  upstreamText,
} from "./parse.js";

/**
 * Narrow reads of library records, for the `media` toolset.
 *
 * The library views the `arr` toolset publishes map a record into a model
 * whose flags default — a record that does not say whether it has a file is
 * mapped as having none — and that is the one answer a decision about
 * importing or searching must not be given on a record's silence. So these
 * readers keep exactly the fields those decisions read, and keep an absent
 * flag absent: `hasFile` is `true`, `false`, or `undefined`, and only `false`
 * means the library has no file.
 *
 * Titles are returned as the instance wrote them. They are upstream text, and
 * the tool layer publishes them only through its own sanitizer, which knows
 * the configured keys this layer does not.
 *
 * Every route here is a GET.
 */

export const libraryTitleRoutes = {
  series: "series",
  movie: "movie",
  episode: "episode",
  episodeFile: "episodefile",
  movieFile: "moviefile",
} as const;

/** The library route and metadata identifier each application files a title under. */
const titleRoutes: Readonly<
  Record<MediaApplication, { readonly route: string; readonly parameter: "tvdbId" | "tmdbId" }>
> = {
  sonarr: { route: libraryTitleRoutes.series, parameter: "tvdbId" },
  radarr: { route: libraryTitleRoutes.movie, parameter: "tmdbId" },
};

const titleRecordSchema = z.object({
  id: upstreamId,
  title: upstreamText,
  tvdbId: optionalUpstreamId,
  tmdbId: optionalUpstreamId,
  monitored: upstreamFlag,
  qualityProfileId: optionalUpstreamId,
  hasFile: upstreamFlag,
  isAvailable: upstreamFlag,
  inCinemas: upstreamText,
  physicalRelease: upstreamText,
  digitalRelease: upstreamText,
});

type TitleUpstream = z.infer<typeof titleRecordSchema>;

/** One series or movie in the library, as the decisions over it read it. */
export interface LibraryTitle {
  readonly application: MediaApplication;
  /** The library record's own identifier. */
  readonly id: number;
  /** The TVDB id of a series or the TMDB id of a movie, where the record carries one. */
  readonly externalId?: number | undefined;
  /** Upstream text, unsanitized; see the module note. */
  readonly title?: string | undefined;
  readonly monitored?: boolean | undefined;
  readonly qualityProfileId?: number | undefined;
  /** Movies only. Absent where the record does not say. */
  readonly hasFile?: boolean | undefined;
  /** Movies only: whether the movie counts as released. */
  readonly isAvailable?: boolean | undefined;
  /** Movies only: every release date the record states, as reported. */
  readonly releaseDates: readonly string[];
}

function positiveId(value: number | null | undefined): number | undefined {
  const id = count(value);
  return id !== undefined && Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

function mapTitle(application: MediaApplication, record: TitleUpstream): LibraryTitle {
  const external = application === "sonarr" ? record.tvdbId : record.tmdbId;
  return {
    application,
    id: record.id,
    externalId: positiveId(external),
    title: text(record.title),
    monitored: flag(record.monitored),
    qualityProfileId: positiveId(record.qualityProfileId),
    hasFile: application === "radarr" ? flag(record.hasFile) : undefined,
    isAvailable: application === "radarr" ? flag(record.isAvailable) : undefined,
    releaseDates: [record.inCinemas, record.physicalRelease, record.digitalRelease]
      .map((date) => text(date))
      .filter((date): date is string => date !== undefined),
  };
}

/** Every series or movie in the library, in the order the instance listed them. */
export async function readLibraryTitles(
  client: UpstreamClient,
  application: MediaApplication,
): Promise<readonly LibraryTitle[]> {
  const { route } = titleRoutes[application];
  const records = parseUpstream(
    z.array(titleRecordSchema),
    await client.get(route),
    application,
    route,
  );
  return records.map((record) => mapTitle(application, record));
}

/**
 * The library record filed under one metadata identifier, or `undefined` for
 * a title that is not in the library.
 *
 * The request asks the instance to filter by that identifier, and the answer
 * is matched against it here as well. Both supported versions document the
 * filter, but which of them honours it has not been established against a
 * live instance; matching locally makes the answer the same either way — an
 * instance that ignores the filter answers the whole library, and the one
 * record with that identifier is still the only one returned.
 */
export async function readLibraryTitleByExternalId(
  client: UpstreamClient,
  application: MediaApplication,
  externalId: number,
): Promise<LibraryTitle | undefined> {
  const { route, parameter } = titleRoutes[application];
  const records = parseUpstream(
    z.array(titleRecordSchema),
    await client.get(route, { [parameter]: externalId }),
    application,
    route,
  );
  return records
    .map((record) => mapTitle(application, record))
    .find((title) => title.externalId === externalId);
}

const episodeStateSchema = z.object({
  id: upstreamId,
  seriesId: optionalUpstreamId,
  seasonNumber: optionalUpstreamId,
  episodeNumber: optionalUpstreamId,
  hasFile: upstreamFlag,
  monitored: upstreamFlag,
  airDateUtc: upstreamText,
});

/** One episode of a series, as the decisions over it read it. */
export interface EpisodeState {
  readonly id: number;
  readonly seasonNumber?: number | undefined;
  readonly episodeNumber?: number | undefined;
  /** Absent where the record does not say; only `false` means no file. */
  readonly hasFile?: boolean | undefined;
  readonly monitored?: boolean | undefined;
  readonly airDateUtc?: string | undefined;
}

function ordinal(value: number | null | undefined): number | undefined {
  const number = count(value);
  return number !== undefined && Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}

/**
 * Every episode of one series, or of one season of it.
 *
 * Asked of the instance by series, and matched to that series here as well,
 * for the same reason the title read matches its identifier. A season is
 * selected here rather than upstream, so both scopes are answered by the one
 * request a recorded fixture covers.
 */
export async function readEpisodeStates(
  client: UpstreamClient,
  seriesId: number,
  seasonNumber?: number | undefined,
): Promise<readonly EpisodeState[]> {
  const route = libraryTitleRoutes.episode;
  const records = parseUpstream(
    z.array(episodeStateSchema),
    await client.get(route, { seriesId }),
    "sonarr",
    route,
  );
  return records
    .filter(
      (record) =>
        record.seriesId === undefined || record.seriesId === null || record.seriesId === seriesId,
    )
    .map(
      (record): EpisodeState => ({
        id: record.id,
        seasonNumber: ordinal(record.seasonNumber),
        episodeNumber: ordinal(record.episodeNumber),
        hasFile: flag(record.hasFile),
        monitored: flag(record.monitored),
        airDateUtc: text(record.airDateUtc),
      }),
    )
    .filter((episode) => seasonNumber === undefined || episode.seasonNumber === seasonNumber);
}

const fileQualitySchema = z.object({
  seriesId: optionalUpstreamId,
  movieId: optionalUpstreamId,
  quality: qualitySchema,
});

/**
 * The vertical resolution of every file the library holds for one series or
 * movie, one entry per file that names one, in the order the instance listed
 * them. A file whose quality names no resolution contributes nothing.
 */
export async function readFileResolutions(
  client: UpstreamClient,
  application: MediaApplication,
  mediaId: number,
): Promise<readonly number[]> {
  const route =
    application === "sonarr" ? libraryTitleRoutes.episodeFile : libraryTitleRoutes.movieFile;
  const parameter = application === "sonarr" ? "seriesId" : "movieId";
  const records = parseUpstream(
    z.array(fileQualitySchema),
    await client.get(route, { [parameter]: mediaId }),
    application,
    route,
  );
  return records
    .filter((record) => {
      const owner = application === "sonarr" ? record.seriesId : record.movieId;
      return owner === undefined || owner === null || owner === mediaId;
    })
    .map((record) => qualityResolution(record.quality))
    .filter((pixels): pixels is number => pixels !== undefined);
}
