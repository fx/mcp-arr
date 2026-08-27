import type { ApplicationId } from "../../applications.js";
import type { UpstreamBody } from "../../http/client.js";
import type { ReadSetObservation } from "../../state/plans.js";
import { fingerprint } from "../../state/tokens.js";
import { createToolError, type ToolError } from "../../tools/errors.js";
import { type DependencyCatalog, referenceValue } from "./dependencies.js";
import {
  classifyProviderField,
  describeSecret,
  type FieldValueKind,
  providerFieldAllowlist,
  safeFieldValue,
} from "./fields.js";
import { type ConfigurationRef, configurationRef, type SafeFieldValue } from "./model.js";
import { isUpstreamRecord } from "./parse.js";
import type { CompiledPatch, PatchAssignment } from "./patches.js";
import type { UpstreamResource } from "./resources.js";
import { isDynamicallyDefined } from "./serialize.js";

/**
 * The lossless full-resource write.
 *
 * These APIs replace a whole resource: a PUT sends the entire record back and
 * every field the sender omits is erased. So a payload assembled from the
 * allowlisted output model would reset everything this server does not model —
 * a field a newer provider definition added, a setting the observation
 * deliberately withholds, a masked credential the instance answered with
 * instead of the stored one.
 *
 * Losslessness here is therefore structural rather than careful. The write
 * starts from {@link UpstreamResource.payload}, which is the untouched upstream
 * record as it arrived, and assigns to exactly the properties and dynamic field
 * entries the compiled patch names. Nothing is rebuilt, nothing is normalized,
 * and no code path enumerates the payload deciding what to keep — so a field
 * nobody has heard of survives because no line of this module touches it.
 *
 * A masked secret is the same story with a different consequence: the sentinel
 * an instance returns in place of a stored credential is what that instance
 * accepts back to mean "keep what is stored", and it survives for the same
 * reason an unknown field does — the write never looks at it.
 *
 * The diff is built from the same assignments, so what a caller is told changed
 * and what actually changed cannot drift: both come from one pass.
 */

/** One field a write moves, described without carrying an unreportable value. */
export interface ConfigurationChange {
  /** The upstream property, or `fields.<name>` for a dynamic provider field. */
  readonly path: string;
  readonly action: "set" | "clear" | "unchanged";
  readonly before?: SafeFieldValue | undefined;
  readonly after?: SafeFieldValue | undefined;
  /**
   * The current value is not one this server may report. The change still
   * happens; the caller is simply told that the value it replaces stays behind
   * the same allowlist an observation applies.
   */
  readonly redacted?: boolean | undefined;
}

/**
 * What a write does to one secret field, never what it holds.
 *
 * `preserved` is the disposition of every secret this server was not asked to
 * change, and it is the interesting one: it is the promise that a credential
 * the caller never supplied is still there afterwards.
 */
export interface SecretDisposition {
  readonly name: string;
  readonly disposition: "preserved" | "cleared";
}

/** How much of the resource this write carried through without touching it. */
export interface PreservedCount {
  /** Top-level properties, excluding the dynamic field array counted below. */
  readonly properties: number;
  readonly fields: number;
}

export interface ConfigurationDiff {
  readonly ref: ConfigurationRef;
  readonly changes: readonly ConfigurationChange[];
  readonly secrets: readonly SecretDisposition[];
  readonly preserved: PreservedCount;
}

export interface ResourceWrite {
  /** The complete resource to send back, unknown fields and all. */
  readonly payload: UpstreamBody;
  readonly diff: ConfigurationDiff;
  /** Whether any named field actually differs from what the instance reports. */
  readonly changed: boolean;
  readonly warnings: readonly string[];
}

export type WriteOutcome =
  | { readonly status: "ok"; readonly write: ResourceWrite }
  | { readonly status: "error"; readonly error: ToolError };

export interface WriteRequest {
  readonly application: ApplicationId;
  readonly resource: UpstreamResource;
  readonly patch: CompiledPatch;
  readonly catalog: DependencyCatalog;
  readonly id: number;
}

