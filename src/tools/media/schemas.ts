import { z } from "zod";
import { objectInput, variantUnion } from "../schemas/publish.js";
import { mediaErrorSchema, mediaErrorShape } from "./errors.js";
import { titleKinds } from "./kinds.js";
import { resolutions } from "./resolution.js";

/**
 * The `media` tools' input and result schemas.
 *
 * Every property here is one the Media Toolset specification names for its
 * tool, and nothing else: no detail level, paging, projection, or reference.
 * Each result is validated against its internal schema before it leaves the
 * process, and published through a copy that differs only in publishing an
 * error's code as a string — the enum would cost every listing its whole
 * vocabulary, and its members name the concepts this toolset keeps out of its
 * published surface.
 */

export const titleKindSchema = z.enum(titleKinds);

/** A TMDB id for a movie, a TVDB id for a series. */
export const titleIdSchema = z.number().int().min(1);

export const resolutionSchema = z.enum(resolutions);

/** The longest search text `media_find` accepts, in characters. */
export const maxFindTextLength = 200;

export const findInputSchema = objectInput(
  z.strictObject({
    text: z.string().min(1).max(maxFindTextLength),
    kind: titleKindSchema.optional(),
  }),
);

export const episodeChoices = ["all", "future"] as const;

export type EpisodeChoice = (typeof episodeChoices)[number];

export const addInputSchema = variantUnion(
  z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("movie"),
      id: titleIdSchema,
      resolution: resolutionSchema.optional(),
    }),
    z.strictObject({
      kind: z.literal("series"),
      id: titleIdSchema,
      resolution: resolutionSchema.optional(),
      episodes: z.enum(episodeChoices).default("all"),
    }),
  ]),
);

const foundTitleSchema = z.strictObject({
  kind: titleKindSchema,
  id: titleIdSchema,
  title: z.string().min(1),
  year: z.number().int().min(1).optional(),
  in_library: z.boolean(),
});

export type FoundTitle = z.infer<typeof foundTitleSchema>;

function findResultShape<TError extends z.ZodType>(error: TError) {
  return z.strictObject({
    titles: z.array(foundTitleSchema),
    unavailable: z.array(z.strictObject({ kind: titleKindSchema, error })),
    warnings: z.array(z.string().min(1)),
    errors: z.array(error),
  });
}

export const addOutcomes = ["added", "already_in_library"] as const;

export type AddOutcome = (typeof addOutcomes)[number];

function addResultShape<TError extends z.ZodType>(error: TError) {
  return z.strictObject({
    kind: titleKindSchema.optional(),
    id: titleIdSchema.optional(),
    title: z.string().min(1).optional(),
    outcome: z.enum(addOutcomes).optional(),
    resolution: resolutionSchema.optional(),
    warnings: z.array(z.string().min(1)),
    errors: z.array(error),
  });
}

const publishedErrorSchema = mediaErrorShape(z.string());

export const findOutputSchema = findResultShape(mediaErrorSchema);
export const findPublishedOutputSchema = findResultShape(publishedErrorSchema);
export const addOutputSchema = addResultShape(mediaErrorSchema);
export const addPublishedOutputSchema = addResultShape(publishedErrorSchema);

export type FindResult = z.infer<typeof findOutputSchema>;
export type AddResult = z.infer<typeof addOutputSchema>;
