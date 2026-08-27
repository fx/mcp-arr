import { z } from "zod";
import { syncLevels } from "../../adapters/configuration/sync.js";
import { toolResultSchema } from "../results.js";
import {
  applicationIdSchema,
  bulkReferences,
  configurationReferenceSchema,
  mutationBaseShape,
  planApplyShape,
  queryBaseShape,
} from "./common.js";
import {
  configurationReconcileDataSchema,
  configurationViewSchema,
} from "./configuration-results.js";
import { variantUnion } from "./publish.js";

/**
 * Provider domains share a dynamic upstream schema; profile and resource
 * domains do not. They are separate discriminated inputs because their
 * reconciliation rules differ, not because their upstream routes differ.
 */
export const providerDomainSchema = z.enum([
  "indexers",
  "download_clients",
  "applications",
  "notifications",
  "import_lists",
  "metadata",
  "proxies",
]);

export const profileDomainSchema = z.enum([
  "quality_profiles",
  "custom_formats",
  "release_profiles",
  "delay_profiles",
  "app_profiles",
]);

export const resourceDomainSchema = z.enum([
  "tags",
  "root_folders",
  "remote_path_mappings",
  "import_list_exclusions",
]);

/**
 * The typed observation domains. Observation is allowlisted on the way out:
 * unknown upstream fields are dropped from the result and secret fields are
 * reported as configured or unconfigured rather than by value.
 */
export const configObserveInputSchema = variantUnion(
  z.discriminatedUnion("domain", [
    z.strictObject({ domain: z.literal("indexers"), ...queryBaseShape }),
    z.strictObject({ domain: z.literal("download_clients"), ...queryBaseShape }),
    z.strictObject({ domain: z.literal("applications"), ...queryBaseShape }),
    z.strictObject({ domain: z.literal("notifications"), ...queryBaseShape }),
    z.strictObject({ domain: z.literal("import_lists"), ...queryBaseShape }),
    z.strictObject({ domain: z.literal("metadata"), ...queryBaseShape }),
    z.strictObject({ domain: z.literal("proxies"), ...queryBaseShape }),
    z.strictObject({ domain: z.literal("quality_profiles"), ...queryBaseShape }),
    z.strictObject({ domain: z.literal("custom_formats"), ...queryBaseShape }),
    z.strictObject({ domain: z.literal("release_profiles"), ...queryBaseShape }),
    z.strictObject({ domain: z.literal("delay_profiles"), ...queryBaseShape }),
    z.strictObject({ domain: z.literal("app_profiles"), ...queryBaseShape }),
    z.strictObject({ domain: z.literal("tags"), ...queryBaseShape }),
    z.strictObject({ domain: z.literal("root_folders"), ...queryBaseShape }),
    z.strictObject({ domain: z.literal("remote_path_mappings"), ...queryBaseShape }),
    z.strictObject({ domain: z.literal("import_list_exclusions"), ...queryBaseShape }),
  ]),
);

/**
 * A value a dynamic provider field can hold. Provider schemas are version
 * specific, so the value type is open while the field list is not: fields are
 * named one by one instead of arriving as a free-form object, which keeps the
 * caller from smuggling in structure the reconciler never inspects.
 */
export const configurationFieldValueSchema = z.union([
  z.string().max(4096),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.union([z.string().max(1024), z.number()])).max(200),
]);

const configurationFieldNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z][A-Za-z0-9_.-]*$/u, "must be a provider field name");

const configurationFieldSchema = z.strictObject({
  name: configurationFieldNameSchema,
  value: configurationFieldValueSchema,
});

const desiredFieldsSchema = z.array(configurationFieldSchema).max(200);

/** Field removal is always explicit; an omitted field is preserved as-is. */
const removeFieldsSchema = z.array(configurationFieldNameSchema).max(200);

/**
 * A secret supplied for this request only.
 *
 * The value is used to build the current upstream request and is never written
 * to a plan, a receipt, a diagnostic, or a result. Applying a secret-bearing
 * plan therefore requires resupplying each named secret.
 */
const transientSecretSchema = z.strictObject({
  name: configurationFieldNameSchema,
  value: z.string().min(1).max(4096),
});

const transientSecretsSchema = z.array(transientSecretSchema).max(20);

const reconcileBaseShape = {
  ...mutationBaseShape,
  application: applicationIdSchema,
} as const;

/**
 * The typed reconciliation intents.
 *
 * Reconciliation is a scoped read-modify-write: the desired state names only
 * the fields it owns, everything else is preserved from the current upstream
 * resource, and apply fails as stale when the resource or its provider schema
 * changed materially since the plan. Arbitrary provider action names are not
 * accepted — testing a provider is its own typed intent, disclosed as an
 * open-world operation because it can contact external systems.
 */
