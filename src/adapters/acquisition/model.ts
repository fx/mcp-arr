import type { ApplicationId } from "../../applications.js";

/**
 * The normalized release model.
 *
 * Two rules hold everywhere in this file, and they are the reason the module
 * exists at all. Nothing a caller can see carries a protected download URL, a
 * magnet link, or an upstream cache key: the identity a later grab needs lives
 * in {@link ReleaseCacheIdentity}, which is deliberately a separate object that
 * travels beside a candidate rather than inside it. And every
 * application-specific field lives inside a namespaced property that the
 * `application` discriminant selects, so a consumer can always tell a shared
 * normalized field from a Sonarr-only, Radarr-only, or Prowlarr-only one.
 *
 * Optional properties are declared as `?: T | undefined` rather than omitted,
 * following the library model: a mapping reads an upstream field that may
 * legitimately be absent, and saying so once is clearer than conditionally
 * spreading every property.
 */

/** The transport an indexer delivers a release over. */
export const releaseProtocols = ["torrent", "usenet", "unknown"] as const;

export type ReleaseProtocol = (typeof releaseProtocols)[number];

/**
 * Which indexer offered a release.
 *
 * The identifier is kept because it is half of the upstream cache identity, and
 * the name because it is the only part of an indexer a caller can meaningfully
 * reason about. Neither is a URL.
 */
export interface ReleaseIndexer {
  readonly id?: number | undefined;
  readonly name?: string | undefined;
}

/**
 * Whether a rejection can ever stop applying.
 *
 * A permanent rejection describes the release itself — a quality the profile
 * does not want — and will read the same way tomorrow. A temporary one
 * describes the moment, so the same release may be accepted later. `unknown`
 * is what an instance that reports a bare reason string gets, rather than
 * having one of the two asserted for it.
 */
export const releaseRejectionTypes = ["permanent", "temporary", "unknown"] as const;

export type ReleaseRejectionType = (typeof releaseRejectionTypes)[number];

export interface ReleaseRejection {
  /**
   * The application's own wording, with any embedded link, credential,
   * canonical server path, or upstream cache identity removed. It is the one
   * free-form sentence an application composes for itself, so it is the one
   * that has to be scrubbed rather than merely mapped.
   */
  readonly reason: string;
  readonly type: ReleaseRejectionType;
}

/**
 * What the application decided about a release.
 *
 * This is present only where an application actually decides. Sonarr and Radarr
 * run a release through their own profile and custom-format rules during an
 * interactive search, so their results carry a decision. Prowlarr does not: it
 * aggregates indexer output and holds no library, no profile, and no opinion,
 * so an invented `approved: true` there would state something no application
 * said.
 */
export interface ReleaseDecision {
  readonly approved: boolean;
  readonly rejections: readonly ReleaseRejection[];
}

/**
 * The quality an application parsed out of a release, plus the two revision
 * flags that decide whether it supersedes an equal-quality file already held.
 */
export interface ReleaseQuality {
  readonly name?: string | undefined;
  readonly source?: string | undefined;
  readonly resolution?: number | undefined;
  readonly proper?: boolean | undefined;
  readonly repack?: boolean | undefined;
}

/**
 * The larger fields a `full` detail level adds. Everything here is omitted by
 * default: a custom-format list and an indexer category list are exactly the
 * kind of nested payload a summary result must not carry.
 */
export interface ReleaseDetail {
  readonly customFormats?: readonly string[] | undefined;
  readonly customFormatScore?: number | undefined;
  readonly indexerFlags?: readonly string[] | undefined;
  /** Indexer category names. Only Prowlarr reports them. */
  readonly categories?: readonly string[] | undefined;
}

export interface ReleaseCandidateBase {
  readonly title: string;
  readonly indexer: ReleaseIndexer;
  readonly protocol: ReleaseProtocol;
  readonly quality?: ReleaseQuality | undefined;
  readonly languages?: readonly string[] | undefined;
  readonly sizeBytes?: number | undefined;
  readonly publishedAt?: string | undefined;
  /** How old the release is, normalized from whichever unit upstream sent. */
  readonly ageMinutes?: number | undefined;
  readonly seeders?: number | undefined;
  readonly leechers?: number | undefined;
  readonly releaseGroup?: string | undefined;
  /** Absent for an application that makes no acceptance decision. */
  readonly decision?: ReleaseDecision | undefined;
  readonly detail?: ReleaseDetail | undefined;
}

