import { z } from "zod";
import {
  configurationPointerKinds,
  mediaRecordKinds,
  type WantedReason,
} from "../../adapters/library/model.js";
import {
  mediaApplicationSchema,
  mediaFileReferenceSchema,
  mediaReferenceSchema,
} from "./common.js";

/**
 * The published shapes `arr_library_query` returns.
 *
 * These mirror the normalized adapter model rather than any upstream payload,
 * with one deliberate difference: an upstream identity becomes an opaque
 * process-local reference plus the application's own identifier. The reference
 * is what other tools accept; the identifier is carried only so a caller can
 * line a result up against what the application's own interface shows.
 *
 * Structure is strict — every object rejects unknown properties and every union
 * is discriminated — while individual values are deliberately unconstrained.
 * The envelope is validated against this schema before it leaves the process,
 * so a needlessly narrow bound on a value an instance reports would replace a
 * real result with a generic failure.
 */

const monitoringSchema = z.strictObject({
  monitored: z.boolean(),
  monitoredChildren: z.number().optional(),
  totalChildren: z.number().optional(),
});

const mediaStatisticsSchema = z.strictObject({
  fileCount: z.number().optional(),
  sizeOnDiskBytes: z.number().optional(),
});

/**
 * A pointer at a configuration object by the application's own identifier.
 * Reading the configuration objects themselves belongs to change 0008, so this
 * is not an opaque reference and no tool accepts it as one.
 */
const configurationPointerSchema = z.strictObject({
  application: mediaApplicationSchema,
  kind: z.enum(configurationPointerKinds),
  id: z.string(),
});

/** The larger fields the `full` detail level adds; absent at `summary`. */
const mediaDetailSchema = z.strictObject({
  overview: z.string().optional(),
  genres: z.array(z.string()).optional(),
  runtimeMinutes: z.number().optional(),
  certification: z.string().optional(),
  path: z.string().optional(),
  alternateTitles: z.array(z.string()).optional(),
});

/**
 * One record's identity, as a nested value.
 *
 * A record publishes these two fields at its own top level, alongside the
 * `kind` and `application` its variant already fixes; this object is the form
 * used where an identity is referred to from elsewhere — a file's parent, or
 * the library record a lookup result already matches. Both of those are library
 * records, so the kind is drawn from the record kinds and a file kind cannot
 * appear here at all.
 */
const mediaIdentitySchema = z.strictObject({
  reference: mediaReferenceSchema,
  application: mediaApplicationSchema,
  kind: z.enum(mediaRecordKinds),
  id: z.string(),
});

const mediaRecordShape = {
  /** The opaque reference other tool inputs accept for this record. */
  reference: mediaReferenceSchema,
  /** The application's own identifier, for correlating with its interface. */
  id: z.string(),
  title: z.string(),
  sortTitle: z.string().optional(),
  year: z.number().optional(),
  monitoring: monitoringSchema,
  status: z.string().optional(),
  added: z.string().optional(),
  statistics: mediaStatisticsSchema.optional(),
  qualityProfile: configurationPointerSchema.optional(),
  rootFolder: configurationPointerSchema.optional(),
  tags: z.array(configurationPointerSchema).optional(),
  detail: mediaDetailSchema.optional(),
} as const;

const seriesRecordSchema = z.strictObject({
  kind: z.literal("series"),
  application: z.literal("sonarr"),
  ...mediaRecordShape,
  sonarr: z.strictObject({
    seriesType: z.string().optional(),
    network: z.string().optional(),
    tvdbId: z.number().optional(),
    ended: z.boolean().optional(),
    seasonCount: z.number().optional(),
  }),
});

const seasonRecordSchema = z.strictObject({
  kind: z.literal("season"),
  application: z.literal("sonarr"),
  ...mediaRecordShape,
  sonarr: z.strictObject({
    seriesId: z.number(),
    seasonNumber: z.number(),
    episodeCount: z.number().optional(),
    episodeFileCount: z.number().optional(),
  }),
});

const episodeRecordSchema = z.strictObject({
  kind: z.literal("episode"),
  application: z.literal("sonarr"),
  ...mediaRecordShape,
  sonarr: z.strictObject({
    seriesId: z.number(),
    seriesTitle: z.string().optional(),
    seasonNumber: z.number(),
    episodeNumber: z.number(),
    /** Kept alongside the aired numbering, never collapsed into it. */
    absoluteEpisodeNumber: z.number().optional(),
    airDate: z.string().optional(),
    airDateUtc: z.string().optional(),
    hasFile: z.boolean(),
    finaleType: z.string().optional(),
  }),
});

