import { beforeEach, describe, expect, it } from "vitest";
import type { ApplicationId } from "../src/applications.js";
import type { FetchLike } from "../src/http/client.js";
import { createWorkflowState, type WorkflowState } from "../src/state/workflow.js";
import { findToolDefinition, type ToolDefinition } from "../src/tools/definitions.js";
import type { ToolContext } from "../src/tools/dispatch.js";
import { summarizeToolResult, type ToolResult } from "../src/tools/results.js";
import type { LibraryViewResult } from "../src/tools/schemas/library-results.js";
import { fixturePathFor, loadFixture } from "./support/fixtures.js";
import {
  allApplicationsEnvironment,
  createTestToolContext,
  fixtureRoot,
  jsonResponse,
  testApiKeys,
} from "./support/tool-context.js";

/**
 * `arr_library_change` add, monitoring, and edit intents, end to end.
 *
 * Every reference a mutation uses is obtained the way a caller obtains one: by
 * running `arr_library_query` first against the same context and using what it
 * published. Nothing is hand-minted except where a reference can only come from
 * configuration observation, which change 0008 owns and which is called out at
 * the one site that needs it.
 *
 * The instance below answers the recorded fixtures over the real upstream
 * client, and it applies writes to its own copy, so a test can assert both what
 * was sent and what a later read would see.
 */

const changeTool = findToolDefinition("arr_library_change") as ToolDefinition;
const queryTool = findToolDefinition("arr_library_query") as ToolDefinition;

const servedRoutes: Readonly<Record<string, readonly string[]>> = {
  sonarr: [
    "system/status",
    "series",
    "series/lookup",
    "episode",
    "rootfolder",
    "qualityprofile",
    "tag",
  ],
  radarr: [
    "system/status",
    "movie",
    "movie/lookup",
    "collection",
    "rootfolder",
    "qualityprofile",
    "tag",
  ],
  prowlarr: ["system/status"],
};

/** The collection route a single-record route belongs to. */
const singleRecordRoutes: Readonly<Record<string, string>> = {
  series: "series",
  episode: "episode",
  movie: "movie",
  collection: "collection",
};

interface RecordedRequest {
  readonly application: ApplicationId;
  readonly method: string;
  readonly route: string;
  readonly body?: Record<string, unknown> | undefined;
}

interface Instances {
  readonly requests: readonly RecordedRequest[];
  readonly fetch: FetchLike;
  /** The instance's current copy of one route's payload. */
  body(application: ApplicationId, route: string): unknown;
  replace(application: ApplicationId, route: string, body: unknown): void;
  /** Edits one record of a collection route, as a change made behind our back. */
  patch(
    application: ApplicationId,
    route: string,
    id: number,
    fields: Record<string, unknown>,
  ): void;
  /**
   * Makes one route answer with a status, as a struggling instance would.
   * Narrow it to one method to fail a write while its read still works.
   */
  failRoute(application: ApplicationId, route: string, status: number, method?: string): void;
  /** Accepts a create but answers with no body, so nothing confirms it. */
  silenceCreates(application: ApplicationId): void;
  /** Lets a route answer normally again. */
  healRoute(application: ApplicationId, route: string): void;
  /** Drops the connection on every write, as a lost answer would. */
  dropWrites(application: ApplicationId): void;
  stop(application: ApplicationId): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function applicationForUrl(url: URL): ApplicationId {
  for (const application of ["sonarr", "radarr", "prowlarr"] as const) {
    if (url.hostname === `${application}.example.invalid`) {
      return application;
    }
  }
  throw new Error(`Unexpected upstream host: ${url.hostname}`);
}

function routeOf(url: URL): string {
  const marker = /\/api\/v\d+\//u.exec(url.pathname);
  if (marker === null) {
    throw new Error(`Unexpected upstream path: ${url.pathname}`);
  }
  return url.pathname.slice(marker.index + marker[0].length);
}

async function createInstances(): Promise<Instances> {
  const bodies = new Map<string, unknown>();
  for (const [application, routes] of Object.entries(servedRoutes)) {
    for (const route of routes) {
      const fixture = await loadFixture(
        fixtureRoot,
        fixturePathFor(application as "sonarr" | "radarr" | "prowlarr", route),
      );
      bodies.set(`${application}/${route}`, structuredClone(fixture.body));
    }
  }

  const requests: RecordedRequest[] = [];
  const stopped = new Set<ApplicationId>();
  const failing = new Map<string, { status: number; method?: string | undefined }>();
  const silent = new Set<ApplicationId>();
  const dropped = new Set<ApplicationId>();
  const key = (application: ApplicationId, route: string) => `${application}/${route}`;

  const collectionOf = (application: ApplicationId, route: string): Record<string, unknown>[] => {
    const stored = bodies.get(key(application, route));
    return Array.isArray(stored) ? (stored as Record<string, unknown>[]) : [];
  };

  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    const application = applicationForUrl(url);
    if (stopped.has(application)) {
      throw new Error("connection refused");
    }
    if (
      init.headers === undefined ||
      (init.headers as Record<string, string>)["X-Api-Key"] !== testApiKeys[application]
    ) {
      return jsonResponse({ message: "unauthorized" }, 401);
    }

    const route = routeOf(url);
    const method = init.method ?? "GET";
    const raw = typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    requests.push({
      application,
      method,
      route,
      ...(isRecord(raw) ? { body: raw } : {}),
    });

    // Dropped after the request is recorded, because the point of this mode is
    // that the instance did receive it.
    if (method !== "GET" && dropped.has(application)) {
      throw new Error("connection reset");
    }

    const failure = failing.get(key(application, route));
    if (failure !== undefined && (failure.method === undefined || failure.method === method)) {
      return jsonResponse({ message: "instance error" }, failure.status);
    }

    const single = /^([a-z]+)\/(\d+)$/u.exec(route);
    const collection = single === null ? undefined : singleRecordRoutes[single[1] ?? ""];
    const id = single === null ? undefined : Number(single[2]);

    if (method === "PUT" && collection !== undefined && id !== undefined && isRecord(raw)) {
      const stored = collectionOf(application, collection);
      const index = stored.findIndex((record) => record.id === id);
      if (index < 0) {
        return jsonResponse({ message: "not found" }, 404);
      }
      stored[index] = raw;
      return jsonResponse(raw);
    }

    if (method === "POST" && isRecord(raw)) {
      const created = { ...raw, id: 999 };
      collectionOf(application, route).push(created);
      return silent.has(application)
        ? new Response(null, { status: 201 })
        : jsonResponse(created, 201);
    }

    if (collection !== undefined && id !== undefined) {
      const found = collectionOf(application, collection).find((record) => record.id === id);
      return found === undefined
        ? jsonResponse({ message: "not found" }, 404)
        : jsonResponse(found);
    }

    const stored = bodies.get(key(application, route));
    return stored === undefined
      ? jsonResponse({ message: "not found" }, 404)
      : jsonResponse(stored);
  };

