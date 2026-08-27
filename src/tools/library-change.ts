import {
  type AddMediaRequest,
  addMediaPayload,
  type ConfigurationRecord,
  createMedia,
  currentTagIds,
  type LookupCandidate,
  monitorSelections,
  type RecordChanges,
  readConfigurationRecords,
  readLookupCandidate,
  readRecordResource,
  recordApplications,
  recordResourcePath,
  recordState,
  rewriteResource,
  supportsMonitorSelection,
  type UpstreamResource,
  writeResource,
} from "../adapters/library/changes.js";
import type {
  ConfigurationPointerKind,
  MediaApplication,
  MediaLookupKind,
  MediaRecordKind,
} from "../adapters/library/model.js";
import { isMediaApplication, mediaRecordKinds } from "../adapters/library/model.js";
import type { PreconditionRead, ReadSetObservation } from "../state/plans.js";
import {
  createToolError,
  type ToolError,
  toolErrorForReferenceFailure,
  toolErrorForThrown,
  toolErrorProvesNoEffect,
} from "./errors.js";
import type { OperationHandler, OperationInvocation, PreconditionReader } from "./operations.js";
import type { Effect, ItemOutcome } from "./results.js";
import { type LibraryChangeIntent, libraryChangeIntentSchema } from "./schemas/library.js";

/**
 * The `arr_library_change` add, monitoring, and edit handlers.
 *
 * The division of labour with the shared dispatcher is the point of this file.
 * Everything that decides whether a mutation may run happens in the
 * precondition reader: references are turned back into upstream identities,
 * dependencies are checked against the instance, and the current state of every
 * selected record is read. The dispatcher fingerprints that read for a plan and
 * compares it again before a planned apply, so the handler below never has to
 * ask whether it is allowed to send — only what to send.
 *
 * The reader hands the handler exactly the state it validated, so an apply
 * writes over the resource it just checked rather than over one it re-read
 * afterwards.
 */

const contextKind = "library-change";

type ResolvedMediaKind = MediaRecordKind | MediaLookupKind;

interface MediaIdentity {
  readonly kind: ResolvedMediaKind;
  readonly id: number;
  /** Set when the reference names a season, which has no upstream id of its own. */
  readonly seasonNumber?: number | undefined;
}

/** One selected record, once its reference and current state have been read. */
interface ValidatedItem {
  readonly reference: string;
  readonly kind: MediaRecordKind;
  readonly id: number;
  readonly seasonNumber?: number | undefined;
  /**
   * The route of the resource this item is stored in, which is not always the
   * item itself: two seasons of a series share one, and so do a series and any
   * of its seasons. It is what groups items into writes, and it is the route
   * rather than the kind precisely because those two do not correspond.
   */
  readonly resourcePath: string;
  /** The resource as it was first read, before any of this call's rewrites. */
  readonly resource: UpstreamResource;
  /** Whether this item's own change differs from what it was applied to. */
  readonly changed: boolean;
}

type ItemValidation =
  | ({ readonly status: "ok" } & ValidatedItem)
  | { readonly status: "error"; readonly reference: string; readonly error: ToolError };

/**
 * One upstream resource this call will send back, with every selected item's
 * change already written over it.
 *
 * Grouping is what keeps a bulk change correct where several items live in one
 * resource: writing each item's own rewrite in turn would send the second
 * resource over the first and silently undo it. Each resource is sent once,
 * carrying every change asked of it.
 */
interface ResourceWrite {
  /** The upstream route this resource is read from and written back to. */
  readonly path: string;
  readonly payload: UpstreamResource;
  readonly changed: boolean;
}

interface AddContext {
  readonly kind: typeof contextKind;
  readonly intent: "add_media";
  readonly candidate: LookupCandidate;
  readonly request: AddMediaRequest;
}

interface ItemsContext {
  readonly kind: typeof contextKind;
  readonly intent: "set_monitoring" | "edit_media";
  readonly items: readonly ItemValidation[];
  readonly writes: readonly ResourceWrite[];
  /** Call-level notes the plan and the apply both repeat, such as a root move. */
  readonly warnings: readonly string[];
  readonly effects: readonly Effect[];
}

type LibraryChangeContext = AddContext | ItemsContext;

function isLibraryChangeContext(value: unknown): value is LibraryChangeContext {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === contextKind
  );
}