/**
 * Sonarr's own release fields. Aired numbering and absolute numbering are kept
 * separately whenever the instance reports both, for the same reason the
 * library model keeps them apart: an anime release is identified by either.
 */
export interface SonarrReleaseFields {
  readonly seriesTitle?: string | undefined;
  readonly seasonNumber?: number | undefined;
  readonly episodeNumbers?: readonly number[] | undefined;
  readonly absoluteEpisodeNumbers?: readonly number[] | undefined;
  readonly fullSeason?: boolean | undefined;
}

export interface RadarrReleaseFields {
  readonly movieTitles?: readonly string[] | undefined;
  readonly year?: number | undefined;
  readonly edition?: string | undefined;
}

export interface ProwlarrReleaseFields {
  readonly grabs?: number | undefined;
  readonly files?: number | undefined;
}

/**
 * One release an application offered. The `application` discriminant selects
 * which namespaced extension property is present, so `release.sonarr` is
 * reachable exactly when Sonarr produced the release.
 */
export type ReleaseCandidate =
  | (ReleaseCandidateBase & {
      readonly application: "sonarr";
      readonly sonarr: SonarrReleaseFields;
    })
  | (ReleaseCandidateBase & {
      readonly application: "radarr";
      readonly radarr: RadarrReleaseFields;
    })
  | (ReleaseCandidateBase & {
      readonly application: "prowlarr";
      readonly prowlarr: ProwlarrReleaseFields;
    });

/**
 * The upstream cache identity a later grab re-establishes a result from.
 *
 * This is internal by construction. It is the minimum an application needs to
 * find the same entry in its own short-lived search cache — which application
 * answered, the release GUID it filed the result under, and which indexer it
 * came from — and it is deliberately not part of {@link ReleaseCandidate}, so
 * publishing a candidate cannot publish it by accident. Change 0005's second
 * task binds one of these into an expiring opaque release reference; nothing
 * before that point puts it in an envelope or a diagnostic.
 */
export interface ReleaseCacheIdentity {
  readonly application: ApplicationId;
  readonly guid: string;
  readonly indexerId?: number | undefined;
}

/** One search result: the candidate a caller may see, and the identity it stands for. */
export interface ReleaseSearchItem {
  readonly release: ReleaseCandidate;
  readonly identity: ReleaseCacheIdentity;
}

/**
 * What became of one indexer during an aggregate search.
 *
 * The four states are distinguishable because the aggregate search asks each
 * indexer separately: an indexer this server never queried because the instance
 * had already disabled it is `blocked`, one whose own request ran out of time
 * is `timed_out`, and one that answered with a failure is `failed`. Collapsing
 * them would lose the distinction between "try again" and "fix the indexer".
 */
export const indexerOutcomeStates = ["succeeded", "failed", "timed_out", "blocked"] as const;

export type IndexerOutcomeState = (typeof indexerOutcomeStates)[number];

export interface IndexerOutcome {
  readonly indexer: ReleaseIndexer;
  readonly state: IndexerOutcomeState;
  /** How many releases this indexer contributed to the merged result. */
  readonly releases: number;
  /** A redacted reason, present for a non-successful outcome. */
  readonly reason?: string | undefined;
}

/**
 * How much of an aggregate search actually ran.
 *
 * `complete` is false whenever any queried indexer did not succeed, or when
 * more indexers were configured than one search will query — a caller that
 * treats an incomplete result as exhaustive would conclude a release does not
 * exist when the indexer that has it simply never answered.
 */
export interface SearchCompleteness {
  readonly complete: boolean;
  readonly queried: number;
  readonly succeeded: number;
  readonly indexers: readonly IndexerOutcome[];
}
