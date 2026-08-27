import { z } from "zod";
import type { UpstreamClient } from "../../http/client.js";
import type {
  CalendarEvent,
  LookupResult,
  MediaDetail,
  MediaFile,
  MediaItem,
  RadarrReleaseDates,
  RadarrReleaseDateType,
  WantedItem,
} from "./model.js";
import { configurationPointer, mediaRef, radarrReleaseDateTypes } from "./model.js";
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
 * The Radarr library read adapters.
 *
 * Each function owns one view: it names its own upstream route, maps the
 * response into the normalized model, and returns a bounded page. None of them
 * writes anything — every route here is a GET, and no add, edit, monitor, or
 * delete path is reachable from this module.
 */

const application = "radarr" as const;

export const radarrRoutes = {
  movie: "movie",
  movieLookup: "movie/lookup",
  collection: "collection",
  movieFile: "moviefile",
  wantedMissing: "wanted/missing",
  wantedCutoff: "wanted/cutoff",
  calendar: "calendar",
} as const;

const alternateTitleSchema = z.object({ title: upstreamText });

const collectionIdentitySchema = z
  .object({ title: upstreamText, tmdbId: upstreamNumber })
  .nullish();

const movieSchema = z.object({
  id: upstreamId,
  title: z.string(),
  sortTitle: upstreamText,
  originalTitle: upstreamText,
  status: upstreamText,
  overview: upstreamText,
  year: upstreamNumber,
  runtime: upstreamNumber,
  path: upstreamText,
  rootFolderPath: upstreamText,
  qualityProfileId: upstreamNumber,
  monitored: upstreamFlag,
  minimumAvailability: upstreamText,
  hasFile: upstreamFlag,
  sizeOnDisk: upstreamNumber,
  tmdbId: upstreamNumber,
  imdbId: upstreamText,
  studio: upstreamText,
  certification: upstreamText,
  genres: z.array(z.string()).nullish(),
  tags: z.array(upstreamId).nullish(),
  added: upstreamText,
  inCinemas: upstreamText,
  physicalRelease: upstreamText,
  digitalRelease: upstreamText,
  collection: collectionIdentitySchema,
  alternateTitles: z.array(alternateTitleSchema).nullish(),
});

type RadarrMovie = z.infer<typeof movieSchema>;

/**
 * A lookup result is a movie resource whose `id` is 0 until it is added, so
 * only its optionality is relaxed here. It stays the same integer identifier
 * `movieSchema` models, because it is what a media reference is built from.
 */
const lookupSchema = movieSchema.extend({ id: optionalUpstreamId });

const collectionSchema = z.object({
  id: upstreamId,
  title: z.string(),
  sortTitle: upstreamText,
  tmdbId: upstreamNumber,
  overview: upstreamText,
  monitored: upstreamFlag,
  qualityProfileId: upstreamNumber,
  rootFolderPath: upstreamText,
  searchOnAdd: upstreamFlag,
  genres: z.array(z.string()).nullish(),
  movies: z.array(z.object({ tmdbId: upstreamNumber, monitored: upstreamFlag })).nullish(),
});

const movieFileSchema = z.object({
  id: upstreamId,
  movieId: upstreamId,
  relativePath: upstreamText,
  path: upstreamText,
  size: upstreamNumber,
  dateAdded: upstreamText,
  releaseGroup: upstreamText,
  edition: upstreamText,
  languages: languageList,
  quality: qualityWrapper.nullish(),
  mediaInfo: mediaInfoSchema,
  customFormats: customFormatList,
  customFormatScore: upstreamNumber,
});

type RadarrMovieFile = z.infer<typeof movieFileSchema>;

type RadarrMovieDetailFields = Pick<
  RadarrMovie,
  "overview" | "genres" | "runtime" | "certification" | "path" | "alternateTitles"
>;

function movieDetail(movie: RadarrMovieDetailFields): MediaDetail {
  return {
    overview: text(movie.overview),
    genres: textList(movie.genres),
    runtimeMinutes: count(movie.runtime),
    certification: text(movie.certification),
    path: text(movie.path),
    alternateTitles: textList((movie.alternateTitles ?? []).map((entry) => entry.title)),
  };
}