const movieRecordSchema = z.strictObject({
  kind: z.literal("movie"),
  application: z.literal("radarr"),
  ...mediaRecordShape,
  radarr: z.strictObject({
    tmdbId: z.number().optional(),
    imdbId: z.string().optional(),
    minimumAvailability: z.string().optional(),
    hasFile: z.boolean(),
    studio: z.string().optional(),
    collection: z
      .strictObject({ tmdbId: z.number().optional(), title: z.string().optional() })
      .optional(),
    releaseDates: z
      .strictObject({
        inCinemas: z.string().optional(),
        physicalRelease: z.string().optional(),
        digitalRelease: z.string().optional(),
      })
      .optional(),
  }),
});

const collectionRecordSchema = z.strictObject({
  kind: z.literal("collection"),
  application: z.literal("radarr"),
  ...mediaRecordShape,
  radarr: z.strictObject({
    tmdbId: z.number().optional(),
    movieCount: z.number().optional(),
    searchOnAdd: z.boolean().optional(),
  }),
});

/**
 * One library record, discriminated by the concept it describes. The `kind`
 * alone separates a Sonarr episode from a Radarr movie, and the namespaced
 * `sonarr` or `radarr` property carries only that application's own fields.
 */
export const libraryMediaRecordSchema = z.discriminatedUnion("kind", [
  seriesRecordSchema,
  seasonRecordSchema,
  episodeRecordSchema,
  movieRecordSchema,
  collectionRecordSchema,
]);

export type LibraryMediaRecord = z.infer<typeof libraryMediaRecordSchema>;

export type LibraryRecordOfKind<TKind extends LibraryMediaRecord["kind"]> = Extract<
  LibraryMediaRecord,
  { kind: TKind }
>;

const mediaFileDetailSchema = z.strictObject({
  path: z.string().optional(),
  customFormats: z.array(z.string()).optional(),
  customFormatScore: z.number().optional(),
  mediaInfo: z
    .strictObject({
      videoCodec: z.string().optional(),
      audioCodec: z.string().optional(),
      audioChannels: z.number().optional(),
      resolution: z.string().optional(),
      runTime: z.string().optional(),
    })
    .optional(),
});

const mediaFileShape = {
  /** A media-file reference; the file mutations of change 0009 accept this kind. */
  reference: mediaFileReferenceSchema,
  id: z.string(),
  /** The series or movie the file belongs to, as its own referenced identity. */
  parent: mediaIdentitySchema,
  relativePath: z.string().optional(),
  sizeBytes: z.number().optional(),
  dateAdded: z.string().optional(),
  quality: z.string().optional(),
  languages: z.array(z.string()).optional(),
  releaseGroup: z.string().optional(),
  detail: mediaFileDetailSchema.optional(),
} as const;

const episodeFileSchema = z.strictObject({
  kind: z.literal("episode_file"),
  application: z.literal("sonarr"),
  ...mediaFileShape,
  sonarr: z.strictObject({
    seriesId: z.number(),
    seasonNumber: z.number().optional(),
    episodeIds: z.array(z.number()),
  }),
});

const movieFileSchema = z.strictObject({
  kind: z.literal("movie_file"),
  application: z.literal("radarr"),
  ...mediaFileShape,
  radarr: z.strictObject({ movieId: z.number(), edition: z.string().optional() }),
});

export const libraryMediaFileSchema = z.discriminatedUnion("kind", [
  episodeFileSchema,
  movieFileSchema,
]);

export type LibraryMediaFile = z.infer<typeof libraryMediaFileSchema>;

export type LibraryFileOfKind<TKind extends LibraryMediaFile["kind"]> = Extract<
  LibraryMediaFile,
  { kind: TKind }
>;

/**
 * One wanted record, for the media a given view actually reports.
 *
 * Both the media variant and the reason are fixed by the view: the Sonarr
 * wanted views report episodes and the Radarr ones movies, and each endpoint
 * answers exactly one reason. Parameterizing rather than declaring the widest
 * shape once is what keeps the published contract from claiming a
 * missing-movies page might contain a cutoff-unmet episode.
 */
