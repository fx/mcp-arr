import type { ApplicationId } from "../../applications.js";

/**
 * The adapter-facing release-search request.
 *
 * This is deliberately not the published tool input. The tool layer validates
 * the caller's arguments and resolves every opaque media reference into the
 * upstream identifier it stands for before building one of these, so an adapter
 * never sees a process-local token and a caller never names an upstream
 * identifier. Registering the tool is change 0005's later work; this module
 * only states the shape the adapters answer.
 */

export const releaseSearchTargets = [
  "sonarr_episode",
  "sonarr_season",
  "radarr_movie",
  "prowlarr_aggregate",
] as const;

export type ReleaseSearchTarget = (typeof releaseSearchTargets)[number];

/**
 * Which applications model each search target.
 *
 * This mirrors the application support the internal operation registry already
 * declares for the `arr_release_search` variants, and a test holds the two
 * lists to each other so a target can never be advertised in one place and
 * refused in the other.
 */
export const releaseSearchApplications: Readonly<
  Record<ReleaseSearchTarget, readonly ApplicationId[]>
> = {
  sonarr_episode: ["sonarr"],
  sonarr_season: ["sonarr"],
  radarr_movie: ["radarr"],
  prowlarr_aggregate: ["prowlarr"],
};

/**
 * Per-target minimum versions, for a target that needs a newer release than the
 * application's own recorded minimum.
 *
 * Every target here is served by an endpoint that already exists in Sonarr
 * 4.0.19.2979, Radarr 6.3.0.10514, and Prowlarr 2.5.2.5491, so the map is
 * empty: the recorded application minimums are sufficient, and raising one
 * without a behavior this code knowingly depends on would reject instances that
 * work.
 */
export const releaseSearchMinimumVersions: Readonly<
  Partial<Record<ReleaseSearchTarget, Readonly<Partial<Record<ApplicationId, string>>>>>
> = {};

export type ReleaseDetailLevel = "summary" | "full";

export interface ReleasePaging {
  readonly pageSize: number;
  /** A continuation minted by a previous page of this same search. */
  readonly cursor?: string | undefined;
}

interface ReleaseSearchBase {
  readonly detail: ReleaseDetailLevel;
  readonly paging: ReleasePaging;
}

export type ReleaseSearchRequest =
  | (ReleaseSearchBase & { readonly target: "sonarr_episode"; readonly episodeId: number })
  | (ReleaseSearchBase & {
      readonly target: "sonarr_season";
      readonly seriesId: number;
      readonly seasonNumber: number;
    })
  | (ReleaseSearchBase & { readonly target: "radarr_movie"; readonly movieId: number })
  | (ReleaseSearchBase & { readonly target: "prowlarr_aggregate"; readonly term: string });

/**
 * The automatic searches `arr_search_start` can begin.
 *
 * Interactive search and automatic search are deliberately separate target
 * sets. An interactive search asks the indexers now and hands the caller the
 * releases; an automatic search asks the application to go and do the whole
 * thing on its own, grab included. The first is a read, the second starts a
 * job, so nothing is shared between the two lists but the naming style.
 */
export const searchStartTargets = [
  "sonarr_episode",
  "sonarr_season",
  "sonarr_series",
  "radarr_movie",
  "missing",
  "cutoff_unmet",
] as const;

export type SearchStartTarget = (typeof searchStartTargets)[number];

/**
 * Which applications model each automatic search.
 *
 * As with the interactive targets, this mirrors what the internal operation
 * registry declares for the `arr_search_start` variants, and a test holds the
 * two lists to each other so a target can never be advertised in one place and
 * refused in the other. Prowlarr appears nowhere: it has no library to search
 * for and no command that would do it.
 */
export const searchStartApplications: Readonly<
  Record<SearchStartTarget, readonly ApplicationId[]>
> = {
  sonarr_episode: ["sonarr"],
  sonarr_season: ["sonarr"],
  sonarr_series: ["sonarr"],
  radarr_movie: ["radarr"],
  missing: ["sonarr", "radarr"],
  cutoff_unmet: ["sonarr", "radarr"],
};

/**
 * Per-target minimum versions for the automatic searches.
 *
 * Empty for the same reason {@link releaseSearchMinimumVersions} is: every
 * command in the allowlist already exists in the recorded application minimums,
 * and raising one without a behavior this code knowingly depends on would
 * reject instances that work.
 */
export const searchStartMinimumVersions: Readonly<
  Partial<Record<SearchStartTarget, Readonly<Partial<Record<ApplicationId, string>>>>>
> = {};

/**
 * The adapter-facing automatic-search request.
 *
 * Like {@link ReleaseSearchRequest} this is not the published tool input: the
 * tool layer has already turned every opaque media reference into the upstream
 * identifier it stands for, so an adapter never sees a process-local token.
 */
export type SearchStartRequest =
  | { readonly target: "sonarr_episode"; readonly episodeIds: readonly number[] }
  | {
      readonly target: "sonarr_season";
      readonly seriesId: number;
      readonly seasonNumber: number;
    }
  | { readonly target: "sonarr_series"; readonly seriesId: number }
  | { readonly target: "radarr_movie"; readonly movieIds: readonly number[] }
  | { readonly target: "missing"; readonly monitoredOnly: boolean }
  | { readonly target: "cutoff_unmet"; readonly monitoredOnly: boolean };

export type ReleaseRequestFor<TTarget extends ReleaseSearchTarget> = Extract<
  ReleaseSearchRequest,
  { readonly target: TTarget }
>;

/**
 * The ordered parts a cursor's query digest is built from.
 *
 * The order is fixed here, per target, rather than derived from the object's
 * own property order, so the same search always digests to the same value and a
 * cursor cannot be paged into a search whose target moved.
 */
export function digestPartsFor(
  application: ApplicationId,
  request: ReleaseSearchRequest,
): readonly (string | number | boolean | undefined)[] {
  const shared = [application, request.target, request.detail, request.paging.pageSize] as const;
  switch (request.target) {
    case "sonarr_episode":
      return [...shared, request.episodeId];
    case "sonarr_season":
      return [...shared, request.seriesId, request.seasonNumber];
    case "radarr_movie":
      return [...shared, request.movieId];
    case "prowlarr_aggregate":
      return [...shared, request.term];
  }
}