function invalid(invocation: OperationInvocation, message: string): ToolError {
  return createToolError({
    code: "invalid_input",
    message: `${invocation.application}: ${message}`,
    application: invocation.application,
  });
}

function conflict(invocation: OperationInvocation, message: string): ToolError {
  return createToolError({
    code: "conflict",
    message: `${invocation.application}: ${message}`,
    application: invocation.application,
  });
}

function unsupported(invocation: OperationInvocation, message: string): ToolError {
  return createToolError({
    code: "unsupported_capability",
    message: `${invocation.application}: ${message}`,
    application: invocation.application,
  });
}

function blocked(error: ToolError): PreconditionRead {
  return { status: "blocked", error };
}

type Resolved<TValue> =
  | { readonly ok: true; readonly value: TValue }
  | { readonly ok: false; readonly error: ToolError };

/**
 * Reads the media application a mutation targets.
 *
 * Prowlarr has no library, and the operation registry already declares these
 * variants for Sonarr and Radarr only, so this narrows a type rather than
 * enforcing a policy — but it refuses rather than assuming, because assuming
 * would mean sending a library write to whatever instance answered.
 */
function mediaApplicationOf(invocation: OperationInvocation): Resolved<MediaApplication> {
  return isMediaApplication(invocation.application)
    ? { ok: true, value: invocation.application }
    : { ok: false, error: unsupported(invocation, "this application has no media library") };
}

/**
 * Turns one media reference back into the identity it stands for.
 *
 * The dispatcher has already rejected a forged, expired, previous-lifetime, or
 * wrong-kind reference. What is checked here is what only this tool knows: that
 * the reference belongs to the instance being written to, and that it names a
 * kind this mutation can act on. A season's identity is composite upstream, so
 * it is split back into the series it belongs to and the season number.
 */
function resolveMediaIdentity(
  invocation: OperationInvocation,
  token: string,
  property: string,
): Resolved<MediaIdentity> {
  const resolution = invocation.state.references.resolve(token, "media");
  if (!resolution.ok) {
    return {
      ok: false,
      error: toolErrorForReferenceFailure(resolution.reason, "media", invocation.application),
    };
  }

  const entry = resolution.entry;
  if (!entry.applications.includes(invocation.application)) {
    return { ok: false, error: invalid(invocation, `${property} names a different application`) };
  }
  if (entry.payload.kind !== "domain") {
    return { ok: false, error: invalid(invocation, `${property} does not name a library record`) };
  }

  const kind = entry.payload.snapshot.detail?.kind;
  if (typeof kind !== "string" || !isResolvableKind(kind)) {
    return { ok: false, error: invalid(invocation, `${property} does not name a library record`) };
  }

  const upstreamId = entry.payload.snapshot.upstreamId;
  if (kind === "season") {
    const parts = /^(\d+)\/(\d+)$/u.exec(upstreamId);
    const seriesId = parts?.[1];
    const seasonNumber = parts?.[2];
    if (seriesId === undefined || seasonNumber === undefined) {
      return { ok: false, error: invalid(invocation, `${property} does not name a single season`) };
    }
    return {
      ok: true,
      value: { kind, id: Number(seriesId), seasonNumber: Number(seasonNumber) },
    };
  }

  // Matched before it is converted, because `Number` answers several strings
  // that are not a plain identifier by quietly changing them.
  if (!/^\d+$/u.test(upstreamId)) {
    return { ok: false, error: invalid(invocation, `${property} does not name a single record`) };
  }
  const id = Number(upstreamId);
  if (!Number.isSafeInteger(id)) {
    return { ok: false, error: invalid(invocation, `${property} does not name a single record`) };
  }
  return { ok: true, value: { kind, id } };
}

const resolvableKinds: readonly string[] = [
  "series",
  "season",
  "episode",
  "movie",
  "collection",
  "series_lookup",
  "movie_lookup",
];

function isResolvableKind(kind: string): kind is ResolvedMediaKind {
  return resolvableKinds.includes(kind);
}

function isRecordKind(kind: ResolvedMediaKind): kind is MediaRecordKind {
  return (mediaRecordKinds as readonly string[]).includes(kind);
}

/**
 * Turns one configuration reference back into the upstream identifier it names.
 *
 * The kind is checked here rather than at the schema, because every
 * configuration reference has the same published shape: a root folder supplied
 * where a quality profile belongs is a wrong-kind reference this tool has to
 * catch, and catching it costs no upstream request.
 */
