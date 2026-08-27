import type {
  ApplicationAdapter,
  ApplicationCapability,
  UpstreamFailure,
} from "../adapters/registry.js";
import { meetsMinimumVersion } from "../adapters/version.js";
import type { ApplicationId } from "../applications.js";
import type { PlanRecord, PreconditionRead } from "../state/plans.js";
import type { WorkflowState } from "../state/workflow.js";
import {
  releaseGrabHandler,
  releaseGrabPreconditions,
  releaseSearchHandler,
  searchStartHandler,
  searchStartPreconditions,
} from "./acquisition.js";
import { activityQueryHandler } from "./activity.js";
import { activityChangeHandler, activityChangePreconditions } from "./activity-change.js";
import { configReconcileHandler, configReconcilePreconditions } from "./config-reconcile.js";
import { configObserveHandler } from "./configuration.js";
import { createToolError, type ToolError } from "./errors.js";
import { jobCancelHandler, jobCancelPreconditions, jobGetHandler } from "./jobs.js";
import { libraryQueryHandler } from "./library.js";
import { libraryChangeHandler, libraryChangePreconditions } from "./library-change.js";
import type { ProjectedToolName, ToolName } from "./names.js";
import { queueResolveHandler, queueResolvePreconditions } from "./queue-resolve.js";
import type { Effect, ItemOutcome } from "./results.js";
import type { Continuation } from "./schemas/common.js";

/**
 * How consequential an operation is. The classification drives the honest MCP
 * annotations on the tool that exposes it and the effects a plan must
 * disclose; it is not a substitute for runtime validation.
 */
export const operationSideEffects = [
  "read",
  "external",
  "start_job",
  "mutate",
  "destructive",
] as const;

export type OperationSideEffect = (typeof operationSideEffects)[number];

/**
 * How the caller asked for the operation to run. Read operations have no mode
 * of their own; mutation tools pass the caller's `mode` straight through.
 */
export type OperationMode = "read" | "plan" | "apply";

export interface OperationInvocation {
  readonly application: ApplicationId;
  readonly adapter: ApplicationAdapter;
  readonly mode: OperationMode;
  /**
   * The tool arguments, already validated against that tool's closed input
   * schema. The public schema is the type authority; a handler narrows to its
   * own variant rather than re-deriving one from a free-form bag.
   *
   * When the caller applied a recorded plan, this is the plan's stored intent
   * with the resupplied transient secrets merged back in, so a handler never
   * has to know which of the two apply forms the caller used.
   */
  readonly input: unknown;
  /** The process-local stores; the only mutable state a handler may touch. */
  readonly state: WorkflowState;
  /** Set when this invocation is applying a recorded plan. */
  readonly plan?: PlanRecord | undefined;
  /**
   * What this operation's own {@link OperationDefinition.readPreconditions}
   * reader resolved for this call, or `undefined` for an operation with no
   * reader. A handler that needs current state receives the state that was just
   * validated rather than re-reading it, so nothing can change between the
   * check and the write.
   */
  readonly validated?: unknown;
}

/**
 * What plan mode discloses.
 *
 * The read-set is not here: the runtime obtains it from the operation's own
 * {@link OperationDefinition.readPreconditions} reader, so the same reader
 * produces the fingerprints a plan stores and the fingerprints a later apply is
 * compared against. A handler cannot accidentally fingerprint one thing and
 * validate another.
 */
export interface OperationPlan {
  readonly requestedEffects: readonly Effect[];
  /** Effects that follow only if the conditions the plan describes still hold. */
  readonly predictedEffects: readonly Effect[];
  readonly warnings?: readonly string[];
}

