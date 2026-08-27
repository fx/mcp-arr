import type { ApplicationId } from "../../applications.js";
import { createToolError, type ToolError } from "../../tools/errors.js";
import { type ConfigurationDomain, type ConfigurationFamily, familyOf } from "./domains.js";
import {
  classifyProviderField,
  type FieldValueKind,
  providerFieldAllowlist,
  safeFieldValue,
} from "./fields.js";
import type { SafeFieldValue } from "./model.js";

/**
 * Desired-state patch compilation.
 *
 * A patch is the write side's counterpart to the observation allowlist, and it
 * is deliberately not its mirror image. Observation decides what a value is
 * allowed to *leave* as; a patch decides what a caller is allowed to *name*.
 * Both are closed lists, so a field this server has no typed opinion about can
 * be neither reported nor written — the change document's one hard non-goal is
 * generic provider payload passthrough, and the way that is enforced is here:
 * a name the table below does not carry is refused rather than forwarded.
 *
 * Three rules follow from that, and each is enforced rather than described.
 *
 * 1. **A name decides a location and a kind, together.** Every managed name
 *    resolves to the upstream property or dynamic field it writes and to the
 *    kind of value it accepts, so `priority` cannot be given a string and
 *    `tags` cannot be given anything but identifiers.
 * 2. **A credential is never a desired field.** A name the classifier reads as
 *    a secret is refused here, so a credential cannot arrive through the
 *    ordinary field channel and be retained in a plan's intent. Supplying one
 *    is its own typed channel, which arrives with the transient-secret work;
 *    clearing one needs no value and is therefore already possible, through an
 *    explicit removal.
 * 3. **Absence is never removal.** A field the patch does not name is
 *    preserved, and a `null` value is refused with the removal channel named,
 *    so "unset this" is always something a caller states rather than something
 *    this server infers.
 */

/** A configuration object a patch may point at, which the instance must report. */
export type DependencyKind = "tags" | "quality_profiles" | "root_folders";

/** One field of a desired state, exactly as the published tool surface shapes it. */
export interface DesiredField {
  readonly name: string;
  /** Unknown by design: what a name is allowed to hold is decided below. */
  readonly value: unknown;
}

/**
 * One desired state, in the three channels the published surface gives it.
 *
 * They are separate because they mean different things, not because they are
 * shaped differently: a field states a value, a removal states an absence, and
 * a secret states that a credential was supplied for this request. Only the
 * names of the third reach a compiled patch.
 */
export interface DesiredState {
  readonly fields: readonly DesiredField[];
  readonly removeFields?: readonly string[] | undefined;
  /** The credential fields the caller supplied a transient value for. */
  readonly secretNames?: readonly string[] | undefined;
}

/**
 * One compiled write.
 *
 * The discriminant is where the value lands, not what it means, because that is
 * what the writer needs to know: a provider's `tags` is a top-level array, its
 * `seedRatio` is an entry inside the dynamic `fields` array, and its `enabled`
 * is however many switches that particular provider happens to carry.
 */
export type PatchAssignment =
  | {
      readonly target: "property";
      readonly name: string;
      readonly property: string;
      readonly value: SafeFieldValue;
    }
  | { readonly target: "enabled"; readonly name: string; readonly value: boolean }
  | { readonly target: "tags"; readonly name: string; readonly ids: readonly number[] }
  | {
      /**
       * A pointer at another configuration object. The caller names it by
       * identifier and the writer substitutes whatever the upstream property
       * actually stores — for a root folder that is the instance's own recorded
       * path, so no caller-authored path is ever sent.
       */
      readonly target: "reference";
      readonly name: string;
      readonly property: string;
      readonly dependency: DependencyKind;
      readonly id: number;
    }
  | { readonly target: "field"; readonly name: string; readonly value: SafeFieldValue }
  | {
      /**
       * A credential the caller supplied for this request only.
       *
       * It carries the name and nothing else. The value stays in the transient
       * bundle in {@link ./secrets.js} until the writer builds the payload,
       * which is what leaves a compiled patch — the object a plan retains —
       * with nowhere to hold a credential even in principle.
       */
      readonly target: "secret";
      readonly name: string;
    };