function resolveConfigurationId(
  invocation: OperationInvocation,
  token: string,
  expected: ConfigurationPointerKind,
  property: string,
): Resolved<string> {
  const resolution = invocation.state.references.resolve(token, "configuration");
  if (!resolution.ok) {
    return {
      ok: false,
      error: toolErrorForReferenceFailure(
        resolution.reason,
        "configuration",
        invocation.application,
      ),
    };
  }

  const entry = resolution.entry;
  if (!entry.applications.includes(invocation.application)) {
    return { ok: false, error: invalid(invocation, `${property} names a different application`) };
  }
  if (entry.payload.kind !== "domain" || entry.payload.snapshot.detail?.kind !== expected) {
    return {
      ok: false,
      error: invalid(invocation, `${property} must name a ${expected.replaceAll("_", " ")}`),
    };
  }
  return { ok: true, value: entry.payload.snapshot.upstreamId };
}

/**
 * Finds the configuration object a reference names in the instance's own list.
 *
 * A reference is matched on the identifier it was minted from and, for a root
 * folder, on its path as well, because a root folder is named by its path in a
 * library record and by an id in the root-folder list. Not finding it is a
 * stale reference rather than a conflict: the remedy is to read the
 * configuration again.
 */
function matchConfiguration(
  records: readonly ConfigurationRecord[],
  upstreamId: string,
): ConfigurationRecord | undefined {
  // The identifier is tried across the whole list before any name is, so a
  // record whose name happens to read like another record's identifier cannot
  // shadow the record that identifier actually names.
  return (
    records.find((record) => String(record.id) === upstreamId) ??
    records.find((record) => record.name !== undefined && record.name === upstreamId)
  );
}

interface DependencyRequest {
  readonly token: string;
  readonly kind: ConfigurationPointerKind;
  readonly property: string;
}

interface DependencyResult {
  readonly request: DependencyRequest;
  readonly record: ConfigurationRecord;
}

/**
 * Validates every configuration dependency one mutation names.
 *
 * Each kind's list is read at most once per call, so naming ten tags costs one
 * request, and the resolved records become part of the read set — a plan that
 * was validated against a profile which has since been deleted must not apply.
 */
async function readDependencies(
  invocation: OperationInvocation,
  application: MediaApplication,
  requests: readonly DependencyRequest[],
): Promise<Resolved<readonly DependencyResult[]>> {
  const lists = new Map<ConfigurationPointerKind, readonly ConfigurationRecord[]>();
  const results: DependencyResult[] = [];

  for (const request of requests) {
    const resolved = resolveConfigurationId(
      invocation,
      request.token,
      request.kind,
      request.property,
    );
    if (!resolved.ok) {
      return resolved;
    }

    let records = lists.get(request.kind);
    if (records === undefined) {
      records = await readConfigurationRecords(
        invocation.adapter.client,
        application,
        request.kind,
      );
      lists.set(request.kind, records);
    }

    const record = matchConfiguration(records, resolved.value);
    if (record === undefined) {
      return {
        ok: false,
        error: createToolError({
          code: "stale_reference",
          message: `${application}: the ${request.property} this call names no longer exists on this instance`,
          application,
        }),
      };
    }
    results.push({ request, record });
  }

  return { ok: true, value: results };
}

function dependencyObservations(
  results: readonly DependencyResult[],
): readonly ReadSetObservation[] {
  return results.map((result) => ({
    key: `${result.request.property}:${result.request.token}`,
    value: { kind: result.request.kind, id: result.record.id, name: result.record.name },
  }));
}

function parseIntent(invocation: OperationInvocation): Resolved<LibraryChangeIntent> {
  const parsed = libraryChangeIntentSchema.safeParse(invocation.input);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : {
        ok: false,
        error: invalid(
          invocation,
          "the arguments do not match the arr_library_change input schema",
        ),
      };
}

function effect(application: MediaApplication, summary: string): Effect {
  return { application, severity: "consequential", summary };
}

/* -------------------------------------------------------------------------- */
/* add_media                                                                   */
/* -------------------------------------------------------------------------- */

const lookupKindApplications: Readonly<Record<MediaLookupKind, MediaApplication>> = {
  series_lookup: "sonarr",
  movie_lookup: "radarr",
};

/**
 * Validates an add before anything is created.
 *
 * Three things have to hold, and all three are read from the instance rather
 * than assumed: the candidate still exists in its metadata source, it is not
 * already a library record, and the root folder, quality profile, and tags the
 * caller named still exist. The candidate's library identity is part of the
 * read set, so a record added between planning and applying makes the plan
 * stale instead of producing a duplicate.
 */
