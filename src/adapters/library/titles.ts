import { z } from "zod";
import type { UpstreamClient } from "../../http/client.js";
import { UpstreamError } from "../../http/errors.js";
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
 * Every route here is a GET, and each is one a recorded fixture covers: the
 * library list, a series' episodes, and a series' episode files.
 */

export const libraryTitleRoutes = {
  series: "series",
  movie: "movie",
  episode: "episode",
  episodeFile: "episodefile",
} as const;

/** The library route each application lists its titles on. */
const titleRoutes: Readonly<Record<MediaApplication, { readonly route: string }>> = {
  sonarr: { route: libraryTitleRoutes.series },
  radarr: { route: libraryTitleRoutes.movie },
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
  movieFile: z.object({ quality: qualitySchema }).nullish(),
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
  /** Movies only: the vertical resolution of the file the record holds, where it names one. */
  readonly fileResolution?: number | undefined;
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
    fileResolution:
      application === "radarr" ? qualityResolution(record.movieFile?.quality) : undefined,
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
 * The whole library is read and the identifier matched here. Both supported
 * versions document a filter by metadata identifier on the same route, but
 * which of them honours it has not been established against a live instance,
 * and the unfiltered list is the answer a recorded fixture covers; whether the
 * filtered route is ever adopted waits on that capture.
 */
export async function readLibraryTitleByExternalId(
  client: UpstreamClient,
  application: MediaApplication,
  externalId: number,
): Promise<LibraryTitle | undefined> {
  return (await readLibraryTitles(client, application)).find(
    (title) => title.externalId === externalId,
  );
}

/** The library record with one library identifier, read the same way. */
export async function readLibraryTitleById(
  client: UpstreamClient,
  application: MediaApplication,
  id: number,
): Promise<LibraryTitle | undefined> {
  return (await readLibraryTitles(client, application)).find((title) => title.id === id);
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
 * Asked of the instance by series, and matched to that series here as well;
 * see {@link ownRecords}. A season is
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
  return ownRecords(records, seriesId, route)
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

/**
 * One series' records out of an answer to a series-scoped read.
 *
 * The scope is matched here as well as asked for, because an instance that
 * ignored it answers with every series' records. A record that names another
 * series is left out; one that names none fails the read, since it could be
 * any series' and counting it in or leaving it out would both be a guess.
 */
function ownRecords<TRecord extends { readonly seriesId?: number | null | undefined }>(
  records: readonly TRecord[],
  seriesId: number,
  route: string,
): TRecord[] {
  if (records.some((record) => record.seriesId === undefined || record.seriesId === null)) {
    throw new UpstreamError("unexpected-response", { application: "sonarr", operation: route });
  }
  return records.filter((record) => record.seriesId === seriesId);
}

const fileQualitySchema = z.object({
  seriesId: optionalUpstreamId,
  quality: qualitySchema,
});

/**
 * The vertical resolution of every episode file the library holds for one
 * series, one entry per file that names one, in the order the instance listed
 * them. A movie's single file is described by its own library record instead.
 */
export async function readEpisodeFileResolutions(
  client: UpstreamClient,
  seriesId: number,
): Promise<readonly number[]> {
  const route = libraryTitleRoutes.episodeFile;
  const records = parseUpstream(
    z.array(fileQualitySchema),
    await client.get(route, { seriesId }),
    "sonarr",
    route,
  );
  return ownRecords(records, seriesId, route)
    .map((record) => qualityResolution(record.quality))
    .filter((pixels): pixels is number => pixels !== undefined);
}
