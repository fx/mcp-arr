import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import { type ApplicationId, applicationIds } from "../applications.js";
import { capabilitySummary, reportCapabilities } from "./capabilities.js";
import { dispatchOperation, type ToolContext } from "./dispatch.js";
import { type ToolName, toolNames } from "./names.js";
import type { OperationMode } from "./operations.js";
import type { ToolResult, ToolSummary } from "./results.js";
import {
  importExecuteInputSchema,
  importExecuteOutputSchema,
  importInspectInputSchema,
  importInspectOutputSchema,
  releaseGrabInputSchema,
  releaseGrabOutputSchema,
  releaseSearchInputSchema,
  releaseSearchOutputSchema,
  searchStartInputSchema,
  searchStartOutputSchema,
} from "./schemas/acquisition.js";
import {
  activityChangeInputSchema,
  activityChangeOutputSchema,
  activityQueryInputSchema,
  activityQueryOutputSchema,
  queueResolveInputSchema,
  queueResolveOutputSchema,
} from "./schemas/activity.js";
import { capabilitiesInputSchema, capabilitiesOutputSchema } from "./schemas/capabilities.js";
import type { DetailLevel } from "./schemas/common.js";
import { configObserveInputSchema, configObserveOutputSchema } from "./schemas/configuration.js";
import {
  jobCancelInputSchema,
  jobCancelOutputSchema,
  jobGetInputSchema,
  jobGetOutputSchema,
} from "./schemas/jobs.js";
import {
  libraryChangeInputSchema,
  libraryChangeOutputSchema,
  libraryQueryInputSchema,
  libraryQueryOutputSchema,
} from "./schemas/library.js";

export interface ToolDefinition {
  readonly name: ToolName;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: z.ZodType;
  readonly outputSchema: z.ZodType;
  readonly annotations: ToolAnnotations;
  /**
   * The input property that carries the variant, or `undefined` for a tool
   * whose input has no variant. It names a property of this tool's own schema,
   * never a value a caller can redirect.
   */
  readonly discriminator: string | undefined;
  /**
   * How this tool words its text summary, where the envelope's own status
   * cannot say what happened. Absent for every tool whose per-application
   * status already is the domain outcome.
   */
  readonly summary?: ToolSummary;
  handle(context: ToolContext, input: unknown): Promise<ToolResult<unknown>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isApplicationId(value: unknown): value is ApplicationId {
  return typeof value === "string" && (applicationIds as readonly string[]).includes(value);
}

/**
 * Re-narrows a value the tool's own schema already validated.
 *
 * These readers exist so one dispatcher can serve every domain tool without a
 * type assertion: each re-checks the shape at runtime and returns `undefined`
 * rather than trusting the cast, so a schema change can never silently feed
 * dispatch a value it did not expect.
 */
function readVariant(input: unknown, discriminator: string | undefined): string | undefined {
  if (discriminator === undefined || !isRecord(input)) {
    return undefined;
  }
  const value = input[discriminator];
  return typeof value === "string" ? value : undefined;
}

function readApplications(input: unknown): readonly ApplicationId[] | undefined {
  if (!isRecord(input)) {
    return undefined;
  }
  const plural = input.applications;
  if (Array.isArray(plural) && plural.length > 0 && plural.every(isApplicationId)) {
    return plural;
  }
  const singular = input.application;
  return isApplicationId(singular) ? [singular] : undefined;
}

/**
 * Reads the capability report's detail level. Anything other than an explicit
 * `full` leaves the report bounded, so a caller that omits the argument — or a
 * host that drops it — gets the summarized form rather than the enumeration.
 */
function readDetail(input: unknown): DetailLevel | undefined {
  if (!isRecord(input)) {
    return undefined;
  }
  return input.detail === "full" ? "full" : "summary";
}

function readPlanReference(input: unknown): string | undefined {
  if (!isRecord(input)) {
    return undefined;
  }
  const plan = input.plan;
  return typeof plan === "string" ? plan : undefined;
}

function readMode(input: unknown): OperationMode {
  if (!isRecord(input)) {
    return "read";
  }
  if (input.mode === "plan") {
    return "plan";
  }
  return input.mode === "apply" ? "apply" : "read";
}

interface DomainToolOptions {
  readonly name: ToolName;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: z.ZodType;
  readonly outputSchema: z.ZodType;
  readonly annotations: ToolAnnotations;
  readonly discriminator: string | undefined;
}

/**
 * Builds a tool that delegates to the shared dispatcher. Every domain tool goes
 * through this factory so no handler can hand-roll an envelope of its own.
 */
function domainTool(options: DomainToolOptions): ToolDefinition {
  const discriminator = options.discriminator;
  return {
    name: options.name,
    title: options.title,
    description: options.description,
    inputSchema: options.inputSchema,
    outputSchema: options.outputSchema,
    annotations: { title: options.title, ...options.annotations },
    discriminator,

    handle(context: ToolContext, input: unknown): Promise<ToolResult<unknown>> {
      return dispatchOperation(context, {
        tool: options.name,
        variant: readVariant(input, discriminator),
        applications: readApplications(input),
        mode: readMode(input),
        planReference: readPlanReference(input),
        input,
      });
    },
  };
}

const readOnly: ToolAnnotations = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: false,
};