  return {
    requests,
    fetch,
    body: (application, route) => bodies.get(key(application, route)),
    replace: (application, route, body) => {
      bodies.set(key(application, route), body);
    },
    patch: (application, route, id, fields) => {
      const stored = collectionOf(application, route);
      const index = stored.findIndex((record) => record.id === id);
      const current = stored[index];
      if (index < 0 || current === undefined) {
        throw new Error(`No ${application} ${route} record ${id}`);
      }
      stored[index] = { ...current, ...fields };
    },
    failRoute: (application, route, status, method) => {
      failing.set(key(application, route), { status, method });
    },
    silenceCreates: (application) => {
      silent.add(application);
    },
    healRoute: (application, route) => {
      failing.delete(key(application, route));
    },
    dropWrites: (application) => {
      dropped.add(application);
    },
    stop: (application) => {
      stopped.add(application);
    },
  };
}

let instances: Instances;
let state: WorkflowState;
let context: ToolContext;

beforeEach(async () => {
  instances = await createInstances();
  state = createWorkflowState();
  context = createTestToolContext({
    environment: allApplicationsEnvironment,
    fetch: instances.fetch,
    state,
  });
});

async function run(definition: ToolDefinition, args: unknown): Promise<ToolResult<unknown>> {
  const parsed = definition.inputSchema.safeParse(args);
  if (!parsed.success) {
    throw new Error(`Arguments rejected by the published schema: ${parsed.error.message}`);
  }
  const result = await definition.handle(context, parsed.data);
  expect(definition.outputSchema.safeParse(result).success).toBe(true);
  return result;
}

const change = (args: unknown) => run(changeTool, args);

async function view(args: Record<string, unknown>): Promise<LibraryViewResult> {
  const result = await run(queryTool, args);
  const outcome = result.applications[0];
  if (outcome?.status !== "ok" || outcome.data === undefined) {
    throw new Error(`The query did not succeed: ${outcome?.error?.code ?? "no outcome"}`);
  }
  return outcome.data as LibraryViewResult;
}

async function seriesRecords() {
  const data = await view({ view: "series", detail: "full", applications: ["sonarr"] });
  if (data.view !== "series") {
    throw new Error("Expected the series view");
  }
  return data.items;
}

async function movieRecords() {
  const data = await view({ view: "movies", detail: "full", applications: ["radarr"] });
  if (data.view !== "movies") {
    throw new Error("Expected the movies view");
  }
  return data.items;
}

async function lookupCandidate(application: "sonarr" | "radarr", title: string) {
  const data = await view({ view: "lookup", term: "example", applications: [application] });
  if (data.view !== "lookup") {
    throw new Error("Expected the lookup view");
  }
  const found = data.items.find((item) => item.title === title);
  if (found?.reference === undefined) {
    throw new Error(`No lookup candidate named ${title}`);
  }
  return { ...found, reference: found.reference };
}

function seriesByTitle(records: Awaited<ReturnType<typeof seriesRecords>>, title: string) {
  const found = records.find((record) => record.title === title);
  if (found === undefined) {
    throw new Error(`No recorded series named ${title}`);
  }
  return found;
}

