import type { ApplicationId } from "../../applications.js";
import { UpstreamError } from "../../http/errors.js";
import type { ConfigurationDomain } from "./domains.js";
import {
  classifyProviderFields,
  countWithheldProperties,
  describeSecret,
  isSecretFieldName,
  safeFieldValue,
} from "./fields.js";
import {
  type ConfiguredSecret,
  configurationRef,
  type DynamicFieldDescriptor,
  type ProfileEntry,
  type ProfileRecord,
  type ProviderRecord,
  type ProviderTemplate,
  type ResourceRecord,
  type SafeField,
} from "./model.js";
import {
  customFormatSchema,
  flatRecordSchema,
  isUpstreamId,
  parseConfiguration,
  providerResourceSchema,
  providerTemplateSchema,
  qualityProfileSchema,
} from "./parse.js";

/**
 * The safe serializers.
 *
 * Every function here builds output by naming what it wants, one property at a
 * time. None of them spreads an upstream record, and none of them iterates one
 * looking for what to keep — a property an instance added since this code was
 * written has no path out, because no line asks for it.
 *
 * The disclosure that something was dropped is a count, produced by comparing
 * the upstream record's own keys against the keys this file surfaced. That list
 * is assembled beside each mapping rather than derived from the output, so
 * widening the output without widening the list shows up as a wrong count
 * rather than as a silent leak.
 */

export type ConfigurationDetail = "summary" | "full";

export interface SerializationContext {
  readonly application: ApplicationId;
  readonly domain: ConfigurationDomain;
  readonly route: string;
  readonly detail: ConfigurationDetail;
}

/**
 * Every configuration row upstream is identified by an integer id, and a record
 * without one can be neither referenced nor reconciled. Refusing it names only
 * the route, like every other unreadable response.
 *
 * What counts as one is {@link isUpstreamId}, which is also what the internal
 * capture matches on: publishing a reference the resource set would not
 * recognize is exactly the divergence the two representations exist to prevent.
 */
function requireId(context: SerializationContext, id: unknown): number {
  if (!isUpstreamId(id)) {
    throw new UpstreamError("unexpected-response", {
      application: context.application,
      operation: context.route,
    });
  }
  return id;
}