export type OperationOutcome =
  | {
      readonly status: "ok";
      readonly data?: unknown;
      readonly warnings?: readonly string[];
      readonly items?: readonly ItemOutcome[];
      readonly continuation?: Continuation;
      /** Required in plan mode; the runtime records it and mints the reference. */
      readonly plan?: OperationPlan;
      /** The job reference this mutation started, when it started one. */
      readonly job?: string;
      /** Effects an apply actually requested, disclosed alongside the result. */
      readonly effects?: readonly Effect[];
      /**
       * Set when the mutation ran but this server could not establish what it
       * did — a lost answer, or an upstream request whose acknowledgement never
       * arrived. The receipt then settles as outcome-unknown instead of
       * succeeded, so a caller is never told a mutation succeeded that nothing
       * confirmed, and the record stays reconcilable against upstream state.
       */
      readonly outcomeUnknown?: ToolError;
      /**
       * Set when the handler can show that the call had no effect, and says why.
       *
       * The receipt then settles as `failed` — the one state a later identical
       * attempt may reuse — because recording it as a success would answer that
       * attempt from a receipt for a mutation that never happened, and a
       * transient failure would become permanent for that exact input.
       *
       * "Can show" is the whole of the contract, and there are exactly two ways
       * to show it: no upstream request was dispatched, or one was dispatched
       * and a re-read of the authoritative upstream state established that it
       * did not apply. The second is why this says "had no effect" rather than
       * "was never sent" — a reconciliation that found the record untouched
       * proves the same thing a request never sent does, and proving it is
       * worth more to a caller than leaving it unknown.
       *
       * What a handler may never do is infer either from an aggregate of item
       * failures, which is equally true of a single write that timed out, or
       * set this while any selection succeeded — settling the receipt as
       * retryable would then licence re-sending the write that did land.
       * Reporting a mutation that may have applied as one that certainly did
       * not is the one direction a receipt must never round in, so where this
       * and {@link outcomeUnknown} disagree, the unknown outcome wins.
       */
      readonly unattempted?: ToolError;
    }
  | {
      readonly status: "error";
      readonly error: ToolError;
      /**
       * The per-item outcomes behind a failure, for a bulk operation in which
       * every item failed. The call as a whole did fail — so the receipt
       * settles from `error` and a retry stays open — but the reasons still
       * belong to the items that produced them, and collapsing them into one
       * error would conceal a mixed set of failures behind whichever one came
       * first.
       */
      readonly items?: readonly ItemOutcome[];
    };

/**
 * Reads the current values a plan's validity depends on.
 *
 * One reader serves three purposes: it supplies the read set a plan
 * fingerprints, it is re-run before a planned apply so a changed value produces
 * `stale_plan`, and it is the immediate current-state validation a direct apply
 * performs before sending anything upstream. An operation with no reader
 * declares that nothing it depends on can change underneath it.
 */
export type PreconditionReader = (invocation: OperationInvocation) => Promise<PreconditionRead>;

export type OperationHandler = (invocation: OperationInvocation) => Promise<OperationOutcome>;

interface OperationBlueprint<TId extends string> {
  readonly id: TId;
  /**
   * The public tool that exposes this operation. Typed as a projected name so
   * the meta tool cannot be declared here: `arr_capabilities` reports this
   * inventory and is never an entry in it.
   */
  readonly tool: ProjectedToolName;
  /**
   * The public discriminator value that reaches this operation, or `undefined`
   * for a tool whose input carries no variant. This is the projection that
   * lets `arr_capabilities` answer "which tool call works here" without ever
   * revealing or accepting an internal identifier.
   */
  readonly variant: string | undefined;
  readonly applications: readonly ApplicationId[];
  /**
   * Per-application minimum versions, used only where an operation needs a
   * newer release than the application's own recorded minimum. An absent entry
   * means the application's recorded minimum is sufficient.
   */
  readonly minimumVersions: Readonly<Partial<Record<ApplicationId, string>>>;
  readonly sideEffect: OperationSideEffect;
  /**
   * Whether the operation has to reach the instance to answer.
   *
   * Job projection is process-local, so reading a job this server already
   * observed — or reporting that its reference no longer resolves — is
   * answerable with the instance switched off. Probing first would turn that
   * local read into an `unavailable_application` error and hide the terminal
   * snapshot the caller asked for.
   */
  readonly upstream: OperationUpstreamNeed;
  readonly handler: OperationHandler;
  readonly readPreconditions: PreconditionReader | undefined;
}

export type OperationUpstreamNeed = "required" | "local_first";

interface DefineOptions {
  readonly minimumVersions?: Readonly<Partial<Record<ApplicationId, string>>>;
  readonly handler?: OperationHandler;
  readonly readPreconditions?: PreconditionReader;
  readonly upstream?: OperationUpstreamNeed;
}

/**
 * The handler every operation starts with. Changes 0003 through 0010 replace
 * these one at a time; until then the tool surface is fully published and fully
 * validated, and a call that survives validation is honestly reported as not
 * yet implemented rather than silently succeeding.
 */
