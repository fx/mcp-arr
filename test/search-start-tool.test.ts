import { beforeAll, describe, expect, it } from "vitest";
import { type ApplicationId, describeApplication } from "../src/applications.js";
import type { FetchLike } from "../src/http/client.js";
import { createManualClock } from "../src/state/clock.js";
import { referenceLifetimes } from "../src/state/references.js";
import { createWorkflowState, type WorkflowState } from "../src/state/workflow.js";
import { findToolDefinition, type ToolDefinition } from "../src/tools/definitions.js";
import type { ToolContext } from "../src/tools/dispatch.js";
import type { ToolResult } from "../src/tools/results.js";
import type { SearchStartResultData } from "../src/tools/schemas/acquisition-results.js";
import { fixtureBody } from "./support/library.js";
import {
  createTestToolContext,
  jsonResponse,
  loadStatusFixtures,
  sampleReferences,
} from "./support/tool-context.js";

/**
 * `arr_search_start` as a caller sees it.
 *
 * The properties under test are the ones that make an allowlisted workflow
 * different from a command dispatcher: the caller names a typed target and
 * opaque media references, exactly one command name can result, the identifiers
 * behind those references never appear in anything published, and the accepted
 * command comes back as the same normalized job every other job-producing tool
 * would return.
 */

const searchStartTool = findToolDefinition("arr_search_start") as ToolDefinition;
const jobGetTool = findToolDefinition("arr_job_get") as ToolDefinition;

interface UpstreamRequest {
  readonly application: ApplicationId;
  readonly method: string;
  readonly route: string;
  readonly body: Record<string, unknown> | undefined;
}

interface Upstream {
  readonly fetch: FetchLike;
  readonly requests: UpstreamRequest[];
}

interface UpstreamOptions {
  /** Answers a started command; the default accepts it. */
  readonly command?: (request: UpstreamRequest) => Response;
  readonly unreachable?: boolean;
}

let statuses: Awaited<ReturnType<typeof loadStatusFixtures>>;
const commandRecords = new Map<ApplicationId, Record<string, unknown>>();

beforeAll(async () => {
  statuses = await loadStatusFixtures();
  for (const application of ["sonarr", "radarr"] as const) {
    const body = await fixtureBody<readonly Record<string, unknown>[]>(application, "command");
    const first = body[0];
    if (first === undefined) {
      throw new Error(`The ${application} command fixture holds no record`);
    }
    commandRecords.set(application, first);
  }
});

function applicationForHost(host: string): ApplicationId {
  for (const application of ["sonarr", "radarr", "prowlarr"] as const) {
    if (host.includes(`${application}.example.invalid`)) {
      return application;
    }
  }
  throw new Error(`Unexpected upstream host: ${host}`);
}

/**
 * A stand-in instance that probes from the status fixtures and answers a
 * created command with the recorded command record, the way a real one does.
 */
function upstream(options: UpstreamOptions = {}): Upstream {
  const requests: UpstreamRequest[] = [];

  const fetch: FetchLike = (input, init) => {
    if (options.unreachable === true) {
      return Promise.reject(new Error("connection refused"));
    }
    const url = new URL(input);
    const application = applicationForHost(url.host);
    const prefix = `${describeApplication(application).apiBasePath}/`;
    const route = url.pathname.slice(url.pathname.indexOf(prefix) + prefix.length);
    const request: UpstreamRequest = {
      application,
      method: String(init.method),
      route,
      body:
        init.body === undefined
          ? undefined
          : (JSON.parse(String(init.body)) as Record<string, unknown>),
    };
    requests.push(request);

    if (request.method === "POST") {
      return Promise.resolve(
        options.command?.(request) ??
          jsonResponse({ ...commandRecords.get(application), name: request.body?.name }, 201),
      );
    }
    if (route === "system/status") {
      return Promise.resolve(jsonResponse(statuses.get(application)?.body));
    }
    return Promise.resolve(jsonResponse({ message: "not found" }, 404));
  };

  return { fetch, requests };
}

function contextFor(instance: Upstream, state: WorkflowState): ToolContext {
  return createTestToolContext({ fetch: instance.fetch, state });
}

async function call(
  definition: ToolDefinition,
  context: ToolContext,
  args: unknown,
): Promise<ToolResult<unknown>> {
  const parsed = definition.inputSchema.safeParse(args);
  if (!parsed.success) {
    throw new Error(`Arguments rejected by the published schema: ${parsed.error.message}`);
  }
  const result = await definition.handle(context, parsed.data);
  expect(definition.outputSchema.safeParse(result).success).toBe(true);
  return result;
}

function outcomeFor(result: ToolResult<unknown>, application: ApplicationId) {
  const outcome = result.applications.find((entry) => entry.application === application);
  if (outcome === undefined) {
    throw new Error(`No outcome for ${application}`);
  }
  return outcome;
}

function dataFor(result: ToolResult<unknown>, application: ApplicationId) {
  return outcomeFor(result, application).data as SearchStartResultData | undefined;
}

