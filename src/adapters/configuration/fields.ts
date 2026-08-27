import type { ConfiguredSecret, SafeField, SafeFieldValue } from "./model.js";

/**
 * Field classification for dynamic provider payloads.
 *
 * A provider's `fields` array is defined by the instance, not by this server:
 * Prowlarr's Cardigann indexers take their field list from a YAML tracker
 * definition, so the names, the count, and the meaning all change with the
 * definition file. Nothing here may therefore depend on recognizing a payload.
 *
 * Three rules do all the work, applied in this order:
 *
 * 1. A field whose name reads as a credential — or whose upstream descriptor
 *    says so — is a secret. Only that it is configured is reported.
 * 2. A field explicitly named in {@link providerFieldAllowlist} carries its
 *    value out, and only if the value is a bounded primitive.
 * 3. Everything else is withheld and counted.
 *
 * The order matters: the secret test runs first, so adding a name to the
 * allowlist can never turn a credential into output. Upstream privacy metadata
 * can only escalate a field to secret, never de-escalate one — a definition
 * file that declares its passkey "normal" does not get to be believed.
 */

/**
 * Name fragments that make a field a credential or an identity.
 *
 * Matched against the name with case and separators removed, so `API_Key`,
 * `apiKey`, and `api-key` are one fragment. Identity fragments are here beside
 * the credential ones on purpose: a username, a login, or an account address
 * identifies the operator to anyone reading the result, and withholding its
 * value costs a caller nothing it needs in order to describe configuration.
 */
const secretNameFragments = [
  "apikey",
  "auth",
  "captcha",
  "cookie",
  "credential",
  "email",
  "login",
  "pass",
  "pin",
  "rsskey",
  "secret",
  "session",
  "token",
  "user",
] as const;

/**
 * Upstream privacy words that mean the field holds a credential. An unknown
 * word is not trusted either way: rule 2 still has to name the field before its
 * value goes anywhere.
 */
const secretPrivacyWords: ReadonlySet<string> = new Set(["password", "apikey", "username"]);

/**
 * The provider field names whose values may be reported.
 *
 * One list serves every provider domain, because the implementations overlap —
 * the same download client appears under Sonarr, Radarr, and Prowlarr — and a
 * per-domain split would only duplicate entries while making it easier for one
 * copy to drift permissive.
 *
 * Every name here is an operational setting. Deliberately absent: anything that
 * names a host, URL, path, port, folder, or account, which describes the
 * operator's environment rather than the configuration's behavior, and anything
 * free-form enough to carry a credential in its text — an indexer's additional
 * query parameters are the usual place a passkey actually lives.
 */
export const providerFieldAllowlist: ReadonlySet<string> = new Set([
  "addPaused",
  "animeCategories",
  "animeStandardFormatSearch",
  "animeSyncCategories",
  "categories",
  "discographySeedTime",
  "firstAndLast",
  "initialState",
  "minimumSeeders",
  "movieCategory",
  "multiLanguages",
  "musicCategory",
  "olderMoviePriority",
  "olderTvPriority",
  "packSeedTime",
  "recentMoviePriority",
  "recentTvPriority",
  "removeCompletedDownloads",
  "removeFailedDownloads",
  "removeYear",
  "seedCriteria.discographySeedTime",
  "seedCriteria.seasonPackSeedTime",
  "seedCriteria.seedRatio",
  "seedCriteria.seedTime",
  "seedRatio",
  "seedTime",
  "seasonPackSeedTime",
  "sequentialOrder",
  "startOnAdd",
  "syncCategories",
  "syncRejectBlocklistedTorrentHashes",
  "tvCategory",
  "useSsl",
]);

/** The longest string value that may be reported, allowlisted or not. */
export const maxSafeFieldValueLength = 200;

/** The most values one allowlisted array-valued field may report. */
export const maxSafeFieldValueItems = 50;

const schemeLikeValue = /^[a-z][a-z0-9+.-]*:\/\//iu;

function normalizeName(name: string): string {
  return name.toLowerCase().replaceAll(/[^a-z0-9]/gu, "");
}

export type FieldClassification = "secret" | "safe" | "withheld";

export interface FieldClassificationInput {
  readonly name: string;
  /** The upstream descriptor's privacy word, where the payload carries one. */
  readonly privacy?: string | null | undefined;
}