async function readAddPreconditions(
  invocation: OperationInvocation,
  application: MediaApplication,
  intent: Extract<LibraryChangeIntent, { intent: "add_media" }>,
): Promise<PreconditionRead> {
  if (intent.application !== application) {
    return blocked(invalid(invocation, "the named application is not the one being called"));
  }
  if (!supportsMonitorSelection(application, intent.monitor)) {
    return blocked(
      unsupported(
        invocation,
        `this application supports the monitor selections: ${monitorSelections[application].join(", ")}`,
      ),
    );
  }

  const identity = resolveMediaIdentity(invocation, intent.lookup, "lookup");
  if (!identity.ok) {
    return blocked(identity.error);
  }
  const kind = identity.value.kind;
  if (kind !== "series_lookup" && kind !== "movie_lookup") {
    return blocked(invalid(invocation, "lookup must name a metadata lookup result"));
  }
  if (lookupKindApplications[kind] !== application) {
    return blocked(unsupported(invocation, "that lookup result belongs to another application"));
  }

  const dependencies = await readDependencies(invocation, application, [
    { token: intent.rootFolder, kind: "root_folder", property: "rootFolder" },
    { token: intent.qualityProfile, kind: "quality_profile", property: "qualityProfile" },
    ...(intent.tags ?? []).map((token) => ({ token, kind: "tag" as const, property: "tags" })),
  ]);
  if (!dependencies.ok) {
    return blocked(dependencies.error);
  }

  const candidate = await readLookupCandidate(
    invocation.adapter.client,
    application,
    kind,
    identity.value.id,
  );
  if (candidate === undefined) {
    return blocked(
      createToolError({
        code: "stale_reference",
        message: `${application}: that lookup result is no longer offered by this instance`,
        application,
      }),
    );
  }
  if (candidate.existingId !== undefined) {
    return blocked(
      conflict(
        invocation,
        `“${candidate.title}” is already in this library; edit the existing record instead of adding it again`,
      ),
    );
  }

  const rootFolder = dependencies.value.find((entry) => entry.request.kind === "root_folder");
  const qualityProfile = dependencies.value.find(
    (entry) => entry.request.kind === "quality_profile",
  );
  const rootFolderPath = rootFolder?.record.name;
  if (rootFolderPath === undefined || qualityProfile === undefined) {
    return blocked(
      conflict(invocation, "this instance reported no usable root folder or quality profile"),
    );
  }

  const context: AddContext = {
    kind: contextKind,
    intent: "add_media",
    candidate,
    request: {
      rootFolderPath,
      qualityProfileId: qualityProfile.record.id,
      tagIds: dependencies.value
        .filter((entry) => entry.request.kind === "tag")
        .map((entry) => entry.record.id),
      monitor: intent.monitor,
      searchOnAdd: intent.searchOnAdd,
    },
  };

  return {
    status: "ok",
    validated: context,
    observations: [
      {
        key: `lookup:${intent.lookup}`,
        // The title is fingerprinted alongside the identity because the plan
        // discloses it: a caller that planned to add one title must not have a
        // different one added by applying that plan. The rest of a candidate's
        // metadata is deliberately not, because both applications refresh it
        // from their own source when the record is created, so a refreshed
        // overview or rating changes nothing about the effect.
        value: {
          metadataId: candidate.metadataId,
          title: candidate.title,
          existing: candidate.existingId ?? null,
        },
      },
      ...dependencyObservations(dependencies.value),
    ],
  };
}

function addEffects(application: MediaApplication, context: AddContext): readonly Effect[] {
  return [
    effect(application, `add “${context.candidate.title}” to the library`),
    ...(context.request.searchOnAdd
      ? [effect(application, `start an acquisition search for “${context.candidate.title}”`)]
      : []),
  ];
}

/* -------------------------------------------------------------------------- */
/* set_monitoring and edit_media                                               */
/* -------------------------------------------------------------------------- */

const editableKinds: readonly MediaRecordKind[] = ["series", "movie", "collection"];

const monitorableKinds: readonly MediaRecordKind[] = [
  "series",
  "season",
  "episode",
  "movie",
  "collection",
];

/**
 * Checks that one selected reference names a record this intent can act on.
 *
 * The two intents differ: monitoring reaches every record kind both
 * applications model, while a profile, root folder, or tag exists only on the
 * records that own one — an episode has no quality profile, so asking to change
 * one is refused rather than silently ignored.
 */