/** Mints the media reference a search target names, as a library query would. */
function mintMedia(
  state: WorkflowState,
  application: ApplicationId,
  kind: string,
  upstreamId: string,
): string {
  return state.references.mint({
    kind: "media",
    applications: [application],
    payload: () => ({
      kind: "domain",
      snapshot: { upstreamId, fingerprint: "test-fingerprint", detail: { kind } },
    }),
  }).reference;
}

describe("arr_search_start plan mode", () => {
  it("discloses the command and the caller's own references without contacting the instance", async () => {
    const state = createWorkflowState();
    const instance = upstream();
    const series = mintMedia(state, "sonarr", "series", "12");

    const result = await call(searchStartTool, contextFor(instance, state), {
      target: "sonarr_series",
      mode: "plan",
      series,
    });

    expect(result.status).toBe("ok");
    expect(dataFor(result, "sonarr")).toEqual({
      stage: "planned",
      target: "sonarr_series",
      application: "sonarr",
      command: "SeriesSearch",
      media: [series],
    });
    // The upstream identifier the reference stands for is never published.
    expect(JSON.stringify(result)).not.toContain('"12"');
    expect(result.mutation?.plan).toMatch(/^pln_/u);
    expect(result.mutation?.requestedEffects[0]?.severity).toBe("consequential");
    expect(result.mutation?.requestedEffects[0]?.summary).toContain("SeriesSearch");
    expect(instance.requests.some((request) => request.method === "POST")).toBe(false);
  });

  it("says a wanted-list search may grab across the whole monitored library", async () => {
    const state = createWorkflowState();
    const instance = upstream();

    const result = await call(searchStartTool, contextFor(instance, state), {
      target: "missing",
      mode: "plan",
      applications: ["radarr"],
      monitoredOnly: true,
    });

    expect(dataFor(result, "radarr")).toMatchObject({
      stage: "planned",
      command: "MissingMoviesSearch",
      media: [],
    });
    const summary = result.mutation?.requestedEffects[0]?.summary ?? "";
    expect(summary).toContain("monitored");
    expect(summary).toContain("grab");
  });
});

describe("arr_search_start apply mode", () => {
  it("sends one allowlisted command and returns the job it was projected into", async () => {
    const state = createWorkflowState();
    const instance = upstream();
    const episodes = [
      mintMedia(state, "sonarr", "episode", "11"),
      mintMedia(state, "sonarr", "episode", "12"),
    ];
    const context = contextFor(instance, state);

    const result = await call(searchStartTool, context, {
      target: "sonarr_episode",
      mode: "apply",
      episodes,
    });

    expect(result.status).toBe("ok");
    const posted = instance.requests.filter((request) => request.method === "POST");
    expect(posted).toHaveLength(1);
    expect(posted[0]?.route).toBe("command");
    expect(posted[0]?.body).toEqual({ name: "EpisodeSearch", episodeIds: [11, 12] });

    const data = dataFor(result, "sonarr");
    if (data?.stage !== "started") {
      throw new Error("Expected a started search");
    }
    expect(data.target).toBe("sonarr_episode");
    expect(data.job.application).toBe("sonarr");
    expect(data.job.command).toEqual({
      name: "EpisodeSearch",
      upstreamId: String(commandRecords.get("sonarr")?.id),
    });
    // The upstream cancel route is a DELETE this server does not expose, so the
    // job says it cannot be cancelled rather than accepting one it would fail
    // to make.
    expect(data.job.cancellable).toBe(false);
    expect(result.mutation?.job).toBe(data.job.job);
    expect(result.mutation?.receipt?.state).toBe("succeeded");
  });

  it("hands the caller a job reference arr_job_get already understands", async () => {
    const state = createWorkflowState();
    const instance = upstream();
    const context = contextFor(instance, state);

    const started = await call(searchStartTool, context, {
      target: "radarr_movie",
      mode: "apply",
      movies: [mintMedia(state, "radarr", "movie", "8")],
    });
    const job = started.mutation?.job;
    expect(job).toMatch(/^job_/u);

    const read = await call(jobGetTool, context, { job });
    expect(outcomeFor(read, "radarr").status).toBe("ok");
    expect(read.applications[0]?.data).toMatchObject({
      job,
      application: "radarr",
      command: { name: "MoviesSearch" },
    });
  });

  it("applies a recorded plan without the caller restating the intent", async () => {
    const state = createWorkflowState();
    const instance = upstream();
    const context = contextFor(instance, state);
    const series = mintMedia(state, "sonarr", "series", "12");

    const planned = await call(searchStartTool, context, {
      target: "sonarr_season",
      mode: "plan",
      series,
      seasonNumber: 2,
    });
    const applied = await call(searchStartTool, context, {
      mode: "apply",
      plan: planned.mutation?.plan,
    });

    expect(applied.status).toBe("ok");
    const posted = instance.requests.filter((request) => request.method === "POST");
    expect(posted[0]?.body).toEqual({ name: "SeasonSearch", seriesId: 12, seasonNumber: 2 });
  });

  it("returns the existing receipt rather than starting the same search twice", async () => {
    const state = createWorkflowState();
    const instance = upstream();
    const context = contextFor(instance, state);
    const args = {
      target: "sonarr_series",
      mode: "apply",
      series: mintMedia(state, "sonarr", "series", "12"),
    };

    const first = await call(searchStartTool, context, args);
    const second = await call(searchStartTool, context, args);

    expect(second.mutation?.receipt).toEqual(first.mutation?.receipt);
    expect(second.mutation?.job).toBe(first.mutation?.job);
    expect(outcomeFor(second, "sonarr").warnings.join(" ")).toContain("already applied");
    expect(instance.requests.filter((request) => request.method === "POST")).toHaveLength(1);
  });
});