export type PatchRemoval =
  | { readonly target: "field"; readonly name: string }
  | { readonly target: "tags"; readonly name: string };

export interface DependencyRequirement {
  readonly kind: DependencyKind;
  readonly ids: readonly number[];
}

export interface CompiledPatch {
  readonly family: ConfigurationFamily;
  readonly domain: ConfigurationDomain;
  /** Sorted by name, so one desired state always produces one diff. */
  readonly assignments: readonly PatchAssignment[];
  readonly removals: readonly PatchRemoval[];
  readonly dependencies: readonly DependencyRequirement[];
}

export type PatchCompilation =
  | { readonly status: "ok"; readonly patch: CompiledPatch }
  | { readonly status: "error"; readonly error: ToolError };

/**
 * What a managed top-level property accepts.
 *
 * `text` is the only kind that admits an arbitrary string, and it is safe here
 * for the reason the observation classifier's `label` kind is not: this value
 * came from the caller in this request rather than from an instance, so
 * accepting it discloses nothing the caller does not already hold.
 */
type PropertyKind = "text" | "flag" | "score";

interface ManagedProperty {
  /** The upstream property this name writes, which is not always the name. */
  readonly property: string;
  readonly kind: PropertyKind | "priority" | "enabled" | "tags" | DependencyKind;
  /** Set where only some domains of the family carry the property. */
  readonly domains?: readonly ConfigurationDomain[];
}

/**
 * The provider properties a patch may name.
 *
 * Deliberately absent: `implementation` and `configContract`, which decide what
 * a provider *is* rather than how it behaves — changing them on an existing
 * resource asks one provider to become another, and creating a provider is its
 * own intent with its own schema check. Also absent is anything naming a host,
 * URL, or port, which the configuration surface does not manage at all.
 *
 * The two list pointers are restricted to import lists because that is the only
 * provider domain whose upstream resource carries them; naming them elsewhere
 * would write a property the instance does not read.
 */
const providerProperties: ReadonlyMap<string, ManagedProperty> = new Map([
  ["name", { property: "name", kind: "text" }],
  ["enabled", { property: "enable", kind: "enabled" }],
  ["priority", { property: "priority", kind: "priority" }],
  ["tags", { property: "tags", kind: "tags" }],
  [
    "qualityProfileId",
    { property: "qualityProfileId", kind: "quality_profiles", domains: ["import_lists"] },
  ],
  ["rootFolderId", { property: "rootFolderPath", kind: "root_folders", domains: ["import_lists"] }],
]);

/**
 * The quality-profile properties a patch may name.
 *
 * Only scalars. A profile's quality tree and its format scores are ordered
 * documents whose entries other resources depend on, so they are preserved
 * untouched by every write here rather than being rebuilt from a desired state
 * that names a few of them; reconciling an entry is its own typed intent.
 */
const profileProperties: ReadonlyMap<string, ManagedProperty> = new Map([
  ["name", { property: "name", kind: "text" }],
  ["upgradeAllowed", { property: "upgradeAllowed", kind: "flag" }],
  ["minFormatScore", { property: "minFormatScore", kind: "score" }],
  ["cutoffFormatScore", { property: "cutoffFormatScore", kind: "score" }],
  ["minUpgradeFormatScore", { property: "minUpgradeFormatScore", kind: "score" }],
]);

/** A tag is a label and nothing else, so a tag patch renames it or does nothing. */
const resourceProperties: ReadonlyMap<string, ManagedProperty> = new Map([
  ["name", { property: "label", kind: "text", domains: ["tags"] }],
]);

/**
 * The domains this server can reconcile today.
 *
 * The remaining domains are observable but not yet writable: their desired
 * states are ordered documents or host-level records whose typed patches belong
 * to later work, and reporting that plainly is better than accepting a patch
 * whose effect nobody has specified.
 */
