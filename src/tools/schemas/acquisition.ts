import { z } from "zod";
import { toolResultSchema } from "../results.js";
import {
  bulkReferences,
  importCandidateReferenceSchema,
  maxBulkItems,
  mediaReferenceSchema,
  mutationBaseShape,
  queryBaseShape,
  queueReferenceSchema,
  releaseReferenceSchema,
  searchTermSchema,
  variantUnion,
} from "./common.js";

const seasonNumberSchema = z.int().min(0).max(1000);

/**
 * Interactive release search.
 *
 * Results replace protected download URLs and upstream cache keys with opaque
 * process-local release references, so the search target is the only thing a
 * caller names here and the grab tool is the only thing that can act on what
 * comes back.
 */
export const releaseSearchInputSchema = variantUnion(
  z.discriminatedUnion("target", [
    z.strictObject({
      target: z.literal("sonarr_episode"),
      ...queryBaseShape,
      episode: mediaReferenceSchema,
    }),
    z.strictObject({
      target: z.literal("sonarr_season"),
      ...queryBaseShape,
      series: mediaReferenceSchema,
      seasonNumber: seasonNumberSchema,
    }),
    z.strictObject({
      target: z.literal("radarr_movie"),
      ...queryBaseShape,
      movie: mediaReferenceSchema,
    }),
    z.strictObject({
      /** Prowlarr aggregate search across its configured indexers. */
      target: z.literal("prowlarr_aggregate"),
      ...queryBaseShape,
      term: searchTermSchema,
    }),
  ]),
);

/**
 * Grabs releases that a previous search returned.
 *
 * The input accepts release references only. An arbitrary download URL, GUID,
 * magnet link, or raw release payload has no field to arrive in, which is the
 * point: a grab can only target something this server itself produced and can
 * still resolve.
 */
export const releaseGrabInputSchema = z.strictObject({
  ...mutationBaseShape,
  releases: bulkReferences(releaseReferenceSchema),
});

/**
 * Automatic search commands. These start upstream work and return a job
 * reference; reading wanted media stays in `arr_library_query` so a wanted-list
 * read never launches a search.
 */
export const searchStartInputSchema = variantUnion(
  z.discriminatedUnion("target", [
    z.strictObject({
      target: z.literal("sonarr_episode"),
      ...mutationBaseShape,
      episodes: bulkReferences(mediaReferenceSchema),
    }),
    z.strictObject({
      target: z.literal("sonarr_season"),
      ...mutationBaseShape,
      series: mediaReferenceSchema,
      seasonNumber: seasonNumberSchema,
    }),
    z.strictObject({
      target: z.literal("sonarr_series"),
      ...mutationBaseShape,
      series: mediaReferenceSchema,
    }),
    z.strictObject({
      target: z.literal("radarr_movie"),
      ...mutationBaseShape,
      movies: bulkReferences(mediaReferenceSchema),
    }),
    z.strictObject({
      target: z.literal("missing"),
      ...mutationBaseShape,
      applications: z
        .array(z.enum(["sonarr", "radarr"]))
        .min(1)
        .max(2)
        .optional(),
      monitoredOnly: z.boolean(),
    }),
    z.strictObject({
      target: z.literal("cutoff_unmet"),
      ...mutationBaseShape,
      applications: z
        .array(z.enum(["sonarr", "radarr"]))
        .min(1)
        .max(2)
        .optional(),
      monitoredOnly: z.boolean(),
    }),
  ]),
);

/**
 * Explicit mapping corrections for a manual-import candidate. Later manual
 * import work refines these fields; none of them is a filesystem path, and the
 * candidate reference is what binds the correction to a discovered file.
 */
const candidateMappingSchema = z.strictObject({
  media: mediaReferenceSchema.optional(),
  episodes: z.array(mediaReferenceSchema).max(maxBulkItems).optional(),
  quality: z.string().min(1).max(120).optional(),
  languages: z.array(z.string().min(1).max(60)).max(20).optional(),
  releaseGroup: z.string().min(1).max(120).optional(),
});

/**
 * Manual-import discovery and reprocessing.
 *
 * Discovery starts from an opaque queue reference or an application-qualified
 * media reference. The default surface accepts no filesystem path at all, and
 * reprocessing validates a corrected mapping without importing anything.
 */
export const importInspectInputSchema = variantUnion(
  z.discriminatedUnion("source", [
    z.strictObject({
      source: z.literal("queue_item"),
      ...queryBaseShape,
      queue: queueReferenceSchema,
    }),
    z.strictObject({
      source: z.literal("library_context"),
      ...queryBaseShape,
      media: mediaReferenceSchema,
      seasonNumber: seasonNumberSchema.optional(),
    }),
    z.strictObject({
      source: z.literal("candidate_reprocess"),
      ...queryBaseShape,
      candidate: importCandidateReferenceSchema,
      mapping: candidateMappingSchema,
    }),
  ]),
);

/**
 * Executes a manual import for candidates that discovery already validated.
 *
 * The import mode is explicit because it decides whether the source file
 * survives, and the candidate references are re-validated against current
 * upstream state immediately before the import command is submitted.
 */
export const importExecuteInputSchema = z.strictObject({
  ...mutationBaseShape,
  candidates: bulkReferences(importCandidateReferenceSchema),
  importMode: z.enum(["auto", "move", "copy"]),
});

export const releaseSearchOutputSchema = toolResultSchema();
export const releaseGrabOutputSchema = toolResultSchema({ mutation: true });
export const searchStartOutputSchema = toolResultSchema({ mutation: true });
export const importInspectOutputSchema = toolResultSchema();
export const importExecuteOutputSchema = toolResultSchema({ mutation: true });