function checkItemKind(
  invocation: OperationInvocation,
  application: MediaApplication,
  intent: "set_monitoring" | "edit_media",
  kind: ResolvedMediaKind,
): Resolved<MediaRecordKind> {
  const allowed = intent === "edit_media" ? editableKinds : monitorableKinds;
  if (!isRecordKind(kind) || !allowed.includes(kind)) {
    return {
      ok: false,
      error: unsupported(
        invocation,
        `this intent accepts ${allowed.join(", ")} records, not a ${kind.replaceAll("_", " ")}`,
      ),
    };
  }
  if (recordApplications[kind] !== application) {
    return { ok: false, error: unsupported(invocation, `this application has no ${kind} records`) };
  }
  return { ok: true, value: kind };
}

/**
 * Which application owns each application-specific edit field.
 *
 * The published `changes` object carries the union of both applications' fields,
 * so the pairing has to be enforced here. Sending Sonarr's series type to Radarr
 * is not a harmless extra property: the write replaces the whole resource, and
 * an application that does not model the field would be told something about
 * itself that is not true of it.
 */
const editFieldApplications: Readonly<Record<string, MediaApplication>> = {
  seriesType: "sonarr",
  minimumAvailability: "radarr",
};

/** The named edits the target application has no field for. */
function foreignEditFields(
  application: MediaApplication,
  changes: Readonly<Record<string, unknown>>,
): readonly string[] {
  return Object.entries(editFieldApplications)
    .filter(([field, owner]) => changes[field] !== undefined && owner !== application)
    .map(([field]) => field);
}

interface ItemChanges {
  readonly changes: RecordChanges;
  /** Tag identifiers to add and remove, applied against each record's own list. */
  readonly addTags: readonly number[];
  readonly removeTags: readonly number[];
}

function tagChangesFor(resource: UpstreamResource, changes: ItemChanges): readonly number[] {
  const current = currentTagIds(resource);
  const removed = new Set(changes.removeTags);
  const kept = current.filter((tag) => !removed.has(tag));
  return [...new Set([...kept, ...changes.addTags])];
}

interface ReadItemsResult {
  readonly items: readonly ItemValidation[];
  readonly writes: readonly ResourceWrite[];
}

/**
 * Reads and rewrites every selected record.
 *
 * Records are read one at a time and each resource is read once, because two
 * references can name the same one — two seasons of a series, most obviously.
 * Every item's change is then written over the accumulated resource rather than
 * over a fresh copy, so the resource that is eventually sent carries all of
 * them; sending one rewrite per item would undo every change but the last.
 *
 * A reference that cannot be resolved or read fails that item alone. Blocking
 * the whole call would hide the outcome of every other item, and a bulk change
 * is explicitly not transactional.
 */
async function readItems(
  invocation: OperationInvocation,
  application: MediaApplication,
  intent: "set_monitoring" | "edit_media",
  references: readonly string[],
  changes: ItemChanges,
): Promise<ReadItemsResult> {
  const items: ItemValidation[] = [];
  // Insertion-ordered, so the writes are sent in the order the caller's items
  // first named their resources.
  const writes = new Map<string, ResourceWrite>();
  const originals = new Map<string, UpstreamResource>();

  for (const reference of references) {
    const identity = resolveMediaIdentity(invocation, reference, "items");
    if (!identity.ok) {
      items.push({ status: "error", reference, error: identity.error });
      continue;
    }

    const checked = checkItemKind(invocation, application, intent, identity.value.kind);
    if (!checked.ok) {
      items.push({ status: "error", reference, error: checked.error });
      continue;
    }
    const kind = checked.value;
    const resourcePath = recordResourcePath(kind, identity.value.id);

    let original = originals.get(resourcePath);
    if (original === undefined) {
      try {
        original = await readRecordResource(
          invocation.adapter.client,
          application,
          kind,
          identity.value.id,
        );
      } catch (error) {
        items.push({ status: "error", reference, error: toolErrorForThrown(error, application) });
        continue;
      }
      originals.set(resourcePath, original);
    }

    // Tags are resolved against the record as it currently stands upstream, so
    // naming the same record twice cannot add a tag against a list that already
    // includes it.
    const base = writes.get(resourcePath)?.payload ?? original;
    const rewrite = rewriteResource(base, {
      kind,
      seasonNumber: identity.value.seasonNumber,
      changes: {
        ...changes.changes,
        ...(changes.addTags.length === 0 && changes.removeTags.length === 0
          ? {}
          : { tagIds: tagChangesFor(original, changes) }),
      },
    });
    if (rewrite.status === "blocked") {
      items.push({ status: "error", reference, error: conflict(invocation, rewrite.reason) });
      continue;
    }

    writes.set(resourcePath, {
      path: resourcePath,
      payload: rewrite.resource,
      changed: rewrite.changed || (writes.get(resourcePath)?.changed ?? false),
    });
    items.push({
      status: "ok",
      reference,
      kind,
      id: identity.value.id,
      seasonNumber: identity.value.seasonNumber,
      resourcePath,
      resource: original,
      changed: rewrite.changed,
    });
  }

  return { items, writes: [...writes.values()] };
}