function wantedRecordSchema<TMedia extends z.ZodType, TReason extends WantedReason>(
  media: TMedia,
  reason: TReason,
) {
  return z.strictObject({
    media,
    wanted: z.strictObject({
      reason: z.literal(reason),
      /** When the record aired or released, where the application reports it. */
      expectedAt: z.string().optional(),
    }),
  });
}

export type LibraryWantedRecord<
  TMedia extends LibraryMediaRecord = LibraryMediaRecord,
  TReason extends WantedReason = WantedReason,
> = {
  media: TMedia;
  wanted: { reason: TReason; expectedAt?: string | undefined };
};

/** The calendar reports a dated Sonarr episode or a dated Radarr movie. */
const calendarMediaSchema = z.discriminatedUnion("kind", [episodeRecordSchema, movieRecordSchema]);

const calendarEventSchema = z.strictObject({
  media: calendarMediaSchema,
  start: z.string().optional(),
  end: z.string().optional(),
  hasFile: z.boolean(),
});

export type LibraryCalendarEvent = z.infer<typeof calendarEventSchema>;

const lookupResultShape = {
  title: z.string(),
  sortTitle: z.string().optional(),
  year: z.number().optional(),
  status: z.string().optional(),
  /**
   * The library record this result already matches, when the application
   * reports one. It is the only link a lookup result carries: reading a lookup
   * result adds nothing, and the add intent belongs to change 0009.
   */
  existing: mediaIdentitySchema.optional(),
  detail: mediaDetailSchema.optional(),
} as const;

export const libraryLookupResultSchema = z.discriminatedUnion("application", [
  z.strictObject({
    application: z.literal("sonarr"),
    ...lookupResultShape,
    sonarr: z.strictObject({
      tvdbId: z.number().optional(),
      seriesType: z.string().optional(),
      network: z.string().optional(),
    }),
  }),
  z.strictObject({
    application: z.literal("radarr"),
    ...lookupResultShape,
    radarr: z.strictObject({
      tmdbId: z.number().optional(),
      imdbId: z.string().optional(),
      studio: z.string().optional(),
    }),
  }),
]);

export type LibraryLookupResult = z.infer<typeof libraryLookupResultSchema>;

/**
 * What one view answers with, discriminated by the view the caller asked for.
 *
 * Each view declares the item variant it can actually return, not the widest
 * one it belongs to. That is the whole point of validating the envelope against
 * this schema before it leaves the process: a contract saying `series` might
 * hold a movie could not catch an adapter that mapped one, and a mismap would
 * ship as a well-formed result. The members mirror the adapter service's own
 * view union one for one, so a view added there without a published shape here
 * fails to compile rather than being rejected at runtime.
 */
export const libraryViewResultSchema = z.discriminatedUnion("view", [
  z.strictObject({ view: z.literal("series"), items: z.array(seriesRecordSchema) }),
  z.strictObject({ view: z.literal("seasons"), items: z.array(seasonRecordSchema) }),
  z.strictObject({ view: z.literal("episodes"), items: z.array(episodeRecordSchema) }),
  z.strictObject({ view: z.literal("movies"), items: z.array(movieRecordSchema) }),
  z.strictObject({ view: z.literal("collections"), items: z.array(collectionRecordSchema) }),
  z.strictObject({ view: z.literal("episode_files"), items: z.array(episodeFileSchema) }),
  z.strictObject({ view: z.literal("movie_files"), items: z.array(movieFileSchema) }),
  z.strictObject({
    view: z.literal("missing_episodes"),
    items: z.array(wantedRecordSchema(episodeRecordSchema, "missing")),
  }),
  z.strictObject({
    view: z.literal("cutoff_unmet_episodes"),
    items: z.array(wantedRecordSchema(episodeRecordSchema, "cutoff_unmet")),
  }),
  z.strictObject({
    view: z.literal("missing_movies"),
    items: z.array(wantedRecordSchema(movieRecordSchema, "missing")),
  }),
  z.strictObject({
    view: z.literal("cutoff_unmet_movies"),
    items: z.array(wantedRecordSchema(movieRecordSchema, "cutoff_unmet")),
  }),
  z.strictObject({ view: z.literal("calendar"), items: z.array(calendarEventSchema) }),
  z.strictObject({ view: z.literal("lookup"), items: z.array(libraryLookupResultSchema) }),
]);

export type LibraryViewResult = z.infer<typeof libraryViewResultSchema>;