function releaseDates(movie: RadarrMovie): RadarrReleaseDates {
  return {
    inCinemas: text(movie.inCinemas),
    physicalRelease: text(movie.physicalRelease),
    digitalRelease: text(movie.digitalRelease),
  };
}

/** The instant a movie became available, preferring the most specific date. */
function releasedAt(movie: RadarrMovie): string | undefined {
  return text(movie.digitalRelease) ?? text(movie.physicalRelease) ?? text(movie.inCinemas);
}

/** One date a movie could be anchored to, and which of the three it is. */
interface ReleaseDateCandidate {
  readonly at: string;
  readonly type: RadarrReleaseDateType;
  readonly instant: number;
}

/**
 * The inclusive instants a calendar request asked for.
 *
 * Both bounds are dates rather than instants and both are inclusive, so the end
 * covers the whole of its own day. A bound that does not parse yields no window
 * at all rather than a half-open one, which leaves the anchor to fall back
 * rather than to be selected against a range that was never asked for.
 */
function requestedWindow(
  request: LibraryRequestFor<"calendar">,
): { readonly from: number; readonly to: number } | undefined {
  const from = Date.parse(`${request.start}T00:00:00.000Z`);
  const to = Date.parse(`${request.end}T23:59:59.999Z`);
  return Number.isNaN(from) || Number.isNaN(to) ? undefined : { from, to };
}

/**
 * A movie's release dates, earliest first.
 *
 * A date the instance did not report, or reported unparsably, is left out: it
 * cannot be shown to fall inside any window, and anchoring to it would report a
 * start no consumer can place. Two candidates on the same instant keep the
 * declared order of {@link radarrReleaseDateTypes}, because `sort` is stable.
 */
function releaseDateCandidates(movie: RadarrMovie): readonly ReleaseDateCandidate[] {
  const dates = releaseDates(movie);
  return radarrReleaseDateTypes
    .flatMap((type): ReleaseDateCandidate[] => {
      const at = dates[type];
      if (at === undefined) {
        return [];
      }
      const instant = Date.parse(at);
      return Number.isNaN(instant) ? [] : [{ at, type, instant }];
    })
    .sort((left, right) => left.instant - right.instant);
}

/**
 * The date one calendar entry is anchored to.
 *
 * Radarr places a movie in a window when any of its three release dates falls
 * inside it, so the anchor is selected against the requested window rather than
 * by a fixed precedence — the same movie belongs on its digital release in one
 * month and on its physical release in another. The earliest candidate inside
 * the window wins, which is deterministic and does not depend on which field a
 * caller happens to care about.
 *
 * A movie Radarr returned whose candidates all fall outside the window keeps
 * its entry and is anchored to its earliest candidate: Radarr was right to
 * return it, and dropping it or blanking its date would lose a real result. The
 * anchor names its own date type either way, so a consumer can tell the two
 * cases apart by comparing the anchor against the window it asked for.
 */
function calendarAnchor(
  movie: RadarrMovie,
  window: ReturnType<typeof requestedWindow>,
): ReleaseDateCandidate | undefined {
  const candidates = releaseDateCandidates(movie);
  const inside =
    window === undefined
      ? undefined
      : candidates.find(
          (candidate) => candidate.instant >= window.from && candidate.instant <= window.to,
        );
  return inside ?? candidates[0];
}