/**
 * One observation per selected item, including the ones that failed.
 *
 * A failed item is fingerprinted too, and that is not bookkeeping: a plan
 * reports such an item as unchangeable and leaves it out of its predicted
 * effects, so if it became readable before the plan was applied, applying it
 * would mutate a record the plan said it would not touch. A key that is present
 * and different is exactly what makes that stale; a key that is simply absent
 * is not, because a plan makes no claim about what it never observed.
 */
function itemObservations(items: readonly ItemValidation[]): readonly ReadSetObservation[] {
  return items.map((item) => ({
    key: `media:${item.reference}`,
    value:
      item.status === "ok"
        ? recordState(item.resource, item.seasonNumber)
        : { unreadable: item.error.code },
  }));
}

function describeCount(items: readonly ItemValidation[]): string {
  const count = items.filter((item) => item.status === "ok").length;
  return `${count} record(s)`;
}

/**
 * Validates a monitoring or metadata change before anything is written.
 *
 * The dependency reads happen once for the whole call and block it on failure,
 * because a profile that does not exist is not one item's problem; the
 * per-record reads happen per item and fail only that item.
 */
async function readItemPreconditions(
  invocation: OperationInvocation,
  application: MediaApplication,
  intent: Extract<LibraryChangeIntent, { intent: "set_monitoring" | "edit_media" }>,
): Promise<PreconditionRead> {
  if (intent.intent === "edit_media") {
    const foreign = foreignEditFields(application, intent.changes);
    if (foreign.length > 0) {
      return blocked(
        unsupported(invocation, `this application does not model ${foreign.join(" or ")}`),
      );
    }
  }

  const requests: DependencyRequest[] = [];
  const changes: RecordChanges =
    intent.intent === "set_monitoring"
      ? { monitored: intent.monitored }
      : {
          monitored: intent.changes.monitored,
          seriesType: intent.changes.seriesType,
          minimumAvailability: intent.changes.minimumAvailability,
        };

  if (intent.intent === "edit_media") {
    if (intent.changes.qualityProfile !== undefined) {
      requests.push({
        token: intent.changes.qualityProfile,
        kind: "quality_profile",
        property: "qualityProfile",
      });
    }
    if (intent.changes.rootFolder !== undefined) {
      requests.push({
        token: intent.changes.rootFolder,
        kind: "root_folder",
        property: "rootFolder",
      });
    }
    for (const token of intent.changes.tags?.add ?? []) {
      requests.push({ token, kind: "tag", property: "tags.add" });
    }
    for (const token of intent.changes.tags?.remove ?? []) {
      requests.push({ token, kind: "tag", property: "tags.remove" });
    }
  }

  const dependencies = await readDependencies(invocation, application, requests);
  if (!dependencies.ok) {
    return blocked(dependencies.error);
  }

  const found = (property: string): readonly number[] =>
    dependencies.value
      .filter((entry) => entry.request.property === property)
      .map((entry) => entry.record.id);
  const rootFolder = dependencies.value.find((entry) => entry.request.property === "rootFolder");
  const rootFolderPath = rootFolder?.record.name;
  const qualityProfileId = found("qualityProfile")[0];

  const itemChanges: ItemChanges = {
    changes: {
      ...changes,
      ...(qualityProfileId === undefined ? {} : { qualityProfileId }),
      ...(rootFolderPath === undefined ? {} : { rootFolderPath }),
    },
    addTags: found("tags.add"),
    removeTags: found("tags.remove"),
  };

  const read = await readItems(invocation, application, intent.intent, intent.items, itemChanges);
  const context: ItemsContext = {
    kind: contextKind,
    intent: intent.intent,
    items: read.items,
    writes: read.writes,
    warnings:
      rootFolder === undefined
        ? []
        : [
            "the selected records are re-pointed under the new root folder; no file is moved on disk by this change",
          ],
    effects: describeEffects(application, intent, read.items),
  };

  return {
    status: "ok",
    validated: context,
    observations: [...dependencyObservations(dependencies.value), ...itemObservations(read.items)],
  };
}