export const unsupportedOperationHandler: OperationHandler = ({ application }) =>
  Promise.resolve({
    status: "error",
    error: createToolError({
      code: "unsupported_capability",
      message: `${application}: this operation is declared but not implemented yet`,
      application,
    }),
  });

/**
 * Whether an operation has real adapter behavior yet.
 *
 * Derived from the handler rather than a flag, so an operation becomes
 * implemented exactly when its change supplies a handler and there is no
 * separate marker to forget to flip. `arr_capabilities` uses this so it never
 * advertises an operation that would answer `unsupported_capability`.
 */
export function isImplementedOperation(operation: OperationDefinition): boolean {
  return operation.handler !== unsupportedOperationHandler;
}

function define<const TId extends string>(
  id: TId,
  tool: ProjectedToolName,
  variant: string | undefined,
  applications: readonly ApplicationId[],
  sideEffect: OperationSideEffect,
  options: DefineOptions = {},
): OperationBlueprint<TId> {
  return {
    id,
    tool,
    variant,
    applications,
    minimumVersions: options.minimumVersions ?? {},
    sideEffect,
    upstream: options.upstream ?? "required",
    handler: options.handler ?? unsupportedOperationHandler,
    readPreconditions: options.readPreconditions,
  };
}

/**
 * Every `arr_library_query` view runs the same handler; the view it answers is
 * carried by the caller's own discriminator, which the handler re-validates
 * against the published schema rather than taking from this table.
 */
const libraryQuery: DefineOptions = { handler: libraryQueryHandler };

/**
 * Every `arr_config_observe` domain runs the same handler, for the same reason
 * the library views do: the domain is carried by the caller's own
 * discriminator, which the handler re-validates against the published schema.
 */
const configObserve: DefineOptions = { handler: configObserveHandler };

/**
 * Every implemented `arr_config_reconcile` intent runs the same handler behind
 * the same precondition reader, for the reason the library and activity
 * mutations do: pairing them here rather than per variant is what makes a
 * desired-state write unreachable without the reader that resolves its target,
 * validates every pointer it names, and builds the resource it would send.
 *
 * The three deletions carry neither. Deleting a referenced resource needs the
 * dependent-migration behaviour the spec describes, no task of this change
 * built it, and an intent registered with the handler and without that would
 * delete without the check that makes deleting safe.
 */
const configReconcile: DefineOptions = {
  handler: configReconcileHandler,
  readPreconditions: configReconcilePreconditions,
};

/**
 * Every `arr_release_search` target runs the same handler, for the same reason
 * the library views do: the target is carried by the caller's own discriminator,
 * which the handler re-validates against the published schema.
 */
const releaseSearch: DefineOptions = { handler: releaseSearchHandler };

/**
 * Every implemented `arr_library_change` intent runs the same handler behind
 * the same precondition reader. Pairing them here rather than per variant is
 * what makes a mutation unreachable without its current-state validation: an
 * intent registered with the handler and without the reader would apply
 * against state nothing had checked.
 */
const libraryChange: DefineOptions = {
  handler: libraryChangeHandler,
  readPreconditions: libraryChangePreconditions,
};

/**
 * Both `arr_activity_change` intents run the same handler behind the same
 * precondition reader, for the reason the library mutations do: pairing them
 * here rather than per variant is what makes either mutation unreachable
 * without the current-state validation that re-reads the record it names.
 */
const activityChange: DefineOptions = {
  handler: activityChangeHandler,
  readPreconditions: activityChangePreconditions,
};

/**
 * Every `arr_queue_resolve` intent runs the same handler behind the same
 * precondition reader, for the reason the library and activity mutations do:
 * pairing them here rather than per variant is what makes a queue transition
 * unreachable without the current-state validation it is compiled from.
 *
 * The pairing matters more here than anywhere else on this surface. The reader
 * re-reads each selected row and compiles its transition from what it just
 * read, and the handler sends exactly what the reader compiled — so an intent
 * registered with the handler and without the reader would send a request built
 * from nothing, against rows nobody had checked, for the operations that delete
 * downloads and their payload data.
 *
 * How consequential each intent is stays per intent in the table below rather
 * than being shared across the union: two of them ask a download client to
 * delete data and are declared `destructive`, one starts a download and is
 * declared `start_job`, and the rest change only what the application tracks.
 * `arr_capabilities` reports that classification per intent, so a caller can
 * tell them apart before it calls one.
 */
const queueResolve: DefineOptions = {
  handler: queueResolveHandler,
  readPreconditions: queueResolvePreconditions,
};

