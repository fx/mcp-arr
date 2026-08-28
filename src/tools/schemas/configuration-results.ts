import { z } from "zod";
import {
  profileDomains,
  providerDomains,
  resourceDomains,
} from "../../adapters/configuration/domains.js";
import { configurationReferenceSchema } from "./common.js";

/**
 * The published payload of `arr_config_observe`, the whole of the configuration
 * surface.
 *
 * These are the contract, not a description of it: every envelope this server
 * produces is validated against the schema a host received from `tools/list`
 * before it leaves the process, so a field the adapter added and this file does
 * not declare is refused rather than published. That is the property worth
 * having here in particular — the adapter's whole design is that what may leave
 * is decided by an allowlist, and this is the second one, closest to the wire.
 *
 * Every domain is the closed set its family actually has, so `tools/list`
 * advertises the shapes this server can produce and no others.
 *
 * Every identity is a reference. A configuration record's upstream row number
 * is held in the reference store and never appears in a result, so a caller can
 * neither read one out of a token nor name a row this server did not return.
 */

/**
 * The domain sets, taken from the adapter's own lists rather than from the
 * input schemas beside this file. Both directions matter: the published result
 * cannot name a domain the adapter does not model, and importing the input
 * module here would close a cycle between the two halves of one tool's schema.
 */
const providerDomainSchema = z.enum(providerDomains);
const profileDomainSchema = z.enum(profileDomains);
const resourceDomainSchema = z.enum(resourceDomains);

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
 * One observed domain.
 *
 * A provider view declares its records and nothing else. The instance's
 * template catalogue is not part of it: its size is set by the catalogue rather
 * than by the query's page bound, and the only operation that needs a template
 * reads the schema route itself.
 */
export const configurationViewSchema = z.discriminatedUnion("family", [
  z.strictObject({
    family: z.literal("provider"),
    domain: providerDomainSchema,
    records: z.array(providerRecordSchema),
  }),
  z.strictObject({
    family: z.literal("profile"),
    domain: profileDomainSchema,
    records: z.array(profileRecordSchema),
  }),
  z.strictObject({
    family: z.literal("resource"),
    domain: resourceDomainSchema,
    records: z.array(resourceRecordSchema),
  }),
]);
