import type { ApplicationId } from "../../applications.js";

/**
 * The normalized library model.
 *
 * Two rules hold everywhere in this file. Every media identity is
 * application-qualified, because Sonarr series 12 and Radarr movie 12 are
 * different objects behind the same number. And every application-specific
 * field lives inside a namespaced property that a discriminant selects, so a
 * consumer can always tell a shared normalized field from a Sonarr-only or
 * Radarr-only one without knowing which application answered.
 *
 * Optional properties are declared as `?: T | undefined` rather than omitted,
 * because a mapping reads an upstream field that may legitimately be absent and
 * saying so once is clearer than conditionally spreading every property. An
 * absent value disappears when the envelope is serialized.
 */

/** The two applications that own a media library. Prowlarr has none. */
export type MediaApplication = "sonarr" | "radarr";

export const mediaApplications: readonly MediaApplication[] = ["sonarr", "radarr"];

export function isMediaApplication(application: ApplicationId): application is MediaApplication {
  return application === "sonarr" || application === "radarr";
}

/**
 * The library records, as distinct from the files under them.
 *
 * The split is not decoration: a file's parent, a lookup match, and every
 * published media view can only ever name a record, so the two sets are
 * declared separately and `mediaKinds` is built from them. A kind added later
 * has to be placed in one set or the other, which is what keeps it from
 * silently widening a contract that was written against the whole list.
 */
export const mediaRecordKinds = ["series", "season", "episode", "movie", "collection"] as const;

export const mediaFileKinds = ["episode_file", "movie_file"] as const;

export const mediaKinds = [...mediaRecordKinds, ...mediaFileKinds] as const;

export type MediaRecordKind = (typeof mediaRecordKinds)[number];

export type MediaFileKind = (typeof mediaFileKinds)[number];

export type MediaKind = (typeof mediaKinds)[number];

/**
 * An application-qualified upstream identity.
 *
 * The identifier is kept as a string so a composite identity — a season, which
 * upstream has no id of its own — fits the same shape as a plain integer id.
 */
export interface MediaRef {
  readonly application: MediaApplication;
  readonly kind: MediaKind;
  readonly id: string;
}

/** An identity that names a library record rather than a file under one. */
export interface MediaRecordRef extends MediaRef {
  readonly kind: MediaRecordKind;
}

/**
 * Builds an identity, keeping the kind the caller named.
 *
 * The kind is carried through as its own literal rather than widened to
 * {@link MediaKind}, so a mapper that names a file where a record belongs — a
 * parent, or the library record a lookup result matches — is a compile error
 * instead of something the published schema has to catch at the boundary.
 */
export function mediaRef<TKind extends MediaKind>(
  application: MediaApplication,
  kind: TKind,
  id: number | string,
): MediaRef & { readonly kind: TKind } {
  return { application, kind, id: String(id) };
}

/** The identity of one season, which upstream models only as a child number. */
export function seasonRef(
  application: MediaApplication,
  seriesId: number,
  season: number,
): MediaRef {
  return mediaRef(application, "season", `${seriesId}/${season}`);
}

/**
 * A stable string form of a media identity.
 *
 * The three parts are concatenated in a fixed order defined here, never in the
 * order a caller supplied anything, so the same object always produces the same
 * key and no caller can influence what two identities collapse to.
 */
export function mediaRefKey(ref: MediaRef): string {
  return `${ref.application}:${ref.kind}:${ref.id}`;
}

export const configurationPointerKinds = ["quality_profile", "root_folder", "tag"] as const;

export type ConfigurationPointerKind = (typeof configurationPointerKinds)[number];

/**
 * A pointer at a configuration object by its upstream identifier.
 *
 * This is not an opaque process-local reference: the tool layer mints those,
 * and reading the configuration objects themselves belongs to change 0008. It
 * exists so a library result can say which profile, root folder, or tag a
 * record uses without embedding the configuration record itself.
 */