const configReconcileIntentSchema = z.discriminatedUnion("intent", [
  z.strictObject({
    intent: z.literal("reconcile_provider"),
    ...reconcileBaseShape,
    domain: providerDomainSchema,
    /** Absent creates a new provider; present updates that one. */
    target: configurationReferenceSchema.optional(),
    fields: desiredFieldsSchema,
    removeFields: removeFieldsSchema.optional(),
    secrets: transientSecretsSchema.optional(),
  }),
  z.strictObject({
    intent: z.literal("delete_provider"),
    ...reconcileBaseShape,
    domain: providerDomainSchema,
    target: configurationReferenceSchema,
  }),
  z.strictObject({
    intent: z.literal("test_provider"),
    ...reconcileBaseShape,
    domain: providerDomainSchema,
    target: configurationReferenceSchema,
    secrets: transientSecretsSchema.optional(),
  }),
  z.strictObject({
    /**
     * Saving a provider the instance would refuse over validation warnings.
     *
     * Its own intent rather than a flag on `reconcile_provider`, because a
     * bypass has to be something a caller asked for and not something that
     * happened because a save was easier that way. Reaching it means naming it.
     *
     * It bypasses warnings and only warnings. The provider is tested first, and
     * a provider that fails validation outright is refused however explicitly
     * the bypass was requested — the instance reported something that is not a
     * warning, and no field on a request turns it into one.
     */
    intent: z.literal("force_provider_save"),
    ...reconcileBaseShape,
    domain: providerDomainSchema,
    /** Absent creates a new provider; present updates that one. */
    target: configurationReferenceSchema.optional(),
    fields: desiredFieldsSchema,
    removeFields: removeFieldsSchema.optional(),
    secrets: transientSecretsSchema.optional(),
    /**
     * The caller's acknowledgement, required and required to be true. A field
     * that could be `false` would make the intent mean two things, one of which
     * `reconcile_provider` already means.
     */
    acceptValidationWarnings: z.literal(true),
  }),
  z.strictObject({
    intent: z.literal("reconcile_profile"),
    ...reconcileBaseShape,
    domain: profileDomainSchema,
    target: configurationReferenceSchema.optional(),
    fields: desiredFieldsSchema,
    removeFields: removeFieldsSchema.optional(),
  }),
  z.strictObject({
    intent: z.literal("delete_profile"),
    ...reconcileBaseShape,
    domain: profileDomainSchema,
    target: configurationReferenceSchema,
    /** The replacement a dependent resource migrates to, when one is required. */
    dependentMigration: configurationReferenceSchema.optional(),
  }),
  z.strictObject({
    intent: z.literal("reconcile_resource"),
    ...reconcileBaseShape,
    domain: resourceDomainSchema,
    target: configurationReferenceSchema.optional(),
    fields: desiredFieldsSchema,
    removeFields: removeFieldsSchema.optional(),
  }),
  z.strictObject({
    intent: z.literal("delete_resource"),
    ...reconcileBaseShape,
    domain: resourceDomainSchema,
    target: configurationReferenceSchema,
  }),
  z.strictObject({
    /**
     * Prowlarr application sync, whose full-sync level can remove remote
     * indexers.
     *
     * Several mappings may be named, and each is answered on its own: Prowlarr
     * synchronizes each mapping separately, so a partial result is the normal
     * case rather than an error path and there is nothing here for a single
     * target to report.
     */
    intent: z.literal("reconcile_application_sync"),
    ...mutationBaseShape,
    application: z.literal("prowlarr"),
    targets: bulkReferences(configurationReferenceSchema),
    syncLevel: z.enum(syncLevels),
    /**
     * Whether to start a synchronization once the levels are written. Explicit
     * and never defaulted: a sync pushes indexers into another application, and
     * a full-sync level pushes deletions with them.
     */
    startSync: z.boolean(),
  }),
]);

/**
 * Applying a recorded reconciliation plan. A secret-bearing plan retains only
 * the names of the secrets it needs, so the caller resupplies each value here
 * for this request alone.
 */
const configReconcilePlanApplySchema = z.strictObject({
  ...planApplyShape,
  secrets: transientSecretsSchema.optional(),
});

export const configReconcileInputSchema = variantUnion(
  z.union([configReconcileIntentSchema, configReconcilePlanApplySchema]),
);

export const configObserveOutputSchema = toolResultSchema({ data: configurationViewSchema });
export const configReconcileOutputSchema = toolResultSchema({
  mutation: true,
  data: configurationReconcileDataSchema,
});