function requireReference(reference: string | undefined, what: string): string {
  if (reference === undefined) {
    throw new Error(`The query published no ${what} reference`);
  }
  return reference;
}

function writes(application: ApplicationId): readonly RecordedRequest[] {
  return instances.requests.filter(
    (request) => request.application === application && request.method !== "GET",
  );
}

function outcomeFor(result: ToolResult<unknown>, application: ApplicationId) {
  const outcome = result.applications.find((entry) => entry.application === application);
  if (outcome === undefined) {
    throw new Error(`No outcome for ${application}`);
  }
  return outcome;
}

function planReference(result: ToolResult<unknown>): string {
  const reference = result.mutation?.plan;
  if (reference === undefined) {
    throw new Error("The plan minted no plan reference");
  }
  return reference;
}

/** Every error the envelope carries, wherever it recorded it. */
function errorCodes(result: ToolResult<unknown>): readonly string[] {
  return [
    ...result.errors.map((error) => error.code),
    ...result.applications.flatMap((outcome) => [
      ...(outcome.error === undefined ? [] : [outcome.error.code]),
      ...(outcome.items ?? []).flatMap((item) =>
        item.error === undefined ? [] : [item.error.code],
      ),
    ]),
  ];
}

describe("arr_library_change add_media", () => {
  it("plans an add without creating anything and applies the recorded plan", async () => {
    const candidate = await lookupCandidate("sonarr", "Example New Series");
    const series = seriesByTitle(await seriesRecords(), "Example Series");

    const planned = await change({
      intent: "add_media",
      mode: "plan",
      application: "sonarr",
      lookup: candidate.reference,
      rootFolder: requireReference(series.rootFolder?.reference, "root folder"),
      qualityProfile: requireReference(series.qualityProfile?.reference, "quality profile"),
      monitor: "all",
      searchOnAdd: false,
    });

    expect(planned.status).toBe("ok");
    expect(planned.mutation?.requestedEffects).toEqual([
      {
        application: "sonarr",
        severity: "consequential",
        summary: "add “Example New Series” to the library",
      },
    ]);
    // Plan mode validated the candidate and its dependencies, and wrote nothing.
    expect((planned.mutation?.readSet ?? []).map((entry) => entry.key).sort()).toEqual([
      `lookup:${candidate.reference}`,
      expect.stringContaining("qualityProfile:"),
      expect.stringContaining("rootFolder:"),
    ]);
    expect(writes("sonarr")).toEqual([]);

    const applied = await change({ mode: "apply", plan: planReference(planned) });

    expect(applied.status).toBe("ok");
    expect(applied.mutation?.receipt).toMatchObject({ state: "succeeded" });
    expect(writes("sonarr")).toEqual([
      expect.objectContaining({ method: "POST", route: "series" }),
    ]);
    expect(writes("sonarr")[0]?.body).toMatchObject({
      tvdbId: 100004,
      rootFolderPath: "/media/example/series",
      qualityProfileId: 1,
      monitored: true,
      addOptions: { monitor: "all", searchForMissingEpisodes: false },
    });
  });

  it("launches a search only when the caller asked for one", async () => {
    const candidate = await lookupCandidate("radarr", "Example Unadded Movie");
    const movie = (await movieRecords())[0];

    const applied = await change({
      intent: "add_media",
      mode: "apply",
      application: "radarr",
      lookup: candidate.reference,
      rootFolder: requireReference(movie?.rootFolder?.reference, "root folder"),
      qualityProfile: requireReference(movie?.qualityProfile?.reference, "quality profile"),
      monitor: "all",
      searchOnAdd: true,
    });

    expect(applied.status).toBe("ok");
    // The search is its own disclosed effect rather than a silent consequence.
    expect(applied.mutation?.requestedEffects).toEqual([
      expect.objectContaining({ summary: "add “Example Unadded Movie” to the library" }),
      expect.objectContaining({
        summary: "start an acquisition search for “Example Unadded Movie”",
      }),
    ]);
    expect(writes("radarr")[0]?.body).toMatchObject({
      tmdbId: 200004,
      addOptions: { monitor: "movieOnly", searchForMovie: true },
    });
  });

  it("reports an add the instance never confirmed as unresolved, not as a success", async () => {
    const candidate = await lookupCandidate("sonarr", "Example New Series");
    const series = seriesByTitle(await seriesRecords(), "Example Series");
    instances.silenceCreates("sonarr");

    const applied = await change({
      intent: "add_media",
      mode: "apply",
      application: "sonarr",
      lookup: candidate.reference,
      rootFolder: requireReference(series.rootFolder?.reference, "root folder"),
      qualityProfile: requireReference(series.qualityProfile?.reference, "quality profile"),
      monitor: "all",
      searchOnAdd: false,
    });

    // The request was sent and may well have been accepted, so the receipt
    // stays reconcilable — and the envelope and its summary say so rather than
    // reporting a record nothing observed.
    expect(writes("sonarr")).toHaveLength(1);
    expect(applied.mutation?.receipt).toMatchObject({ state: "outcome_unknown" });
    expect(applied.status).toBe("error");
    expect(errorCodes(applied)).toContain("conflict");
    expect(summarizeToolResult("arr_library_change", applied)).toContain("conflict");
  });

  it("refuses a plan whose candidate is no longer the one it disclosed", async () => {
    const candidate = await lookupCandidate("sonarr", "Example New Series");
    const series = seriesByTitle(await seriesRecords(), "Example Series");
    const planned = await change({
      intent: "add_media",
      mode: "plan",
      application: "sonarr",
      lookup: candidate.reference,
      rootFolder: requireReference(series.rootFolder?.reference, "root folder"),
      qualityProfile: requireReference(series.qualityProfile?.reference, "quality profile"),
      monitor: "all",
      searchOnAdd: false,
    });

    // The plan disclosed the title it would add, so applying it must not add a
    // different one.
    const lookups = instances.body("sonarr", "series/lookup") as Record<string, unknown>[];
    instances.replace(
      "sonarr",
      "series/lookup",
      lookups.map((entry) =>
        entry.tvdbId === 100004 ? { ...entry, title: "Example Renamed Series" } : entry,
      ),
    );

    const applied = await change({ mode: "apply", plan: planReference(planned) });

    expect(errorCodes(applied)).toContain("stale_plan");
    expect(writes("sonarr")).toEqual([]);
  });

  it("refuses to add a candidate the library already holds", async () => {
    const candidate = await lookupCandidate("sonarr", "Example Series");
    const series = seriesByTitle(await seriesRecords(), "Example Series");

    const applied = await change({
      intent: "add_media",
      mode: "apply",
      application: "sonarr",
      lookup: candidate.reference,
      rootFolder: requireReference(series.rootFolder?.reference, "root folder"),
      qualityProfile: requireReference(series.qualityProfile?.reference, "quality profile"),
      monitor: "all",
      searchOnAdd: false,
    });

    expect(applied.status).toBe("error");
    expect(errorCodes(applied)).toContain("conflict");
    expect(outcomeFor(applied, "sonarr").error?.message).toContain("already in this library");
    expect(writes("sonarr")).toEqual([]);
  });

  it("refuses a configuration reference of the wrong kind before reading anything", async () => {
    const candidate = await lookupCandidate("sonarr", "Example New Series");
    const series = seriesByTitle(await seriesRecords(), "Example Series");
    const rootFolder = requireReference(series.rootFolder?.reference, "root folder");
    const before = instances.requests.length;

    const applied = await change({
      intent: "add_media",
      mode: "apply",
      application: "sonarr",
      lookup: candidate.reference,
      rootFolder,
      // A root folder is not a quality profile, and only this tool knows that:
      // both are published as the same reference kind.
      qualityProfile: rootFolder,
      monitor: "all",
      searchOnAdd: false,
    });

    expect(errorCodes(applied)).toContain("invalid_input");
    expect(
      instances.requests.slice(before).filter((request) => request.route === "qualityprofile"),
    ).toEqual([]);
    expect(writes("sonarr")).toEqual([]);
  });

  it("refuses a dependency the instance no longer has", async () => {
    const candidate = await lookupCandidate("sonarr", "Example New Series");
    const series = seriesByTitle(await seriesRecords(), "Example Series");
    instances.replace("sonarr", "qualityprofile", []);

    const applied = await change({
      intent: "add_media",
      mode: "apply",
      application: "sonarr",
      lookup: candidate.reference,
      rootFolder: requireReference(series.rootFolder?.reference, "root folder"),
      qualityProfile: requireReference(series.qualityProfile?.reference, "quality profile"),
      monitor: "all",
      searchOnAdd: false,
    });

    expect(errorCodes(applied)).toContain("stale_reference");
    expect(writes("sonarr")).toEqual([]);
  });

  it("refuses a monitor selection the application does not model", async () => {
    const candidate = await lookupCandidate("radarr", "Example Unadded Movie");
    const movie = (await movieRecords())[0];

    const applied = await change({
      intent: "add_media",
      mode: "plan",
      application: "radarr",
      lookup: candidate.reference,
      rootFolder: requireReference(movie?.rootFolder?.reference, "root folder"),
      qualityProfile: requireReference(movie?.qualityProfile?.reference, "quality profile"),
      // Radarr monitors a movie or does not; "future" describes part of a series.
      monitor: "future",
      searchOnAdd: false,
    });

    expect(errorCodes(applied)).toContain("unsupported_capability");
    expect(writes("radarr")).toEqual([]);
  });

  it("reports an unreachable instance without sending the mutation", async () => {
    const candidate = await lookupCandidate("sonarr", "Example New Series");
    const series = seriesByTitle(await seriesRecords(), "Example Series");
    instances.stop("sonarr");

    const applied = await change({
      intent: "add_media",
      mode: "apply",
      application: "sonarr",
      lookup: candidate.reference,
      rootFolder: requireReference(series.rootFolder?.reference, "root folder"),
      qualityProfile: requireReference(series.qualityProfile?.reference, "quality profile"),
      monitor: "all",
      searchOnAdd: false,
    });

    expect(errorCodes(applied)).toContain("unavailable_application");
    expect(writes("sonarr")).toEqual([]);
  });
});