export interface ConfigurationPointer {
  readonly application: MediaApplication;
  readonly kind: ConfigurationPointerKind;
  readonly id: string;
}

export function configurationPointer(
  application: MediaApplication,
  kind: ConfigurationPointerKind,
  id: number | string,
): ConfigurationPointer {
  return { application, kind, id: String(id) };
}

/**
 * Whether a record is monitored, and how much of it is.
 *
 * The child counts are populated only where the application reports them — a
 * Sonarr series counts its seasons — and are absent rather than zero when it
 * does not, so "no children" and "not reported" stay distinguishable.
 */
export interface MonitoringState {
  readonly monitored: boolean;
  readonly monitoredChildren?: number | undefined;
  readonly totalChildren?: number | undefined;
}

export interface MediaStatistics {
  readonly fileCount?: number | undefined;
  readonly sizeOnDiskBytes?: number | undefined;
}

/**
 * The larger fields a `full` detail level adds.
 *
 * Everything here is omitted by default: an overview, a genre list, or a full
 * alternate-title list is exactly the kind of nested payload a summary result
 * must not carry.
 */
export interface MediaDetail {
  readonly overview?: string | undefined;
  readonly genres?: readonly string[] | undefined;
  readonly runtimeMinutes?: number | undefined;
  readonly certification?: string | undefined;
  readonly path?: string | undefined;
  readonly alternateTitles?: readonly string[] | undefined;
}

interface MediaItemBase {
  readonly ref: MediaRef;
  readonly title: string;
  readonly sortTitle?: string | undefined;
  readonly year?: number | undefined;
  readonly monitoring: MonitoringState;
  /** The application's own status word, passed through rather than remapped. */
  readonly status?: string | undefined;
  readonly added?: string | undefined;
  readonly statistics?: MediaStatistics | undefined;
  readonly qualityProfile?: ConfigurationPointer | undefined;
  /** Populated only at `full` detail, where the record's path is also returned. */
  readonly rootFolder?: ConfigurationPointer | undefined;
  readonly tags?: readonly ConfigurationPointer[] | undefined;
  readonly detail?: MediaDetail | undefined;
}

/** Sonarr's own fields, discriminated by which library record they describe. */
export type SonarrMediaFields =
  | {
      readonly kind: "series";
      readonly seriesType?: string | undefined;
      readonly network?: string | undefined;
      readonly tvdbId?: number | undefined;
      readonly ended?: boolean | undefined;
      readonly seasonCount?: number | undefined;
    }
  | {
      readonly kind: "season";
      readonly seriesId: number;
      readonly seasonNumber: number;
      readonly episodeCount?: number | undefined;
      readonly episodeFileCount?: number | undefined;
    }
  | {
      /**
       * Aired numbering and absolute numbering are separate fields, and both
       * are kept when the application reports both: an anime episode is
       * identified by its season and episode number *and* by its absolute
       * number, and collapsing them would lose an identity a caller needs.
       */
      readonly kind: "episode";
      readonly seriesId: number;
      readonly seriesTitle?: string | undefined;
      readonly seasonNumber: number;
      readonly episodeNumber: number;
      readonly absoluteEpisodeNumber?: number | undefined;
      readonly airDate?: string | undefined;
      readonly airDateUtc?: string | undefined;
      readonly hasFile: boolean;
      readonly finaleType?: string | undefined;
    };

export interface RadarrCollectionIdentity {
  readonly tmdbId?: number | undefined;
  readonly title?: string | undefined;
}

export interface RadarrReleaseDates {
  readonly inCinemas?: string | undefined;
  readonly physicalRelease?: string | undefined;
  readonly digitalRelease?: string | undefined;
}

/** Radarr's own fields, discriminated by which library record they describe. */
export type RadarrMediaFields =
  | {
      readonly kind: "movie";
      readonly tmdbId?: number | undefined;
      readonly imdbId?: string | undefined;
      readonly minimumAvailability?: string | undefined;
      readonly hasFile: boolean;
      readonly studio?: string | undefined;
      readonly collection?: RadarrCollectionIdentity | undefined;
      readonly releaseDates?: RadarrReleaseDates | undefined;
    }
  | {
      readonly kind: "collection";
      readonly tmdbId?: number | undefined;
      readonly movieCount?: number | undefined;
      readonly searchOnAdd?: boolean | undefined;
    };

