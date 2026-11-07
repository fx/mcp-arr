import { z } from "zod";
import { objectInput, variantUnion } from "../schemas/publish.js";
import { mediaErrorSchema } from "./errors.js";
import { titleKinds } from "./kinds.js";
import { resolutions } from "./resolution.js";

/**
 * The `media` tools' input and result schemas.
 *
 * Every property here is one the Media Toolset specification names for its
 * tool, and nothing else: no detail level, paging, projection, or reference.
 * Each result is validated against its internal schema before it leaves the
 * process, and published through a copy built from plainer leaves — see
 * {@link Leaves}. Among them, an error's code is published as a string: the
 * enum would cost every listing its whole vocabulary, and its members name
 * the concepts this toolset keeps out of its published surface.
 */

export const titleKindSchema = z.enum(titleKinds);

/** A TMDB id for a movie, a TVDB id for a series. */
export const titleIdSchema = z.number().int().min(1);

export const resolutionSchema = z.enum(resolutions);

/** The most entries any list in a status or fix result holds. */
export const maxListedEntries = 10;

/** A season number, zero for specials. */
const seasonSchema = z.number().int().min(0);

/** An episode number within its season. */
const episodeSchema = z.number().int().min(1);

const countSchema = z.number().int().min(0);

/**
 * The leaves a result shape is built from.
 *
 * Every tool validates its results against the exact leaves and publishes a
 * copy built from plain ones: every bound an exact leaf adds is
 * restated in each property the listing carries, and the Media Toolset
 * specification caps that listing, so the published copy keeps every field
 * and every closed vocabulary a caller branches on and leaves the numeric and
 * length bounds to validation, which still applies them.
 */
interface Leaves<TError extends z.ZodType> {
  /** A positive whole number: a title's id, a year. */
  readonly positive: z.ZodNumber;
  readonly count: z.ZodNumber;
  readonly season: z.ZodNumber;
  readonly episode: z.ZodNumber;
  readonly progress: z.ZodNumber;
  readonly text: z.ZodString;
  readonly error: TError;
  /** A list a result bounds to {@link maxListedEntries}. */
  list<TItem extends z.ZodType>(item: TItem): z.ZodArray<TItem>;
}

const exactLeaves: Leaves<typeof mediaErrorSchema> = {
  positive: titleIdSchema,
  count: countSchema,
  season: seasonSchema,
  episode: episodeSchema,
  progress: z.number().int().min(0).max(100),
  text: z.string().min(1),
  error: mediaErrorSchema,
  list: (item) => z.array(item).max(maxListedEntries),
};

const publishedErrorLeaf = z.strictObject({
  code: z.string(),
  message: z.string(),
  recoverable: z.boolean(),
  remediation: z.string(),
});

const publishedLeaves: Leaves<typeof publishedErrorLeaf> = {
  positive: z.number(),
  count: z.number(),
  season: z.number(),
  episode: z.number(),
  progress: z.number(),
  text: z.string(),
  error: publishedErrorLeaf,
  list: (item) => z.array(item),
};

/** The longest search text `media_find` accepts, in characters. */
export const maxFindTextLength = 200;

/**
 * A search text: at least one character that is not whitespace, published as a
 * pattern so a caller sees the rule, and searched for with its surrounding
 * whitespace removed. Text that is only whitespace names nothing to search for,
 * and sending it upstream would turn a caller's mistake into a failure of the
 * source.
 */