export function isSecretFieldName(name: string): boolean {
  const normalized = normalizeName(name);
  return secretNameFragments.some((fragment) => normalized.includes(fragment));
}

export function classifyProviderField(input: FieldClassificationInput): FieldClassification {
  const privacy = typeof input.privacy === "string" ? normalizeName(input.privacy) : undefined;
  if (isSecretFieldName(input.name) || (privacy !== undefined && secretPrivacyWords.has(privacy))) {
    return "secret";
  }
  return providerFieldAllowlist.has(input.name) ? "safe" : "withheld";
}

function isSafePrimitive(value: unknown): value is string | number | boolean {
  if (typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  return (
    typeof value === "string" &&
    value.length <= maxSafeFieldValueLength &&
    !schemeLikeValue.test(value)
  );
}

/**
 * Narrows an upstream value to something reportable, or refuses it.
 *
 * A field that passed the name allowlist can still hold a shape this model has
 * no room for — an object, a nested array, an over-long string a definition
 * file used as a free-text slot. Those are refused rather than stringified,
 * because stringifying is exactly how an unexamined payload gets out.
 */
export function safeFieldValue(value: unknown): SafeFieldValue | undefined {
  if (isSafePrimitive(value)) {
    return value;
  }
  if (!Array.isArray(value) || value.length > maxSafeFieldValueItems) {
    return undefined;
  }
  const items: (string | number | boolean)[] = [];
  for (const item of value) {
    if (!isSafePrimitive(item)) {
      return undefined;
    }
    items.push(item);
  }
  return items;
}

/**
 * Whether a secret field currently holds a value, and whether the instance
 * answered with a mask.
 *
 * Absence, null, and the empty string all mean unconfigured. A run of asterisks
 * is the sentinel these applications substitute for a stored secret, so it
 * means configured — the value is set, this server simply was not told it.
 */
const maskedSentinel = /^\*+$/u;

export function describeSecret(name: string, value: unknown): ConfiguredSecret {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") {
      return { name, state: "unconfigured", masked: false };
    }
    return maskedSentinel.test(trimmed)
      ? { name, state: "configured", masked: true }
      : { name, state: "configured", masked: false };
  }
  const state = value === null || value === undefined ? "unconfigured" : "configured";
  return { name, state, masked: false };
}

export interface UpstreamProviderField {
  readonly name: string;
  readonly value?: unknown;
  readonly privacy?: string | null | undefined;
}

export interface ClassifiedFields {
  readonly fields: readonly SafeField[];
  readonly secrets: readonly ConfiguredSecret[];
  readonly withheldCount: number;
}

/**
 * Splits one provider's dynamic fields into what may be reported, what may only
 * be acknowledged, and what may not leave at all.
 *
 * A duplicate name is not merged: the instance sent two entries, and collapsing
 * them would let a second, differently classified entry disappear silently.
 */
export function classifyProviderFields(fields: readonly UpstreamProviderField[]): ClassifiedFields {
  const safe: SafeField[] = [];
  const secrets: ConfiguredSecret[] = [];
  let withheldCount = 0;

  for (const field of fields) {
    const classification = classifyProviderField(field);
    if (classification === "secret") {
      // A boolean is not a credential, and the name fragments are broad enough
      // to catch a switch — `useAuthentication`, `requireLogin`. Calling one
      // "configured" would misdescribe a toggle, so it is withheld instead:
      // still nothing leaves, and nothing false is said about it either.
      if (typeof field.value === "boolean") {
        withheldCount += 1;
        continue;
      }
      secrets.push(describeSecret(field.name, field.value));
      continue;
    }
    const value = classification === "safe" ? safeFieldValue(field.value) : undefined;
    if (value === undefined) {
      withheldCount += 1;
      continue;
    }
    safe.push({ name: field.name, value });
  }

  return { fields: safe, secrets, withheldCount };
}

/**
 * How many of a flat record's own properties were not surfaced.
 *
 * Profiles and resources have fixed shapes rather than dynamic fields, so they
 * are mapped property by property; this reports what that mapping left behind,
 * again as a count rather than as names.
 */
export function countWithheldProperties(
  record: Readonly<Record<string, unknown>>,
  surfaced: readonly string[],
): number {
  const known = new Set(surfaced);
  return Object.keys(record).filter((key) => !known.has(key)).length;
}