function text(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function number(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function flag(value: boolean | null | undefined): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function isSecretPrivacy(privacy: string | null | undefined): boolean {
  if (typeof privacy !== "string") {
    return false;
  }
  const normalized = privacy.toLowerCase().replaceAll(/[^a-z0-9]/gu, "");
  return normalized === "password" || normalized === "apikey" || normalized === "username";
}

/**
 * Acknowledges any top-level property whose name reads as a credential.
 *
 * Providers keep their credentials in the dynamic `fields` array, and profiles
 * and resources are not supposed to carry one at all — which is exactly why
 * this runs over every record. A classifier that only ever inspected the place
 * secrets are expected would be one upstream shape change away from inspecting
 * nothing.
 */
function topLevelSecrets(raw: Record<string, unknown>): readonly ConfiguredSecret[] {
  return Object.keys(raw)
    .filter((key) => isSecretFieldName(key))
    .map((key) => describeSecret(key, raw[key]));
}

/**
 * Whether a provider is on.
 *
 * The applications disagree about what "on" is: a download client has a single
 * `enable`, while an indexer has three independent search switches. A provider
 * with any switch on is reported as enabled, and one whose payload carries no
 * switch at all is reported as neither.
 */
function providerEnabled(resource: {
  readonly enable?: boolean | null | undefined;
  readonly enableRss?: boolean | null | undefined;
  readonly enableAutomaticSearch?: boolean | null | undefined;
  readonly enableInteractiveSearch?: boolean | null | undefined;
}): boolean | undefined {
  const single = flag(resource.enable);
  if (single !== undefined) {
    return single;
  }
  const switches = [
    resource.enableRss,
    resource.enableAutomaticSearch,
    resource.enableInteractiveSearch,
  ].filter((value): value is boolean => typeof value === "boolean");
  return switches.length === 0 ? undefined : switches.some((value) => value);
}

const providerSurfacedKeys = [
  "id",
  "name",
  "implementation",
  "implementationName",
  "configContract",
  "protocol",
  "priority",
  "enable",
  "enableRss",
  "enableAutomaticSearch",
  "enableInteractiveSearch",
  "syncLevel",
  "tags",
  "fields",
];

/**
 * Whether this provider's field list comes from a tracker definition rather
 * than from the application's own compiled schema.
 *
 * Exported because the write side has to make the same judgement: a diff that
 * reported a definition-driven provider's current field values would publish
 * exactly what this suppression exists to withhold.
 *
 * Prowlarr's Cardigann indexers take their fields from a YAML file, so every
 * name in them is chosen by that file. The classifier already refuses a value
 * whose kind does not match the name it borrowed, but a handful of allowlisted
 * names legitimately carry free text, and for a definition-driven provider
 * there is no reason to trust those either. So a dynamically defined provider
 * reports no field values at all: its credentials are still acknowledged, and
 * everything else is counted as withheld.
 */
export function isDynamicallyDefined(raw: Record<string, unknown>): boolean {
  const implementation =
    typeof raw.implementation === "string" ? text(raw.implementation)?.toLowerCase() : undefined;
  return implementation === "cardigann" || "definitionName" in raw || "definitionFile" in raw;
}

export function serializeProvider(
  context: SerializationContext,
  raw: Record<string, unknown>,
): ProviderRecord {
  const resource = parseConfiguration(
    providerResourceSchema,
    raw,
    context.application,
    context.route,
  );
  const classified = classifyProviderFields(
    (resource.fields ?? []).map((field) => ({
      name: field.name,
      value: field.value,
      privacy: field.privacy,
    })),
  );
  const dynamic = isDynamicallyDefined(raw);
  const reportedFields = dynamic ? [] : classified.fields;
  const withheldFieldCount = classified.withheldCount + (dynamic ? classified.fields.length : 0);
  const secrets = [...classified.secrets, ...topLevelSecrets(raw)];
  const tags = (resource.tags ?? []).map((id) => configurationRef(context.application, "tags", id));
  const surfaced = [
    ...providerSurfacedKeys,
    ...secrets.map((secret) => secret.name).filter((name) => name in raw),
  ];

  return {
    family: "provider",
    ref: configurationRef(context.application, context.domain, requireId(context, resource.id)),
    name: text(resource.name),
    implementation: text(resource.implementation) ?? text(resource.implementationName),
    configContract: text(resource.configContract),
    protocol: text(resource.protocol),
    priority: number(resource.priority),
    enabled: providerEnabled(resource),
    syncLevel: text(resource.syncLevel),
    ...(tags.length === 0 ? {} : { tags }),
    ...(context.detail === "full" ? { fields: reportedFields } : {}),
    secrets,
    withheld: {
      count: withheldFieldCount + countWithheldProperties(raw, surfaced),
    },
  };
}

/**
 * The top-level properties each non-provider domain reports.
 *
 * Profiles and resources have fixed shapes, so their allowlist is by domain
 * rather than by dynamic field. Two families of name are deliberately missing.
 * A remote path mapping's `host` names the operator's download machine, and
 * nothing here needs it in order to say what the mapping does. Anything nested
 * — a profile's quality tree, a root folder's unmapped folder list — is not a
 * scalar, and is reported as an ordered entry list where it matters at all.
 */
const domainPropertyAllowlist: Readonly<Record<ConfigurationDomain, readonly string[]>> = {
  indexers: [],
  download_clients: [],
  applications: [],
  notifications: [],
  import_lists: [],
  metadata: [],
  proxies: [],
  quality_profiles: [
    "upgradeAllowed",
    "cutoff",
    "minFormatScore",
    "cutoffFormatScore",
    "minUpgradeFormatScore",
  ],
  custom_formats: ["includeCustomFormatWhenRenaming"],
  release_profiles: ["enabled", "indexerId", "required", "ignored"],
  delay_profiles: [
    "enableUsenet",
    "enableTorrent",
    "preferredProtocol",
    "usenetDelay",
    "torrentDelay",
    "bypassIfHighestQuality",
    "bypassIfAboveCustomFormatScore",
    "minimumCustomFormatScore",
    "order",
  ],
  app_profiles: ["enableRss", "enableAutomaticSearch", "enableInteractiveSearch", "minimumSeeders"],
  tags: [],
  root_folders: ["path", "accessible", "freeSpace", "totalSpace"],
  remote_path_mappings: ["remotePath", "localPath"],
  import_list_exclusions: ["tvdbId", "tmdbId", "title", "movieTitle", "movieYear", "year"],
};

interface FlatMapping {
  readonly fields: readonly SafeField[];
  readonly secrets: readonly ConfiguredSecret[];
  /** The upstream keys this mapping accounted for, for the withheld count. */
  readonly surfaced: readonly string[];
}

function mapFlatRecord(raw: Record<string, unknown>, allowed: readonly string[]): FlatMapping {
  const secrets = topLevelSecrets(raw);
  const fields: SafeField[] = [];
  const surfaced: string[] = secrets.map((secret) => secret.name);

  for (const name of allowed) {
    if (!(name in raw) || isSecretFieldName(name)) {
      continue;
    }
    const value = safeFieldValue(raw[name]);
    if (value !== undefined) {
      fields.push({ name, value });
      surfaced.push(name);
    }
  }

  return { fields, secrets, surfaced };
}

function recordName(raw: Record<string, unknown>): string | undefined {
  const parsed = flatRecordSchema.safeParse(raw);
  if (!parsed.success) {
    return undefined;
  }
  return text(parsed.data.name) ?? text(parsed.data.label);
}

/**
 * The identity keys a record accounts for. Both name properties are listed
 * because {@link recordName} reads either, and a key a record does not carry
 * costs the withheld count nothing.
 */
const identityKeys = ["id", "name", "label"];

/**
 * The ordered entries a profile is made of.
 *
 * Only the two profile domains whose documents are ordered lists produce these.
 * Ordering is reported exactly as the instance sent it, never sorted: the order
 * *is* the preference, and a later full-resource write has to send it back.
 */
function profileEntries(
  context: SerializationContext,
  raw: Record<string, unknown>,
): readonly ProfileEntry[] | undefined {
  if (context.domain === "quality_profiles") {
    const profile = parseConfiguration(
      qualityProfileSchema,
      raw,
      context.application,
      context.route,
    );
    const qualities = (profile.items ?? []).flatMap((item): ProfileEntry[] => {
      const name = text(item.name) ?? text(item.quality?.name);
      return name === undefined ? [] : [{ name, allowed: flag(item.allowed) }];
    });
    const formats = (profile.formatItems ?? []).flatMap((item): ProfileEntry[] => {
      const name = text(item.name);
      return name === undefined ? [] : [{ name, score: number(item.score) }];
    });
    return [...qualities, ...formats];
  }
  if (context.domain === "custom_formats") {
    const format = parseConfiguration(customFormatSchema, raw, context.application, context.route);
    return (format.specifications ?? []).flatMap((specification): ProfileEntry[] => {
      const name = text(specification.name);
      return name === undefined ? [] : [{ name }];
    });
  }
  return undefined;
}

function structuralKeysFor(domain: ConfigurationDomain): readonly string[] {
  if (domain === "quality_profiles") {
    return ["items", "formatItems"];
  }
  return domain === "custom_formats" ? ["specifications"] : [];
}

export function serializeProfile(
  context: SerializationContext,
  raw: Record<string, unknown>,
): ProfileRecord {
  const identified = parseConfiguration(flatRecordSchema, raw, context.application, context.route);
  const mapped = mapFlatRecord(raw, domainPropertyAllowlist[context.domain]);
  const entries = profileEntries(context, raw);
  const surfaced = [...identityKeys, ...mapped.surfaced, ...structuralKeysFor(context.domain)];

  return {
    family: "profile",
    ref: configurationRef(context.application, context.domain, requireId(context, identified.id)),
    name: recordName(raw),
    ...(context.detail === "full" ? { fields: mapped.fields } : {}),
    ...(entries === undefined ? {} : { entries }),
    secrets: mapped.secrets,
    withheld: { count: countWithheldProperties(raw, surfaced) },
  };
}

export function serializeResource(
  context: SerializationContext,
  raw: Record<string, unknown>,
): ResourceRecord {
  const identified = parseConfiguration(flatRecordSchema, raw, context.application, context.route);
  const mapped = mapFlatRecord(raw, domainPropertyAllowlist[context.domain]);

  return {
    family: "resource",
    ref: configurationRef(context.application, context.domain, requireId(context, identified.id)),
    name: recordName(raw),
    ...(context.detail === "full" ? { fields: mapped.fields } : {}),
    secrets: mapped.secrets,
    withheld: {
      count: countWithheldProperties(raw, [...identityKeys, ...mapped.surfaced]),
    },
  };
}

/**
 * Maps one provider template from the instance's schema endpoint.
 *
 * A descriptor says what a field is; it never carries what a field holds. The
 * schema endpoint returns a `value` for every field, and for an
 * already-configured template that value is the current setting — so the
 * property is simply never read here.
 */
export function serializeProviderTemplate(
  context: SerializationContext,
  raw: Record<string, unknown>,
): ProviderTemplate | undefined {
  const template = parseConfiguration(
    providerTemplateSchema,
    raw,
    context.application,
    context.route,
  );
  const implementation = text(template.implementation) ?? text(template.implementationName);
  if (implementation === undefined) {
    return undefined;
  }

  return {
    implementation,
    name: text(template.name) ?? text(template.implementationName),
    configContract: text(template.configContract),
    fields: (template.fields ?? []).map(
      (field): DynamicFieldDescriptor => ({
        name: field.name,
        label: text(field.label),
        type: text(field.type),
        advanced: flag(field.advanced),
        secret: isSecretFieldName(field.name) || isSecretPrivacy(field.privacy),
      }),
    ),
  };
}