export const findInputSchema = objectInput(
  z.strictObject({
    text: z
      .string()
      .min(1)
      .max(maxFindTextLength)
      .regex(/\S/u)
      .transform((text) => text.trim()),
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

function foundTitleShape<TError extends z.ZodType>(leaves: Leaves<TError>) {
  return z.strictObject({
    kind: titleKindSchema,
    id: leaves.positive,
    title: leaves.text,
    year: leaves.positive.optional(),
    in_library: z.boolean(),
  });
}

export type FoundTitle = z.infer<ReturnType<typeof foundTitleShape<typeof mediaErrorSchema>>>;

function findResultShape<TError extends z.ZodType>(leaves: Leaves<TError>) {
  return z.strictObject({
    titles: z.array(foundTitleShape(leaves)),
    unavailable: z.array(z.strictObject({ kind: titleKindSchema, error: leaves.error })),
    warnings: z.array(leaves.text),
    errors: z.array(leaves.error),
  });
}

export const addOutcomes = ["added", "already_in_library"] as const;

export type AddOutcome = (typeof addOutcomes)[number];

function addResultShape<TError extends z.ZodType>(leaves: Leaves<TError>) {
  return z.strictObject({
    kind: titleKindSchema.optional(),
    id: leaves.positive.optional(),
    title: leaves.text.optional(),
    outcome: z.enum(addOutcomes).optional(),
    resolution: resolutionSchema.optional(),
    warnings: z.array(leaves.text),
    errors: z.array(leaves.error),
  });
}

export const downloadStates = ["queued", "downloading", "waiting", "importing", "stuck"] as const;

export type DownloadState = (typeof downloadStates)[number];

export const remedies = ["replace", "import", "none"] as const;

export type Remedy = (typeof remedies)[number];

export const statusInputSchema = objectInput(
  z.strictObject({
    kind: titleKindSchema.optional(),
    id: titleIdSchema.optional(),
  }),
);

/** One download, named by the title it is for rather than by any of its rows. */
function downloadShape<TError extends z.ZodType>(leaves: Leaves<TError>) {
  return z.strictObject({
    kind: titleKindSchema,
    id: leaves.positive,
    title: leaves.text.optional(),
    episodes: leaves.text.optional(),
    state: z.enum(downloadStates),
    resolution: resolutionSchema.optional(),
    progress: leaves.progress.optional(),
    reason: leaves.text.optional(),
    remedy: z.enum(remedies).optional(),
  });
}

/** A title, or some of its episodes, beside the date something happened or is due. */
function datedShape<TError extends z.ZodType>(leaves: Leaves<TError>) {
  return z.strictObject({
    kind: titleKindSchema,
    id: leaves.positive,
    title: leaves.text.optional(),
    episodes: leaves.text.optional(),
    date: leaves.text,
  });
}

function statusResultShape<TError extends z.ZodType>(leaves: Leaves<TError>) {
  const list = <TItem extends z.ZodType>(item: TItem) => leaves.list(item).optional();
  return z.strictObject({
    kinds: z.array(titleKindSchema).optional(),
    kind: titleKindSchema.optional(),
    id: leaves.positive.optional(),
    title: leaves.text.optional(),
    in_library: z.boolean().optional(),
    monitored: z.boolean().optional(),
    resolution: resolutionSchema.optional(),
    file_resolutions: z.array(resolutionSchema).optional(),
    have: leaves.count.optional(),
    missing: leaves.count.optional(),
    next_due: leaves.text.optional(),
    downloads: list(downloadShape(leaves)),
    downloads_total: leaves.count.optional(),
    imported: list(datedShape(leaves)),
    imported_total: leaves.count.optional(),
    upcoming: list(datedShape(leaves)),
    upcoming_total: leaves.count.optional(),
    warnings: z.array(leaves.text),
    errors: z.array(leaves.error),
  });
}

export type ReportedDownload = z.infer<ReturnType<typeof downloadShape<typeof mediaErrorSchema>>>;
export type DatedTitle = z.infer<ReturnType<typeof datedShape<typeof mediaErrorSchema>>>;

export const fixInputSchema = objectInput(
  z.strictObject({
    kind: titleKindSchema,
    id: titleIdSchema,
  }),
);

export const fixActions = ["replaced", "import_started", "none"] as const;

export type FixAction = (typeof fixActions)[number];

function fixedDownloadShape<TError extends z.ZodType>(leaves: Leaves<TError>) {
  return z.strictObject({
    title: leaves.text.optional(),
    episodes: leaves.text.optional(),
    action: z.enum(fixActions),
    reason: leaves.text.optional(),
  });
}

export type FixedDownload = z.infer<ReturnType<typeof fixedDownloadShape<typeof mediaErrorSchema>>>;

function fixResultShape<TError extends z.ZodType>(leaves: Leaves<TError>) {
  return z.strictObject({
    kind: titleKindSchema.optional(),
    id: leaves.positive.optional(),
    title: leaves.text.optional(),
    downloads: leaves.list(fixedDownloadShape(leaves)).optional(),
    remaining: leaves.count.optional(),
    warnings: z.array(leaves.text),
    errors: z.array(leaves.error),
  });
}

/**
 * One flat object rather than a variant per kind: a movie has no season, and
 * the handler refuses one, as it refuses an episode named without its
 * season. The variants would publish the same two rules as prose.
 */
export const searchAgainInputSchema = objectInput(
  z.strictObject({
    kind: titleKindSchema,
    id: titleIdSchema,
    season: seasonSchema.optional(),
    episode: episodeSchema.optional(),
  }),
);

function searchAgainResultShape<TError extends z.ZodType>(leaves: Leaves<TError>) {
  return z.strictObject({
    kind: titleKindSchema.optional(),
    id: leaves.positive.optional(),
    title: leaves.text.optional(),
    season: leaves.season.optional(),
    episode: leaves.episode.optional(),
    searched: leaves.count.optional(),
    warnings: z.array(leaves.text),
    errors: z.array(leaves.error),
  });
}

export const removeInputSchema = objectInput(
  z.strictObject({
    kind: titleKindSchema,
    id: titleIdSchema,
    delete_files: z.boolean().default(false),
  }),
);

export const removeOutcomes = ["removed", "not_in_library"] as const;

export type RemoveOutcome = (typeof removeOutcomes)[number];

function removeResultShape<TError extends z.ZodType>(leaves: Leaves<TError>) {
  return z.strictObject({
    kind: titleKindSchema.optional(),
    id: leaves.positive.optional(),
    title: leaves.text.optional(),
    outcome: z.enum(removeOutcomes).optional(),
    files_deleted: z.boolean().optional(),
    warnings: z.array(leaves.text),
    errors: z.array(leaves.error),
  });
}

export const findOutputSchema = findResultShape(exactLeaves);
export const findPublishedOutputSchema = findResultShape(publishedLeaves);
export const addOutputSchema = addResultShape(exactLeaves);
export const addPublishedOutputSchema = addResultShape(publishedLeaves);

export type FindResult = z.infer<typeof findOutputSchema>;
export type AddResult = z.infer<typeof addOutputSchema>;

export const statusOutputSchema = statusResultShape(exactLeaves);
export const statusPublishedOutputSchema = statusResultShape(publishedLeaves);
export const fixOutputSchema = fixResultShape(exactLeaves);
export const fixPublishedOutputSchema = fixResultShape(publishedLeaves);
export const searchAgainOutputSchema = searchAgainResultShape(exactLeaves);
export const searchAgainPublishedOutputSchema = searchAgainResultShape(publishedLeaves);
export const removeOutputSchema = removeResultShape(exactLeaves);
export const removePublishedOutputSchema = removeResultShape(publishedLeaves);

export type StatusResult = z.infer<typeof statusOutputSchema>;
export type FixResult = z.infer<typeof fixOutputSchema>;
export type SearchAgainResult = z.infer<typeof searchAgainOutputSchema>;
export type RemoveResult = z.infer<typeof removeOutputSchema>;