const patchableDomains: ReadonlySet<ConfigurationDomain> = new Set([
  "indexers",
  "download_clients",
  "applications",
  "notifications",
  "import_lists",
  "metadata",
  "proxies",
  "quality_profiles",
  "tags",
]);

/** The removal name that clears a provider's whole tag list. */
const tagsName = "tags";

const maxTextLength = 100;
const maxTagIds = 100;
const maxPriority = 1000;
const maxScore = 100_000;

const controlCharacter = /[\p{Cc}\p{Cf}]/u;

function invalid(application: ApplicationId, message: string): ToolError {
  return createToolError({
    code: "invalid_input",
    message: `${application}: ${message}`,
    application,
  });
}

function unsupported(application: ApplicationId, message: string): ToolError {
  return createToolError({
    code: "unsupported_capability",
    message: `${application}: ${message}`,
    application,
  });
}

function propertiesFor(family: ConfigurationFamily): ReadonlyMap<string, ManagedProperty> {
  switch (family) {
    case "provider":
      return providerProperties;
    case "profile":
      return profileProperties;
    case "resource":
      return resourceProperties;
  }
}

/**
 * A caller-supplied label, such as a provider's name or a tag's.
 *
 * Trimmed, bounded, and free of control characters — the last because these
 * values are written into an upstream record that this server later reads back
 * and reports, and a name carrying a newline or a bidirectional override would
 * be a caller deciding how its own output renders.
 */
function patchText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > maxTextLength || controlCharacter.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function patchInteger(value: unknown, minimum: number, maximum: number): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : undefined;
}

/**
 * The identifiers of the tags a provider should carry.
 *
 * A tag list is replaced whole rather than merged, because merging would make
 * the same patch mean different things depending on what the resource already
 * carried; duplicates are refused rather than collapsed so the caller and the
 * instance agree on what was asked for.
 */
function patchTagIds(value: unknown): readonly number[] | undefined {
  if (!Array.isArray(value) || value.length > maxTagIds) {
    return undefined;
  }
  const ids: number[] = [];
  for (const item of value) {
    const id = patchInteger(item, 1, Number.MAX_SAFE_INTEGER);
    if (id === undefined || ids.includes(id)) {
      return undefined;
    }
    ids.push(id);
  }
  return ids;
}

interface CompilationState {
  readonly application: ApplicationId;
  readonly domain: ConfigurationDomain;
  readonly family: ConfigurationFamily;
  readonly assignments: PatchAssignment[];
  readonly removals: PatchRemoval[];
  readonly dependencies: Map<DependencyKind, number[]>;
}

function requireDependency(state: CompilationState, kind: DependencyKind, id: number): void {
  const ids = state.dependencies.get(kind);
  if (ids === undefined) {
    state.dependencies.set(kind, [id]);
    return;
  }
  if (!ids.includes(id)) {
    ids.push(id);
  }
}

/**
 * Compiles one managed property assignment, or explains why the value is not
 * one this name accepts.
 *
 * The message names the field the caller supplied and the shape it should have
 * taken. It never quotes the value: a rejected value is the one thing in a
 * patch most likely to be a credential the caller mistyped into the wrong slot.
 */