/**
 * The effects a monitoring or metadata change requests.
 *
 * One effect per named change rather than one per call, because "change the
 * quality profile" and "change the root folder" are different consequences and
 * a plan that merged them would disclose less than it knows.
 */
function describeEffects(
  application: MediaApplication,
  intent: Extract<LibraryChangeIntent, { intent: "set_monitoring" | "edit_media" }>,
  items: readonly ItemValidation[],
): readonly Effect[] {
  const scope = describeCount(items);
  if (intent.intent === "set_monitoring") {
    return [effect(application, `${intent.monitored ? "monitor" : "stop monitoring"} ${scope}`)];
  }

  const changes = intent.changes;
  const effects: Effect[] = [];
  if (changes.monitored !== undefined) {
    effects.push(
      effect(application, `${changes.monitored ? "monitor" : "stop monitoring"} ${scope}`),
    );
  }
  if (changes.qualityProfile !== undefined) {
    effects.push(effect(application, `change the quality profile of ${scope}`));
  }
  if (changes.rootFolder !== undefined) {
    effects.push(
      effect(application, `re-point ${scope} at a different root folder without moving files`),
    );
  }
  if (changes.seriesType !== undefined) {
    effects.push(effect(application, `set the series type of ${scope} to ${changes.seriesType}`));
  }
  if (changes.minimumAvailability !== undefined) {
    effects.push(
      effect(
        application,
        `set the minimum availability of ${scope} to ${changes.minimumAvailability}`,
      ),
    );
  }
  if ((changes.tags?.add ?? []).length > 0 || (changes.tags?.remove ?? []).length > 0) {
    effects.push(effect(application, `change the tags of ${scope}`));
  }
  return effects;
}

/* -------------------------------------------------------------------------- */
/* Preconditions and handler                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Reads everything an add, monitoring, or edit intent depends on.
 *
 * The dispatcher runs this before plan mode and again before apply mode, so it
 * is both the facts a plan is fingerprinted against and the immediate
 * current-state validation a direct apply performs. Nothing is written here.
 */
export const libraryChangePreconditions: PreconditionReader = async (invocation) => {
  const application = mediaApplicationOf(invocation);
  if (!application.ok) {
    return blocked(application.error);
  }
  const intent = parseIntent(invocation);
  if (!intent.ok) {
    return blocked(intent.error);
  }

  switch (intent.value.intent) {
    case "add_media":
      return readAddPreconditions(invocation, application.value, intent.value);
    case "set_monitoring":
    case "edit_media":
      return readItemPreconditions(invocation, application.value, intent.value);
    default:
      // The file and rename intents belong to a later task of change 0009, and
      // the registry still routes them to the not-implemented handler.
      return blocked(unsupported(invocation, "this intent is declared but not implemented yet"));
  }
};

function itemOutcome(
  reference: string,
  error: ToolError | undefined,
  warnings: readonly string[],
): ItemOutcome {
  return {
    reference,
    status: error === undefined ? "ok" : "error",
    warnings: [...warnings],
    ...(error === undefined ? {} : { error }),
  };
}

interface AppliedItems {
  readonly outcomes: readonly ItemOutcome[];
  /**
   * The failure, if any, that leaves this mutation's outcome unknown.
   *
   * Only a failed *write* can qualify, and only one that does not prove the
   * instance ignored it — a timeout, a lost connection. An item that failed
   * while its current state was being read sent nothing at all, so it is
   * reported per item and must not settle the receipt as unknown: that would
   * close a mutation nothing was sent for to any later retry.
   */
  readonly unresolved?: ToolError | undefined;
}

/**
 * Sends each resource once and reports each item's own outcome.
 *
 * The write is per resource and the outcome is per item, because those are two
 * different things: several items can share one request, and each of them
 * succeeded or failed exactly as that request did. A resource nothing changed
 * is not sent at all, and every item resting on it says so.
 */