describe("arr_library_change set_monitoring", () => {
  it("reports per-record outcomes and sends nothing for a record already in state", async () => {
    const records = await seriesRecords();
    const monitored = seriesByTitle(records, "Example Series");
    const unmonitored = seriesByTitle(records, "Example Retired Series");

    const applied = await change({
      intent: "set_monitoring",
      mode: "apply",
      items: [monitored.reference, unmonitored.reference],
      monitored: true,
    });

    expect(applied.status).toBe("ok");
    expect(outcomeFor(applied, "sonarr").items).toEqual([
      expect.objectContaining({
        reference: monitored.reference,
        status: "ok",
        warnings: [expect.stringContaining("already matched the requested state")],
      }),
      expect.objectContaining({ reference: unmonitored.reference, status: "ok", warnings: [] }),
    ]);
    // Only the record that actually moves is written back.
    expect(writes("sonarr")).toEqual([
      expect.objectContaining({ method: "PUT", route: "series/14" }),
    ]);
    expect(writes("sonarr")[0]?.body).toMatchObject({
      id: 14,
      monitored: true,
      // A field this project does not model survives the round trip, because
      // these APIs replace the whole resource.
      titleSlug: "example-retired-series",
    });
  });

  it("monitors one season without disturbing the rest of its series", async () => {
    const series = seriesByTitle(await seriesRecords(), "Example Series");
    const seasons = await view({
      view: "seasons",
      series: series.reference,
      applications: ["sonarr"],
    });
    if (seasons.view !== "seasons") {
      throw new Error("Expected the seasons view");
    }
    const second = seasons.items.find((item) => item.sonarr.seasonNumber === 2);

    const applied = await change({
      intent: "set_monitoring",
      mode: "apply",
      items: [requireReference(second?.reference, "season")],
      monitored: true,
    });

    expect(applied.status).toBe("ok");
    expect(writes("sonarr")).toEqual([
      expect.objectContaining({ method: "PUT", route: "series/12" }),
    ]);
    expect(writes("sonarr")[0]?.body?.seasons).toEqual([
      expect.objectContaining({ seasonNumber: 1, monitored: true }),
      expect.objectContaining({ seasonNumber: 2, monitored: true }),
    ]);
  });

  it("sends one request for two records that share a resource", async () => {
    // Both seasons start monitored, so both of them change — which is what makes
    // a per-item write observable: the second would revert the first.
    instances.patch("sonarr", "series", 12, {
      seasons: [
        { seasonNumber: 1, monitored: true },
        { seasonNumber: 2, monitored: true },
      ],
    });
    const series = seriesByTitle(await seriesRecords(), "Example Series");
    const seasons = await view({
      view: "seasons",
      series: series.reference,
      applications: ["sonarr"],
    });
    if (seasons.view !== "seasons") {
      throw new Error("Expected the seasons view");
    }

    const applied = await change({
      intent: "set_monitoring",
      mode: "apply",
      items: seasons.items.map((item) => item.reference),
      monitored: false,
    });

    expect(applied.status).toBe("ok");
    // Both seasons live in the one series resource, so it is sent once carrying
    // both changes. One request per item would send the second resource over
    // the first and silently undo it.
    expect(writes("sonarr")).toEqual([
      expect.objectContaining({ method: "PUT", route: "series/12" }),
    ]);
    expect(writes("sonarr")[0]?.body?.seasons).toEqual([
      expect.objectContaining({ seasonNumber: 1, monitored: false }),
      expect.objectContaining({ seasonNumber: 2, monitored: false }),
    ]);
    expect(outcomeFor(applied, "sonarr").items).toEqual([
      expect.objectContaining({ reference: seasons.items[0]?.reference, status: "ok" }),
      expect.objectContaining({ reference: seasons.items[1]?.reference, status: "ok" }),
    ]);
  });

  it("keeps a series change and one of its own seasons in the same request", async () => {
    const series = seriesByTitle(await seriesRecords(), "Example Series");
    const seasons = await view({
      view: "seasons",
      series: series.reference,
      applications: ["sonarr"],
    });
    if (seasons.view !== "seasons") {
      throw new Error("Expected the seasons view");
    }
    const second = seasons.items.find((item) => item.sonarr.seasonNumber === 2);

    const applied = await change({
      intent: "set_monitoring",
      mode: "apply",
      items: [series.reference, requireReference(second?.reference, "season")],
      monitored: false,
    });

    expect(applied.status).toBe("ok");
    // A season is not its own upstream resource: it lives in its series. The
    // two selections are one write, or the second would undo the first.
    expect(writes("sonarr")).toEqual([
      expect.objectContaining({ method: "PUT", route: "series/12" }),
    ]);
    expect(writes("sonarr")[0]?.body).toMatchObject({ monitored: false });
    expect(writes("sonarr")[0]?.body?.seasons).toEqual([
      expect.objectContaining({ seasonNumber: 1, monitored: true }),
      expect.objectContaining({ seasonNumber: 2, monitored: false }),
    ]);
  });

  it("returns the working item and the failed item together", async () => {
    const records = await seriesRecords();
    const kept = seriesByTitle(records, "Example Retired Series");
    const removed = seriesByTitle(records, "Example Anime");
    // The record is gone from the instance, which is what a bulk request finds
    // when one of its selections was deleted after the query that listed it.
    instances.replace(
      "sonarr",
      "series",
      (instances.body("sonarr", "series") as Record<string, unknown>[]).filter(
        (record) => record.id !== 13,
      ),
    );

    const applied = await change({
      intent: "set_monitoring",
      mode: "apply",
      items: [kept.reference, removed.reference],
      monitored: true,
    });

    expect(applied.status).toBe("partial");
    expect(errorCodes(applied)).toContain("stale_reference");
    expect(errorCodes(applied)).toContain("partial_failure");
    expect(outcomeFor(applied, "sonarr").items).toEqual([
      expect.objectContaining({ reference: kept.reference, status: "ok" }),
      expect.objectContaining({ reference: removed.reference, status: "error" }),
    ]);
    // The item that could be changed still was; a bulk change is not
    // transactional and never claims to be.
    expect(writes("sonarr")).toEqual([
      expect.objectContaining({ method: "PUT", route: "series/14" }),
    ]);
    // The summary a host may show on its own must not read better than that.
    expect(summarizeToolResult("arr_library_change", applied)).toContain("1 item(s) failed");
  });

  it("keeps the receipt retryable when an item failed before anything was sent", async () => {
    const records = await seriesRecords();
    const readable = seriesByTitle(records, "Example Retired Series");
    const unreadable = seriesByTitle(records, "Example Series");
    // A failure this server cannot interpret, so it proves nothing on its own —
    // but it happened while reading, so nothing was sent for that item.
    instances.failRoute("sonarr", "series/12", 500);

    const applied = await change({
      intent: "set_monitoring",
      mode: "apply",
      items: [readable.reference, unreadable.reference],
      monitored: true,
    });

    expect(errorCodes(applied)).toContain("unexpected_response");
    // The receipt stays settled, because a mutation nothing was sent for must
    // not be closed to a later retry.
    expect(applied.mutation?.receipt).toMatchObject({ state: "succeeded" });
    expect(writes("sonarr")).toEqual([
      expect.objectContaining({ method: "PUT", route: "series/14" }),
    ]);
  });

  it("keeps a write whose answer was lost reconcilable rather than calling it failed", async () => {
    const series = seriesByTitle(await seriesRecords(), "Example Series");
    instances.dropWrites("sonarr");
    const intent = {
      intent: "set_monitoring",
      mode: "apply",
      items: [series.reference],
      monitored: false,
    };

    const applied = await change(intent);

    // The request was sent and the answer never arrived. Every item reports an
    // error, which is exactly what an apply that reached nothing looks like —
    // and settling on that resemblance would record a mutation that may have
    // applied as one that certainly did not.
    expect(writes("sonarr")).toHaveLength(1);
    expect(applied.status).toBe("error");
    expect(applied.mutation?.receipt).toMatchObject({ state: "outcome_unknown" });
    expect(errorCodes(applied)).toContain("unavailable_application");

    // A repeat is answered from that receipt rather than sending it again,
    // which is the whole point of not rounding down to `failed`.
    const repeated = await change(intent);
    expect(writes("sonarr")).toHaveLength(1);
    expect(repeated.mutation?.receipt?.reference).toBe(applied.mutation?.receipt?.reference);
  });

  it("leaves an apply that reached nothing retryable with the same input", async () => {
    const series = seriesByTitle(await seriesRecords(), "Example Series");
    instances.failRoute("sonarr", "series/12", 500);
    const intent = {
      intent: "set_monitoring",
      mode: "apply",
      items: [series.reference],
      monitored: false,
    };

    const first = await change(intent);
    expect(first.status).toBe("error");
    expect(writes("sonarr")).toEqual([]);
    // Nothing was sent, so the receipt records a failure rather than a success:
    // a failure is the one state a later identical attempt may reuse.
    expect(first.mutation?.receipt).toMatchObject({ state: "failed" });
    expect(outcomeFor(first, "sonarr").items).toEqual([
      expect.objectContaining({ reference: series.reference, status: "error" }),
    ]);

    const attempts = instances.requests.filter((request) => request.route === "series/12").length;
    const second = await change(intent);

    // The repeat really is attempted again rather than answered from the
    // receipt, which is what makes a transient read failure recoverable.
    expect(
      instances.requests.filter((request) => request.route === "series/12").length,
    ).toBeGreaterThan(attempts);
    expect(second.status).toBe("error");
  });

  it("refuses a plan whose unreadable item became readable again", async () => {
    const records = await seriesRecords();
    const readable = seriesByTitle(records, "Example Retired Series");
    const unreadable = seriesByTitle(records, "Example Anime");
    instances.failRoute("sonarr", "series/13", 500);

    const planned = await change({
      intent: "set_monitoring",
      mode: "plan",
      items: [readable.reference, unreadable.reference],
      monitored: true,
    });
    // The plan reported the item as unchangeable, so it is fingerprinted too:
    // a plan that made no claim about it could later mutate it unannounced.
    expect((planned.mutation?.readSet ?? []).map((entry) => entry.key).sort()).toEqual(
      [`media:${readable.reference}`, `media:${unreadable.reference}`].sort(),
    );

    instances.healRoute("sonarr", "series/13");
    const applied = await change({ mode: "apply", plan: planReference(planned) });

    expect(errorCodes(applied)).toContain("stale_plan");
    expect(writes("sonarr")).toEqual([]);
  });

  it("refuses a plan whose record changed underneath it", async () => {
    const series = seriesByTitle(await seriesRecords(), "Example Retired Series");
    const planned = await change({
      intent: "set_monitoring",
      mode: "plan",
      items: [series.reference],
      monitored: true,
    });
    expect(planned.mutation?.readSet).toEqual([
      { key: `media:${series.reference}`, digest: expect.any(String) },
    ]);

    instances.patch("sonarr", "series", 14, { qualityProfileId: 4 });
    const applied = await change({ mode: "apply", plan: planReference(planned) });

    expect(errorCodes(applied)).toContain("stale_plan");
    expect(writes("sonarr")).toEqual([]);
  });

  it("repeats a partial bulk apply as the partial result it was", async () => {
    const records = await seriesRecords();
    const applied = seriesByTitle(records, "Example Series");
    const rejected = seriesByTitle(records, "Example Anime");
    // The read still works, so the item is validated and sent; the instance
    // then refuses the write itself.
    instances.failRoute("sonarr", "series/13", 400, "PUT");
    const intent = {
      intent: "set_monitoring",
      mode: "apply",
      items: [applied.reference, rejected.reference],
      monitored: false,
    };

    const first = await change(intent);
    expect(first.status).toBe("partial");
    expect(errorCodes(first)).toContain("upstream_rejection");

    const repeated = await change(intent);

    // The receipt is the whole of what a repeat is answered from, so it has to
    // carry the item that failed; reporting a clean success here would conceal
    // the partial failure the caller repeated the call to see.
    expect(repeated.status).toBe("partial");
    expect(errorCodes(repeated)).toContain("upstream_rejection");
    expect(outcomeFor(repeated, "sonarr").items).toEqual([
      expect.objectContaining({ reference: applied.reference, status: "ok" }),
      expect.objectContaining({ reference: rejected.reference, status: "error" }),
    ]);
    expect(writes("sonarr")).toHaveLength(2);
  });

  it("answers a repeated apply from its receipt instead of sending it again", async () => {
    const series = seriesByTitle(await seriesRecords(), "Example Retired Series");
    const intent = {
      intent: "set_monitoring",
      mode: "apply",
      items: [series.reference],
      monitored: true,
    };

    const first = await change(intent);
    const second = await change(intent);

    expect(first.mutation?.receipt).toMatchObject({ state: "succeeded" });
    expect(second.mutation?.receipt?.reference).toBe(first.mutation?.receipt?.reference);
    expect(outcomeFor(second, "sonarr").warnings).toEqual([
      expect.stringContaining("already applied by this server"),
    ]);
    expect(writes("sonarr")).toHaveLength(1);
  });
});

