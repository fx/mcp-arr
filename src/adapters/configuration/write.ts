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
import type { TransientSecrets } from "./secrets.js";
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
  /**
   * The configuration record this field now points at, where it points at one.
   *
   * It is what a pointer's change says instead of its stored value. An import
   * list stores its root folder as a filesystem path, and the observation of an
   * import list does not surface that path — so a diff of the same record must
   * not become the place it appears. The reference names the record without
   * describing the operator's disks.
   */
  readonly reference?: ConfigurationRef | undefined;
}

/**
 * What a write does to one secret field, never what it holds.
 *
 * `preserved` is the disposition of every secret this server was not asked to
 * change, and it is the interesting one: it is the promise that a credential
 * the caller never supplied is still there afterwards. `set` and `changed` are
 * told apart by what the record held before — an instance that answered with a
 * mask still said that something was configured — so a caller learns whether it
 * has replaced a credential or supplied a first one.
 */
export interface SecretDisposition {
  readonly name: string;
  readonly disposition: "preserved" | "cleared" | "set" | "changed";
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
  /**
   * The credentials supplied for this request.
   *
   * Read here and nowhere else: this is the only place a value is needed, so it
   * is the only place one is taken. The runtime erases the bundle on its way
   * out, whatever this function answered.
   */
  readonly secrets: TransientSecrets;
}

/** The dynamic field array's property name, and the diff prefix for its entries. */
const fieldsProperty = "fields";

/**
 * The switches a provider may express "on" through. Exported because apply
 * verification has to check exactly the ones a write moved, and rediscovering
 * them by name prefix would check properties this write never touched.
 */