function mapMovie(movie: RadarrMovie, detail: DetailLevel): MediaItem {
  const rootFolderPath = text(movie.rootFolderPath);
  const qualityProfileId = count(movie.qualityProfileId);
  const collection = movie.collection ?? undefined;
  const hasFile = flag(movie.hasFile);
  return {
    application,
    ref: mediaRef(application, "movie", movie.id),
    title: movie.title,
    sortTitle: text(movie.sortTitle),
    year: count(movie.year),
    monitoring: { monitored: flag(movie.monitored) ?? false },
    status: text(movie.status),
    added: text(movie.added),
    // Omitted rather than zeroed: a movie whose instance reported neither a
    // file flag nor a size on disk has an unknown file count, and
    // `fileCount: 0` would state that it has no file.
    statistics: present({
      fileCount: hasFile === undefined ? undefined : Number(hasFile),
      sizeOnDiskBytes: count(movie.sizeOnDisk),
    }),
    qualityProfile:
      qualityProfileId === undefined
        ? undefined
        : configurationPointer(application, "quality_profile", qualityProfileId),
    rootFolder:
      detail === "full" && rootFolderPath !== undefined
        ? configurationPointer(application, "root_folder", rootFolderPath)
        : undefined,
    tags: (movie.tags ?? undefined)?.map((tag) => configurationPointer(application, "tag", tag)),
    detail: detail === "full" ? present(movieDetail(movie)) : undefined,
    radarr: {
      kind: "movie",
      tmdbId: count(movie.tmdbId),
      imdbId: text(movie.imdbId),
      minimumAvailability: text(movie.minimumAvailability),
      hasFile: hasFile ?? false,
      studio: text(movie.studio),
      collection:
        collection === null || collection === undefined
          ? undefined
          : present({ tmdbId: count(collection.tmdbId), title: text(collection.title) }),
      releaseDates: present(releaseDates(movie)),
    },
  };
}

function mapCollection(
  collection: z.infer<typeof collectionSchema>,
  detail: DetailLevel,
): MediaItem {
  const movies = collection.movies ?? undefined;
  const qualityProfileId = count(collection.qualityProfileId);
  const rootFolderPath = text(collection.rootFolderPath);
  return {
    application,
    ref: mediaRef(application, "collection", collection.id),
    title: collection.title,
    sortTitle: text(collection.sortTitle),
    monitoring: {
      monitored: flag(collection.monitored) ?? false,
      monitoredChildren: movies?.filter((movie) => flag(movie.monitored) === true).length,
      totalChildren: movies?.length,
    },
    qualityProfile:
      qualityProfileId === undefined
        ? undefined
        : configurationPointer(application, "quality_profile", qualityProfileId),
    rootFolder:
      detail === "full" && rootFolderPath !== undefined
        ? configurationPointer(application, "root_folder", rootFolderPath)
        : undefined,
    // The member list itself is a large nested payload, so a collection reports
    // how many movies it holds rather than carrying them.
    detail:
      detail === "full"
        ? present({ overview: text(collection.overview), genres: textList(collection.genres) })
        : undefined,
    radarr: {
      kind: "collection",
      tmdbId: count(collection.tmdbId),
      movieCount: movies?.length,
      searchOnAdd: flag(collection.searchOnAdd),
    },
  };
}