/**
 * One library record. The `application` discriminant selects which namespaced
 * extension property is present, so `item.sonarr` is reachable exactly when the
 * record came from Sonarr.
 */
export type MediaItem =
  | (MediaItemBase & { readonly application: "sonarr"; readonly sonarr: SonarrMediaFields })
  | (MediaItemBase & { readonly application: "radarr"; readonly radarr: RadarrMediaFields });

export interface MediaFileInfo {
  readonly videoCodec?: string | undefined;
  readonly audioCodec?: string | undefined;
  readonly audioChannels?: number | undefined;
  readonly resolution?: string | undefined;
  readonly runTime?: string | undefined;
}

/** The larger media-file fields a `full` detail level adds. */
export interface MediaFileDetail {
  readonly path?: string | undefined;
  readonly customFormats?: readonly string[] | undefined;
  readonly customFormatScore?: number | undefined;
  readonly mediaInfo?: MediaFileInfo | undefined;
}

interface MediaFileBase {
  readonly ref: MediaRef;
  /** The series or movie this file belongs to, qualified the same way. */
  readonly parent: MediaRecordRef;
  readonly relativePath?: string | undefined;
  readonly sizeBytes?: number | undefined;
  readonly dateAdded?: string | undefined;
  readonly quality?: string | undefined;
  readonly languages?: readonly string[] | undefined;
  readonly releaseGroup?: string | undefined;
  readonly detail?: MediaFileDetail | undefined;
}

export interface SonarrFileFields {
  readonly seriesId: number;
  readonly seasonNumber?: number | undefined;
  readonly episodeIds: readonly number[];
}

export interface RadarrFileFields {
  readonly movieId: number;
  readonly edition?: string | undefined;
}

export type MediaFile =
  | (MediaFileBase & { readonly application: "sonarr"; readonly sonarr: SonarrFileFields })
  | (MediaFileBase & { readonly application: "radarr"; readonly radarr: RadarrFileFields });

export const wantedReasons = ["missing", "cutoff_unmet"] as const;

export type WantedReason = (typeof wantedReasons)[number];

export interface WantedState {
  readonly reason: WantedReason;
  /** When the record aired or released, where the application reports it. */
  readonly expectedAt?: string | undefined;
}

export interface WantedItem {
  readonly media: MediaItem;
  readonly wanted: WantedState;
}

/**
 * One dated library event. `start` is absent when the application returned a
 * record with no usable date; the record keeps its media identity rather than
 * being dropped from a bounded page silently.
 */
export interface CalendarEvent {
  readonly media: MediaItem;
  readonly start?: string | undefined;
  readonly end?: string | undefined;
  readonly hasFile: boolean;
}

interface LookupResultBase {
  readonly title: string;
  readonly sortTitle?: string | undefined;
  readonly year?: number | undefined;
  readonly status?: string | undefined;
  /**
   * The library record this result already matches, when the application
   * reports one. It is the only link a lookup result carries: reading a lookup
   * result adds nothing and implies no add, which change 0009 owns.
   */
  readonly existing?: MediaRecordRef | undefined;
  readonly detail?: MediaDetail | undefined;
}

export type LookupResult =
  | (LookupResultBase & {
      readonly application: "sonarr";
      readonly sonarr: {
        readonly tvdbId?: number | undefined;
        readonly seriesType?: string | undefined;
        readonly network?: string | undefined;
      };
    })
  | (LookupResultBase & {
      readonly application: "radarr";
      readonly radarr: {
        readonly tmdbId?: number | undefined;
        readonly imdbId?: string | undefined;
        readonly studio?: string | undefined;
      };
    });
