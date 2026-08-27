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
 *    value out, and only if the value also has the kind and shape that
 *    allowlist records for the name. The name alone never decides: it was
 *    chosen by the same definition that supplied the value.
 * 3. Everything else is withheld and counted.
 *
 * The order matters: the secret test runs first, so adding a name to the
 * allowlist can never turn a credential into output. Upstream privacy metadata
 * can only escalate a field to secret, never de-escalate one — a definition
 * file that declares its passkey "normal" does not get to be believed.
 *
 * Recognizing a payload is allowed only where it tightens the result. The
 * serializer suppresses field values outright for a provider it recognizes as
 * definition-driven; nothing anywhere may recognize a payload in order to
 * publish more of it.
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
 * What an allowlisted field is allowed to hold.
 *
 * The name alone is not enough. A dynamic definition chooses its own field
 * names, so it can name a field `minimumSeeders` and put a passkey in it; a
 * classifier that trusted the name would then report the passkey. Pairing each
 * allowlisted name with the kind of value it is supposed to carry closes that,
 * because a credential is a string and almost every operational setting here is
 * a number, a boolean, or a list of numbers.
 */
export type FieldValueKind = "number" | "boolean" | "label" | "numberList";

/**
 * The shape a `label` value must have.
 *
 * There is deliberately no unconstrained string kind. A credential is itself a
 * bounded primitive string, so a kind that accepted "any string" would let a
 * definition publish a passkey simply by naming the field after a setting whose
 * value happens to be text — the name would be doing all the deciding, which is
 * the recognition strategy rule 3 exists to avoid.
 *
 * Every string-valued setting in the allowlist is a short human label: a
 * download client's category is `radarr` or `tv-sonarr`. So the shape is
 * twenty-four characters at most, drawn from letters, digits, spaces, hyphens
 * and underscores, and starting with a letter or digit. That excludes a base64
 * blob and a query fragment, which carry `+/=` and `&`, and it excludes any
 * token long enough to be worth stealing.
 *
 * The hex rule closes what length alone leaves open: a short all-hex string is
 * still credential-shaped, and no honest category is nine or more hex digits
 * with nothing else in it.
 */
const labelValue = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,23}$/u;

const hexLikeValue = /^[0-9a-f]{9,}$/iu;

function isLabel(value: unknown): value is string {
  return typeof value === "string" && labelValue.test(value) && !hexLikeValue.test(value);
}

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
export const providerFieldAllowlist: ReadonlyMap<string, FieldValueKind> = new Map([
  ["addPaused", "boolean"],
  ["animeCategories", "numberList"],
  ["animeStandardFormatSearch", "boolean"],
  ["animeSyncCategories", "numberList"],
  ["categories", "numberList"],
  ["discographySeedTime", "number"],
  ["firstAndLast", "boolean"],
  ["initialState", "number"],
  ["minimumSeeders", "number"],
  ["movieCategory", "label"],
  ["multiLanguages", "numberList"],
  ["musicCategory", "label"],
  ["olderMoviePriority", "number"],
  ["olderTvPriority", "number"],
  ["packSeedTime", "number"],
  ["recentMoviePriority", "number"],
  ["recentTvPriority", "number"],
  ["removeCompletedDownloads", "boolean"],
  ["removeFailedDownloads", "boolean"],
  ["removeYear", "boolean"],
  ["seedCriteria.discographySeedTime", "number"],
  ["seedCriteria.seasonPackSeedTime", "number"],
  ["seedCriteria.seedRatio", "number"],
  ["seedCriteria.seedTime", "number"],
  ["seedRatio", "number"],
  ["seedTime", "number"],
  ["seasonPackSeedTime", "number"],
  ["sequentialOrder", "boolean"],
  ["startOnAdd", "boolean"],
  ["syncCategories", "numberList"],
  ["syncRejectBlocklistedTorrentHashes", "boolean"],
  ["tvCategory", "label"],
  ["useSsl", "boolean"],
]);
/**
 * The ceiling on a string reported through the kindless path, which serves the
 * fixed-shape records whose property names come from the application's own
 * schema. A dynamic field never reaches it: its kind is always known, and no
 * kind admits an arbitrary string.
 */
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
 *
 * Supplying the {@link FieldValueKind} the name is supposed to carry narrows it
 * further, and that is what a *dynamic* field must always do: the name came
 * from a definition file, so it is not evidence about the value. Every kind
 * constrains the value, `label` included — there is no kind meaning "any
 * string", because a credential is one.
 *
 * The kindless form remains for fixed-shape upstream records, whose property
 * names come from the application's own compiled schema rather than from a file
 * an operator installed, so there the name genuinely is evidence.
 */
export function safeFieldValue(value: unknown, kind?: FieldValueKind): SafeFieldValue | undefined {
  switch (kind) {
    case "numberList":
      return numberList(value);
    case "label":
      return isLabel(value) ? value : undefined;
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? value : undefined;
    case "boolean":
      return typeof value === "boolean" ? value : undefined;
    default:
      return isSafePrimitive(value) ? value : primitiveList(value);
  }
}

function numberList(value: unknown): readonly number[] | undefined {
  if (!Array.isArray(value) || value.length > maxSafeFieldValueItems) {
    return undefined;
  }
  const items: number[] = [];
  for (const item of value) {
    if (typeof item !== "number" || !Number.isFinite(item)) {
      return undefined;
    }
    items.push(item);
  }
  return items;
}

function primitiveList(value: unknown): SafeFieldValue | undefined {
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
 * Absence, null, and a blank string all mean unconfigured — blank, not merely
 * empty, because the value is trimmed first. A run of asterisks
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
    // The kind the allowlist records is passed in, so a dynamic definition
    // cannot smuggle a value out by borrowing an allowlisted name.
    const value =
      classification === "safe"
        ? safeFieldValue(field.value, providerFieldAllowlist.get(field.name))
        : undefined;
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