const readOnlyOpenWorld: ToolAnnotations = {
  readOnlyHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

const mutating: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

const destructive: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

export const toolDefinitions: readonly ToolDefinition[] = [
  {
    name: "arr_capabilities",
    title: "Report application capabilities",
    description:
      "Report which configured applications are reachable, which versions they run, and which " +
      "tool variants they support. Unconfigured applications are reported without credentials, " +
      "and one unreachable application never fails the whole report. Operations an instance " +
      "cannot currently run are counted rather than listed unless detail is full.",
    inputSchema: capabilitiesInputSchema,
    outputSchema: capabilitiesOutputSchema,
    annotations: { title: "Report application capabilities", ...readOnly },
    discriminator: undefined,
    summary: capabilitySummary,

    handle(context: ToolContext, input: unknown): Promise<ToolResult<unknown>> {
      return reportCapabilities(context, readApplications(input), readDetail(input));
    },
  },

  domainTool({
    name: "arr_library_query",
    title: "Query the media library",
    description:
      "Read normalized Sonarr and Radarr library state through typed views: series, seasons, " +
      "episodes, movies, collections, media files, missing and cutoff-unmet media, calendar " +
      "entries, and metadata lookup. Results are bounded and a lookup never adds anything.",
    inputSchema: libraryQueryInputSchema,
    outputSchema: libraryQueryOutputSchema,
    annotations: readOnly,
    discriminator: "view",
  }),

  domainTool({
    name: "arr_activity_query",
    title: "Query activity and diagnostics",
    description:
      "Read queue status, queue records and details, history, blocklist, health, command " +
      "activity, disk conditions, and Prowlarr indexer status or sanitized statistics. Queue " +
      "items are returned as opaque references usable by arr_queue_resolve.",
    inputSchema: activityQueryInputSchema,
    outputSchema: activityQueryOutputSchema,
    annotations: readOnly,
    discriminator: "view",
  }),

  domainTool({
    name: "arr_release_search",
    title: "Search for releases",
    description:
      "Run an interactive release search for a Sonarr episode or season, a Radarr movie, or " +
      "across Prowlarr indexers. Results carry opaque release references instead of protected " +
      "download URLs and report per-indexer completeness.",
    inputSchema: releaseSearchInputSchema,
    outputSchema: releaseSearchOutputSchema,
    annotations: readOnlyOpenWorld,
    discriminator: "target",
  }),

  domainTool({
    name: "arr_import_inspect",
    title: "Inspect manual-import candidates",
    description:
      "Discover manual-import candidates from a tracked queue reference or a library context, " +
      "and reprocess a candidate with explicit mapping corrections. Reprocessing validates a " +
      "mapping; it never imports a file, and no filesystem path is accepted.",
    inputSchema: importInspectInputSchema,
    outputSchema: importInspectOutputSchema,
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false },
    discriminator: "source",
  }),

  domainTool({
    name: "arr_config_observe",
    title: "Observe application configuration",
    description:
      "Read sanitized current configuration for providers, profiles, formats, tags, roots, " +
      "remote path mappings, lists, and exclusions. Secret fields are reported as configured " +
      "or unconfigured, never by value.",
    inputSchema: configObserveInputSchema,
    outputSchema: configObserveOutputSchema,
    annotations: readOnly,
    discriminator: "domain",
  }),

  domainTool({
    name: "arr_job_get",
    title: "Read a job projection",
    description:
      "Read the normalized status, progress, upstream command identity, terminal result, and " +
      "per-item outcomes of a job this server projected. A job that has not ended is refreshed " +
      "from its upstream command first; one that has ended is answered from the snapshot this " +
      "server kept. Job references are process-local and do not survive a restart.",
    inputSchema: jobGetInputSchema,
    outputSchema: jobGetOutputSchema,
    annotations: readOnly,
    discriminator: undefined,
  }),

  domainTool({
    name: "arr_search_start",
    title: "Start an automatic search",
    description:
      "Start a supported automatic search for episodes, a season, a series, movies, missing " +
      "media, or cutoff-unmet media, returning a job reference. Reading wanted media is a " +
      "separate query that starts no search.",
    inputSchema: searchStartInputSchema,
    outputSchema: searchStartOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    discriminator: "target",
  }),

  domainTool({
    name: "arr_release_grab",
    title: "Grab searched releases",
    description:
      "Grab one or more releases that a previous search returned. Only release references are " +
      "accepted; an arbitrary download URL, GUID, or magnet link cannot be supplied. Each " +
      "release reports its own outcome.",
    inputSchema: releaseGrabInputSchema,
    outputSchema: releaseGrabOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    discriminator: undefined,
  }),

  domainTool({
    name: "arr_queue_resolve",
    title: "Resolve queue items",
    description:
      "Apply a typed queue transition: ignore tracking, remove from the client and delete its " +
      "data, blocklist and remove, change category and mark imported, route to manual import, " +
      "or force, remove, or blocklist a pending release. Each intent compiles to one exact " +
      "upstream flag combination.",
    inputSchema: queueResolveInputSchema,
    outputSchema: queueResolveOutputSchema,
    annotations: destructive,
    discriminator: "intent",
  }),

  domainTool({
    name: "arr_activity_change",
    title: "Change history and blocklist records",
    description:
      "Mark a history record failed or remove a blocklist record. Removing a blocklist record " +
      "only allows the release to be considered again; it deletes no media and no download.",
    inputSchema: activityChangeInputSchema,
    outputSchema: activityChangeOutputSchema,
    annotations: mutating,
    discriminator: "intent",
  }),

  domainTool({
    name: "arr_import_execute",
    title: "Execute a manual import",
    description:
      "Import validated manual-import candidates with an explicit import mode. Candidates are " +
      "revalidated immediately beforehand and the import stops on any remaining blocking " +
      "rejection or changed fingerprint. Each file reports its own outcome.",
    inputSchema: importExecuteInputSchema,
    outputSchema: importExecuteOutputSchema,
    annotations: destructive,
    discriminator: undefined,
  }),

  domainTool({
    name: "arr_library_change",
    title: "Change the media library",
    description:
      "Add media from a lookup result, set monitoring, edit typed metadata, delete records, " +
      "update or delete media files, or rename. Physical file deletion is always an explicit " +
      "choice, and rename in plan mode returns the proposed paths without renaming.",
    inputSchema: libraryChangeInputSchema,
    outputSchema: libraryChangeOutputSchema,
    annotations: destructive,
    discriminator: "intent",
  }),

  domainTool({
    name: "arr_job_cancel",
    title: "Cancel a job",
    description:
      "Request cancellation of a projected job. The result distinguishes cancelled, " +
      "cancellation requested, uncancellable, already completed, and unknown, and never " +
      "reports success for a command that cannot be cancelled.",
    inputSchema: jobCancelInputSchema,
    outputSchema: jobCancelOutputSchema,
    annotations: mutating,
    discriminator: undefined,
  }),
];

const definitionsByName = new Map<ToolName, ToolDefinition>(
  toolDefinitions.map((definition) => [definition.name, definition]),
);

if (definitionsByName.size !== toolNames.length) {
  throw new Error("Every published tool name must have exactly one definition");
}

export function findToolDefinition(name: ToolName): ToolDefinition | undefined {
  return definitionsByName.get(name);
}