/**
 * Every `arr_search_start` target runs the same handler and the same
 * precondition reader; which command a target compiles to is decided by the
 * adapter's own closed table, never by this one.
 */
const searchStart: DefineOptions = {
  handler: searchStartHandler,
  readPreconditions: searchStartPreconditions,
};

/**
 * Every `arr_activity_query` view runs the same handler, for the same reason:
 * the view is carried by the caller's own discriminator, which the handler
 * re-validates against the published schema.
 */
const activityQuery: DefineOptions = { handler: activityQueryHandler };

const every = ["sonarr", "radarr", "prowlarr"] as const;
const media = ["sonarr", "radarr"] as const;
const sonarr = ["sonarr"] as const;
const radarr = ["radarr"] as const;
const prowlarr = ["prowlarr"] as const;

/**
 * The internal semantic operation inventory.
 *
 * This table is a policy source, not a surface: it is never published as a
 * tool, and no public schema accepts one of its identifiers. It exists so that
 * variant registration, adapter dispatch, version gating, and capability
 * projection all read the same list instead of drifting apart.
 */
const definitions = [
  // arr_library_query
  define("library.query.series", "arr_library_query", "series", sonarr, "read", libraryQuery),
  define("library.query.seasons", "arr_library_query", "seasons", sonarr, "read", libraryQuery),
  define("library.query.episodes", "arr_library_query", "episodes", sonarr, "read", libraryQuery),
  define(
    "library.query.episode_files",
    "arr_library_query",
    "episode_files",
    sonarr,
    "read",
    libraryQuery,
  ),
  define(
    "library.query.missing_episodes",
    "arr_library_query",
    "missing_episodes",
    sonarr,
    "read",
    libraryQuery,
  ),
  define(
    "library.query.cutoff_unmet_episodes",
    "arr_library_query",
    "cutoff_unmet_episodes",
    sonarr,
    "read",
    libraryQuery,
  ),
  define("library.query.movies", "arr_library_query", "movies", radarr, "read", libraryQuery),
  define(
    "library.query.collections",
    "arr_library_query",
    "collections",
    radarr,
    "read",
    libraryQuery,
  ),
  define(
    "library.query.movie_files",
    "arr_library_query",
    "movie_files",
    radarr,
    "read",
    libraryQuery,
  ),
  define(
    "library.query.missing_movies",
    "arr_library_query",
    "missing_movies",
    radarr,
    "read",
    libraryQuery,
  ),
  define(
    "library.query.cutoff_unmet_movies",
    "arr_library_query",
    "cutoff_unmet_movies",
    radarr,
    "read",
    libraryQuery,
  ),
  define("library.query.calendar", "arr_library_query", "calendar", media, "read", libraryQuery),
  define("library.query.lookup", "arr_library_query", "lookup", media, "read", libraryQuery),

  // arr_activity_query
  define(
    "activity.query.queue_status",
    "arr_activity_query",
    "queue_status",
    media,
    "read",
    activityQuery,
  ),
  define("activity.query.queue", "arr_activity_query", "queue", media, "read", activityQuery),
  define(
    "activity.query.queue_details",
    "arr_activity_query",
    "queue_details",
    media,
    "read",
    activityQuery,
  ),
  define("activity.query.history", "arr_activity_query", "history", every, "read", activityQuery),
  define(
    "activity.query.blocklist",
    "arr_activity_query",
    "blocklist",
    media,
    "read",
    activityQuery,
  ),
  define("activity.query.health", "arr_activity_query", "health", every, "read", activityQuery),
  define("activity.query.commands", "arr_activity_query", "commands", every, "read", activityQuery),
  define(
    "activity.query.disk_space",
    "arr_activity_query",
    "disk_space",
    media,
    "read",
    activityQuery,
  ),
  define(
    "activity.query.indexer_status",
    "arr_activity_query",
    "indexer_status",
    prowlarr,
    "read",
    activityQuery,
  ),
  define(
    "activity.query.indexer_statistics",
    "arr_activity_query",
    "indexer_statistics",
    prowlarr,
    "read",
    activityQuery,
  ),

  // arr_release_search
  define(
    "release.search.sonarr_episode",
    "arr_release_search",
    "sonarr_episode",
    sonarr,
    "external",
    releaseSearch,
  ),
  define(
    "release.search.sonarr_season",
    "arr_release_search",
    "sonarr_season",
    sonarr,
    "external",
    releaseSearch,
  ),
  define(
    "release.search.radarr_movie",
    "arr_release_search",
    "radarr_movie",
    radarr,
    "external",
    releaseSearch,
  ),
  define(
    "release.search.prowlarr_aggregate",
    "arr_release_search",
    "prowlarr_aggregate",
    prowlarr,
    "external",
    releaseSearch,
  ),

  // arr_import_inspect
  define("import.inspect.queue_item", "arr_import_inspect", "queue_item", media, "read"),
  define("import.inspect.library_context", "arr_import_inspect", "library_context", media, "read"),
  define(
    "import.inspect.candidate_reprocess",
    "arr_import_inspect",
    "candidate_reprocess",
    media,
    "read",
  ),

  // arr_config_observe
  define("config.observe.indexers", "arr_config_observe", "indexers", every, "read", configObserve),
  define(
    "config.observe.download_clients",
    "arr_config_observe",
    "download_clients",
    every,
    "read",
    configObserve,
  ),
  define(
    "config.observe.applications",
    "arr_config_observe",
    "applications",
    prowlarr,
    "read",
    configObserve,
  ),
  define(
    "config.observe.notifications",
    "arr_config_observe",
    "notifications",
    every,
    "read",
    configObserve,
  ),
  define(
    "config.observe.import_lists",
    "arr_config_observe",
    "import_lists",
    media,
    "read",
    configObserve,
  ),
  define("config.observe.metadata", "arr_config_observe", "metadata", media, "read", configObserve),
  define("config.observe.proxies", "arr_config_observe", "proxies", every, "read", configObserve),
  define(
    "config.observe.quality_profiles",
    "arr_config_observe",
    "quality_profiles",
    media,
    "read",
    configObserve,
  ),
  define(
    "config.observe.custom_formats",
    "arr_config_observe",
    "custom_formats",
    media,
    "read",
    configObserve,
  ),
  define(
    "config.observe.release_profiles",
    "arr_config_observe",
    "release_profiles",
    sonarr,
    "read",
    configObserve,
  ),
  define(
    "config.observe.delay_profiles",
    "arr_config_observe",
    "delay_profiles",
    media,
    "read",
    configObserve,
  ),
  define(
    "config.observe.app_profiles",
    "arr_config_observe",
    "app_profiles",
    prowlarr,
    "read",
    configObserve,
  ),
  define("config.observe.tags", "arr_config_observe", "tags", every, "read", configObserve),
  define(
    "config.observe.root_folders",
    "arr_config_observe",
    "root_folders",
    media,
    "read",
    configObserve,
  ),
  define(
    "config.observe.remote_path_mappings",
    "arr_config_observe",
    "remote_path_mappings",
    media,
    "read",
    configObserve,
  ),
  define(
    "config.observe.import_list_exclusions",
    "arr_config_observe",
    "import_list_exclusions",
    media,
    "read",
    configObserve,
  ),

  // arr_job_get
  define("job.get", "arr_job_get", undefined, every, "read", {
    upstream: "local_first",
    handler: jobGetHandler,
  }),

  // arr_search_start
  define(
    "search.start.sonarr_episode",
    "arr_search_start",
    "sonarr_episode",
    sonarr,
    "start_job",
    searchStart,
  ),
  define(
    "search.start.sonarr_season",
    "arr_search_start",
    "sonarr_season",
    sonarr,
    "start_job",
    searchStart,
  ),
  define(
    "search.start.sonarr_series",
    "arr_search_start",
    "sonarr_series",
    sonarr,
    "start_job",
    searchStart,
  ),
  define(
    "search.start.radarr_movie",
    "arr_search_start",
    "radarr_movie",
    radarr,
    "start_job",
    searchStart,
  ),
  define("search.start.missing", "arr_search_start", "missing", media, "start_job", searchStart),
  define(
    "search.start.cutoff_unmet",
    "arr_search_start",
    "cutoff_unmet",
    media,
    "start_job",
    searchStart,
  ),

  // arr_release_grab
  define("release.grab", "arr_release_grab", undefined, every, "start_job", {
    handler: releaseGrabHandler,
    readPreconditions: releaseGrabPreconditions,
  }),

  // arr_queue_resolve
  define(
    "queue.resolve.ignore_tracking",
    "arr_queue_resolve",
    "ignore_tracking",
    media,
    "mutate",
    queueResolve,
  ),
  define(
    "queue.resolve.remove_from_client_and_delete_data",
    "arr_queue_resolve",
    "remove_from_client_and_delete_data",
    media,
    "destructive",
    queueResolve,
  ),
  define(
    "queue.resolve.blocklist_and_remove",
    "arr_queue_resolve",
    "blocklist_and_remove",
    media,
    "destructive",
    queueResolve,
  ),
  define(
    "queue.resolve.change_category_mark_imported",
    "arr_queue_resolve",
    "change_category_mark_imported",
    media,
    "mutate",
    queueResolve,
  ),
  define(
    "queue.resolve.route_to_manual_import",
    "arr_queue_resolve",
    "route_to_manual_import",
    media,
    // Declared `read` because that is what it is: the transition sends no
    // upstream request and changes nothing, answering with the import
    // inspection to perform next. Declaring it `mutate` would have been the
    // safe-looking direction and still a false statement — `arr_capabilities`
    // publishes this per intent, and a caller reading `mutate` would believe
    // the call changes state.
    "read",
    queueResolve,
  ),
  define(
    "queue.resolve.force_pending_grab",
    "arr_queue_resolve",
    "force_pending_grab",
    media,
    "start_job",
    queueResolve,
  ),
  define(
    "queue.resolve.remove_pending",
    "arr_queue_resolve",
    "remove_pending",
    media,
    "mutate",
    queueResolve,
  ),
  define(
    "queue.resolve.blocklist_pending",
    "arr_queue_resolve",
    "blocklist_pending",
    media,
    "mutate",
    queueResolve,
  ),

  // arr_activity_change
  define(
    "activity.change.mark_history_failed",
    "arr_activity_change",
    "mark_history_failed",
    media,
    "mutate",
    activityChange,
  ),
  define(
    "activity.change.remove_blocklist_record",
    "arr_activity_change",
    "remove_blocklist_record",
    media,
    "mutate",
    activityChange,
  ),

  // arr_import_execute
  define("import.execute", "arr_import_execute", undefined, media, "destructive"),

  // arr_library_change
  define(
    "library.change.add_media",
    "arr_library_change",
    "add_media",
    media,
    "mutate",
    libraryChange,
  ),
  define(
    "library.change.set_monitoring",
    "arr_library_change",
    "set_monitoring",
    media,
    "mutate",
    libraryChange,
  ),
  define(
    "library.change.edit_media",
    "arr_library_change",
    "edit_media",
    media,
    "mutate",
    libraryChange,
  ),
  define(
    "library.change.delete_media",
    "arr_library_change",
    "delete_media",
    media,
    "destructive",
    libraryChange,
  ),
  define(
    "library.change.update_file_metadata",
    "arr_library_change",
    "update_file_metadata",
    media,
    "mutate",
    libraryChange,
  ),
  define(
    "library.change.delete_file",
    "arr_library_change",
    "delete_file",
    media,
    "destructive",
    libraryChange,
  ),
  define(
    "library.change.rename",
    "arr_library_change",
    "rename",
    media,
    "destructive",
    libraryChange,
  ),
  define(
    "library.change.move_media",
    "arr_library_change",
    "move_media",
    media,
    "destructive",
    libraryChange,
  ),

  // arr_config_reconcile
  define(
    "config.reconcile.reconcile_provider",
    "arr_config_reconcile",
    "reconcile_provider",
    every,
    "mutate",
    configReconcile,
  ),
  define(
    "config.reconcile.delete_provider",
    "arr_config_reconcile",
    "delete_provider",
    every,
    "destructive",
  ),
  define(
    "config.reconcile.force_provider_save",
    "arr_config_reconcile",
    "force_provider_save",
    every,
    "mutate",
    configReconcile,
  ),
  define(
    "config.reconcile.test_provider",
    "arr_config_reconcile",
    "test_provider",
    every,
    "external",
    configReconcile,
  ),
  define(
    "config.reconcile.reconcile_profile",
    "arr_config_reconcile",
    "reconcile_profile",
    every,
    "mutate",
    configReconcile,
  ),
  define(
    "config.reconcile.delete_profile",
    "arr_config_reconcile",
    "delete_profile",
    every,
    "destructive",
  ),
  define(
    "config.reconcile.reconcile_resource",
    "arr_config_reconcile",
    "reconcile_resource",
    every,
    "mutate",
    configReconcile,
  ),
  define(
    "config.reconcile.delete_resource",
    "arr_config_reconcile",
    "delete_resource",
    every,
    "destructive",
  ),
  // Destructive rather than mutating, because what this intent can do is what a
  // caller has to be told: at full sync it deletes the indexers a mapping no
  // longer selects on the other application. A call that cannot reach that says
  // so in its own plan; the declaration is about the intent, and understating a
  // deletion is the one direction this must not round in.
  define(
    "config.reconcile.reconcile_application_sync",
    "arr_config_reconcile",
    "reconcile_application_sync",
    prowlarr,
    "destructive",
    configReconcile,
  ),

  // arr_job_cancel
  define("job.cancel", "arr_job_cancel", undefined, every, "mutate", {
    upstream: "local_first",
    handler: jobCancelHandler,
    readPreconditions: jobCancelPreconditions,
  }),
] as const;