function mapMovieFile(file: RadarrMovieFile, detail: DetailLevel): MediaFile {
  return {
    application,
    ref: mediaRef(application, "movie_file", file.id),
    parent: mediaRef(application, "movie", file.movieId),
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
    radarr: { movieId: file.movieId, edition: text(file.edition) },
  };
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
 * Metadata lookup. It reads `movie/lookup` and nothing else: a result carries
 * the library record it already matches when Radarr reports one, and adding a
 * result is not reachable from here.
 */
export async function lookupMovies(
  client: UpstreamClient,
  window: PageWindow,
  request: LibraryRequestFor<"lookup">,
): Promise<AdapterPage<LookupResult>> {
  const results = await readList(
    client,
    radarrRoutes.movieLookup,
    { term: request.term },
    lookupSchema,
  );

  return projectPage({
    source: results,
    window,
    map: (result): LookupResult => {
      const existingId = count(result.id);
      return {
        application,
        title: result.title,
        sortTitle: text(result.sortTitle),
        year: count(result.year),
        status: text(result.status),
        existing:
          existingId === undefined || existingId <= 0
            ? undefined
            : mediaRef(application, "movie", existingId),
        detail: request.detail === "full" ? present(movieDetail(result)) : undefined,
        radarr: {
          tmdbId: count(result.tmdbId),
          imdbId: text(result.imdbId),
          studio: text(result.studio),
        },
      };
    },
  });
}

/** Every movie, filtered and bounded here because `movie` has no paging. */
export async function listMovies(
  client: UpstreamClient,
  window: PageWindow,
  request: LibraryRequestFor<"movies">,
): Promise<AdapterPage<MediaItem>> {
  const movies = await readList(client, radarrRoutes.movie, undefined, movieSchema);
  const wanted = request.ids === undefined ? undefined : new Set(request.ids);

  return projectPage({
    source: movies,
    window,
    include: (movie) =>
      (wanted === undefined || wanted.has(movie.id)) &&
      (request.monitored === undefined || (flag(movie.monitored) ?? false) === request.monitored),
    map: (movie) => mapMovie(movie, request.detail),
  });
}

export async function listCollections(
  client: UpstreamClient,
  window: PageWindow,
  request: LibraryRequestFor<"collections">,
): Promise<AdapterPage<MediaItem>> {
  const collections = await readList(client, radarrRoutes.collection, undefined, collectionSchema);

  return projectPage({
    source: collections,
    window,
    include: (collection) =>
      request.monitored === undefined ||
      (flag(collection.monitored) ?? false) === request.monitored,
    map: (collection) => mapCollection(collection, request.detail),
  });
}

export async function listMovieFiles(
  client: UpstreamClient,
  window: PageWindow,
  request: LibraryRequestFor<"movie_files">,
): Promise<AdapterPage<MediaFile>> {
  const files = await readList(
    client,
    radarrRoutes.movieFile,
    { movieId: request.movieId },
    movieFileSchema,
  );

  return projectPage({
    source: files,
    window,
    map: (file) => mapMovieFile(file, request.detail),
  });
}

/**
 * Missing and cutoff-unmet movies, both served by an upstream-paged endpoint,
 * so the window is applied by the instance rather than projected here.
 *
 * Omitting the monitored filter leaves the instance's own default in force,
 * which returns monitored records only; ask for it explicitly to widen that.
 */
export async function listWantedMovies(
  client: UpstreamClient,
  window: PageWindow,
  request: LibraryRequestFor<"missing_movies"> | LibraryRequestFor<"cutoff_unmet_movies">,
): Promise<AdapterPage<WantedItem>> {
  const route =
    request.view === "missing_movies" ? radarrRoutes.wantedMissing : radarrRoutes.wantedCutoff;
  const reason = request.view === "missing_movies" ? "missing" : "cutoff_unmet";
  const body = await client.get(route, {
    page: pageNumberFor(window),
    pageSize: window.pageSize,
    monitored: request.monitored,
  });
  const envelope = parseUpstream(pagedEnvelope(movieSchema), body, application, route);

  return upstreamPage(
    envelope.records.map(
      (movie): WantedItem => ({
        media: mapMovie(movie, request.detail),
        wanted: { reason, expectedAt: releasedAt(movie) },
      }),
    ),
    window,
    count(envelope.totalRecords),
  );
}

/**
 * The dated movie window. Radarr returns only monitored records unless
 * `unmonitored` is set, so an unfiltered query asks for both and a
 * monitored-state filter is applied on top of what comes back.
 *
 * Each entry's anchor is selected against the window the caller asked for
 * rather than by a fixed release-date precedence; see {@link calendarAnchor},
 * which also defines what a record with no candidate inside the window
 * anchors to.
 */
export async function listCalendar(
  client: UpstreamClient,
  window: PageWindow,
  request: LibraryRequestFor<"calendar">,
): Promise<AdapterPage<CalendarEvent>> {
  const movies = await readList(
    client,
    radarrRoutes.calendar,
    { start: request.start, end: request.end, unmonitored: request.monitored !== true },
    movieSchema,
  );
  const requested = requestedWindow(request);

  return projectPage({
    source: movies,
    window,
    include: (movie) =>
      request.monitored === undefined || (flag(movie.monitored) ?? false) === request.monitored,
    map: (movie): CalendarEvent => {
      const anchor = calendarAnchor(movie, requested);
      const start = anchor?.at;
      return {
        media: mapMovie(movie, request.detail),
        start,
        end: endOf(start, count(movie.runtime)),
        hasFile: flag(movie.hasFile) ?? false,
        radarr: anchor === undefined ? undefined : { anchor: anchor.type },
      };
    },
  });
}