function compileProperty(
  state: CompilationState,
  managed: ManagedProperty,
  field: DesiredField,
): ToolError | undefined {
  const { application } = state;
  const name = field.name;
  if (managed.domains !== undefined && !managed.domains.includes(state.domain)) {
    return invalid(application, `${name} is not a field of the ${state.domain} domain`);
  }

  switch (managed.kind) {
    case "text": {
      const text = patchText(field.value);
      if (text === undefined) {
        return invalid(
          application,
          `${name} must be a name of at most ${maxTextLength} characters`,
        );
      }
      state.assignments.push({
        target: "property",
        name,
        property: managed.property,
        value: text,
      });
      return undefined;
    }
    case "flag": {
      if (typeof field.value !== "boolean") {
        return invalid(application, `${name} must be true or false`);
      }
      state.assignments.push({
        target: "property",
        name,
        property: managed.property,
        value: field.value,
      });
      return undefined;
    }
    case "score": {
      const score = patchInteger(field.value, -maxScore, maxScore);
      if (score === undefined) {
        return invalid(application, `${name} must be a whole number of at most ${maxScore}`);
      }
      state.assignments.push({
        target: "property",
        name,
        property: managed.property,
        value: score,
      });
      return undefined;
    }
    case "priority": {
      const priority = patchInteger(field.value, 0, maxPriority);
      if (priority === undefined) {
        return invalid(application, `${name} must be a whole number between 0 and ${maxPriority}`);
      }
      state.assignments.push({
        target: "property",
        name,
        property: managed.property,
        value: priority,
      });
      return undefined;
    }
    case "enabled": {
      if (typeof field.value !== "boolean") {
        return invalid(application, `${name} must be true or false`);
      }
      state.assignments.push({ target: "enabled", name, value: field.value });
      return undefined;
    }
    case "tags": {
      const ids = patchTagIds(field.value);
      if (ids === undefined) {
        return invalid(
          application,
          `${name} must be a list of at most ${maxTagIds} distinct tag identifiers`,
        );
      }
      state.assignments.push({ target: "tags", name, ids });
      for (const id of ids) {
        requireDependency(state, "tags", id);
      }
      return undefined;
    }
    default: {
      const id = patchInteger(field.value, 1, Number.MAX_SAFE_INTEGER);
      if (id === undefined) {
        return invalid(application, `${name} must be the identifier of an existing record`);
      }
      state.assignments.push({
        target: "reference",
        name,
        property: managed.property,
        dependency: managed.kind,
        id,
      });
      requireDependency(state, managed.kind, id);
      return undefined;
    }
  }
}

/**
 * Compiles one dynamic provider field.
 *
 * The allowlist decides both halves — whether the name may be written at all,
 * and what kind of value it takes — so a definition file that named a field
 * after an allowlisted setting still cannot be handed a credential-shaped
 * value through it.
 */
function compileDynamicField(state: CompilationState, field: DesiredField): ToolError | undefined {
  const { application } = state;
  const name = field.name;
  if (state.family !== "provider") {
    return invalid(application, `${name} is not a field this server manages for that domain`);
  }
  if (classifyProviderField({ name }) === "secret") {
    return invalid(
      application,
      `${name} holds a credential; supply it through this request's secrets, clear it with an explicit removal, but never state it as a desired field`,
    );
  }
  const kind = providerFieldAllowlist.get(name);
  if (kind === undefined) {
    return invalid(application, `${name} is not a field this server manages for that domain`);
  }
  const value = safeFieldValue(field.value, kind);
  if (value === undefined) {
    return invalid(application, `${name} must be ${describeKind(kind)}`);
  }
  state.assignments.push({ target: "field", name, value });
  return undefined;
}

function describeKind(kind: FieldValueKind): string {
  switch (kind) {
    case "number":
      return "a number";
    case "boolean":
      return "true or false";
    case "label":
      return "a short label";
    case "numberList":
      return "a list of numbers";
  }
}

/**
 * Compiles one supplied credential.
 *
 * Which fields may travel this way is decided at write time rather than here,
 * and deliberately so: a field is a credential because its name reads as one
 * *or* because the instance's own privacy word says so, and only the resource
 * knows the second. Compiling a name is therefore not a decision that it may be
 * written — the writer refuses a field neither this server nor the instance
 * calls a credential, which is what keeps this channel from becoming the
 * generic passthrough the typed tables exist to prevent.
 *
 * The two channels are complementary, and each is closed in the direction the
 * other is open. A desired field is refused the moment the instance marks it as
 * a credential; a supplied secret is refused unless something marks it as one.
 */
function compileSecret(state: CompilationState, name: string): ToolError | undefined {
  if (state.family !== "provider") {
    return invalid(state.application, `a ${state.domain} record holds no credentials`);
  }
  state.assignments.push({ target: "secret", name });
  return undefined;
}