/** The dynamic field array's property name, and the diff prefix for its entries. */
const fieldsProperty = "fields";

const enableSwitches = [
  "enable",
  "enableRss",
  "enableAutomaticSearch",
  "enableInteractiveSearch",
] as const;

function toolError(
  application: ApplicationId,
  code: "invalid_input" | "unexpected_response",
  message: string,
): ToolError {
  return createToolError({ code, message: `${application}: ${message}`, application });
}

function fieldPath(name: string): string {
  return `${fieldsProperty}.${name}`;
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => item === right[index]);
  }
  return left === right;
}

/**
 * The current value as a caller may see it.
 *
 * It goes through the observation classifier rather than being reported
 * directly, because a `before` is an upstream value: the same value the
 * observation would have withheld cannot become reportable merely by appearing
 * in a diff. A value the classifier refuses is reported as redacted, which says
 * that something is there without saying what.
 *
 * A dynamic field is narrowed by the kind its allowlist entry records, exactly
 * as the observation narrows it. Passing the kind is what stops a definition
 * file from publishing a credential by naming the field it lives in after an
 * allowlisted setting: the name came from that file, so it is not evidence
 * about the value, and a diff must not be the softer of the two paths.
 */
function reportable(
  value: unknown,
  kind?: FieldValueKind,
): { value?: SafeFieldValue; redacted: boolean } {
  const safe = safeFieldValue(value, kind);
  return safe === undefined ? { redacted: true } : { value: safe, redacted: false };
}

function change(
  path: string,
  action: "set" | "clear",
  before: unknown,
  after: unknown,
  current = reportable(before),
): ConfigurationChange {
  const settled = sameValue(before, after) ? "unchanged" : action;
  return {
    path,
    action: settled,
    ...(current.value === undefined ? {} : { before: current.value }),
    ...(current.redacted ? { redacted: true } : {}),
    ...(action === "clear" ? {} : { after: after as SafeFieldValue }),
  };
}

interface FieldEntry {
  readonly record: Record<string, unknown>;
  readonly index: number;
}

/**
 * Locates a provider's dynamic field entries by name.
 *
 * The entries themselves are handed back rather than copies, because the write
 * assigns into them: the payload is already this write's own deep clone, so
 * mutating one entry changes what is sent and nothing else.
 */
function fieldEntries(
  payload: Record<string, unknown>,
): ReadonlyMap<string, readonly FieldEntry[]> {
  const entries = new Map<string, FieldEntry[]>();
  const fields = payload[fieldsProperty];
  if (!Array.isArray(fields)) {
    return entries;
  }
  fields.forEach((value, index) => {
    if (!isUpstreamRecord(value) || typeof value.name !== "string") {
      return;
    }
    const found = entries.get(value.name);
    const entry: FieldEntry = { record: value, index };
    if (found === undefined) {
      entries.set(value.name, [entry]);
      return;
    }
    found.push(entry);
  });
  return entries;
}

interface WriteState {
  readonly application: ApplicationId;
  readonly payload: Record<string, unknown>;
  readonly entries: ReadonlyMap<string, readonly FieldEntry[]>;
  /** Whether a tracker definition, rather than the application, named the fields. */
  readonly definitionDriven: boolean;
  readonly changes: ConfigurationChange[];
  readonly warnings: string[];
  readonly writtenProperties: Set<string>;
  readonly writtenFields: Set<number>;
}

/**
 * Resolves the one entry a named dynamic field has.
 *
 * A name the provider does not carry is refused rather than added: the field
 * list is defined by the instance's own provider schema, so inventing an entry
 * would write a setting that definition has no meaning for. Two entries under
 * one name is refused too — the classifier deliberately does not merge
 * duplicates, and a write that picked one of them would be guessing.
 */
function resolveField(state: WriteState, name: string): FieldEntry | ToolError {
  const found = state.entries.get(name) ?? [];
  const [entry] = found;
  if (entry === undefined) {
    return toolError(state.application, "invalid_input", `this record has no ${name} field`);
  }
  if (found.length > 1) {
    return toolError(
      state.application,
      "unexpected_response",
      `this record reports more than one ${name} field`,
    );
  }
  return entry;
}

