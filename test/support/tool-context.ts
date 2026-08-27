import { fileURLToPath } from "node:url";
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
  arr_config_reconcile: {
    intent: "reconcile_provider",
    mode: "plan",
    application: "sonarr",
    domain: "indexers",
    fields: [],
  },
  arr_job_cancel: { mode: "apply", job: sampleReferences.job },
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
