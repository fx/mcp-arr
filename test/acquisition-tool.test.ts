import { beforeAll, describe, expect, it } from "vitest";
import { upstreamSearchCacheMs } from "../src/adapters/acquisition/grab.js";
import { type ApplicationId, describeApplication } from "../src/applications.js";
import type { FetchLike } from "../src/http/client.js";
import { createManualClock } from "../src/state/clock.js";
import { referenceLifetimes } from "../src/state/references.js";
import { createWorkflowState, type WorkflowState } from "../src/state/workflow.js";
import { findToolDefinition, type ToolDefinition } from "../src/tools/definitions.js";
import type { ToolContext } from "../src/tools/dispatch.js";
import type { ToolResult } from "../src/tools/results.js";
import type {
  ReleaseGrabResultData,
  ReleaseSearchResult,
} from "../src/tools/schemas/acquisition-results.js";
import { fixtureBody } from "./support/library.js";
import {
  createTestToolContext,
  jsonResponse,
  loadStatusFixtures,
  sampleReferences,
} from "./support/tool-context.js";

/**
 * `arr_release_search` and `arr_release_grab` as a caller sees them.
 *
 * Everything here goes through the registered definitions — published schema
 * first, then the shared dispatcher — because the properties this pair has to
 * hold are properties of the whole path: that a search result carries an opaque
 * reference and never the cache identity behind it, that a grab reaches an
 * instance only through such a reference, and that an expired or unrecognized
 * one is refused before any request is sent.
 */

const searchTool = findToolDefinition("arr_release_search") as ToolDefinition;
const grabTool = findToolDefinition("arr_release_grab") as ToolDefinition;

interface UpstreamRequest {
  readonly application: ApplicationId;
  readonly method: string;
  readonly route: string;
  readonly query: URLSearchParams;
  readonly body: unknown;
}

interface Upstream {
  readonly fetch: FetchLike;
  readonly requests: UpstreamRequest[];
}

interface UpstreamOptions {
  /** Answers a grab; the default accepts every release. */
  readonly grab?: (request: UpstreamRequest) => Response;
  /** Drops every request, the way an instance that is not running does. */
  readonly unreachable?: boolean;
}

let statuses: Awaited<ReturnType<typeof loadStatusFixtures>>;
const searchBodies = new Map<string, unknown>();

beforeAll(async () => {
  statuses = await loadStatusFixtures();
  for (const [application, route] of [
    ["sonarr", "release"],
    ["radarr", "release"],
    ["prowlarr", "search"],
    ["prowlarr", "indexer"],
    ["prowlarr", "indexerstatus"],
  ] as const) {
    searchBodies.set(`${application}/${route}`, await fixtureBody(application, route));
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
 * A stand-in instance that answers the recorded search fixtures and records
 * every request, so a test can assert both what came back and what was sent.
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
      query: url.searchParams,
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
    };
    requests.push(request);

    if (request.method === "POST") {
      return Promise.resolve(options.grab?.(request) ?? jsonResponse({}));
    }
    if (route === "system/status") {
      return Promise.resolve(jsonResponse(statuses.get(application)?.body));
    }
    const body = searchBodies.get(`${application}/${route}`);
    return Promise.resolve(
      body === undefined ? jsonResponse({ message: "not found" }, 404) : jsonResponse(body),
    );
  };

  return { fetch, requests };
}

function contextFor(instance: Upstream, state?: WorkflowState): ToolContext {
  return createTestToolContext({
    fetch: instance.fetch,
    ...(state === undefined ? {} : { state }),
  });
}

/**
 * Calls a registered tool the way its host does: validate against the published
 * schema first, then hand the parsed arguments to the definition, then hold the
 * envelope to the tool's own declared output schema.
 */
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

