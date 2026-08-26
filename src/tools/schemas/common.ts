import { z } from "zod";
import { applicationIds } from "../../applications.js";

export const applicationIdSchema = z.enum(applicationIds);

/**
 * The two applications that own a media library. Prowlarr has no library,
 * activity queue, or media-file contract, so variants that only make sense for
 * a library instance narrow to this pair instead of relying on a runtime
 * unsupported-capability error.
 */
export const mediaApplicationSchema = z.enum(["sonarr", "radarr"]);

/**
 * Optional caller-supplied application filter. Omitting it targets every
 * application the requested operation declares support for; naming one that
 * does not support the operation yields an `unsupported_capability` outcome for
 * that application rather than a silently narrowed result.
 */
export const applicationFilterSchema = z
  .array(applicationIdSchema)
  .min(1)
  .max(applicationIds.length);

/**
 * Every mutation tool accepts both modes. The calling agent owns the
 * interaction strategy: plan performs non-mutating validation and returns the
 * predicted effects, apply performs the change. Plan is never treated as
 * authorization for a later apply.
 */
export const modeSchema = z.enum(["plan", "apply"]);

/**
 * Detail levels are a closed set so a caller cannot request an unbounded
 * payload. `summary` omits large nested upstream structures.
 */
export const detailLevelSchema = z.enum(["summary", "full"]);

export const defaultPageSize = 25;
export const maxPageSize = 100;

/**
 * The hard ceiling on how many references one bulk mutation may name. Bulk
 * mutations are not transactional, so the bound keeps a single call's
 * per-item outcome list reviewable.
 */
export const maxBulkItems = 50;

export const pageSizeSchema = z.int().min(1).max(maxPageSize).default(defaultPageSize);

/**
 * An opaque continuation token minted by a previous page of the same query.
 * It is process-local and carries no upstream URL, credential, or path.
 */
export const cursorSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9_-]+$/u, "must be an opaque continuation token");

/**
 * Fields every bounded collection query shares. Spread into a variant rather
 * than nested so a caller supplies them alongside the variant's own filters.
 */
export const pageShape = {
  pageSize: pageSizeSchema,
  cursor: cursorSchema.optional(),
} as const;

export const continuationSchema = z.strictObject({
  pageSize: z.int().min(1).max(maxPageSize),
  returned: z.int().min(0),
  hasMore: z.boolean(),
  cursor: cursorSchema.optional(),
});

export type Continuation = z.infer<typeof continuationSchema>;

/**
 * The kinds of process-local reference the tool surface accepts. Every kind
 * has its own prefix so supplying a release reference where an import
 * candidate is required fails schema validation before any upstream request is
 * sent, and so a reference can never be confused for an upstream identifier, a
 * download URL, or a filesystem path.
 */
export const referenceKinds = [
  "media",
  "media_file",
  "queue",
  "release",
  "import_candidate",
  "history",
  "blocklist",
  "configuration",
  "plan",
  "apply",
  "job",
] as const;

export type ReferenceKind = (typeof referenceKinds)[number];

export const referencePrefixes: Readonly<Record<ReferenceKind, string>> = {
  media: "med",
  media_file: "mfl",
  queue: "que",
  release: "rel",
  import_candidate: "imp",
  history: "his",
  blocklist: "blk",
  configuration: "cfg",
  plan: "pln",
  apply: "apl",
  job: "job",
};

export function referenceSchema(kind: ReferenceKind): z.ZodString {
  const prefix = referencePrefixes[kind];
  return z
    .string()
    .regex(new RegExp(`^${prefix}_[A-Za-z0-9_-]{8,64}$`, "u"), `must be a ${kind} reference`);
}

export const mediaReferenceSchema = referenceSchema("media");
export const mediaFileReferenceSchema = referenceSchema("media_file");
export const queueReferenceSchema = referenceSchema("queue");
export const releaseReferenceSchema = referenceSchema("release");
export const importCandidateReferenceSchema = referenceSchema("import_candidate");
export const historyReferenceSchema = referenceSchema("history");
export const blocklistReferenceSchema = referenceSchema("blocklist");
export const configurationReferenceSchema = referenceSchema("configuration");
export const planReferenceSchema = referenceSchema("plan");
export const applyReferenceSchema = referenceSchema("apply");
export const jobReferenceSchema = referenceSchema("job");

/**
 * Every input property whose values are opaque references.
 *
 * The shared dispatcher resolves an input's references before it selects an
 * application, so it needs to know which properties hold one. It cannot infer
 * that from the value: a Prowlarr search term and a provider field value are
 * caller-authored text, and text that happens to look like a reference must
 * still be searched for rather than resolved. Listing the properties keeps that
 * distinction explicit, and a test derives the same list from the published
 * JSON Schemas so this cannot drift away from what the tools actually accept.
 */
export const referenceProperties = [
  "add",
  "candidate",
  "candidates",
  "dependentMigration",
  "episode",
  "episodes",
  "files",
  "items",
  "job",
  "lookup",
  "media",
  "movie",
  "movies",
  "plan",
  "qualityProfile",
  "queue",
  "records",
  "releases",
  "remove",
  "rootFolder",
  "series",
  "tags",
  "target",
] as const;

const referencePropertySet: ReadonlySet<string> = new Set(referenceProperties);

export function isReferenceProperty(name: string): boolean {
  return referencePropertySet.has(name);
}

/** An ISO-8601 calendar date, used for bounded date-window queries. */
export const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, "must be an ISO-8601 date");

export const isoDateTimeSchema = z.iso.datetime();

/** A bounded free-text search term. Never a path, URL, or upstream route. */
export const searchTermSchema = z.string().min(1).max(200);

export function bulkReferences(schema: z.ZodString): z.ZodArray<z.ZodString> {
  return z.array(schema).min(1).max(maxBulkItems);
}

/**
 * Fields every bounded collection query shares. Every query is bounded by
 * default: omitting `pageSize` yields {@link defaultPageSize} rather than an
 * unbounded fetch, and `detail` defaults to the payload that omits large
 * nested upstream structures.
 */
export const queryBaseShape = {
  applications: applicationFilterSchema.optional(),
  detail: detailLevelSchema.default("summary"),
  ...pageShape,
} as const;

/**
 * Declares a variant union as an object at the JSON Schema root.
 *
 * MCP requires a published tool input schema to carry `type: "object"` at its
 * root, and the Zod-to-JSON-Schema conversion emits only `oneOf` for a
 * discriminated union. Every member of these unions is an object, so declaring
 * the root type is accurate as well as required — without it a client rejects
 * the whole `tools/list` response.
 */
export function variantUnion<TSchema extends z.ZodType>(union: TSchema): TSchema {
  return union.meta({ type: "object" });
}

/** Fields every direct mutation intent shares. */
export const mutationBaseShape = {
  mode: modeSchema,
} as const;

/**
 * The alternative apply form: a plan reference instead of a restated intent.
 *
 * Apply mode accepts either a complete direct intent or a compatible plan
 * reference, so this is its own union member rather than an optional field
 * beside required intent fields — a `plan` that still required the intent
 * could never actually replace it. The mode is fixed to `apply` because
 * planning a plan reference has no meaning.
 */
export const planApplyShape = {
  mode: z.literal("apply"),
  plan: planReferenceSchema,
} as const;

/** The apply-from-plan form for a tool that carries no transient secrets. */
export const planApplySchema = z.strictObject({ ...planApplyShape });