describe("arr_search_start refusals", () => {
  it("blocks the command when a named reference has expired", async () => {
    const clock = createManualClock(Date.now());
    const state = createWorkflowState({ clock });
    const instance = upstream();
    const context = contextFor(instance, state);
    const series = mintMedia(state, "sonarr", "series", "12");

    clock.advance(referenceLifetimes.media + 1);
    const result = await call(searchStartTool, context, {
      target: "sonarr_series",
      mode: "apply",
      series,
    });

    expect(result.status).toBe("error");
    expect(result.errors[0]?.code).toBe("stale_reference");
    expect(result.errors[0]?.remediation).toContain("Repeat the query");
    expect(instance.requests.some((request) => request.method === "POST")).toBe(false);
  });

  it("refuses a reference that names the wrong kind of record", async () => {
    const state = createWorkflowState();
    const instance = upstream();

    const result = await call(searchStartTool, contextFor(instance, state), {
      target: "sonarr_series",
      mode: "apply",
      series: mintMedia(state, "sonarr", "episode", "11"),
    });

    expect(outcomeFor(result, "sonarr").error?.code).toBe("invalid_input");
    expect(instance.requests.some((request) => request.method === "POST")).toBe(false);
  });

  it("rejects a media reference this server never issued", async () => {
    const state = createWorkflowState();
    const instance = upstream();

    const result = await call(searchStartTool, contextFor(instance, state), {
      target: "sonarr_series",
      mode: "apply",
      series: sampleReferences.media,
    });

    expect(result.errors[0]?.code).toBe("stale_reference");
    expect(instance.requests).toEqual([]);
  });

  it("names one application rather than fanning a wanted-list search across both", async () => {
    const state = createWorkflowState();
    const instance = upstream();

    const result = await call(searchStartTool, contextFor(instance, state), {
      target: "cutoff_unmet",
      mode: "apply",
      monitoredOnly: true,
    });

    // The published mutation envelope carries one job and one receipt, so a
    // mutation that targets two instances is refused with the instruction
    // rather than run twice.
    expect(result.status).toBe("error");
    expect(result.errors[0]?.code).toBe("invalid_input");
    expect(result.errors[0]?.message).toContain("name one application");
    expect(instance.requests).toEqual([]);
  });

  it("reports an unreachable application rather than a search it cannot have started", async () => {
    const state = createWorkflowState();
    const offline = upstream({ unreachable: true });

    const result = await call(searchStartTool, contextFor(offline, state), {
      target: "missing",
      mode: "apply",
      applications: ["sonarr"],
      monitoredOnly: true,
    });

    expect(outcomeFor(result, "sonarr").status).toBe("unavailable");
    expect(outcomeFor(result, "sonarr").error?.code).toBe("unavailable_application");
  });

  it("settles the receipt as retryable when the instance refuses the command", async () => {
    const state = createWorkflowState();
    const instance = upstream({
      command: () => jsonResponse({ message: "canary-upstream-detail" }, 400),
    });
    const context = contextFor(instance, state);

    const result = await call(searchStartTool, context, {
      target: "sonarr_series",
      mode: "apply",
      series: mintMedia(state, "sonarr", "series", "12"),
    });

    expect(result.status).toBe("error");
    expect(outcomeFor(result, "sonarr").error?.code).toBe("upstream_rejection");
    // Upstream demonstrably refused it, so a later attempt is a retry rather
    // than a duplicate.
    expect(result.mutation?.receipt?.state).toBe("failed");
    expect(JSON.stringify(result)).not.toContain("canary");
  });

  it("keeps a planted upstream secret out of the job, its warnings, and the envelope", async () => {
    const secret = "canary-instance-key-9f3d21ab";
    const state = createWorkflowState();
    const instance = upstream({
      command: (request) =>
        jsonResponse({
          ...commandRecords.get("sonarr"),
          name: request.body?.name,
          message: `Searching https://tracker.example.invalid/rss?apikey=${secret}`,
        }),
    });
    const context = contextFor(instance, state);

    const result = await call(searchStartTool, context, {
      target: "sonarr_series",
      mode: "apply",
      series: mintMedia(state, "sonarr", "series", "12"),
    });

    expect(result.status).toBe("ok");
    expect(JSON.stringify(result)).not.toContain(secret);
    const read = await call(jobGetTool, context, { job: result.mutation?.job });
    expect(JSON.stringify(read)).not.toContain(secret);
  });
});