/**
 * Compiles one explicit removal.
 *
 * Removal is narrower than assignment on purpose. A field can only be cleared
 * if this server can say what it is: an operational setting it manages, or a
 * credential it recognizes as one. Everything else — a base URL, a definition
 * file's own free-text slot — is preserved rather than cleared, because
 * clearing a field this server cannot describe is indistinguishable from
 * breaking the provider.
 */
function compileRemoval(state: CompilationState, name: string): ToolError | undefined {
  const { application } = state;
  if (state.family !== "provider") {
    return invalid(application, `a ${state.domain} record has no removable fields`);
  }
  if (name === tagsName) {
    state.removals.push({ target: "tags", name });
    return undefined;
  }
  const classification = classifyProviderField({ name });
  if (classification === "withheld") {
    return invalid(application, `${name} is not a field this server can clear`);
  }
  state.removals.push({ target: "field", name });
  return undefined;
}

/**
 * Turns a desired state into typed writes, or refuses it.
 *
 * Nothing here reads the current resource: compilation is about whether the
 * caller named something this server manages, and the resource decides only
 * whether the named field is actually there. Keeping the two apart is what lets
 * a patch be validated identically on the planning call and on the apply.
 */
export function compileConfigurationPatch(
  application: ApplicationId,
  domain: ConfigurationDomain,
  desired: DesiredState,
): PatchCompilation {
  if (!patchableDomains.has(domain)) {
    return {
      status: "error",
      error: unsupported(
        application,
        `the ${domain} configuration domain cannot be reconciled by this server`,
      ),
    };
  }

  const family = familyOf(domain);
  const state: CompilationState = {
    application,
    domain,
    family,
    assignments: [],
    removals: [],
    dependencies: new Map(),
  };
  const managed = propertiesFor(family);
  const named = new Set<string>();
  const secretNames = new Set<string>();

  for (const field of desired.fields) {
    if (named.has(field.name)) {
      return { status: "error", error: invalid(application, `${field.name} is named twice`) };
    }
    named.add(field.name);
    if (field.value === null) {
      return {
        status: "error",
        error: invalid(
          application,
          `${field.name} cannot be set to null; name it as a removal to clear it`,
        ),
      };
    }
    const property = managed.get(field.name);
    const error =
      property === undefined
        ? compileDynamicField(state, field)
        : compileProperty(state, property, field);
    if (error !== undefined) {
      return { status: "error", error };
    }
  }

  const removed = new Set<string>();
  for (const name of desired.removeFields ?? []) {
    if (named.has(name)) {
      return {
        status: "error",
        error: invalid(application, `${name} is both set and removed by this desired state`),
      };
    }
    if (removed.has(name)) {
      return { status: "error", error: invalid(application, `${name} is removed twice`) };
    }
    removed.add(name);
    const error = compileRemoval(state, name);
    if (error !== undefined) {
      return { status: "error", error };
    }
  }

  for (const name of desired.secretNames ?? []) {
    if (named.has(name) || removed.has(name)) {
      return {
        status: "error",
        error: invalid(
          application,
          `${name} is named both as a credential and as an ordinary field of this desired state`,
        ),
      };
    }
    if (secretNames.has(name)) {
      return { status: "error", error: invalid(application, `${name} is supplied twice`) };
    }
    secretNames.add(name);
    const error = compileSecret(state, name);
    if (error !== undefined) {
      return { status: "error", error };
    }
  }

  if (state.assignments.length === 0 && state.removals.length === 0) {
    return {
      status: "error",
      error: invalid(application, "a desired state must name at least one field to set or remove"),
    };
  }

  const byName = (left: { name: string }, right: { name: string }): number =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0;

  return {
    status: "ok",
    patch: {
      family,
      domain,
      assignments: [...state.assignments].sort(byName),
      removals: [...state.removals].sort(byName),
      dependencies: [...state.dependencies].map(([kind, ids]) => ({ kind, ids: [...ids] })),
    },
  };
}