describe("arr_library_change edit_media", () => {
  it("applies typed profile and tag changes against each record's own tags", async () => {
    const records = await seriesRecords();
    const target = seriesByTitle(records, "Example Series");
    const anime = seriesByTitle(records, "Example Anime");
    const archived = seriesByTitle(records, "Example Retired Series");
    const archiveTag = archived.tags?.find((tag) => tag.id === "4");

    const applied = await change({
      intent: "edit_media",
      mode: "apply",
      items: [target.reference],
      changes: {
        qualityProfile: requireReference(anime.qualityProfile?.reference, "quality profile"),
        tags: {
          add: [requireReference(archiveTag?.reference, "tag")],
          remove: [requireReference(target.tags?.[0]?.reference, "tag")],
        },
      },
    });

    expect(applied.status).toBe("ok");
    expect(applied.mutation?.requestedEffects).toEqual([
      expect.objectContaining({ summary: "change the quality profile of 1 record(s)" }),
      expect.objectContaining({ summary: "change the tags of 1 record(s)" }),
    ]);
    expect(writes("sonarr")[0]?.body).toMatchObject({
      id: 12,
      qualityProfileId: 2,
      // Removed and added against the record's own list rather than replacing it.
      tags: [4],
    });
  });

  it("re-points a record at another root folder without moving files", async () => {
    const series = seriesByTitle(await seriesRecords(), "Example Series");
    // The archive root is in the instance's root-folder list but no library
    // record uses it, so no query publishes a reference for it. Configuration
    // observation (change 0008) is what will; until then the reference is
    // minted here in exactly the shape that change produces.
    const archiveRoot = state.references.mint({
      kind: "configuration",
      applications: ["sonarr"],
      payload: () => ({
        kind: "domain",
        snapshot: { upstreamId: "2", fingerprint: "test", detail: { kind: "root_folder" } },
      }),
    }).reference;

    const applied = await change({
      intent: "edit_media",
      mode: "apply",
      items: [series.reference],
      changes: { rootFolder: archiveRoot },
    });

    expect(applied.status).toBe("ok");
    expect(outcomeFor(applied, "sonarr").warnings).toEqual([
      expect.stringContaining("no file is moved on disk"),
    ]);
    expect(writes("sonarr")[0]?.body).toMatchObject({
      rootFolderPath: "/media/example/archive",
      // The record keeps its own folder under the new root.
      path: "/media/example/archive/Example Series",
    });
  });

  it("refuses an application-specific field the target application does not model", async () => {
    const movie = (await movieRecords())[0];

    const applied = await change({
      intent: "edit_media",
      mode: "apply",
      items: [requireReference(movie?.reference, "movie")],
      // The series type is Sonarr's; a whole-resource write would otherwise
      // tell Radarr something that is not true of a movie.
      changes: { seriesType: "anime" },
    });

    expect(errorCodes(applied)).toContain("unsupported_capability");
    expect(writes("radarr")).toEqual([]);

    const series = seriesByTitle(await seriesRecords(), "Example Series");
    const reversed = await change({
      intent: "edit_media",
      mode: "apply",
      items: [series.reference],
      changes: { minimumAvailability: "released" },
    });

    expect(errorCodes(reversed)).toContain("unsupported_capability");
    expect(writes("sonarr")).toEqual([]);
  });

  it("refuses a record kind that owns none of the edited fields", async () => {
    const series = seriesByTitle(await seriesRecords(), "Example Series");
    const episodes = await view({
      view: "episodes",
      series: series.reference,
      applications: ["sonarr"],
    });
    if (episodes.view !== "episodes") {
      throw new Error("Expected the episodes view");
    }

    const applied = await change({
      intent: "edit_media",
      mode: "apply",
      items: [requireReference(episodes.items[0]?.reference, "episode")],
      changes: { monitored: false },
    });

    expect(errorCodes(applied)).toContain("unsupported_capability");
    expect(writes("sonarr")).toEqual([]);
  });

  it("predicts nothing for a selection that is already in the requested state", async () => {
    const series = seriesByTitle(await seriesRecords(), "Example Series");

    const planned = await change({
      intent: "edit_media",
      mode: "plan",
      items: [series.reference],
      changes: { monitored: true, seriesType: "standard" },
    });

    expect(planned.mutation?.requestedEffects).toHaveLength(2);
    expect(planned.mutation?.predictedEffects).toEqual([]);
    expect(outcomeFor(planned, "sonarr").warnings).toEqual([
      expect.stringContaining("already matches the requested state"),
    ]);
  });
});