/**
 * A change to one dynamic provider field.
 *
 * Two narrowings a top-level property does not need, and both are the
 * observation serializer's, applied here for the same reasons. The current
 * value is held to the kind the allowlist records for the name, and for a
 * provider whose field list comes from a tracker definition no current value is
 * reported at all — that definition chose the names, so a name is not evidence
 * about what the value is.
 */
function fieldChange(
  state: WriteState,
  name: string,
  action: "set" | "clear",
  before: unknown,
  after: unknown,
): ConfigurationChange {
  const current: { value?: SafeFieldValue; redacted: boolean } = state.definitionDriven
    ? { redacted: true }
    : reportable(before, providerFieldAllowlist.get(name));
  return change(fieldPath(name), action, before, after, current);
}

function setProperty(state: WriteState, path: string, property: string, value: unknown): void {
  const before = state.payload[property];
  state.payload[property] = value;
  state.writtenProperties.add(property);
  state.changes.push(change(path, "set", before, value));
}

/**
 * Writes the enable switches this particular provider carries.
 *
 * The applications disagree about what "on" means: a download client has a
 * single `enable`, while an indexer has three independent search switches. Each
 * switch that exists becomes its own change, so a caller enabling an indexer is
 * told plainly that interactive search moved too rather than discovering it
 * afterwards. A switch the payload does not carry is not invented.
 */
function setEnabled(state: WriteState, value: boolean): ToolError | undefined {
  const present = enableSwitches.filter((name) => typeof state.payload[name] === "boolean");
  if (present.length === 0) {
    return toolError(
      state.application,
      "invalid_input",
      "this record reports no enable switch to set",
    );
  }
  for (const name of present) {
    setProperty(state, name, name, value);
  }
  if (present.length > 1 && value) {
    state.warnings.push(
      "enabling this provider turns on every search switch it reports, including any that were off",
    );
  }
  return undefined;
}

function applyAssignment(
  state: WriteState,
  patch: CompiledPatch,
  catalog: DependencyCatalog,
  assignment: PatchAssignment,
): ToolError | undefined {
  switch (assignment.target) {
    case "property":
      setProperty(state, assignment.property, assignment.property, assignment.value);
      return undefined;
    case "enabled":
      return setEnabled(state, assignment.value);
    case "tags":
      setProperty(state, "tags", "tags", [...assignment.ids]);
      return undefined;
    case "reference": {
      const value = referenceValue(catalog, assignment.dependency, assignment.id);
      if (value === undefined) {
        return toolError(
          state.application,
          "invalid_input",
          `this application reports nothing usable for ${assignment.name} ${assignment.id}`,
        );
      }
      setProperty(state, assignment.property, assignment.property, value);
      return undefined;
    }
    case "field": {
      const entry = resolveField(state, assignment.name);
      if (!("record" in entry)) {
        return entry;
      }
      // Classified again here, with the entry's own privacy word, because the
      // compiler had only the name to go on. Upstream privacy may escalate a
      // field to a credential and never de-escalate one, so an instance that
      // marks an allowlisted setting as a password decides that it is one — and
      // a credential is not something the ordinary desired-state channel sets.
      const privacy = typeof entry.record.privacy === "string" ? entry.record.privacy : undefined;
      if (classifyProviderField({ name: assignment.name, privacy }) === "secret") {
        return toolError(
          state.application,
          "invalid_input",
          `this instance marks ${assignment.name} as a credential, so it is never set as a desired field; clear it with an explicit removal instead`,
        );
      }
      const before = entry.record.value;
      entry.record.value = assignment.value;
      state.writtenFields.add(entry.index);
      state.changes.push(fieldChange(state, assignment.name, "set", before, assignment.value));
      return undefined;
    }
    default:
      return unreachable(patch, assignment);
  }
}

/**
 * A compiled assignment this module has no case for cannot exist, and saying so
 * in code rather than in a comment is what makes a new target kind fail to
 * compile here instead of being silently dropped from the write.
 */
