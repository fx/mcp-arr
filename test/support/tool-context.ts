import { fileURLToPath } from "node:url";
import {
  profileDomains,
  providerDomains,
  resourceDomains,
} from "../../src/adapters/configuration/domains.js";
import { createAdapterRegistry } from "../../src/adapters/registry.js";
import { type ApplicationId, applicationDescriptors } from "../../src/applications.js";
import { type EnvironmentRecord, parseEnvironment } from "../../src/config/environment.js";
import type { FetchLike, UpstreamClient } from "../../src/http/client.js";
import { createWorkflowState, type WorkflowState } from "../../src/state/workflow.js";
import type { ToolContext } from "../../src/tools/dispatch.js";
import type { ToolName } from "../../src/tools/names.js";
import { createOperationRegistry, type OperationDefinition } from "../../src/tools/operations.js";
import { loadFixture, type VersionedFixture } from "./fixtures.js";

export const fixtureRoot = fileURLToPath(new URL("../fixtures", import.meta.url));

/**
 * Placeholder credentials. Every host is under the reserved `.invalid` TLD and
 * every request is served by an injected fetch, so nothing here can reach a
 * real instance.
 */
export const testApiKeys: Readonly<Record<ApplicationId, string>> = {
  sonarr: "sonarr-secret-key",
  radarr: "radarr-secret-key",
  prowlarr: "prowlarr-secret-key",
};

export const allApplicationsEnvironment: EnvironmentRecord = {
  SONARR_URL: "https://sonarr.example.invalid/sonarr",
  SONARR_API_KEY: testApiKeys.sonarr,
  RADARR_URL: "https://radarr.example.invalid",
  RADARR_API_KEY: testApiKeys.radarr,
  PROWLARR_URL: "http://prowlarr.example.invalid:9696",
  PROWLARR_API_KEY: testApiKeys.prowlarr,
};

/**
 * A client stub for a test that only reads.
 *
 * Every write method rejects, so a test that unexpectedly reaches one fails
 * naming the route rather than silently doing nothing and passing.
 */
export function readOnlyClient(
  application: ApplicationId,
  get: UpstreamClient["get"],
  apiBaseUrl = `https://${application}.example.invalid/api/v3`,
): UpstreamClient {
  const refuse = (path: string): Promise<never> =>
    Promise.reject(new Error(`This stub is read-only; it was asked to write ${path}`));
  return {
    application,
    apiBaseUrl,
    get,
    post: refuse,
    put: refuse,
    delete: refuse,
    validate: refuse,
  };
}

