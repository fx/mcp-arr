import { z } from "zod";
import { configurationReferenceSchema } from "./common.js";

/**
 * The published payloads of the two configuration tools.
 *
 * These are the contract, not a description of it: every envelope this server
 * produces is validated against the schema a host received from `tools/list`
 * before it leaves the process, so a field the adapter added and this file does
 * not declare is refused rather than published. That is the property worth
 * having here in particular — the adapter's whole design is that what may leave
 * is decided by an allowlist, and this is the second one, closest to the wire.
 *
 * Every identity is a reference. A configuration record's upstream row number
 * is held in the reference store and never appears in a result, so a caller can
 * neither read one out of a token nor name a row this server did not return.
 */

const safeFieldValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.union([z.string(), z.number(), z.boolean()])),
]);

const safeFieldSchema = z.strictObject({
  name: z.string().min(1),
  value: safeFieldValueSchema,
});

/**
 * A credential, reported as configured or not and never by value. `masked` says
 * the instance answered with a sentinel rather than the stored value, which is
 * what lets a full-resource write send it back untouched.
 */
const configuredSecretSchema = z.strictObject({
  name: z.string().min(1),
  state: z.enum(["configured", "unconfigured"]),
  masked: z.boolean(),
});

/** How many fields were dropped on the way out. A count, never a name. */
const withheldSchema = z.strictObject({ count: z.int().min(0) });

const profileEntrySchema = z.strictObject({
  name: z.string().min(1),
  allowed: z.boolean().optional(),
  score: z.number().optional(),
});

const recordBaseShape = {
  reference: configurationReferenceSchema,
  name: z.string().optional(),
  fields: z.array(safeFieldSchema).optional(),
  secrets: z.array(configuredSecretSchema),
  withheld: withheldSchema,
} as const;

const providerRecordSchema = z.strictObject({
  ...recordBaseShape,
  family: z.literal("provider"),
  implementation: z.string().optional(),
  configContract: z.string().optional(),
  protocol: z.string().optional(),
  priority: z.number().optional(),
  enabled: z.boolean().optional(),
  syncLevel: z.string().optional(),
  tags: z.array(configurationReferenceSchema).optional(),
});

const profileRecordSchema = z.strictObject({
  ...recordBaseShape,
  family: z.literal("profile"),
  entries: z.array(profileEntrySchema).optional(),
});

const resourceRecordSchema = z.strictObject({
  ...recordBaseShape,
  family: z.literal("resource"),
});

/**
 * One dynamic field as the instance's schema describes it. A descriptor says
 * what a field is and never what it holds, so there is no value here to declare.
 */
const dynamicFieldSchema = z.strictObject({
  name: z.string().min(1),
  label: z.string().optional(),
  type: z.string().optional(),
  advanced: z.boolean().optional(),
  secret: z.boolean(),
});

const providerTemplateSchema = z.strictObject({
  implementation: z.string().min(1),
  name: z.string().optional(),
  configContract: z.string().optional(),
  fields: z.array(dynamicFieldSchema),
});

const providerSchemaSchema = z.strictObject({
  application: z.string().min(1),
  domain: z.string().min(1),
  templates: z.array(providerTemplateSchema),
});

export const configurationViewSchema = z.discriminatedUnion("family", [
  z.strictObject({
    family: z.literal("provider"),
    domain: z.string().min(1),
    records: z.array(providerRecordSchema),
    schema: providerSchemaSchema.optional(),
  }),
  z.strictObject({
    family: z.literal("profile"),
    domain: z.string().min(1),
    records: z.array(profileRecordSchema),
  }),
  z.strictObject({
    family: z.literal("resource"),
    domain: z.string().min(1),
    records: z.array(resourceRecordSchema),
  }),
]);

/**
 * One field a write moves.
 *
 * `before` is absent where the current value is not one this server may report,
 * and `redacted` says so; a pointer reports the record it now names rather than
 * the value the instance stores for it, which is how a root folder's path stays
 * out of a diff.
 */
const configurationChangeSchema = z.strictObject({
  path: z.string().min(1),
  action: z.enum(["set", "clear", "unchanged"]),
  before: safeFieldValueSchema.optional(),
  after: safeFieldValueSchema.optional(),
  redacted: z.boolean().optional(),
  reference: configurationReferenceSchema.optional(),
});

const secretDispositionSchema = z.strictObject({
  name: z.string().min(1),
  disposition: z.enum(["preserved", "cleared", "set", "changed"]),
});

export const configurationDiffSchema = z.strictObject({
  reference: configurationReferenceSchema,
  changes: z.array(configurationChangeSchema),
  secrets: z.array(secretDispositionSchema),
  /** What this write carried through without touching, as counts. */
  preserved: z.strictObject({ properties: z.int().min(0), fields: z.int().min(0) }),
});

/**
 * What a provider test established.
 *
 * A finding names the field the instance objected to and whether the objection
 * was a warning; the instance's own message is deliberately not published,
 * because a rejection body is upstream text this server does not quote back.
 */
const validationFindingSchema = z.strictObject({
  field: z.string().min(1).optional(),
  warning: z.boolean(),
});

export const providerTestResultSchema = z.strictObject({
  outcome: z.enum(["passed", "warned", "failed"]),
  findings: z.array(validationFindingSchema),
  /** Objections this server could not read, counted rather than guessed at. */
  unreadable: z.int().min(0),
});

const syncEffectSchema = z.strictObject({
  indexer: configurationReferenceSchema,
  name: z.string().min(1),
  effect: z.enum(["add", "update", "remove", "stale"]),
  reason: z.string().min(1),
});

const syncItemSchema = z.strictObject({
  reference: configurationReferenceSchema,
  name: z.string().min(1),
  selection: z.string().min(1),
  currentLevel: z.enum(["disabled", "add_only", "full_sync"]).optional(),
  desiredLevel: z.enum(["disabled", "add_only", "full_sync"]),
  effects: z.array(syncEffectSchema),
  changed: z.boolean(),
  attempted: z.boolean(),
  verified: z.boolean().optional(),
});

export const applicationSyncResultSchema = z.strictObject({
  mappings: z.array(syncItemSchema),
});

/**
 * The three payloads a reconciliation answers with, kept apart because they say
 * different things: what a desired-state write would change, what a test found,
 * and what each synchronized mapping did.
 */
export const configurationReconcileDataSchema = z.union([
  configurationDiffSchema,
  providerTestResultSchema,
  applicationSyncResultSchema,
]);