export const enableSwitches = [
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

/**
 * An upstream identifier, in the one casing everything here compares it in.
 * Anything that is not a string is passed through, so a payload that reports
 * something else still fingerprints as itself rather than as absent.
 */
function identifierOf(value: unknown): unknown {
  return typeof value === "string" ? value.trim().toLowerCase() : value;
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
 * Whether one dynamic field entry actually holds a credential.
 *
 * The name and the instance's privacy word decide it, and the current value
 * gets a veto: the observation classifier treats a boolean under a
 * credential-shaped name as a switch rather than a credential — `useAuthentication`
 * and `requireLogin` are switches — and withholds it instead of calling it
 * configured. The write side has to agree, or the secret channel becomes a way
 * to overwrite an ordinary switch with a supplied string, which is the generic
 * passthrough this whole surface exists to prevent.
 *
 * Every place the writer asks "is this a credential" asks it here: the supplied
 * secret, the explicit removal, the dispositions, and the read set.
 */
function isCredentialEntry(name: string, record: Record<string, unknown>): boolean {
  if (typeof record.value === "boolean") {
    return false;
  }
  const privacy = typeof record.privacy === "string" ? record.privacy : undefined;
  return classifyProviderField({ name, privacy }) === "secret";
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

/**
 * The provider's field list as a shape rather than as contents.
 *
 * Names are kept with their multiplicity and sorted, not deduplicated: a second
 * entry appearing under a name the patch writes is a material change to the
 * record — it is the case the writer refuses as ambiguous — so a plan made
 * before it has to expire rather than being carried into a refusal that blames
 * the response. Entries the reader cannot name are counted for the same reason:
 * they are part of the shape even though nothing can address them.
 */
function fieldShape(payload: Record<string, unknown>): unknown {
  const fields = payload[fieldsProperty];
  if (!Array.isArray(fields)) {
    return { named: [], unreadable: 0 };
  }
  const named: string[] = [];
  let unreadable = 0;
  for (const field of fields) {
    if (isUpstreamRecord(field) && typeof field.name === "string") {
      named.push(field.name);
    } else {
      unreadable += 1;
    }
  }
  return { named: named.sort(), unreadable };
}

interface WriteState {
  readonly application: ApplicationId;
  readonly payload: Record<string, unknown>;
  readonly entries: ReadonlyMap<string, readonly FieldEntry[]>;
  /** Whether a tracker definition, rather than the application, named the fields. */
  readonly definitionDriven: boolean;
  readonly secrets: TransientSecrets;
  /** Credentials this write supplied a value for, and whether one was already set. */
  readonly supplied: Map<string, "set" | "changed">;
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

/** Writes one top-level property and answers what it replaced. */
function assignProperty(state: WriteState, property: string, value: unknown): unknown {
  const before = state.payload[property];
  state.payload[property] = value;
  state.writtenProperties.add(property);
  return before;
}

function setProperty(state: WriteState, path: string, property: string, value: unknown): void {
  state.changes.push(change(path, "set", assignProperty(state, property, value), value));
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
      const before = assignProperty(state, assignment.property, value);
      const reference = configurationRef(state.application, assignment.dependency, assignment.id);
      // Reported by value only where the stored value *is* the identifier the
      // caller supplied. Where the instance stores something else — a root
      // folder is stored as its path — the change carries the reference and
      // withholds the value, so a pointer never becomes the way a filesystem
      // path reaches a result.
      state.changes.push(
        typeof value === "number"
          ? { ...change(assignment.property, "set", before, value), reference }
          : {
              path: assignment.property,
              action: sameValue(before, value) ? "unchanged" : "set",
              redacted: true,
              reference,
            },
      );
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
    case "secret": {
      const entry = resolveField(state, assignment.name);
      if (!("record" in entry)) {
        return entry;
      }
      // The instance has the last word. A name that reads as a credential got
      // the patch this far; a record that does not actually treat the field as
      // one — because nothing marks it, or because it holds a switch — would be
      // written through a channel whose whole purpose is that the value is
      // never retained, and a value that is not a credential belongs in a
      // desired field where it can be described.
      if (!isCredentialEntry(assignment.name, entry.record)) {
        return toolError(
          state.application,
          "invalid_input",
          `${assignment.name} is not a credential on this record; state it as a desired field instead`,
        );
      }
      const value = state.secrets.take(assignment.name);
      if (value === undefined) {
        return toolError(
          state.application,
          "invalid_input",
          `no value was supplied for ${assignment.name}; a credential is supplied again with every request that needs it`,
        );
      }
      // Told apart by what was configured before, never by comparing values: a
      // comparison would need the old credential, and an instance that answered
      // with a mask never gave one. A supplied credential is therefore always a
      // change to send, even where it happens to match what is stored.
      const configured = describeSecret(assignment.name, entry.record.value).state;
      entry.record.value = value;
      state.writtenFields.add(entry.index);
      state.supplied.set(assignment.name, configured === "configured" ? "changed" : "set");
      state.changes.push({ path: fieldPath(assignment.name), action: "set", redacted: true });
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
  const secret = isCredentialEntry(name, entry.record);
  if (!secret && !providerFieldAllowlist.has(name)) {
    // The compiler cleared this name by reading it alone; the record says it is
    // a switch rather than a credential, and a switch this server cannot
    // describe is one it will not clear either. Refusing here rather than
    // silently writing null keeps removal to fields it can say something about.
    return toolError(
      state.application,
      "invalid_input",
      `${name} is a switch on this record rather than a credential, and is not a field this server can clear`,
    );
  }
  const before = entry.record.value;
  entry.record.value = null;
  state.writtenFields.add(entry.index);
  state.changes.push(
    secret
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
  supplied: ReadonlyMap<string, "set" | "changed">,
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
    // A boolean under a credential-shaped name is a switch, not a credential;
    // the observation classifier withholds it rather than calling it
    // configured, and calling it preserved here would say the same false thing.
    if (!isCredentialEntry(value.name, value)) {
      continue;
    }
    dispositions.push({
      name: value.name,
      disposition: supplied.get(value.name) ?? (cleared.has(value.name) ? "cleared" : "preserved"),
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
    secrets: request.secrets,
    supplied: new Map(),
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
  const secrets = secretDispositions(payload, cleared, state.supplied);
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
 *
 * One observation is about shape rather than about a value. A provider's field
 * list is defined by the instance, so a field entry that appears or disappears,
 * or an implementation that has been swapped underneath, changes what this
 * patch means even though every value it names still reads the same. That is
 * the resource-side half of the schema fingerprint in {@link ./fingerprints.js},
 * and it is deliberately an inventory of names rather than of contents, so it
 * moves when the record's shape moves and not when its settings do.
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
  if (patch.family === "provider") {
    observations.push({
      key: "resource-shape",
      value: fingerprint({
        // Folded exactly as the schema side folds them, because they are the
        // same two identifiers matched the same case-insensitive way. A record
        // whose instance re-cased its own implementation still selects the same
        // template and still produces the same write, so neither half of the
        // shape fingerprint may move for it.
        implementation: identifierOf(payload.implementation),
        configContract: identifierOf(payload.configContract),
        fields: fieldShape(payload),
      }),
    });
  }

  const observeProperty = (property: string): void => {
    observations.push({ key: property, value: fingerprint(payload[property]) });
  };
  const observeField = (name: string): void => {
    const [entry] = entries.get(name) ?? [];
    const record = entry?.record;
    observations.push({
      key: fieldPath(name),
      value: fingerprint(
        record === undefined
          ? undefined
          : isCredentialEntry(name, record)
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
          // A switch the writer cannot move is observed as unwritable rather
          // than by value: an instance changing a legacy `enable: "yes"` to
          // some other non-boolean neither changes what this write does nor is
          // disclosed by its diff, while one that becomes a real boolean does
          // change it and still expires the plan.
          observations.push({
            key: name,
            value: fingerprint(typeof payload[name] === "boolean" ? payload[name] : "unwritable"),
          });
        }
        break;
      case "tags":
        observeProperty("tags");
        break;
      case "field":
      case "secret":
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