/** The typed internal identifiers. Never accepted from a caller. */
export type OperationId = (typeof definitions)[number]["id"];

export type OperationDefinition = OperationBlueprint<OperationId>;

export const operationDefinitions: readonly OperationDefinition[] = definitions;

export type OperationSupport =
  | { readonly status: "supported" }
  | { readonly status: "unconfigured" }
  | { readonly status: "unavailable"; readonly failure: UpstreamFailure }
  | {
      readonly status: "unsupported";
      readonly reason: "application" | "version";
      readonly requiredVersion?: string;
    };

/**
 * Decides whether one application can run one operation right now.
 *
 * Application membership is checked before anything version-specific so a
 * request naming an application the operation was never defined for is
 * rejected without probing that instance at all.
 */
export function checkOperationSupport(
  operation: OperationDefinition,
  capability: ApplicationCapability,
): OperationSupport {
  if (!operation.applications.includes(capability.application)) {
    return { status: "unsupported", reason: "application" };
  }
  if (capability.status === "unconfigured") {
    return { status: "unconfigured" };
  }
  if (capability.status === "unavailable") {
    return { status: "unavailable", failure: capability.failure };
  }
  if (capability.status === "unsupported") {
    return { status: "unsupported", reason: "version", requiredVersion: capability.minimumVersion };
  }

  const required = operation.minimumVersions[capability.application];
  if (required !== undefined && !meetsMinimumVersion(capability.version, required)) {
    return { status: "unsupported", reason: "version", requiredVersion: required };
  }
  return { status: "supported" };
}

