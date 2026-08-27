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
  relocatePath,
  rewriteResource,
  supportsMonitorSelection,
  type UpstreamResource,
  writeResource,
} from "../adapters/library/changes.js";
import {
  type CommandAcceptance,
  type CommandWorkflow,
  type DeletionChoices,
  deleteFileResource,
  deleteRecordResource,
  type FileChanges,
  type FileDependency,
  type FileResource,
  fileApplications,
  fileParentId,
  fileParentKinds,
  fileResourcePath,
  fileState,
  matchOption,
  moveCommandPayload,
  type NamedOption,
  type RenameProposal,
  readFileResource,
  readLanguageOptions,
  readQualityOptions,
  readRenameProposals,
  recordDeletionQuery,
  recordDeletionState,
  recordPathState,
  renameCommandPayload,
  rewriteFileResource,
  startCommand,
} from "../adapters/library/files.js";
import type {
  ConfigurationPointerKind,
  MediaApplication,
  MediaFileKind,
  MediaLookupKind,
  MediaRecordKind,
} from "../adapters/library/model.js";
import { isMediaApplication, mediaRecordKinds } from "../adapters/library/model.js";
import type { UpstreamBody, UpstreamClient } from "../http/client.js";
import type { PreconditionRead, ReadSetObservation } from "../state/plans.js";
import {
  createToolError,
  type ToolError,
  toolErrorForReferenceFailure,
  toolErrorForThrown,
  toolErrorProvesNoEffect,
} from "./errors.js";
import type {
  OperationHandler,
  OperationInvocation,
  OperationOutcome,
  PreconditionReader,
} from "./operations.js";
import type { Effect, EffectSeverity, ItemOutcome } from "./results.js";
import { maxBulkItems } from "./schemas/common.js";
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
  readonly form: "add";
  readonly intent: "add_media";
  readonly candidate: LookupCandidate;
  readonly request: AddMediaRequest;
}

interface ItemsContext {
  readonly kind: typeof contextKind;
  readonly form: "items";
  readonly intent: "set_monitoring" | "edit_media";
  readonly items: readonly ItemValidation[];
  readonly writes: readonly ResourceWrite[];
  /** Call-level notes the plan and the apply both repeat, such as a root move. */
  readonly warnings: readonly string[];
  readonly effects: readonly Effect[];
}

/**
 * One upstream request a file or deletion mutation will send.
 *
 * The request is carried as the call that sends it rather than as a route and a
 * payload, because these intents send three different kinds of request — a
 * whole-resource write, a record deletion with its explicit choices, a file
 * deletion — and the apply loop that dispatches them has no business knowing
 * which. The path is still here, because it is the grouping key: two references
 * that name the same resource share one request and report its one outcome.
 */
interface PendingRequest {
  readonly path: string;
  readonly send: (client: UpstreamClient) => Promise<unknown>;
}

/** One selected file or record, once its reference and current state are read. */
interface SelectedItem {
  readonly reference: string;
  /** The request this item rests on, absent when the item itself failed. */
  readonly requestPath?: string | undefined;
  readonly error?: ToolError | undefined;
  readonly warnings?: readonly string[] | undefined;
  /** What this item contributes to the read set, failures included. */
  readonly observation: Readonly<Record<string, unknown>>;
}

/**
 * A bulk mutation that sends one request per selected thing rather than
 * rewriting a shared resource: the deletions and the file-metadata edits.
 */
interface RequestsContext {
  readonly kind: typeof contextKind;
  readonly form: "requests";
  readonly intent: "delete_media" | "delete_file" | "update_file_metadata";
  readonly items: readonly SelectedItem[];
  readonly requests: readonly PendingRequest[];
  readonly warnings: readonly string[];
  readonly effects: readonly Effect[];
}

/**
 * A mutation that runs as one allowlisted upstream command: a rename or a move.
 *
 * The payload is built by the precondition reader from what it read, so the
 * handler sends exactly what was validated and disclosed. A payload of
 * `undefined` means the reader found nothing to do, which an apply reports as
 * such rather than sending an empty command.
 */
interface CommandContext {
  readonly kind: typeof contextKind;
  readonly form: "command";
  readonly intent: "rename" | "move_media";
  readonly reference: string;
  readonly workflow: CommandWorkflow;
  readonly payload?: UpstreamBody | undefined;
  readonly warnings: readonly string[];
  readonly effects: readonly Effect[];
}