export function applicationForUrl(url: string): ApplicationId {
  const descriptor = applicationDescriptors.find((candidate) =>
    url.includes(`${candidate.id}.example.invalid`),
  );
  if (descriptor === undefined) {
    throw new Error(`Unexpected upstream URL: ${url}`);
  }
  return descriptor.id;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function loadStatusFixtures(): Promise<
  ReadonlyMap<ApplicationId, VersionedFixture<Record<string, unknown>>>
> {
  const entries = await Promise.all(
    applicationDescriptors.map(async (descriptor) => {
      const fixture = await loadFixture<Record<string, unknown>>(
        fixtureRoot,
        `${descriptor.id}/${descriptor.apiVersion}/${descriptor.minimumVersion}/system-status.json`,
      );
      return [descriptor.id, fixture] as const;
    }),
  );
  return new Map(entries);
}

export const sampleReferences = {
  media: "med_00000001",
  mediaFile: "mfl_00000001",
  queue: "que_00000001",
  release: "rel_00000001",
  importCandidate: "imp_00000001",
  history: "his_00000001",
  blocklist: "blk_00000001",
  configuration: "cfg_00000001",
  plan: "pln_00000001",
  job: "job_00000001",
} as const;

/**
 * One minimal valid argument object per published tool. The schema tests
 * mutate these to prove that unknown properties and undeclared variants are
 * rejected, so each entry deliberately supplies only the required fields.
 */
export const sampleToolInputs: Readonly<Record<ToolName, Record<string, unknown>>> = {
  arr_capabilities: {},
  arr_library_query: { view: "series" },
  arr_activity_query: { view: "queue_status" },
  arr_release_search: { target: "radarr_movie", movie: sampleReferences.media },
  arr_import_inspect: { source: "queue_item", queue: sampleReferences.queue },
  arr_config_observe: { domain: "indexers" },
  arr_job_get: { job: sampleReferences.job },
  arr_search_start: { target: "sonarr_series", mode: "plan", series: sampleReferences.media },
  arr_release_grab: { mode: "apply", releases: [sampleReferences.release] },
  arr_queue_resolve: { intent: "ignore_tracking", mode: "plan", items: [sampleReferences.queue] },
  arr_activity_change: {
    intent: "mark_history_failed",
    mode: "plan",
    records: [sampleReferences.history],
  },
  arr_import_execute: {
    mode: "plan",
    candidates: [sampleReferences.importCandidate],
    importMode: "auto",
  },
  arr_library_change: {
    intent: "set_monitoring",
    mode: "plan",
    items: [sampleReferences.media],
    monitored: true,
  },
  arr_job_cancel: { mode: "apply", job: sampleReferences.job },
};

/** The apply-from-plan form, which every mutation tool accepts in place of an intent. */
const planApplyArguments = { mode: "apply", plan: sampleReferences.plan } as const;

/**
 * Every observation domain, assembled from the adapter's three family lists.
 *
 * `arr_config_observe` names its sixteen domains one literal at a time, so
 * these lists are a second statement of the same set rather than a restatement
 * of that tool's own union — a domain added to one and not the other is what
 * the completeness guard is there to catch.
 */
const configurationDomains: readonly string[] = [
  ...providerDomains,
  ...profileDomains,
  ...resourceDomains,
];

/**
 * The queue intents whose only argument beyond the mode is the item selection.
 *
 * Written out rather than harvested from `queueResolveIntentSchema`: a list
 * taken from the very union it is checked against would agree with it by
 * construction, and the completeness guard over it would assert nothing.
 */
const uniformQueueResolveIntents: readonly string[] = [
  "ignore_tracking",
  "remove_from_client_and_delete_data",
  "change_category_mark_imported",
  "route_to_manual_import",
  "force_pending_grab",
  "remove_pending",
  "blocklist_pending",
];

/**
 * A minimal accepted argument object for every branch of every tool's input.
 *
 * A published input schema is one flat object per tool, so the variant a caller
 * actually supplies is no longer a shape the schema names — which makes "the
 * published schema admits what this tool accepts" a claim that has to be
 * checked once per variant rather than once per tool. {@link sampleToolInputs}
 * exercises one variant each; this covers the rest.
 *
 * Written by hand, one literal per branch. A generated minimal object is a
 * value nobody chose, a generator sharing a bug with the schema would make both
 * halves of the round-trip pass for the wrong reason, and a generator cannot
 * satisfy a branch guarded by a refinement at all — the calendar window below
 * is two real dates in order, which no date pattern can be asked for. The
 * completeness guard in `tool-stdio.test.ts` is what keeps the table honest: a
 * variant nobody adds an entry for fails immediately.
 */
export const sampleBranchInputs: Readonly<Record<ToolName, readonly Record<string, unknown>[]>> = {
  arr_capabilities: [{}],
  arr_library_query: [
    { view: "series" },
    { view: "seasons", series: sampleReferences.media },
    { view: "episodes", series: sampleReferences.media },
    { view: "episode_files", series: sampleReferences.media },
    { view: "missing_episodes" },
    { view: "cutoff_unmet_episodes" },
    { view: "movies" },
    { view: "collections" },
    { view: "movie_files", movie: sampleReferences.media },
    { view: "missing_movies" },
    { view: "cutoff_unmet_movies" },
    { view: "calendar", start: "2026-01-01", end: "2026-01-31" },
    { view: "lookup", term: "example" },
  ],
  arr_activity_query: [
    { view: "queue_status" },
    { view: "queue" },
    { view: "queue_details", queue: sampleReferences.queue },
    { view: "history" },
    { view: "blocklist" },
    { view: "health" },
    { view: "commands" },
    { view: "disk_space" },
    { view: "indexer_status" },
    { view: "indexer_statistics" },
  ],
  arr_release_search: [
    { target: "sonarr_episode", episode: sampleReferences.media },
    { target: "sonarr_season", series: sampleReferences.media, seasonNumber: 2 },
    { target: "radarr_movie", movie: sampleReferences.media },
    { target: "prowlarr_aggregate", term: "example" },
  ],
  arr_import_inspect: [
    { source: "queue_item", queue: sampleReferences.queue },
    { source: "library_context", media: sampleReferences.media },
    {
      source: "candidate_reprocess",
      candidate: sampleReferences.importCandidate,
      mapping: { releaseGroup: "EXAMPLEGRP" },
    },
  ],
  arr_config_observe: configurationDomains.map((domain) => ({ domain })),
  arr_job_get: [{ job: sampleReferences.job }],
  arr_search_start: [
    { target: "sonarr_episode", mode: "plan", episodes: [sampleReferences.media] },
    { target: "sonarr_season", mode: "plan", series: sampleReferences.media, seasonNumber: 2 },
    { target: "sonarr_series", mode: "plan", series: sampleReferences.media },
    { target: "radarr_movie", mode: "plan", movies: [sampleReferences.media] },
    // A wanted-list search names the one application it runs on: the mutation
    // envelope carries one job and one receipt, so the published schema
    // requires the application rather than defaulting to both.
    { target: "missing", mode: "plan", application: "sonarr", monitoredOnly: true },
    { target: "cutoff_unmet", mode: "plan", application: "radarr", monitoredOnly: false },
    planApplyArguments,
  ],
  arr_release_grab: [{ mode: "plan", releases: [sampleReferences.release] }, planApplyArguments],
  arr_queue_resolve: [
    ...uniformQueueResolveIntents.map((intent) => ({
      intent,
      mode: "plan",
      items: [sampleReferences.queue],
    })),
    {
      intent: "blocklist_and_remove",
      mode: "plan",
      items: [sampleReferences.queue],
      replacementSearch: "suppress",
    },
    planApplyArguments,
  ],
  arr_activity_change: [
    { intent: "mark_history_failed", mode: "plan", records: [sampleReferences.history] },
    { intent: "remove_blocklist_record", mode: "plan", records: [sampleReferences.blocklist] },
    planApplyArguments,
  ],
  arr_import_execute: [
    {
      mode: "plan",
      candidates: [sampleReferences.importCandidate],
      importMode: "auto",
    },
    planApplyArguments,
  ],
  arr_library_change: [
    {
      intent: "add_media",
      mode: "plan",
      application: "sonarr",
      lookup: sampleReferences.media,
      rootFolder: sampleReferences.configuration,
      qualityProfile: sampleReferences.configuration,
      monitor: "all",
      searchOnAdd: false,
    },
    {
      intent: "set_monitoring",
      mode: "plan",
      items: [sampleReferences.media],
      monitored: true,
    },
    {
      intent: "edit_media",
      mode: "plan",
      items: [sampleReferences.media],
      changes: { monitored: true },
    },
    {
      intent: "delete_media",
      mode: "plan",
      items: [sampleReferences.media],
      deleteFiles: false,
      addImportListExclusion: false,
    },
    {
      intent: "update_file_metadata",
      mode: "plan",
      files: [sampleReferences.mediaFile],
      changes: { releaseGroup: "EXAMPLEGRP" },
    },
    { intent: "delete_file", mode: "plan", files: [sampleReferences.mediaFile] },
    { intent: "rename", mode: "plan", media: sampleReferences.media },
    {
      intent: "move_media",
      mode: "plan",
      media: sampleReferences.media,
      rootFolder: sampleReferences.configuration,
    },
    planApplyArguments,
  ],
  arr_job_cancel: [{ mode: "apply", job: sampleReferences.job }, planApplyArguments],
};

export interface TestContextOptions {
  readonly environment?: EnvironmentRecord;
  readonly fetch?: FetchLike;
  readonly operations?: readonly OperationDefinition[];
  /** Reused so a test can seed the stores and then call through the tool. */
  readonly state?: WorkflowState;
}

export function createTestToolContext(options: TestContextOptions = {}): ToolContext {
  const configuration = parseEnvironment(options.environment ?? allApplicationsEnvironment);
  return {
    registry: createAdapterRegistry(configuration, {
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    }),
    operations: createOperationRegistry(options.operations),
    state: options.state ?? createWorkflowState(),
  };
}