export interface OperationRegistry {
  readonly operations: readonly OperationDefinition[];
  /**
   * The only lookup the tool layer has. It is keyed by a public tool name and
   * a public variant, so no caller-supplied string can name an internal
   * operation identifier.
   */
  find(tool: ToolName, variant: string | undefined): OperationDefinition | undefined;
  forTool(tool: ToolName): readonly OperationDefinition[];
}

function registryKey(tool: ToolName, variant: string | undefined): string {
  // Escaped rather than embedded: a raw NUL in the source is invisible in an
  // editor and can be stripped by tooling, which would silently let keys
  // collide. No tool name or variant can contain it, so it stays the
  // separator that cannot occur inside either half.
  return `${tool}\u0000${variant ?? ""}`;
}

export function createOperationRegistry(
  operations: readonly OperationDefinition[] = operationDefinitions,
): OperationRegistry {
  const byKey = new Map<string, OperationDefinition>();
  const byTool = new Map<ToolName, OperationDefinition[]>();
  const seenIds = new Set<string>();

  for (const operation of operations) {
    if (seenIds.has(operation.id)) {
      throw new Error(`Duplicate operation id: ${operation.id}`);
    }
    seenIds.add(operation.id);

    const key = registryKey(operation.tool, operation.variant);
    if (byKey.has(key)) {
      throw new Error(`Duplicate operation variant: ${operation.tool}/${operation.variant ?? "-"}`);
    }
    byKey.set(key, operation);

    const existing = byTool.get(operation.tool);
    if (existing === undefined) {
      byTool.set(operation.tool, [operation]);
    } else {
      existing.push(operation);
    }
  }

  return {
    operations,

    find(tool: ToolName, variant: string | undefined): OperationDefinition | undefined {
      return byKey.get(registryKey(tool, variant));
    },

    forTool(tool: ToolName): readonly OperationDefinition[] {
      return byTool.get(tool) ?? [];
    },
  };
}
