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
  /** Answers a record read; the default serves the recorded library fixture. */
  readonly record?: (route: string) => Response | undefined;
  readonly unreachable?: boolean;
}

let statuses: Awaited<ReturnType<typeof loadStatusFixtures>>;
const commandRecords = new Map<ApplicationId, Record<string, unknown>>();
/**
 * The recorded library records the precondition check reads, keyed by
 * application and route.
 */
const libraryRecords = new Map<string, Record<string, unknown>>();

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
  for (const [application, route] of [
    ["sonarr", "series"],
    ["sonarr", "episode"],
    ["radarr", "movie"],
  ] as const) {
    for (const record of await fixtureBody<readonly Record<string, unknown>[]>(
      application,
      route,
    )) {
      // Keyed by application as well as route: Sonarr does not hold Radarr's
      // movies, and a stub that served them across applications would answer a
      // request no instance could have answered.
      libraryRecords.set(`${application}/${route}/${String(record.id)}`, record);
    }
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

/** The applications that expose a command endpoint at all. Prowlarr does not. */
const commandApplications: readonly ApplicationId[] = ["sonarr", "radarr"];

/**
 * A stand-in instance that probes from the status fixtures and answers a
 * created command with the recorded command record, the way a real one does.
 *
 * It refuses what a real instance refuses: `command` is the only route it
 * accepts a write on and only where the application exposes one, a command
 * without a name is `400`, and any other method is `405`. A stub that answered
 * every POST with a created command would pass an implementation that started
 * its search by posting to the wrong endpoint entirely.
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
      if (route !== "command" || !commandApplications.includes(application)) {
        return Promise.resolve(jsonResponse({ message: "not found" }, 404));
      }
      if (typeof request.body?.name !== "string") {
        return Promise.resolve(jsonResponse({ message: "unknown command" }, 400));
      }
      return Promise.resolve(
        options.command?.(request) ??
          jsonResponse({ ...commandRecords.get(application), name: request.body.name }, 201),
      );
    }
    if (request.method !== "GET") {
      return Promise.resolve(jsonResponse({ message: "method not allowed" }, 405));
    }
    if (route === "system/status") {
      return Promise.resolve(jsonResponse(statuses.get(application)?.body));
    }
    const overridden = options.record?.(route);
    if (overridden !== undefined) {
      return Promise.resolve(overridden);
    }
    const record = libraryRecords.get(`${application}/${route}`);
    return Promise.resolve(
      record === undefined ? jsonResponse({ message: "not found" }, 404) : jsonResponse(record),
    );
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

describe("the stand-in instance itself", () => {
  const url = (application: ApplicationId, route: string): string =>
    `https://${application}.example.invalid${describeApplication(application).apiBasePath}/${route}`;

  it("accepts a command only where one exists, and only when it is named", async () => {
    const instance = upstream();

    // The tests below assert that a search was started by looking at what was
    // posted, so the stub has to be the thing that would refuse the wrong post.
    expect(
      (await instance.fetch(url("sonarr", "command"), { method: "POST", body: "{}" })).status,
    ).toBe(400);
    expect(
      (
        await instance.fetch(url("sonarr", "series"), {
          method: "POST",
          body: JSON.stringify({ name: "SeriesSearch" }),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await instance.fetch(url("prowlarr", "command"), {
          method: "POST",
          body: JSON.stringify({ name: "SeriesSearch" }),
        })
      ).status,
    ).toBe(404);
    expect((await instance.fetch(url("sonarr", "series/12"), { method: "PUT" })).status).toBe(405);
  });

  it("serves each application only its own records", async () => {
    const instance = upstream();

    expect((await instance.fetch(url("sonarr", "series/12"), { method: "GET" })).status).toBe(200);
    // The Radarr fixture holds movie 8; Sonarr must not answer for it.
    expect((await instance.fetch(url("radarr", "movie/8"), { method: "GET" })).status).toBe(200);
    expect((await instance.fetch(url("sonarr", "movie/8"), { method: "GET" })).status).toBe(404);
  });
});

describe("arr_search_start plan mode", () => {
  it("sends no command, and discloses the one it would send with the caller's own references", async () => {
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
    // Nothing was started. The instance is still read — a plan that could not
    // tell the caller the application is unreachable, or that the record is
    // gone, would hand out one that cannot be applied.
    expect(instance.requests.some((request) => request.method === "POST")).toBe(false);
    expect(instance.requests.map((request) => request.route)).toContain("series/12");
  });

  it("says a wanted-list search may grab across the whole monitored library", async () => {
    const state = createWorkflowState();
    const instance = upstream();

    const result = await call(searchStartTool, contextFor(instance, state), {
      target: "missing",
      mode: "plan",
      application: "radarr",
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

  it("says out loud that a relaxed wanted scope is the application's own, not everything", async () => {
    const state = createWorkflowState();
    const instance = upstream();

    const result = await call(searchStartTool, contextFor(instance, state), {
      target: "missing",
      mode: "plan",
      application: "sonarr",
      monitoredOnly: false,
    });

    // The upstream filter selects rather than switches, so `false` cannot mean
    // "search unmonitored media too"; the effect and the warning both say what
    // is actually sent instead of claiming something wider.
    const warnings = outcomeFor(result, "sonarr").warnings.join(" ");
    expect(warnings).toContain("default wanted scope");
    expect(result.mutation?.requestedEffects[0]?.summary).toContain("default wanted scope");
  });
});

describe("arr_search_start apply mode", () => {
  it("sends one allowlisted command and returns the job it was projected into", async () => {
    const state = createWorkflowState();
    const instance = upstream();
    // The two recorded episodes of the recorded series, so the precondition
    // check reads records that actually exist in the fixtures.
    const episodes = [
      mintMedia(state, "sonarr", "episode", "1001"),
      mintMedia(state, "sonarr", "episode", "1003"),
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
    expect(posted[0]?.body).toEqual({ name: "EpisodeSearch", episodeIds: [1001, 1003] });

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

  it("blocks the command when a named record no longer exists upstream", async () => {
    const state = createWorkflowState();
    const instance = upstream({
      record: (route) =>
        route === "series/12" ? jsonResponse({ message: "not found" }, 404) : undefined,
    });

    const result = await call(searchStartTool, contextFor(instance, state), {
      target: "sonarr_series",
      mode: "apply",
      series: mintMedia(state, "sonarr", "series", "12"),
    });

    // The reference still resolves; only the instance knows the record is gone,
    // which is exactly what the immediate current-state read is for.
    expect(result.status).toBe("error");
    expect(outcomeFor(result, "sonarr").error?.code).toBe("stale_reference");
    expect(instance.requests.some((request) => request.method === "POST")).toBe(false);
  });

  it("fails a recorded plan as stale once a searched record's monitoring changes", async () => {
    const state = createWorkflowState();
    let monitored = true;
    const instance = upstream({
      record: (route) => (route === "series/12" ? jsonResponse({ id: 12, monitored }) : undefined),
    });
    const context = contextFor(instance, state);
    const series = mintMedia(state, "sonarr", "series", "12");

    const planned = await call(searchStartTool, context, {
      target: "sonarr_series",
      mode: "plan",
      series,
    });
    monitored = false;
    const applied = await call(searchStartTool, context, {
      mode: "apply",
      plan: planned.mutation?.plan,
    });

    expect(applied.status).toBe("error");
    expect(outcomeFor(applied, "sonarr").error?.code).toBe("stale_plan");
    expect(instance.requests.some((request) => request.method === "POST")).toBe(false);
  });

  it("refuses a reference that names the wrong kind of record", async () => {
    const state = createWorkflowState();
    const instance = upstream();

    const result = await call(searchStartTool, contextFor(instance, state), {
      target: "sonarr_series",
      mode: "apply",
      series: mintMedia(state, "sonarr", "episode", "1001"),
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

  it("runs a wanted-list search on the one application the caller named", async () => {
    const state = createWorkflowState();
    const instance = upstream();

    const result = await call(searchStartTool, contextFor(instance, state), {
      target: "cutoff_unmet",
      mode: "apply",
      application: "radarr",
      monitoredOnly: true,
    });

    expect(result.status).toBe("ok");
    expect(dataFor(result, "radarr")).toMatchObject({ stage: "started" });
    // The other library application was never asked, so the one job and the one
    // receipt the envelope carries describe the whole of what happened.
    expect(result.applications.map((outcome) => outcome.application)).toEqual(["radarr"]);
    expect(instance.requests.map((request) => request.application)).not.toContain("sonarr");
  });

  it("still refuses at the dispatcher when nothing named the application", async () => {
    const state = createWorkflowState();
    const instance = upstream();

    // Deliberately not through `call`: the published schema now requires the
    // selection, so this argument object cannot come from a caller reading it.
    // What is under test is the backstop beneath the schema — the rule holds
    // for an internal caller, and for the next mutation to publish an
    // application selection, whether or not its schema was written correctly.
    const result = await searchStartTool.handle(contextFor(instance, state), {
      target: "cutoff_unmet",
      mode: "apply",
      monitoredOnly: true,
    });

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
      application: "sonarr",
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

  it("reports the instance's sentence once, and does not republish it from the job", async () => {
    // The start path and the refresh path have to agree about the same
    // sentence. Saying it on the call that started the command is reporting;
    // writing it into the projection would republish it on every later read,
    // including the read that finds the job finished successfully.
    const state = createWorkflowState();
    const instance = upstream({
      command: (request) =>
        jsonResponse({
          ...commandRecords.get("sonarr"),
          name: request.body?.name,
          status: "queued",
          message: "Refreshing series",
        }),
      record: (route) =>
        route.startsWith("command/")
          ? jsonResponse({ id: 3001, status: "completed", result: "successful" })
          : undefined,
    });
    const context = contextFor(instance, state);

    const started = await call(searchStartTool, context, {
      target: "sonarr_series",
      mode: "apply",
      series: mintMedia(state, "sonarr", "series", "12"),
    });

    // Said once, by the call that read it.
    expect(outcomeFor(started, "sonarr").warnings).toContain("Refreshing series");

    const read = await call(jobGetTool, context, { job: started.mutation?.job });

    expect((read.applications[0]?.data as { status?: string } | undefined)?.status).toBe(
      "completed",
    );
    expect(outcomeFor(read, "sonarr").warnings).toEqual([]);
    expect(JSON.stringify(read)).not.toContain("Refreshing series");
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