async function applyItems(
  invocation: OperationInvocation,
  application: MediaApplication,
  context: ItemsContext,
): Promise<AppliedItems> {
  const failures = new Map<string, ToolError>();
  let unresolved: ToolError | undefined;

  for (const write of context.writes) {
    if (!write.changed) {
      continue;
    }
    try {
      await writeResource(invocation.adapter.client, write.path, write.payload);
    } catch (error) {
      const failure = toolErrorForThrown(error, application);
      failures.set(write.path, failure);
      if (unresolved === undefined && !toolErrorProvesNoEffect(failure.code)) {
        unresolved = failure;
      }
    }
  }

  const outcomes = context.items.map((item) => {
    if (item.status === "error") {
      return itemOutcome(item.reference, item.error, []);
    }
    const failure = failures.get(item.resourcePath);
    if (failure !== undefined) {
      return itemOutcome(item.reference, failure, []);
    }
    return itemOutcome(
      item.reference,
      undefined,
      item.changed
        ? []
        : ["this record already matched the requested state; nothing was sent for it"],
    );
  });

  return { outcomes, unresolved };
}

function planForItems(context: ItemsContext): {
  requestedEffects: readonly Effect[];
  predictedEffects: readonly Effect[];
  warnings: readonly string[];
} {
  const changing = context.items.filter((item) => item.status === "ok" && item.changed).length;
  const failing = context.items.filter((item) => item.status === "error").length;
  return {
    requestedEffects: context.effects,
    // Nothing is predicted for a selection that is already in the requested
    // state: an apply would send nothing, and predicting the effect anyway
    // would overstate what the plan is going to do.
    predictedEffects: changing === 0 ? [] : context.effects,
    warnings: [
      ...context.warnings,
      ...(changing === 0 ? ["every selected record already matches the requested state"] : []),
      ...(failing === 0
        ? []
        : [`${failing} selected record(s) cannot be changed; see the per-item outcomes`]),
    ],
  };
}

/**
 * Adds, monitors, and edits library records.
 *
 * Plan mode discloses what an apply would request and predicts only what the
 * state it just read says will actually follow. Apply mode writes over the
 * resources the precondition reader validated, one record at a time, so every
 * item reports its own outcome and a failure part-way through neither hides the
 * items that succeeded nor claims the ones that did not.
 */
export const libraryChangeHandler: OperationHandler = async (invocation) => {
  const application = mediaApplicationOf(invocation);
  if (!application.ok) {
    return { status: "error", error: application.error };
  }

  const context = invocation.validated;
  if (!isLibraryChangeContext(context)) {
    return {
      status: "error",
      error: conflict(invocation, "the current state of this mutation was not validated"),
    };
  }

  if (context.intent === "add_media") {
    const effects = addEffects(application.value, context);
    if (invocation.mode === "plan") {
      return { status: "ok", plan: { requestedEffects: effects, predictedEffects: effects } };
    }

    const created = await createMedia(
      invocation.adapter.client,
      application.value,
      addMediaPayload(application.value, context.candidate, context.request),
    );
    return {
      status: "ok",
      effects,
      ...(created === undefined
        ? {
            // The instance accepted the request but told this server nothing
            // about what it created, so the receipt stays reconcilable rather
            // than reporting a record it never saw.
            outcomeUnknown: conflict(
              invocation,
              "the add was sent but the instance returned no record to confirm it",
            ),
          }
        : {}),
    };
  }

  if (invocation.mode === "plan") {
    const plan = planForItems(context);
    return {
      status: "ok",
      plan,
      items: context.items.map((item) =>
        item.status === "error"
          ? itemOutcome(item.reference, item.error, [])
          : itemOutcome(item.reference, undefined, item.changed ? [] : ["already in this state"]),
      ),
    };
  }

  const applied = await applyItems(invocation, application.value, context);
  // Every selection failing means nothing reached the application, so the
  // receipt must stay reusable: a transient failure reading the only selected
  // record would otherwise make that exact input permanently unretryable.
  const unattempted =
    applied.outcomes.length > 0 && applied.outcomes.every((item) => item.status === "error")
      ? applied.outcomes[0]?.error
      : undefined;

  return {
    status: "ok",
    items: applied.outcomes,
    effects: context.effects,
    warnings: context.warnings,
    ...(applied.unresolved === undefined ? {} : { outcomeUnknown: applied.unresolved }),
    ...(unattempted === undefined ? {} : { unattempted }),
  };
};
