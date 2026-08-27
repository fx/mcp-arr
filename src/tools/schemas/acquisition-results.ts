import { z } from "zod";
import { releaseGrabStates } from "../../adapters/acquisition/grab.js";
import {
  indexerOutcomeStates,
  releaseProtocols,
  releaseRejectionTypes,
} from "../../adapters/acquisition/model.js";
import { releaseSearchTargets } from "../../adapters/acquisition/requests.js";
import { applicationIdSchema, releaseReferenceSchema } from "./common.js";

/**
 * The published shapes `arr_release_search` and `arr_release_grab` return.
 *
 * They mirror the normalized release model with one deliberate difference, and
 * it is the whole point of the pair: the upstream cache identity a later grab
 * resolves from — the release GUID and the indexer it came from — is replaced
 * by an opaque process-local reference. Nothing published here carries a
 * download URL, a magnet link, an info URL, or the cache key itself, and the
 * grab tool accepts nothing but the reference, so a caller can act on a search
 * result without ever holding the values that stand behind it.
 *
 * As in the library results, structure is strict — every object rejects unknown
 * properties and every union is discriminated — while individual values stay
 * unconstrained, because a needlessly narrow bound on something an instance
 * reports would replace a real result with a generic failure.
 */

const releaseIndexerSchema = z.strictObject({
  id: z.number().optional(),
  name: z.string().optional(),
});

const releaseRejectionSchema = z.strictObject({
  /** The application's own wording, already scrubbed by the adapter. */
  reason: z.string(),
  type: z.enum(releaseRejectionTypes),
});

/**
 * Present only for an application that actually judges a release. Prowlarr
 * holds no library and no profile, so its results carry none rather than an
 * empty rejection list that would read as an approval.
 */
const releaseDecisionSchema = z.strictObject({
  approved: z.boolean(),
  rejections: z.array(releaseRejectionSchema),
});

const releaseQualitySchema = z.strictObject({
  name: z.string().optional(),
  source: z.string().optional(),
  resolution: z.number().optional(),
  proper: z.boolean().optional(),
  repack: z.boolean().optional(),
});

/** The larger fields the `full` detail level adds; absent at `summary`. */
const releaseDetailSchema = z.strictObject({
  customFormats: z.array(z.string()).optional(),
  customFormatScore: z.number().optional(),
  indexerFlags: z.array(z.string()).optional(),
  categories: z.array(z.string()).optional(),
});

const releaseCandidateShape = {
  /** The opaque reference `arr_release_grab` accepts for this release. */
  reference: releaseReferenceSchema,
  title: z.string(),
  indexer: releaseIndexerSchema,
  protocol: z.enum(releaseProtocols),
  quality: releaseQualitySchema.optional(),
  languages: z.array(z.string()).optional(),
  sizeBytes: z.number().optional(),
  publishedAt: z.string().optional(),
  ageMinutes: z.number().optional(),
  seeders: z.number().optional(),
  leechers: z.number().optional(),
  releaseGroup: z.string().optional(),
  decision: releaseDecisionSchema.optional(),
  detail: releaseDetailSchema.optional(),
} as const;

export const releaseCandidateSchema = z.discriminatedUnion("application", [
  z.strictObject({
    ...releaseCandidateShape,
    application: z.literal("sonarr"),
    sonarr: z.strictObject({
      seriesTitle: z.string().optional(),
      seasonNumber: z.number().optional(),
      episodeNumbers: z.array(z.number()).optional(),
      absoluteEpisodeNumbers: z.array(z.number()).optional(),
      fullSeason: z.boolean().optional(),
    }),
  }),
  z.strictObject({
    ...releaseCandidateShape,
    application: z.literal("radarr"),
    radarr: z.strictObject({
      movieTitles: z.array(z.string()).optional(),
      year: z.number().optional(),
      edition: z.string().optional(),
    }),
  }),
  z.strictObject({
    ...releaseCandidateShape,
    application: z.literal("prowlarr"),
    prowlarr: z.strictObject({
      grabs: z.number().optional(),
      files: z.number().optional(),
    }),
  }),
]);

export type PublishedReleaseCandidate = z.infer<typeof releaseCandidateSchema>;

const indexerOutcomeSchema = z.strictObject({
  indexer: releaseIndexerSchema,
  state: z.enum(indexerOutcomeStates),
  releases: z.number(),
  reason: z.string().optional(),
});

/**
 * How much of an aggregate search actually ran. Absent for an application whose
 * interactive search reports nothing about the indexers it queried, because
 * claiming completeness there would assert something no application said.
 */
const searchCompletenessSchema = z.strictObject({
  complete: z.boolean(),
  queried: z.number(),
  succeeded: z.number(),
  indexers: z.array(indexerOutcomeSchema),
});

export const releaseSearchDataSchema = z.strictObject({
  target: z.enum(releaseSearchTargets),
  releases: z.array(releaseCandidateSchema),
  completeness: searchCompletenessSchema.optional(),
});

export type ReleaseSearchResult = z.infer<typeof releaseSearchDataSchema>;

/**
 * One release a grab names, identified the same way in both stages so a plan
 * and its apply describe the same thing.
 */
const grabbedReleaseShape = {
  reference: releaseReferenceSchema,
  application: applicationIdSchema,
  title: z.string(),
  indexer: releaseIndexerSchema,
  protocol: z.enum(releaseProtocols),
} as const;

/**
 * What a grab returns, discriminated by which stage produced it.
 *
 * A plan states which releases would be grabbed and nothing about how they
 * went, because nothing has been sent yet. An apply adds the per-release
 * outcome; the failure behind a failed one travels in the shared item list,
 * where a caller already looks for per-item errors.
 *
 * Neither stage carries a queue or job reference: all three applications
 * resolve a grab synchronously out of their own search cache and answer with
 * the release rather than with a queue item or a command, so this server has
 * none to expose and says so instead of inventing one.
 */
export const releaseGrabDataSchema = z.discriminatedUnion("stage", [
  z.strictObject({
    stage: z.literal("planned"),
    releases: z.array(z.strictObject({ ...grabbedReleaseShape })),
  }),
  z.strictObject({
    stage: z.literal("applied"),
    requested: z.int().min(0),
    accepted: z.int().min(0),
    releases: z.array(
      z.strictObject({ ...grabbedReleaseShape, outcome: z.enum(releaseGrabStates) }),
    ),
  }),
]);

export type ReleaseGrabResultData = z.infer<typeof releaseGrabDataSchema>;