describe("arr_library_change disclosure", () => {
  it("keeps upstream payload content and credentials out of every published field", async () => {
    const canary = "CANARY-SECRET-DO-NOT-LEAK";
    instances.patch("sonarr", "series", 14, { cleanTitle: canary, imdbId: canary });

    const series = seriesByTitle(await seriesRecords(), "Example Retired Series");
    const planned = await change({
      intent: "set_monitoring",
      mode: "plan",
      items: [series.reference],
      monitored: true,
    });
    const applied = await change({ mode: "apply", plan: planReference(planned) });

    const published = [
      JSON.stringify(planned),
      JSON.stringify(applied),
      summarizeToolResult("arr_library_change", planned),
      summarizeToolResult("arr_library_change", applied),
      // The retained plan record is process-local, and must hold the caller's
      // intent rather than the upstream payload the plan was validated against.
      JSON.stringify(state.plans.resolve(planReference(planned))),
    ].join("\n");

    expect(published).not.toContain(canary);
    expect(published).not.toContain(testApiKeys.sonarr);
    expect(published).not.toContain("example.invalid");
    // The value is still carried back to the instance untouched, which is the
    // whole reason a write is a read-modify-write.
    expect(writes("sonarr")[0]?.body).toMatchObject({ cleanTitle: canary });
  });

  it("rejects a reference from a previous process lifetime for the whole call", async () => {
    const foreign = createWorkflowState();
    const stale = foreign.references.mint({
      kind: "media",
      applications: ["sonarr"],
      payload: () => ({
        kind: "domain",
        snapshot: { upstreamId: "12", fingerprint: "test", detail: { kind: "series" } },
      }),
    }).reference;

    const applied = await change({
      intent: "set_monitoring",
      mode: "apply",
      items: [stale],
      monitored: false,
    });

    expect(errorCodes(applied)).toContain("stale_reference");
    expect(instances.requests).toEqual([]);
  });
});
