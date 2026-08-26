import type { MediaApplication } from "./model.js";

/**
 * The adapter-facing library request.
 *
 * This is deliberately not the published tool input. The tool layer validates
 * the caller's arguments, resolves every opaque reference into the upstream
 * identifier it stands for, and then builds one of these — so an adapter never
 * sees a process-local token, and a caller never names an upstream identifier.
 */

export const libraryViews = [
  "series",
  "seasons",
  "episodes",
  "episode_files",
  "missing_episodes",
  "cutoff_unmet_episodes",
  "movies",
  "collections",
  "movie_files",
  "missing_movies",
  "cutoff_unmet_movies",
  "calendar",
  "lookup",
] as const;

export type LibraryView = (typeof libraryViews)[number];

/**
 * Which applications model each view.
 *
 * This mirrors the application support the internal operation registry already
 * declares for the `arr_library_query` variants, and a test holds the two
 * lists to each other so a view can never be advertised in one place and
 * refused in the other. Prowlarr appears nowhere: it has no media library, and
 * giving it an empty one would be a false symmetry.
 */
export const libraryViewApplications: Readonly<Record<LibraryView, readonly MediaApplication[]>> = {
  series: ["sonarr"],
  seasons: ["sonarr"],
  episodes: ["sonarr"],
  episode_files: ["sonarr"],
  missing_episodes: ["sonarr"],
  cutoff_unmet_episodes: ["sonarr"],
  movies: ["radarr"],
  collections: ["radarr"],
  movie_files: ["radarr"],
  missing_movies: ["radarr"],
  cutoff_unmet_movies: ["radarr"],
  calendar: ["sonarr", "radarr"],
  lookup: ["sonarr", "radarr"],
};

/**
 * Per-view minimum versions, for a view that needs a newer release than the
 * application's own recorded minimum.
 *
 * Every view here is served by an endpoint that already exists in Sonarr
 * 4.0.19.2979 and Radarr 6.3.0.10514, so the map is empty: the recorded
 * application minimums are sufficient, and raising one without a behavior this
 * code knowingly depends on would reject instances that work.
 */
export const libraryViewMinimumVersions: Readonly<
  Partial<Record<LibraryView, Readonly<Partial<Record<MediaApplication, string>>>>>
> = {};

export type DetailLevel = "summary" | "full";

export interface LibraryPaging {
  readonly pageSize: number;
  /** A continuation minted by a previous page of this same query. */
  readonly cursor?: string | undefined;
}

interface LibraryQueryBase {
  readonly detail: DetailLevel;
  readonly paging: LibraryPaging;
}

export type LibraryQueryRequest =
  | (LibraryQueryBase & {
      readonly view: "series";
      readonly monitored?: boolean | undefined;
      /** Upstream series identifiers, already resolved from media references. */
      readonly ids?: readonly number[] | undefined;
    })
  | (LibraryQueryBase & {
      readonly view: "seasons";
      readonly seriesId: number;
      readonly monitored?: boolean | undefined;
    })
  | (LibraryQueryBase & {
      readonly view: "episodes";
      readonly seriesId: number;
      readonly seasonNumber?: number | undefined;
      readonly monitored?: boolean | undefined;
    })
  | (LibraryQueryBase & {
      readonly view: "episode_files";
      readonly seriesId: number;
      readonly seasonNumber?: number | undefined;
    })
  | (LibraryQueryBase & {
      readonly view: "missing_episodes";
      readonly monitored?: boolean | undefined;
    })
  | (LibraryQueryBase & {
      readonly view: "cutoff_unmet_episodes";
      readonly monitored?: boolean | undefined;
    })
  | (LibraryQueryBase & {
      readonly view: "movies";
      readonly monitored?: boolean | undefined;
      readonly ids?: readonly number[] | undefined;
    })
  | (LibraryQueryBase & {
      readonly view: "collections";
      readonly monitored?: boolean | undefined;
    })
  | (LibraryQueryBase & { readonly view: "movie_files"; readonly movieId: number })
  | (LibraryQueryBase & {
      readonly view: "missing_movies";
      readonly monitored?: boolean | undefined;
    })
  | (LibraryQueryBase & {
      readonly view: "cutoff_unmet_movies";
      readonly monitored?: boolean | undefined;
    })
  | (LibraryQueryBase & {
      readonly view: "calendar";
      /** An inclusive ISO-8601 date window; the tool schema bounds its width. */
      readonly start: string;
      readonly end: string;
      readonly monitored?: boolean | undefined;
    })
  | (LibraryQueryBase & { readonly view: "lookup"; readonly term: string });

export type LibraryRequestFor<TView extends LibraryView> = Extract<
  LibraryQueryRequest,
  { readonly view: TView }
>;

/**
 * The ordered parts a cursor's query digest is built from.
 *
 * The order is fixed here, per view, rather than derived from the object's own
 * property order, and the identifier filter is sorted before it is digested —
 * so naming the same three series in a different order continues the same page
 * rather than minting an incompatible cursor.
 */
export function digestPartsFor(
  application: MediaApplication,
  request: LibraryQueryRequest,
): readonly (string | number | boolean | undefined)[] {
  const shared = [application, request.view, request.detail, request.paging.pageSize] as const;
  switch (request.view) {
    case "series":
    case "movies":
      return [...shared, request.monitored, ...[...(request.ids ?? [])].sort((a, b) => a - b)];
    case "seasons":
      return [...shared, request.seriesId, request.monitored];
    case "episodes":
      return [...shared, request.seriesId, request.seasonNumber, request.monitored];
    case "episode_files":
      return [...shared, request.seriesId, request.seasonNumber];
    case "movie_files":
      return [...shared, request.movieId];
    case "missing_episodes":
    case "cutoff_unmet_episodes":
    case "missing_movies":
    case "cutoff_unmet_movies":
    case "collections":
      return [...shared, request.monitored];
    case "calendar":
      return [...shared, request.start, request.end, request.monitored];
    case "lookup":
      return [...shared, request.term];
  }
}
