import type { ApplicationId } from "../../applications.js";
import type { ConfigurationDomain } from "./domains.js";

/**
 * The model-facing configuration model.
 *
 * Everything in this file is *output*: it is what a calling agent is allowed to
 * see. It is built by explicit allowlist from the upstream payload, never by
 * copying one, so a field a newer instance adds cannot appear here by simply
 * existing. The untouched upstream payload lives beside it in
 * {@link ./resources.js}, which is what a later full-resource write sends; the
 * two are deliberately separate types so no code path can mistake one for the
 * other.
 *
 * No type here has a field a secret is *meant* to travel in: a secret is
 * reported only as {@link ConfiguredSecret}, which says that one is configured
 * without saying what it is. That is a statement about intent, not a guarantee
 * the types can make — {@link SafeField} holds a primitive, and a primitive is
 * what a secret is. The guarantee lives in the classifier in
 * {@link ./fields.js}, which decides what may reach a `SafeField` at all, and
 * in the serializers that build these records one named property at a time.
 * Widening a type here without widening that classifier is how a leak would be
 * introduced, so the two are changed together.
 */

/**
 * A pointer at one upstream configuration record.
 *
 * It is not the opaque `cfg_` reference a caller receives: the tool layer mints
 * those from this. Keeping the upstream identifier here and nowhere in the
 * published output is what stops a caller from naming an upstream row directly.
 */
export interface ConfigurationRef {
  readonly application: ApplicationId;
  readonly domain: ConfigurationDomain;
  readonly id: string;
}

export function configurationRef(
  application: ApplicationId,
  domain: ConfigurationDomain,
  id: number | string,
): ConfigurationRef {
  return { application, domain, id: String(id) };
}

/** A value an allowlisted field may carry out. Never an object or a nested array. */
export type SafeFieldValue = string | number | boolean | readonly (string | number | boolean)[];

/**
 * One allowlisted field and its current value.
 *
 * A dynamic field reaches this type only by being named in the classifier's
 * allowlist *and* carrying a value of the kind and shape that allowlist records
 * for the name. Both halves are load-bearing: the name was chosen by the same
 * definition that supplied the value, so on its own it vouches for nothing.
 */
export interface SafeField {
  readonly name: string;
  readonly value: SafeFieldValue;
}

/**
 * Whether a secret field currently holds something, and whether the instance
 * answered with a mask rather than the value.
 *
 * `masked` matters to reconciliation rather than to the reader: an application
 * that returns a sentinel instead of the stored secret also accepts that
 * sentinel back to mean "keep what is stored", which is the only way a
 * full-resource update can leave a secret it was never told alone.
 */
export interface ConfiguredSecret {
  readonly name: string;
  readonly state: "configured" | "unconfigured";
  readonly masked: boolean;
}

/**
 * What was dropped on the way out.
 *
 * Only a count, never a name. A dynamic provider definition names its own
 * fields, and those names describe the operator's tracker or client as surely
 * as the values do, so reporting how many were withheld is the most that can be
 * said without becoming the leak this type exists to prevent.
 */
export interface WithheldFields {
  readonly count: number;
}

interface ConfigurationRecordBase {
  readonly ref: ConfigurationRef;
  readonly name?: string | undefined;
  /** Populated at `full` detail only; a summary carries identity and state. */
  readonly fields?: readonly SafeField[] | undefined;
  readonly secrets: readonly ConfiguredSecret[];
  readonly withheld: WithheldFields;
}

/**
 * One provider: an indexer, download client, notification, list, metadata
 * writer, proxy, or — on Prowlarr — a synchronized application.
 */
export interface ProviderRecord extends ConfigurationRecordBase {
  readonly family: "provider";
  readonly implementation?: string | undefined;
  readonly configContract?: string | undefined;
  readonly protocol?: string | undefined;
  readonly priority?: number | undefined;
  readonly enabled?: boolean | undefined;
  /** Prowlarr application sync level, whose full-sync form can remove indexers. */
  readonly syncLevel?: string | undefined;
  readonly tags?: readonly ConfigurationRef[] | undefined;
}

/** One profile document: quality, custom format, release, delay, or app. */
export interface ProfileRecord extends ConfigurationRecordBase {
  readonly family: "profile";
  /**
   * The ordered entries the profile is made of, by name only. Ordering is
   * meaningful upstream, so it is preserved as reported rather than sorted.
   */
  readonly entries?: readonly ProfileEntry[] | undefined;
}

export interface ProfileEntry {
  readonly name: string;
  readonly allowed?: boolean | undefined;
  readonly score?: number | undefined;
}

/** One flat resource: a tag, root folder, path mapping, or list exclusion. */
export interface ResourceRecord extends ConfigurationRecordBase {
  readonly family: "resource";
}

export type ConfigurationRecord = ProviderRecord | ProfileRecord | ResourceRecord;

/**
 * One dynamic provider field as the instance's schema describes it.
 *
 * A descriptor never carries a value, not even the default the schema offers:
 * the schema for an already-configured template can echo the current setting,
 * and the point of this type is to say what a field *is*, not what it holds.
 */
export interface DynamicFieldDescriptor {
  readonly name: string;
  readonly label?: string | undefined;
  readonly type?: string | undefined;
  readonly advanced?: boolean | undefined;
  /** Whether supplying this field means supplying a secret. */
  readonly secret: boolean;
}

/**
 * One provider template the instance offers for a domain.
 *
 * Internal to the operation that reads a schema route: the instance's
 * catalogue is not something an observation returns, so this describes what a
 * staleness check digests rather than anything a caller receives.
 */
export interface ProviderTemplate {
  readonly implementation: string;
  readonly name?: string | undefined;
  readonly configContract?: string | undefined;
  readonly fields: readonly DynamicFieldDescriptor[];
}

/**
 * One domain's observation, discriminated by family so a consumer that knows
 * which domain it asked for also knows which record type it is holding.
 */
export type ConfigurationView =
  | {
      readonly family: "provider";
      readonly domain: ConfigurationDomain;
      readonly records: readonly ProviderRecord[];
    }
  | {
      readonly family: "profile";
      readonly domain: ConfigurationDomain;
      readonly records: readonly ProfileRecord[];
    }
  | {
      readonly family: "resource";
      readonly domain: ConfigurationDomain;
      readonly records: readonly ResourceRecord[];
    };