function unreachable(patch: CompiledPatch, assignment: never): ToolError {
  throw new Error(`Unhandled ${patch.domain} assignment ${JSON.stringify(assignment)}`);
}

/**
 * Clears one named field.
 *
 * A cleared dynamic field becomes `null` rather than being spliced out of the
 * list: the entry is part of the provider's schema-defined shape, and removing
 * it would change what the resource *is* rather than what it holds. A cleared
 * secret is reported by disposition alone, so a diff never says what was there.
 */
function applyRemoval(
  state: WriteState,
  target: "field" | "tags",
  name: string,
): ToolError | undefined {
  if (target === "tags") {
    const before = state.payload.tags;
    state.payload.tags = [];
    state.writtenProperties.add("tags");
    state.changes.push(change("tags", "clear", before, []));
    return undefined;
  }
  const entry = resolveField(state, name);
  if (!("record" in entry)) {
    return entry;
  }
  const before = entry.record.value;
  entry.record.value = null;
  state.writtenFields.add(entry.index);
  const secret = classifyProviderField({
    name,
    privacy: typeof entry.record.privacy === "string" ? entry.record.privacy : undefined,
  });
  state.changes.push(
    secret === "secret"
      ? { path: fieldPath(name), action: before === null ? "unchanged" : "clear", redacted: true }
      : fieldChange(state, name, "clear", before, null),
  );
  return undefined;
}

/**
 * What happens to every credential on this resource.
 *
 * Reported for the whole resource rather than only for the fields the patch
 * named, because "preserved" is the claim worth making: it says which
 * credentials this write carries through untouched, which is exactly what a
 * full-resource update is otherwise capable of destroying.
 */
function secretDispositions(
  payload: Record<string, unknown>,
  cleared: ReadonlySet<string>,
): readonly SecretDisposition[] {
  const fields = payload[fieldsProperty];
  if (!Array.isArray(fields)) {
    return [];
  }
  const dispositions: SecretDisposition[] = [];
  for (const value of fields) {
    if (!isUpstreamRecord(value) || typeof value.name !== "string") {
      continue;
    }
    const privacy = typeof value.privacy === "string" ? value.privacy : undefined;
    if (classifyProviderField({ name: value.name, privacy }) !== "secret") {
      continue;
    }
    // A boolean under a credential-shaped name is a switch, not a credential;
    // the observation classifier withholds it rather than calling it
    // configured, and calling it preserved here would say the same false thing.
    if (typeof value.value === "boolean") {
      continue;
    }
    dispositions.push({
      name: value.name,
      disposition: cleared.has(value.name) ? "cleared" : "preserved",
    });
  }
  return dispositions;
}

/**
 * Builds the complete resource one patch produces, and the diff describing it.
 *
 * The resource is never partially written: an assignment that cannot be made
 * refuses the whole write, so no caller receives a payload that carries half of
 * a desired state.
 */
export function writeConfigurationPatch(request: WriteRequest): WriteOutcome {
  const { application, patch } = request;
  const payload = request.resource.payload();
  if (!isUpstreamRecord(payload)) {
    return {
      status: "error",
      error: toolError(
        application,
        "unexpected_response",
        "this record is not a readable resource",
      ),
    };
  }

  const state: WriteState = {
    application,
    payload,
    entries: fieldEntries(payload),
    definitionDriven: isDynamicallyDefined(payload),
    changes: [],
    warnings: [],
    writtenProperties: new Set(),
    writtenFields: new Set(),
  };

  for (const assignment of patch.assignments) {
    const error = applyAssignment(state, patch, request.catalog, assignment);
    if (error !== undefined) {
      return { status: "error", error };
    }
  }

  const cleared = new Set<string>();
  for (const removal of patch.removals) {
    const error = applyRemoval(state, removal.target, removal.name);
    if (error !== undefined) {
      return { status: "error", error };
    }
    if (removal.target === "field") {
      cleared.add(removal.name);
    }
  }

  const fields = payload[fieldsProperty];
  const fieldCount = Array.isArray(fields) ? fields.length : 0;
  const secrets = secretDispositions(payload, cleared);
  if (secrets.some((secret) => secret.disposition === "cleared")) {
    state.warnings.push(
      "clearing a credential leaves this record without it until one is supplied again",
    );
  }

  return {
    status: "ok",
    write: {
      payload: payload as UpstreamBody,
      changed: state.changes.some((entry) => entry.action !== "unchanged"),
      warnings: state.warnings,
      diff: {
        ref: configurationRef(application, patch.domain, request.id),
        changes: state.changes,
        secrets,
        preserved: {
          properties: Object.keys(payload).filter(
            (key) => key !== fieldsProperty && !state.writtenProperties.has(key),
          ).length,
          fields: fieldCount - state.writtenFields.size,
        },
      },
    },
  };
}