function searchDataFor(result: ToolResult<unknown>, application: ApplicationId) {
  const outcome = outcomeFor(result, application);
  if (outcome.status !== "ok") {
    throw new Error(`${application} did not succeed: ${outcome.error?.code ?? "unknown"}`);
  }
  return outcome.data as ReleaseSearchResult;
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

interface SearchedState {
  readonly state: WorkflowState;
  readonly context: ToolContext;
  readonly instance: Upstream;
  readonly releases: ReleaseSearchResult["releases"];
}

/**
 * Runs one Sonarr episode search and returns everything it produced, which is
 * the starting point for every grab below: a grab can only name a reference a
 * search actually minted.
 */
async function searched(options: UpstreamOptions & { state?: WorkflowState } = {}) {
  const state = options.state ?? createWorkflowState();
  const instance = upstream(options);
  const context = contextFor(instance, state);
  const result = await call(searchTool, context, {
    target: "sonarr_episode",
    episode: mintMedia(state, "sonarr", "episode", "42"),
  });
  const searchedState: SearchedState = {
    state,
    context,
    instance,
    releases: searchDataFor(result, "sonarr").releases,
  };
  return searchedState;
}

function grabDataFor(result: ToolResult<unknown>, application: ApplicationId) {
  const outcome = outcomeFor(result, application);
  return outcome.data as ReleaseGrabResultData | undefined;
}

describe("arr_release_search results", () => {
  it("publishes every release behind an opaque reference and never its cache identity", async () => {
    const { releases, instance } = await searched();
    const fixture = searchBodies.get("sonarr/release") as readonly Record<string, unknown>[];

    expect(releases).toHaveLength(fixture.length);
    for (const release of releases) {
      expect(release.reference).toMatch(/^rel_[A-Za-z0-9_-]{8,64}$/u);
      expect(release.application).toBe("sonarr");
    }
    // Every reference is distinct, so two releases can never be grabbed as one.
    expect(new Set(releases.map((release) => release.reference)).size).toBe(releases.length);

    // The upstream cache identity is what the reference replaces, so none of it
    // may appear anywhere in the published payload.
    const serialized = JSON.stringify(releases);
    for (const record of fixture) {
      expect(serialized).not.toContain(String(record.guid));
    }
    for (const forbidden of ["guid", "downloadUrl", "magnetUrl", "infoUrl"]) {
      expect(serialized).not.toContain(forbidden);
    }

    // The search itself is a read: nothing was posted to the instance.
    expect(instance.requests.every((request) => request.method === "GET")).toBe(true);
    expect(instance.requests.map((request) => request.route)).toContain("release");
  });

  it("reports Prowlarr per-indexer completeness through the published result", async () => {
    const instance = upstream();
    const result = await call(searchTool, contextFor(instance), {
      target: "prowlarr_aggregate",
      term: "example series",
    });

    const data = searchDataFor(result, "prowlarr");
    expect(data.target).toBe("prowlarr_aggregate");
    expect(data.completeness?.indexers.length).toBeGreaterThan(0);
    for (const release of data.releases) {
      expect(release.reference).toMatch(/^rel_/u);
    }
  });

  it("refuses a media reference that names the wrong kind of record", async () => {
    const state = createWorkflowState();
    const instance = upstream();
    const result = await call(searchTool, contextFor(instance, state), {
      target: "sonarr_episode",
      episode: mintMedia(state, "sonarr", "series", "12"),
    });

    expect(outcomeFor(result, "sonarr").error?.code).toBe("invalid_input");
    expect(instance.requests.some((request) => request.route === "release")).toBe(false);
  });

  it("keeps a planted upstream secret out of every result, reference, and receipt", async () => {
    const secret = "canary-tracker-passkey-9f3d21ab";
    const fixture = searchBodies.get("sonarr/release") as readonly Record<string, unknown>[];
    // The secret is planted in exactly the places an instance could carry one:
    // a protected link, a cache key, and the one free-form sentence an
    // application composes for itself.
    const poisoned = fixture.map((record) => ({
      ...record,
      downloadUrl: `https://tracker.example.invalid/dl?passkey=${secret}`,
      magnetUrl: `magnet:?xt=urn:btih:${secret}`,
      rejections: [{ reason: `Release blocked by passkey=${secret}`, type: "permanent" }],
    }));

    const state = createWorkflowState();
    const instance: Upstream = {
      requests: [],
      fetch: (input, init) => {
        const url = new URL(input);
        const application = applicationForHost(url.host);
        if (url.pathname.endsWith("system/status")) {
          return Promise.resolve(jsonResponse(statuses.get(application)?.body));
        }
        return Promise.resolve(
          String(init.method) === "POST" ? jsonResponse(poisoned[0]) : jsonResponse(poisoned),
        );
      },
    };
    const context = contextFor(instance, state);

    const search = await call(searchTool, context, {
      target: "sonarr_episode",
      episode: mintMedia(state, "sonarr", "episode", "42"),
    });
    const releases = searchDataFor(search, "sonarr").releases;
    expect(JSON.stringify(search)).not.toContain(secret);
    for (const release of releases) {
      expect(release.reference).not.toContain(secret);
    }

    const grab = await call(grabTool, context, {
      mode: "apply",
      releases: [releases[0]?.reference],
    });
    expect(JSON.stringify(grab)).not.toContain(secret);
  });
});

describe("arr_release_grab", () => {
  it("grabs only through a reference a search minted, sending the cache identity", async () => {
    const { context, instance, releases } = await searched();
    const reference = releases[0]?.reference;
    const fixture = searchBodies.get("sonarr/release") as readonly Record<string, unknown>[];

    const result = await call(grabTool, context, { mode: "apply", releases: [reference] });

    expect(result.status).toBe("ok");
    expect(grabDataFor(result, "sonarr")).toEqual({
      stage: "applied",
      requested: 1,
      accepted: 1,
      releases: [
        {
          reference,
          application: "sonarr",
          title: fixture[0]?.title,
          indexer: { id: fixture[0]?.indexerId, name: fixture[0]?.indexer },
          protocol: fixture[0]?.protocol,
          outcome: "accepted",
        },
      ],
    });
    expect(result.mutation?.receipt?.state).toBe("succeeded");

    const posted = instance.requests.filter((request) => request.method === "POST");
    expect(posted).toHaveLength(1);
    expect(posted[0]?.route).toBe("release");
    expect(posted[0]?.body).toEqual({ guid: fixture[0]?.guid, indexerId: fixture[0]?.indexerId });
  });

  it("returns stale_reference with its remediation once a reference has expired", async () => {
    const clock = createManualClock(Date.now());
    const state = createWorkflowState({ clock });
    const { context, instance, releases } = await searched({ state });

    clock.advance(referenceLifetimes.release + 1);
    const before = instance.requests.length;
    const result = await call(grabTool, context, {
      mode: "apply",
      releases: [releases[0]?.reference],
    });

    const error = result.errors[0];
    expect(result.status).toBe("error");
    expect(error?.code).toBe("stale_reference");
    expect(error?.recoverable).toBe(true);
    expect(error?.remediation).toContain("Repeat the query");
    expect(error?.message).toContain("expired");
    // Refused before anything reached the instance, and before a receipt exists.
    expect(instance.requests).toHaveLength(before);
    expect(result.mutation?.receipt).toBeUndefined();
  });

  it("rejects a release reference this server never issued", async () => {
    const instance = upstream();
    const result = await call(grabTool, contextFor(instance), {
      mode: "apply",
      releases: [sampleReferences.release],
    });

    expect(result.errors[0]?.code).toBe("stale_reference");
    expect(instance.requests).toEqual([]);
  });

  it("refuses a release reference that does not stand for a search result", async () => {
    const state = createWorkflowState();
    const instance = upstream();
    const foreign = state.references.mint({
      kind: "release",
      applications: ["sonarr"],
      payload: () => ({
        kind: "domain",
        snapshot: { upstreamId: "12", fingerprint: "x", detail: { kind: "queue" } },
      }),
    }).reference;

    const result = await call(grabTool, contextFor(instance, state), {
      mode: "apply",
      releases: [foreign],
    });

    expect(outcomeFor(result, "sonarr").error?.code).toBe("invalid_input");
    expect(instance.requests.some((request) => request.method === "POST")).toBe(false);
  });

  it("discloses the effects in plan mode and sends nothing until the plan is applied", async () => {
    const { context, instance, releases } = await searched();
    const reference = releases[0]?.reference;

    const planned = await call(grabTool, context, { mode: "plan", releases: [reference] });
    expect(planned.status).toBe("ok");
    expect(grabDataFor(planned, "sonarr")).toMatchObject({ stage: "planned" });
    expect(planned.mutation?.requestedEffects).toHaveLength(1);
    expect(planned.mutation?.requestedEffects[0]?.severity).toBe("consequential");
    expect(planned.mutation?.readSet?.length).toBeGreaterThan(0);
    const plan = planned.mutation?.plan;
    expect(plan).toMatch(/^pln_/u);
    expect(instance.requests.some((request) => request.method === "POST")).toBe(false);

    const applied = await call(grabTool, context, { mode: "apply", plan });
    expect(applied.status).toBe("ok");
    expect(grabDataFor(applied, "sonarr")).toMatchObject({ stage: "applied", accepted: 1 });
    expect(instance.requests.filter((request) => request.method === "POST")).toHaveLength(1);
  });

  it("refuses a grab plan whose window has passed rather than grabbing on it", async () => {
    const clock = createManualClock(Date.now());
    const state = createWorkflowState({ clock });
    const { context, instance, releases } = await searched({ state });

    const planned = await call(grabTool, context, {
      mode: "plan",
      releases: [releases[0]?.reference],
    });
    clock.advance(referenceLifetimes.release + 1);

    const applied = await call(grabTool, context, {
      mode: "apply",
      plan: planned.mutation?.plan,
    });

    // A grab plan and the releases it names run out together — both kinds hold
    // the same lifetime, and neither may outlive the instance's own cache — so
    // the plan itself is what no longer resolves, and the caller is told to
    // plan again rather than being handed a grab this server cannot send.
    expect(referenceLifetimes.plan).toBe(referenceLifetimes.release);
    expect(applied.status).toBe("error");
    expect(applied.errors[0]?.code).toBe("stale_plan");
    expect(applied.errors[0]?.remediation).toContain("Create a new plan");
    expect(instance.requests.some((request) => request.method === "POST")).toBe(false);
  });

  it("stops grabbing the moment a selected reference runs out mid-call", async () => {
    const clock = createManualClock(Date.now());
    const state = createWorkflowState({ clock });
    // The first grab to reach the instance takes the whole window with it, so
    // every release still queued behind it is out of time by the time its own
    // request would go out. Resolving the references once up front would send
    // them anyway; each one is re-checked against the clock instead.
    const { context, instance, releases } = await searched({
      state,
      grab: () => {
        clock.advance(referenceLifetimes.release + 1);
        return jsonResponse({});
      },
    });
    expect(releases.length).toBeGreaterThan(2);

    const before = instance.requests.filter((request) => request.method === "POST").length;
    const result = await call(grabTool, context, {
      mode: "apply",
      releases: releases.map((release) => release.reference),
    });

    const posted = instance.requests.filter((request) => request.method === "POST").length - before;
    expect(posted).toBe(1);
    expect(result.status).toBe("partial");
    const items = outcomeFor(result, "sonarr").items ?? [];
    expect(items[0]?.status).toBe("ok");
    for (const item of items.slice(1)) {
      expect(item.status).toBe("error");
      expect(item.error?.code).toBe("stale_reference");
    }
  });

  it("returns the existing receipt when the same grab is repeated", async () => {
    const { context, instance, releases } = await searched();
    const args = { mode: "apply", releases: [releases[0]?.reference] };

    const first = await call(grabTool, context, args);
    const second = await call(grabTool, context, args);

    expect(second.mutation?.receipt).toEqual(first.mutation?.receipt);
    expect(outcomeFor(second, "sonarr").warnings.join(" ")).toContain("already applied");
    expect(instance.requests.filter((request) => request.method === "POST")).toHaveLength(1);
  });

  it("reports each release's own outcome when only some are accepted", async () => {
    const fixture = searchBodies.get("sonarr/release") as readonly Record<string, unknown>[];
    const refused = String(fixture[1]?.guid);
    const { context, releases } = await searched({
      grab: (request) =>
        (request.body as { guid: string }).guid === refused
          ? jsonResponse({ message: "canary-upstream-detail" }, 400)
          : jsonResponse({}),
    });

    const selected = releases.slice(0, 2).map((release) => release.reference);
    const result = await call(grabTool, context, { mode: "apply", releases: selected });

    expect(result.status).toBe("partial");
    expect(result.errors.some((error) => error.code === "partial_failure")).toBe(true);
    const items = outcomeFor(result, "sonarr").items ?? [];
    expect(items.map((item) => [item.reference, item.status])).toEqual([
      [selected[0], "ok"],
      [selected[1], "error"],
    ]);
    expect(items[1]?.error?.code).toBe("upstream_rejection");
    expect(JSON.stringify(result)).not.toContain("canary");
    expect(grabDataFor(result, "sonarr")).toMatchObject({ requested: 2, accepted: 1 });
  });

  it("fails the call when nothing was accepted, keeping every release's reason", async () => {
    const { context, releases } = await searched({
      grab: () => jsonResponse({ message: "no" }, 400),
    });
    const selected = releases.slice(0, 2).map((release) => release.reference);

    const result = await call(grabTool, context, { mode: "apply", releases: selected });

    expect(result.status).toBe("error");
    // Every release failed the same way, so that code and its remedy survive
    // rather than being flattened into a generic partial failure.
    expect(outcomeFor(result, "sonarr").error?.code).toBe("upstream_rejection");
    expect((outcomeFor(result, "sonarr").items ?? []).map((item) => item.status)).toEqual([
      "error",
      "error",
    ]);
    // Upstream refused it, so the receipt stays retryable rather than claiming
    // a mutation this server knows did not happen.
    expect(result.mutation?.receipt?.state).toBe("failed");
  });

  it("reports an unreachable application rather than a grab it cannot have sent", async () => {
    const { context, releases } = await searched();
    const offline = contextFor(upstream({ unreachable: true }), context.state);

    const result = await call(grabTool, offline, {
      mode: "apply",
      releases: [releases[0]?.reference],
    });

    expect(outcomeFor(result, "sonarr").status).toBe("unavailable");
    expect(outcomeFor(result, "sonarr").error?.code).toBe("unavailable_application");
  });
});

describe("release reference binding", () => {
  it("expires well inside the upstream search cache it stands for", () => {
    expect(referenceLifetimes.release).toBeLessThan(upstreamSearchCacheMs);
  });
});