/**
 * What the precondition reader validated, handed to the handler unchanged.
 *
 * Each member carries a `form` as well as the intent it came from, and the
 * handler selects on the form rather than on the intent. That is deliberate:
 * the form says how a mutation is *sent* — one rewritten resource, one request
 * per selected thing, one allowlisted command — and several intents share each
 * of those. A handler keyed on the intent would repeat the same dispatch code
 * per variant and would let a variant added later fall through to the wrong one.
 */
type LibraryChangeContext = AddContext | ItemsContext | RequestsContext | CommandContext;

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

/**
 * One disclosed effect.
 *
 * The severity is a parameter rather than a constant because this tool now
 * spans both kinds of consequence: changing what an application believes, and
 * changing what is on the disk underneath it. A plan never softens the second
 * into the first — the deletions, the renames, and the moves declare themselves
 * destructive even though it makes the plan read worse.
 */
function effect(
  application: MediaApplication,
  summary: string,
  severity: EffectSeverity = "consequential",
): Effect {
  return { application, severity, summary };
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
    form: "add",
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
 * The intents differ in what they can reach: monitoring reaches every record
 * kind both applications model, while a profile, root folder, or tag exists
 * only on the records that own one — an episode has no quality profile, so
 * asking to change one is refused rather than silently ignored — and a deletion
 * or a move reaches only a record that is its own thing on disk.
 */
function checkItemKind(
  invocation: OperationInvocation,
  application: MediaApplication,
  allowed: readonly MediaRecordKind[],
  kind: ResolvedMediaKind,
): Resolved<MediaRecordKind> {
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

    const checked = checkItemKind(
      invocation,
      application,
      intent === "edit_media" ? editableKinds : monitorableKinds,
      identity.value.kind,
    );
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

/** What a failed selection contributes to the read set: that it could not be read. */
function unreadable(error: ToolError): Readonly<Record<string, unknown>> {
  return { unreadable: error.code };
}

/**
 * One observation per selected file or record, including the ones that failed,
 * for the same reason {@link itemObservations} keeps them: a plan that reported
 * an item as unchangeable must not act on it after it became readable again.
 */
function itemObservationsFor(
  prefix: "media" | "file",
  items: readonly SelectedItem[],
): readonly ReadSetObservation[] {
  return items.map((item) => ({ key: `${prefix}:${item.reference}`, value: item.observation }));
}

function describeSelection(items: readonly SelectedItem[], noun: string): string {
  return `${items.filter((item) => item.error === undefined).length} ${noun}(s)`;
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
    form: "items",
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
/* delete_media                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The records a deletion may remove.
 *
 * A season and an episode are parts of a series rather than resources of their
 * own, and a collection is a grouping Radarr keeps for movies it does not own
 * outright, so none of them is something a delete could remove without deciding
 * on the caller's behalf what else went with it.
 */
const deletableKinds: readonly MediaRecordKind[] = ["series", "movie"];

/**
 * Validates a deletion before anything is removed.
 *
 * The current state of every selected record is read, and what is fingerprinted
 * is what the plan discloses: the title being removed and how much data is
 * under it. A record that grew files between planning and applying therefore
 * makes the plan stale rather than quietly taking more than the plan said it
 * would.
 */
async function readDeletePreconditions(
  invocation: OperationInvocation,
  application: MediaApplication,
  intent: Extract<LibraryChangeIntent, { intent: "delete_media" }>,
): Promise<PreconditionRead> {
  const choices: DeletionChoices = {
    deleteFiles: intent.deleteFiles,
    addImportListExclusion: intent.addImportListExclusion,
  };
  const items: SelectedItem[] = [];
  const requests = new Map<string, PendingRequest>();

  for (const reference of intent.items) {
    const identity = resolveMediaIdentity(invocation, reference, "items");
    if (!identity.ok) {
      items.push({ reference, error: identity.error, observation: unreadable(identity.error) });
      continue;
    }
    const checked = checkItemKind(invocation, application, deletableKinds, identity.value.kind);
    if (!checked.ok) {
      items.push({ reference, error: checked.error, observation: unreadable(checked.error) });
      continue;
    }

    const resourcePath = recordResourcePath(checked.value, identity.value.id);
    let resource: UpstreamResource;
    try {
      resource = await readRecordResource(
        invocation.adapter.client,
        application,
        checked.value,
        identity.value.id,
      );
    } catch (error) {
      const failure = toolErrorForThrown(error, application);
      items.push({ reference, error: failure, observation: unreadable(failure) });
      continue;
    }

    // Two references naming the same record ask for one deletion, not two: the
    // second request would find nothing and report a failure for a record this
    // call had just removed itself.
    if (!requests.has(resourcePath)) {
      requests.set(resourcePath, {
        path: resourcePath,
        send: (client) =>
          deleteRecordResource(client, resourcePath, recordDeletionQuery(application, choices)),
      });
    }
    items.push({
      reference,
      requestPath: resourcePath,
      observation: recordDeletionState(resource, choices),
    });
  }

  const scope = describeSelection(items, "record");
  const effects: Effect[] = [
    effect(application, `remove ${scope} from the library`, "destructive"),
    ...(choices.deleteFiles
      ? [effect(application, `delete the files of ${scope} from disk`, "destructive")]
      : []),
    ...(choices.addImportListExclusion
      ? [effect(application, `exclude ${scope} from future import-list additions`)]
      : []),
  ];

  const context: RequestsContext = {
    kind: contextKind,
    form: "requests",
    intent: "delete_media",
    items,
    requests: [...requests.values()],
    warnings: [
      choices.deleteFiles
        ? "the files of the selected records are deleted from disk by this change"
        : "the library records are removed and their files are left on disk",
    ],
    effects,
  };

  return { status: "ok", validated: context, observations: itemObservationsFor("media", items) };
}

/* -------------------------------------------------------------------------- */
/* update_file_metadata and delete_file                                        */
/* -------------------------------------------------------------------------- */

interface FileIdentity {
  readonly kind: MediaFileKind;
  readonly id: number;
}

/**
 * Turns one media-file reference back into the identity it stands for.
 *
 * A file is its own reference kind, so the dispatcher has already refused a
 * media reference supplied where a file belongs. What is checked here is what
 * only this tool knows: that the reference belongs to the instance being
 * written to, and that the file kind is one this application actually models.
 */
function resolveFileIdentity(
  invocation: OperationInvocation,
  application: MediaApplication,
  token: string,
): Resolved<FileIdentity> {
  const resolution = invocation.state.references.resolve(token, "media_file");
  if (!resolution.ok) {
    return {
      ok: false,
      error: toolErrorForReferenceFailure(resolution.reason, "media_file", application),
    };
  }

  // Checked against the media application this call resolved, not against the
  // invocation's own. The two agree today, because the media application is
  // narrowed from it — but this function exists to validate a reference against
  // the library instance being written to, and that is the value that says which
  // one that is.
  const entry = resolution.entry;
  if (!entry.applications.includes(application)) {
    return {
      ok: false,
      error: invalid(
        invocation,
        `this file reference belongs to ${entry.applications.join(" and ")}, and this call addressed ${application}`,
      ),
    };
  }
  if (entry.payload.kind !== "domain") {
    return { ok: false, error: invalid(invocation, "this file reference does not name a file") };
  }

  const kind = entry.payload.snapshot.detail?.kind;
  if (kind !== "episode_file" && kind !== "movie_file") {
    return { ok: false, error: invalid(invocation, "this file reference does not name a file") };
  }
  if (fileApplications[kind] !== application) {
    return {
      ok: false,
      error: unsupported(
        invocation,
        `this application has no ${kind.replaceAll("_", " ")} records`,
      ),
    };
  }

  const upstreamId = entry.payload.snapshot.upstreamId;
  if (!/^\d+$/u.test(upstreamId)) {
    return {
      ok: false,
      error: invalid(invocation, "this file reference does not name a single file"),
    };
  }
  const id = Number(upstreamId);
  if (!Number.isSafeInteger(id)) {
    return {
      ok: false,
      error: invalid(invocation, "this file reference does not name a single file"),
    };
  }
  return { ok: true, value: { kind, id } };
}

interface SelectedFile {
  readonly reference: string;
  readonly kind: MediaFileKind;
  readonly id: number;
  readonly parentId: number;
  readonly resource: FileResource;
}

interface ReadFilesResult {
  readonly items: readonly SelectedItem[];
  readonly selected: readonly SelectedFile[];
}

/**
 * Reads every selected file, failing one reference at a time.
 *
 * A reference that cannot be resolved or read fails that file alone, for the
 * same reason a record does: a bulk change is explicitly not transactional, and
 * blocking the call would hide the outcome of every other file.
 */
async function readFiles(
  invocation: OperationInvocation,
  application: MediaApplication,
  references: readonly string[],
  depends: FileDependency,
): Promise<ReadFilesResult> {
  const items: SelectedItem[] = [];
  const selected: SelectedFile[] = [];

  for (const reference of references) {
    const identity = resolveFileIdentity(invocation, application, reference);
    if (!identity.ok) {
      items.push({ reference, error: identity.error, observation: unreadable(identity.error) });
      continue;
    }

    let resource: FileResource;
    try {
      resource = await readFileResource(
        invocation.adapter.client,
        application,
        identity.value.kind,
        identity.value.id,
      );
    } catch (error) {
      const failure = toolErrorForThrown(error, application);
      items.push({ reference, error: failure, observation: unreadable(failure) });
      continue;
    }

    const parentId = fileParentId(identity.value.kind, resource);
    if (parentId === undefined) {
      const failure = conflict(
        invocation,
        "this file reports no parent record, so it cannot be grouped safely",
      );
      items.push({ reference, error: failure, observation: unreadable(failure) });
      continue;
    }

    selected.push({ ...identity.value, reference, parentId, resource });
    items.push({ reference, observation: fileState(identity.value.kind, resource, depends) });
  }

  return { items, selected };
}

/**
 * Refuses a selection upstream cannot process as one group.
 *
 * The file endpoints are organized around the record a file hangs off, so a
 * call spanning two of them is asking one handler for something it has no
 * single answer to. It is refused whole rather than split here, because
 * splitting it would decide on the caller's behalf which grouping they meant —
 * and this is the one place a mutation could silently act on more than what was
 * asked for.
 */
function checkSingleParent(
  invocation: OperationInvocation,
  selected: readonly SelectedFile[],
): ToolError | undefined {
  const kind = selected[0]?.kind;
  if (kind === undefined) {
    return undefined;
  }
  const parents = new Set(selected.map((file) => file.parentId));
  if (parents.size <= 1) {
    return undefined;
  }
  return invalid(
    invocation,
    `every file in one call must belong to the same ${fileParentKinds[kind]}; this call names ${parents.size}, so split it into one call per ${fileParentKinds[kind]}`,
  );
}

interface ResolvedFileChanges {
  readonly changes: FileChanges;
  readonly observations: readonly ReadSetObservation[];
}

/**
 * Turns the caller's names for a quality and languages into the instance's own
 * objects.
 *
 * Each list is read at most once per call and only when the intent names
 * something from it, and the resolved values join the read set — a plan
 * validated against a quality definition this instance has since removed must
 * not apply.
 */
async function readFileChanges(
  invocation: OperationInvocation,
  application: MediaApplication,
  changes: Extract<LibraryChangeIntent, { intent: "update_file_metadata" }>["changes"],
): Promise<Resolved<ResolvedFileChanges>> {
  const observations: ReadSetObservation[] = [];
  const observe = (property: string, option: NamedOption): void => {
    observations.push({
      key: `${property}:${option.name}`,
      value: { id: option.id, name: option.name },
    });
  };

  let quality: NamedOption | undefined;
  if (changes.quality !== undefined) {
    const options = await readQualityOptions(invocation.adapter.client, application);
    quality = matchOption(options, changes.quality);
    if (quality === undefined) {
      return {
        ok: false,
        error: invalid(invocation, `this instance defines no quality named “${changes.quality}”`),
      };
    }
    observe("quality", quality);
  }

  let languages: NamedOption[] | undefined;
  if (changes.languages !== undefined) {
    const options = await readLanguageOptions(invocation.adapter.client, application);
    languages = [];
    for (const name of changes.languages) {
      const matched = matchOption(options, name);
      if (matched === undefined) {
        return {
          ok: false,
          // Named, because a call listing several languages has to say which of
          // them the instance did not recognize.
          error: invalid(invocation, `this instance knows no language named “${name}”`),
        };
      }
      languages.push(matched);
      observe("language", matched);
    }
  }

  return {
    ok: true,
    value: {
      changes: {
        ...(quality === undefined ? {} : { quality }),
        ...(languages === undefined ? {} : { languages }),
        ...(changes.releaseGroup === undefined ? {} : { releaseGroup: changes.releaseGroup }),
      },
      observations,
    },
  };
}

/**
 * Validates a file-metadata update or a file deletion before anything is sent.
 *
 * The grouping check runs before any write is prepared, so a call that upstream
 * could not process safely reaches no request at all — not even for the files
 * that would have been fine on their own.
 */
async function readFilePreconditions(
  invocation: OperationInvocation,
  application: MediaApplication,
  intent: Extract<LibraryChangeIntent, { intent: "update_file_metadata" | "delete_file" }>,
): Promise<PreconditionRead> {
  const read = await readFiles(
    invocation,
    application,
    intent.files,
    intent.intent === "delete_file" ? "identity" : "metadata",
  );
  const grouping = checkSingleParent(invocation, read.selected);
  if (grouping !== undefined) {
    return blocked(grouping);
  }

  let resolved: ResolvedFileChanges = { changes: {}, observations: [] };
  if (intent.intent === "update_file_metadata") {
    const changes = await readFileChanges(invocation, application, intent.changes);
    if (!changes.ok) {
      return blocked(changes.error);
    }
    resolved = changes.value;
  }

  const requests = new Map<string, PendingRequest>();
  const items = read.items.map((item): SelectedItem => {
    const file = read.selected.find((candidate) => candidate.reference === item.reference);
    if (item.error !== undefined || file === undefined) {
      return item;
    }

    const path = fileResourcePath(file.kind, file.id);
    if (intent.intent === "delete_file") {
      if (!requests.has(path)) {
        requests.set(path, {
          path,
          send: (client) => deleteFileResource(client, file.kind, file.id),
        });
      }
      return { ...item, requestPath: path };
    }

    const rewrite = rewriteFileResource(file.resource, resolved.changes);
    if (rewrite.status === "blocked") {
      const failure = conflict(invocation, rewrite.reason);
      return { ...item, error: failure, observation: unreadable(failure) };
    }
    if (!rewrite.changed) {
      return {
        ...item,
        warnings: ["this file already matched the requested metadata; nothing was sent for it"],
      };
    }
    if (!requests.has(path)) {
      requests.set(path, {
        path,
        send: (client) => writeResource(client, path, rewrite.resource),
      });
    }
    return { ...item, requestPath: path };
  });

  const scope = describeSelection(items, "file");
  const context: RequestsContext = {
    kind: contextKind,
    form: "requests",
    intent: intent.intent,
    items,
    requests: [...requests.values()],
    warnings:
      intent.intent === "delete_file"
        ? ["the selected files are deleted from disk by this change"]
        : [],
    effects:
      intent.intent === "delete_file"
        ? [effect(application, `delete ${scope} from disk`, "destructive")]
        : fileChangeEffects(application, intent.changes, scope),
  };

  return {
    status: "ok",
    validated: context,
    observations: [...resolved.observations, ...itemObservationsFor("file", items)],
  };
}

/** One effect per named file-metadata change, for the same reason records get one. */
function fileChangeEffects(
  application: MediaApplication,
  changes: Extract<LibraryChangeIntent, { intent: "update_file_metadata" }>["changes"],
  scope: string,
): readonly Effect[] {
  const effects: Effect[] = [];
  if (changes.quality !== undefined) {
    effects.push(effect(application, `set the recorded quality of ${scope} to ${changes.quality}`));
  }
  if (changes.languages !== undefined) {
    effects.push(effect(application, `set the recorded languages of ${scope}`));
  }
  if (changes.releaseGroup !== undefined) {
    effects.push(effect(application, `set the recorded release group of ${scope}`));
  }
  return effects;
}

/* -------------------------------------------------------------------------- */
/* rename and move_media                                                       */
/* -------------------------------------------------------------------------- */

/** The records whose files an instance will propose a rename for. */
const renamableKinds: readonly MediaRecordKind[] = ["series", "season", "movie"];

/** The records that own a folder of their own, and so can be moved. */
const movableKinds: readonly MediaRecordKind[] = ["series", "movie"];

/**
 * The most files one rename may cover.
 *
 * Two constraints meet here and only one ceiling satisfies both. An apply may
 * touch only files its plan disclosed, so the disclosure cannot be truncated —
 * a preview that listed twenty of two hundred paths and then renamed all two
 * hundred would be a preview in name only. And a result has to stay bounded, so
 * the disclosure cannot be unlimited either. So a record with more files than
 * this is refused, with the narrower selection that will fit, rather than
 * previewed in part. The ceiling is the one every other bulk mutation is bounded
 * by, because it answers the same question about the same kind of result.
 */
const maxRenameProposals = maxBulkItems;

/**
 * Names every rename a preview proposes.
 *
 * The paths come from the instance rather than from a caller, and disclosing
 * them is the whole point of a preview. The list is complete because
 * {@link maxRenameProposals} already refused anything that would not fit: what
 * an apply sends is exactly what this listed.
 */
function describeProposals(proposals: readonly RenameProposal[]): readonly string[] {
  return proposals.map((proposal) => {
    const from = proposal.existingPath ?? "a path this instance did not report";
    const to = proposal.newPath ?? "a path this instance did not report";
    return `rename ${from} to ${to}`;
  });
}

/**
 * Reads what a rename would do, without renaming anything.
 *
 * This reader *is* the preview: it asks the instance for the paths it proposes
 * and fingerprints exactly those, and the apply then sends the file identifiers
 * that came back here. A rename therefore cannot reach a file the plan did not
 * disclose, and a file that changed underneath the plan makes it stale.
 */
async function readRenamePreconditions(
  invocation: OperationInvocation,
  application: MediaApplication,
  intent: Extract<LibraryChangeIntent, { intent: "rename" }>,
): Promise<PreconditionRead> {
  const identity = resolveMediaIdentity(invocation, intent.media, "media");
  if (!identity.ok) {
    return blocked(identity.error);
  }
  const checked = checkItemKind(invocation, application, renamableKinds, identity.value.kind);
  if (!checked.ok) {
    return blocked(checked.error);
  }

  const parentKind = checked.value === "season" ? "series" : checked.value;
  const resource = await readRecordResource(
    invocation.adapter.client,
    application,
    parentKind,
    identity.value.id,
  );
  const proposals = await readRenameProposals(invocation.adapter.client, application, {
    kind: parentKind,
    id: identity.value.id,
    seasonNumber: identity.value.seasonNumber,
  });
  if (proposals.length > maxRenameProposals) {
    return blocked(
      invalid(
        invocation,
        `this instance proposes ${proposals.length} renames for that selection and one call may disclose at most ${maxRenameProposals}${
          application === "sonarr" && identity.value.seasonNumber === undefined
            ? "; select a single season instead"
            : ""
        }`,
      ),
    );
  }

  const title = typeof resource.title === "string" ? resource.title : "the selected record";
  const scope = `${proposals.length} file(s)`;
  const context: CommandContext = {
    kind: contextKind,
    form: "command",
    intent: "rename",
    reference: intent.media,
    workflow: "rename_files",
    ...(proposals.length === 0
      ? {}
      : {
          payload: renameCommandPayload(
            application,
            identity.value.id,
            proposals.map((proposal) => proposal.fileId),
          ),
        }),
    warnings: [
      ...(proposals.length === 0
        ? ["this instance proposes no rename for the selected record"]
        : describeProposals(proposals)),
    ],
    effects:
      proposals.length === 0
        ? []
        : [effect(application, `rename ${scope} of “${title}” on disk`, "destructive")],
  };

  return {
    status: "ok",
    validated: context,
    observations: [
      { key: `media:${intent.media}`, value: recordPathState(resource, "record") },
      {
        key: `rename:${intent.media}`,
        // Every proposal is fingerprinted, in the order the instance returned
        // them, because the plan disclosed exactly these paths and the apply
        // sends exactly these file identifiers.
        value: proposals.map((proposal) => [
          proposal.fileId,
          proposal.existingPath,
          proposal.newPath,
        ]),
      },
    ],
  };
}

/**
 * Validates a move before anything is moved.
 *
 * Neither path in the command is caller-authored: the source is where the
 * instance says the record is now, and the destination is a root folder from
 * the instance's own list. A record already under that root asks for nothing,
 * which is reported rather than sent — a move command for a record that is
 * already there is work an instance does not need to be given.
 */
async function readMovePreconditions(
  invocation: OperationInvocation,
  application: MediaApplication,
  intent: Extract<LibraryChangeIntent, { intent: "move_media" }>,
): Promise<PreconditionRead> {
  const identity = resolveMediaIdentity(invocation, intent.media, "media");
  if (!identity.ok) {
    return blocked(identity.error);
  }
  const checked = checkItemKind(invocation, application, movableKinds, identity.value.kind);
  if (!checked.ok) {
    return blocked(checked.error);
  }

  const dependencies = await readDependencies(invocation, application, [
    { token: intent.rootFolder, kind: "root_folder", property: "rootFolder" },
  ]);
  if (!dependencies.ok) {
    return blocked(dependencies.error);
  }
  const destination = dependencies.value[0]?.record.name;
  if (destination === undefined) {
    return blocked(conflict(invocation, "this instance reported no usable root folder"));
  }

  const resource = await readRecordResource(
    invocation.adapter.client,
    application,
    checked.value,
    identity.value.id,
  );
  const sourcePath = typeof resource.path === "string" ? resource.path.trim() : "";
  if (sourcePath === "") {
    return blocked(
      conflict(invocation, "this record reports no current path, so it cannot be moved"),
    );
  }

  // The destination is composed the same way a root-folder edit composes one, so
  // a move and a re-point cannot disagree about where the record ends up. A
  // record already at that path asks for nothing.
  const destinationPath = relocatePath(sourcePath, destination);
  if (destinationPath === undefined) {
    return blocked(conflict(invocation, "this record's current path names no folder to move"));
  }
  const settled = destinationPath === sourcePath;
  const title = typeof resource.title === "string" ? resource.title : "the selected record";
  const context: CommandContext = {
    kind: contextKind,
    form: "command",
    intent: "move_media",
    reference: intent.media,
    workflow: "move_record",
    ...(settled
      ? {}
      : {
          payload: moveCommandPayload(application, {
            recordId: identity.value.id,
            sourcePath,
            destinationPath,
          }),
        }),
    warnings: settled
      ? ["this record is already under the selected root folder; nothing was sent for it"]
      : [
          "the application moves this record's files on disk; the move runs as a background command and the returned job reports its progress",
        ],
    effects: settled
      ? []
      : [
          effect(
            application,
            `move the files of “${title}” to the selected root folder`,
            "destructive",
          ),
        ],
  };

  return {
    status: "ok",
    validated: context,
    observations: [
      ...dependencyObservations(dependencies.value),
      { key: `media:${intent.media}`, value: recordPathState(resource, "location") },
    ],
  };
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
    case "delete_media":
      return readDeletePreconditions(invocation, application.value, intent.value);
    case "update_file_metadata":
    case "delete_file":
      return readFilePreconditions(invocation, application.value, intent.value);
    case "rename":
      return readRenamePreconditions(invocation, application.value, intent.value);
    case "move_media":
      return readMovePreconditions(invocation, application.value, intent.value);
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
  /**
   * How many upstream writes were actually dispatched.
   *
   * Counted rather than inferred, because it is the one thing that decides
   * whether this mutation may be recorded as never having happened. "Every
   * item reported an error" does not decide it: a single record whose write
   * timed out produces exactly that, and the request was sent.
   */
  readonly dispatched: number;
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
  let dispatched = 0;

  for (const write of context.writes) {
    if (!write.changed) {
      continue;
    }
    dispatched += 1;
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

  return { outcomes, unresolved, dispatched };
}

/**
 * Sends one request per selected file or record and reports each item's own
 * outcome.
 *
 * The same division as {@link applyItems}: the request is per resource and the
 * outcome is per item, because two references can name one resource and both of
 * them succeeded or failed exactly as its one request did.
 */
async function applyRequests(
  invocation: OperationInvocation,
  application: MediaApplication,
  context: RequestsContext,
): Promise<AppliedItems> {
  const failures = new Map<string, ToolError>();
  let unresolved: ToolError | undefined;
  let dispatched = 0;

  for (const request of context.requests) {
    dispatched += 1;
    try {
      await request.send(invocation.adapter.client);
    } catch (error) {
      const failure = toolErrorForThrown(error, application);
      failures.set(request.path, failure);
      if (unresolved === undefined && !toolErrorProvesNoEffect(failure.code)) {
        unresolved = failure;
      }
    }
  }

  const outcomes = context.items.map((item) => {
    if (item.error !== undefined) {
      return itemOutcome(item.reference, item.error, []);
    }
    const failure = item.requestPath === undefined ? undefined : failures.get(item.requestPath);
    return itemOutcome(item.reference, failure, failure === undefined ? (item.warnings ?? []) : []);
  });

  return { outcomes, unresolved, dispatched };
}

/**
 * Whether this apply can be recorded as never having happened.
 *
 * Both halves are needed: no upstream request was dispatched at all, and every
 * selection failed before one could be. "Every item errored" alone is equally
 * true of a single resource whose write timed out, and recording that as
 * unattempted would turn "we may have written and do not know" into "we
 * definitely did not", which is the one direction a receipt must never round in.
 */
function unattemptedFailure(applied: AppliedItems): ToolError | undefined {
  return applied.dispatched === 0 &&
    applied.outcomes.length > 0 &&
    applied.outcomes.every((item) => item.status === "error")
    ? applied.outcomes[0]?.error
    : undefined;
}

/**
 * Runs one allowlisted command, or reports that there was nothing to run.
 *
 * The payload was built by the precondition reader from what it read, so what
 * is sent here is exactly what the plan disclosed. An accepted command becomes a
 * job the caller can follow; one the instance acknowledged with nothing leaves
 * the receipt reconcilable rather than reporting a command nothing confirmed.
 */
async function applyCommand(
  invocation: OperationInvocation,
  application: MediaApplication,
  context: CommandContext,
): Promise<OperationOutcome> {
  if (context.payload === undefined) {
    return { status: "ok", items: [itemOutcome(context.reference, undefined, context.warnings)] };
  }

  const accepted: CommandAcceptance | undefined = await startCommand(
    invocation.adapter.client,
    application,
    context.workflow,
    context.payload,
  );
  if (accepted === undefined) {
    return {
      status: "ok",
      effects: context.effects,
      warnings: context.warnings,
      outcomeUnknown: conflict(
        invocation,
        "the command was sent but the instance returned nothing to confirm it",
      ),
    };
  }

  const job = invocation.state.jobs.project({
    application,
    command: { name: accepted.name, upstreamId: String(accepted.upstreamId) },
    observation: { state: accepted.state },
    cancellation: { supported: false },
  });

  return {
    status: "ok",
    effects: context.effects,
    warnings: context.warnings,
    items: [itemOutcome(context.reference, undefined, [])],
    job: job.reference,
  };
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
 * Plan disclosure for the intents that send one request per selected thing.
 *
 * Predicting nothing when no request is prepared is the same rule the record
 * intents keep: an apply would send nothing, and predicting the effect anyway
 * would overstate what the plan is going to do.
 */
function planForRequests(context: RequestsContext): {
  requestedEffects: readonly Effect[];
  predictedEffects: readonly Effect[];
  warnings: readonly string[];
} {
  const failing = context.items.filter((item) => item.error !== undefined).length;
  return {
    requestedEffects: context.effects,
    predictedEffects: context.requests.length === 0 ? [] : context.effects,
    warnings: [
      ...context.warnings,
      ...(context.requests.length === 0 ? ["nothing in this selection needs to be sent"] : []),
      ...(failing === 0
        ? []
        : [`${failing} selected item(s) cannot be changed; see the per-item outcomes`]),
    ],
  };
}

function plannedItems(context: RequestsContext): readonly ItemOutcome[] {
  return context.items.map((item) =>
    itemOutcome(item.reference, item.error, item.error === undefined ? (item.warnings ?? []) : []),
  );
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

  if (context.form === "add") {
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

  if (context.form === "command") {
    if (invocation.mode === "plan") {
      return {
        status: "ok",
        plan: {
          requestedEffects: context.effects,
          // The preview is the read this plan rests on, so what it found is
          // what an apply will do; nothing further has to be conditioned.
          predictedEffects: context.effects,
          warnings: context.warnings,
        },
        items: [itemOutcome(context.reference, undefined, [])],
      };
    }
    return applyCommand(invocation, application.value, context);
  }

  if (context.form === "requests") {
    if (invocation.mode === "plan") {
      return { status: "ok", plan: planForRequests(context), items: plannedItems(context) };
    }

    const sent = await applyRequests(invocation, application.value, context);
    const unattempted = unattemptedFailure(sent);
    return {
      status: "ok",
      items: sent.outcomes,
      effects: context.effects,
      warnings: context.warnings,
      ...(sent.unresolved === undefined ? {} : { outcomeUnknown: sent.unresolved }),
      ...(unattempted === undefined ? {} : { unattempted }),
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
  const unattempted = unattemptedFailure(applied);

  return {
    status: "ok",
    items: applied.outcomes,
    effects: context.effects,
    warnings: context.warnings,
    ...(applied.unresolved === undefined ? {} : { outcomeUnknown: applied.unresolved }),
    ...(unattempted === undefined ? {} : { unattempted }),
  };
};