/**
 * What this reconciliation's plan depends on, and nothing else.
 *
 * A plan is stale when the state its reasoning rests on has moved, so the read
 * set names exactly the fields the patch writes, the identity of the record
 * they belong to, and the existence of every dependency it points at. Observing
 * more than that — the whole resource, say — would expire valid plans whenever
 * an unrelated field moved, which teaches a caller to re-plan reflexively and
 * makes staleness mean nothing.
 *
 * Every value read from the resource is fingerprinted here rather than carried
 * out of this function. A read set exists to be compared, so a digest answers
 * the only question asked of it, and this way no unclassified upstream value —
 * a credential a definition file filed under an ordinary name, most of all —
 * sits in the result the tool layer holds while it records a plan.
 *
 * A secret is observed by presence before it is digested. That is not only
 * hygiene: a plan whose validity depended on a credential's exact bytes would
 * go stale on a rotation that changes nothing about what the patch does.
 */
export function configurationObservations(
  resource: UpstreamResource,
  patch: CompiledPatch,
): readonly ReadSetObservation[] {
  const payload = resource.payload();
  const observations: ReadSetObservation[] = [
    // The identity the caller itself named, so it is the one observation with
    // nothing to withhold.
    { key: "resource-id", value: isUpstreamRecord(payload) ? payload.id : undefined },
  ];
  if (!isUpstreamRecord(payload)) {
    return observations;
  }
  const entries = fieldEntries(payload);

  const observeProperty = (property: string): void => {
    observations.push({ key: property, value: fingerprint(payload[property]) });
  };
  const observeField = (name: string): void => {
    const [entry] = entries.get(name) ?? [];
    const record = entry?.record;
    const privacy = typeof record?.privacy === "string" ? record.privacy : undefined;
    const secret = classifyProviderField({ name, privacy }) === "secret";
    observations.push({
      key: fieldPath(name),
      value: fingerprint(
        record === undefined
          ? undefined
          : secret
            ? describeSecret(name, record.value).state
            : record.value,
      ),
    });
  };

  for (const assignment of patch.assignments) {
    switch (assignment.target) {
      case "property":
      case "reference":
        observeProperty(assignment.property);
        break;
      case "enabled":
        for (const name of enableSwitches) {
          observeProperty(name);
        }
        break;
      case "tags":
        observeProperty("tags");
        break;
      case "field":
        observeField(assignment.name);
        break;
    }
  }

  for (const removal of patch.removals) {
    if (removal.target === "tags") {
      observeProperty("tags");
    } else {
      observeField(removal.name);
    }
  }

  return observations;
}

/**
 * The dependency half of the read set.
 *
 * Kept separate because it is read from a different request than the resource:
 * a plan that pointed at a tag which has since been deleted is stale for the
 * same reason a plan whose target moved is, and this is what makes that
 * visible rather than surfacing later as an upstream rejection.
 */
export function dependencyObservations(
  patch: CompiledPatch,
  catalog: DependencyCatalog,
): readonly ReadSetObservation[] {
  return patch.dependencies.flatMap((requirement) =>
    requirement.ids.map((id) => ({
      key: `${requirement.kind}:${id}`,
      value: catalog.get(requirement.kind)?.has(id) === true,
    })),
  );
}
