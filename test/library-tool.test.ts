import { afterEach, describe, expect, it } from "vitest";
import { libraryViews } from "../src/adapters/library/requests.js";
import { applicationIds } from "../src/applications.js";
import { createWorkflowState, type WorkflowState } from "../src/state/workflow.js";
import { reportCapabilities } from "../src/tools/capabilities.js";
import { findToolDefinition, type ToolDefinition } from "../src/tools/definitions.js";
import type { ToolContext } from "../src/tools/dispatch.js";
import type { ToolResult } from "../src/tools/results.js";
import { defaultPageSize, maxPageSize } from "../src/tools/schemas/common.js";
import { maxCalendarWindowDays } from "../src/tools/schemas/library.js";
import type { LibraryViewResult } from "../src/tools/schemas/library-results.js";
import {
  type FixtureInstance,
  instanceEnvironment,
  startFixtureInstance,
} from "./support/instance-server.js";
import { createTestToolContext, sampleReferences } from "./support/tool-context.js";

const definition = findToolDefinition("arr_library_query") as ToolDefinition;

const started: FixtureInstance[] = [];

async function instance(
  application: "sonarr" | "radarr",
  options: { unreachable?: boolean } = {},
): Promise<FixtureInstance> {
  const running = await startFixtureInstance(application, options);
  started.push(running);
  return running;
}

afterEach(async () => {
  await Promise.all(started.splice(0).map((running) => running.close()));
});

function parseInput(value: unknown) {
  return definition.inputSchema.safeParse(value);
}

function calendarWindow(start: string, end: string): boolean {
  return parseInput({ view: "calendar", start, end }).success;
}

/**
 * Calls the registered tool the way its host does: validate against the
 * published schema first, then hand the parsed arguments to the definition.
 * A call whose arguments the schema rejects never reaches an adapter.
 */
async function call(context: ToolContext, args: unknown): Promise<ToolResult<unknown>> {
  const parsed = parseInput(args);
  if (!parsed.success) {
    throw new Error(`Arguments rejected by the published schema: ${parsed.error.message}`);
  }
  const result = await definition.handle(context, parsed.data);
  expect(definition.outputSchema.safeParse(result).success).toBe(true);
  return result;
}

function dataFor(result: ToolResult<unknown>, application: string): LibraryViewResult {
  const outcome = result.applications.find((entry) => entry.application === application);
  if (outcome === undefined) {
    throw new Error(`No outcome for ${application}`);
  }
  if (outcome.status !== "ok") {
    throw new Error(`${application} did not succeed: ${outcome.error?.code ?? "unknown"}`);
  }
  return outcome.data as LibraryViewResult;
}

describe("arr_library_query input schema", () => {
  it("accepts each view's minimal arguments and applies the bounded defaults", () => {
    const minimal: Readonly<Record<string, Record<string, unknown>>> = {
      series: { view: "series" },
      seasons: { view: "seasons", series: sampleReferences.media },
      episodes: { view: "episodes", series: sampleReferences.media },
      episode_files: { view: "episode_files", series: sampleReferences.media },
      missing_episodes: { view: "missing_episodes" },
      cutoff_unmet_episodes: { view: "cutoff_unmet_episodes" },
      movies: { view: "movies" },
      collections: { view: "collections" },
      movie_files: { view: "movie_files", movie: sampleReferences.media },
      missing_movies: { view: "missing_movies" },
      cutoff_unmet_movies: { view: "cutoff_unmet_movies" },
      calendar: { view: "calendar", start: "2026-01-01", end: "2026-01-31" },
      lookup: { view: "lookup", term: "example" },
    };

    expect(Object.keys(minimal).sort()).toEqual([...libraryViews].sort());
    for (const view of libraryViews) {
      const parsed = parseInput(minimal[view]);
      expect(parsed.success, view).toBe(true);
      expect(parsed.success ? parsed.data : undefined, view).toMatchObject({
        pageSize: defaultPageSize,
        detail: "summary",
      });

      expect(parseInput({ ...minimal[view], unexpectedProperty: 1 }).success, view).toBe(false);
      expect(parseInput({ ...minimal[view], pageSize: maxPageSize }).success, view).toBe(true);
      expect(parseInput({ ...minimal[view], pageSize: maxPageSize + 1 }).success, view).toBe(false);
      expect(parseInput({ ...minimal[view], pageSize: 0 }).success, view).toBe(false);
      expect(parseInput({ ...minimal[view], detail: "full" }).success, view).toBe(true);
      expect(parseInput({ ...minimal[view], detail: "everything" }).success, view).toBe(false);
    }
  });

  it("rejects an undeclared view and an internal operation identifier", () => {
    expect(parseInput({ view: "everything" }).success).toBe(false);
    expect(parseInput({ view: "library.query.series" }).success).toBe(false);
    expect(parseInput({}).success).toBe(false);
  });

  it("requires each view's own filters and binds every reference to its kind", () => {
    expect(parseInput({ view: "seasons" }).success).toBe(false);
    expect(parseInput({ view: "movie_files" }).success).toBe(false);
    expect(parseInput({ view: "lookup" }).success).toBe(false);
    expect(parseInput({ view: "calendar", start: "2026-01-01" }).success).toBe(false);

    // A media-file reference is not a media reference, and the schema says so
    // before anything is resolved or sent.
    expect(parseInput({ view: "seasons", series: sampleReferences.mediaFile }).success).toBe(false);
    expect(parseInput({ view: "movie_files", movie: sampleReferences.queue }).success).toBe(false);
    expect(parseInput({ view: "series", media: [sampleReferences.mediaFile] }).success).toBe(false);
    expect(parseInput({ view: "series", media: [sampleReferences.media] }).success).toBe(true);
    expect(parseInput({ view: "series", media: [] }).success).toBe(false);
  });

  it("bounds the calendar window", () => {
    expect(calendarWindow("2026-01-01", "2026-01-01")).toBe(true);
    expect(calendarWindow("2026-01-01", "2026-12-31")).toBe(true);
    expect(calendarWindow("2026-01-02", "2026-01-01")).toBe(false);
    expect(calendarWindow("2026-01-01", "2027-01-02")).toBe(false);
    expect(maxCalendarWindowDays).toBeGreaterThan(0);
  });

  it("refuses a calendar date that does not round-trip and keeps every real one", () => {
    // Each of these is shaped correctly and rolls *forward* under `Date.parse`,
    // so accepting one would query a different window than the caller asked
    // for. The other bound is deliberately far enough away that the rolled-over
    // date would still leave an in-order, in-bounds window — the date itself
    // has to be what is rejected, not the window it happens to produce.
    for (const impossible of ["2026-02-30", "2026-04-31", "2027-02-29", "2026-11-31"]) {
      expect(calendarWindow(impossible, "2026-12-01"), impossible).toBe(false);
      expect(calendarWindow("2026-01-01", impossible), impossible).toBe(false);
    }
    for (const malformed of ["2026-13-01", "2026-00-10", "2026-01-32", "2026-01-00"]) {
      expect(calendarWindow(malformed, "2026-12-01"), malformed).toBe(false);
      expect(calendarWindow("2026-01-01", malformed), malformed).toBe(false);
    }

    // Real dates, a leap day included, survive as both bounds untouched.
    for (const real of ["2028-02-29", "2026-02-28", "2026-01-31", "2026-12-31"]) {
      expect(calendarWindow(real, real), real).toBe(true);
    }
  });
});

describe("arr_library_query results", () => {
  let sonarr: FixtureInstance;

  async function sonarrContext(state?: WorkflowState): Promise<ToolContext> {
    sonarr = await instance("sonarr");
    return createTestToolContext({
      environment: instanceEnvironment([sonarr]),
      ...(state === undefined ? {} : { state }),
    });
  }

  it("returns published series records carrying an opaque reference", async () => {
    const context = await sonarrContext();
    const result = await call(context, { view: "series" });

    expect(result.status).toBe("ok");
    const data = dataFor(result, "sonarr");
    expect(data.view).toBe("series");
    if (data.view !== "series") {
      throw new Error("Expected the series view");
    }
    expect(data.items.map((item) => [item.kind, item.application, item.id, item.title])).toEqual([
      ["series", "sonarr", "12", "Example Series"],
      ["series", "sonarr", "13", "Example Anime"],
      ["series", "sonarr", "14", "Example Retired Series"],
    ]);
    for (const item of data.items) {
      expect(item.reference).toMatch(/^med_/u);
      // A summary result omits the large nested payloads by default.
      expect(item.detail).toBeUndefined();
    }
    expect(result.applications[0]?.continuation).toMatchObject({
      pageSize: defaultPageSize,
      returned: 3,
      hasMore: false,
    });
  });

  it("adds the larger nested payload only at the full detail level", async () => {
    const context = await sonarrContext();
    const summary = dataFor(await call(context, { view: "series" }), "sonarr");
    const full = dataFor(await call(context, { view: "series", detail: "full" }), "sonarr");

    if (summary.view !== "series" || full.view !== "series") {
      throw new Error("Expected the series view");
    }
    expect(summary.items[0]?.detail).toBeUndefined();
    expect(full.items[0]?.detail?.overview).toBeTruthy();
  });

  it("filters by monitored state and by identifier reference", async () => {
    const state = createWorkflowState();
    const context = await sonarrContext(state);
    const all = dataFor(await call(context, { view: "series" }), "sonarr");
    if (all.view !== "series") {
      throw new Error("Expected the series view");
    }
    const anime = all.items.find((item) => item.id === "13");
    if (anime === undefined) {
      throw new Error("Expected the recorded anime series");
    }

    const selected = dataFor(
      await call(context, { view: "series", media: [anime.reference] }),
      "sonarr",
    );
    if (selected.view !== "series") {
      throw new Error("Expected the series view");
    }
    expect(selected.items.map((item) => item.id)).toEqual(["13"]);

    const monitored = dataFor(await call(context, { view: "series", monitored: false }), "sonarr");
    if (monitored.view !== "series") {
      throw new Error("Expected the series view");
    }
    expect(monitored.items.every((item) => !item.monitoring.monitored)).toBe(true);
  });

  it("accepts a minted reference as the parent of the seasons and episodes views", async () => {
    const state = createWorkflowState();
    const context = await sonarrContext(state);
    const series = dataFor(await call(context, { view: "series" }), "sonarr");
    if (series.view !== "series") {
      throw new Error("Expected the series view");
    }
    const reference = series.items.find((item) => item.id === "12")?.reference;
    if (reference === undefined) {
      throw new Error("Expected the recorded series");
    }

    const seasons = dataFor(await call(context, { view: "seasons", series: reference }), "sonarr");
    const episodes = dataFor(
      await call(context, { view: "episodes", series: reference }),
      "sonarr",
    );

    if (seasons.view !== "seasons" || episodes.view !== "episodes") {
      throw new Error("Expected the seasons and episodes views");
    }
    expect(seasons.items.every((item) => item.kind === "season")).toBe(true);
    expect(seasons.items.length).toBeGreaterThan(0);
    // The instance narrows by series, so only that series' episodes come back.
    expect(episodes.items.every((item) => item.kind === "episode")).toBe(true);
    expect(
      episodes.items.every((item) => item.kind === "episode" && item.sonarr.seriesId === 12),
    ).toBe(true);
  });

  it("returns media files as file references with a referenced parent", async () => {
    const state = createWorkflowState();
    const context = await sonarrContext(state);
    const series = dataFor(await call(context, { view: "series" }), "sonarr");
    if (series.view !== "series") {
      throw new Error("Expected the series view");
    }
    const reference = series.items.find((item) => item.id === "12")?.reference;
    if (reference === undefined) {
      throw new Error("Expected the recorded series");
    }

    const files = dataFor(
      await call(context, { view: "episode_files", series: reference }),
      "sonarr",
    );
    if (files.view !== "episode_files") {
      throw new Error("Expected the episode-files view");
    }

    expect(files.items.length).toBeGreaterThan(0);
    for (const file of files.items) {
      expect(file.kind).toBe("episode_file");
      expect(file.reference).toMatch(/^mfl_/u);
      expect(file.parent).toMatchObject({ application: "sonarr", kind: "series", id: "12" });
      expect(file.parent.reference).toMatch(/^med_/u);
    }
    // One identity, one reference: the shared parent is minted exactly once.
    expect(new Set(files.items.map((file) => file.parent.reference)).size).toBe(1);
  });

  it("reports wanted media with its reason and lookup results without adding them", async () => {
    const context = await sonarrContext();
    const missing = dataFor(await call(context, { view: "missing_episodes" }), "sonarr");
    const lookup = dataFor(await call(context, { view: "lookup", term: "example" }), "sonarr");

    if (missing.view !== "missing_episodes" || lookup.view !== "lookup") {
      throw new Error("Expected the missing-episodes and lookup views");
    }
    expect(missing.items.length).toBeGreaterThan(0);
    expect(missing.items.every((item) => item.wanted.reason === "missing")).toBe(true);
    expect(missing.items.every((item) => item.media.kind === "episode")).toBe(true);

    expect(lookup.items.length).toBeGreaterThan(0);
    expect(lookup.items.some((item) => item.existing !== undefined)).toBe(true);
    expect(lookup.items.some((item) => item.existing === undefined)).toBe(true);
    // A lookup result is metadata, never a library record of its own.
    expect(lookup.items.every((item) => !("reference" in item))).toBe(true);
  });

  it("pages with a continuation and refuses one minted for another query", async () => {
    const context = await sonarrContext();
    const first = await call(context, { view: "series", pageSize: 2 });
    const continuation = first.applications[0]?.continuation;

    expect(continuation).toMatchObject({ pageSize: 2, returned: 2, hasMore: true });
    const cursor = continuation?.cursor;
    if (cursor === undefined) {
      throw new Error("Expected a continuation cursor");
    }

    const second = await call(context, { view: "series", pageSize: 2, cursor });
    expect(second.applications[0]?.continuation).toMatchObject({ returned: 1, hasMore: false });

    const mismatched = await call(context, {
      view: "series",
      pageSize: 2,
      cursor,
      monitored: true,
    });
    expect(mismatched.applications[0]?.error?.code).toBe("invalid_input");
  });

  it("forwards a calendar window to the instance exactly as it was supplied", async () => {
    const context = await sonarrContext();
    await call(context, { view: "calendar", start: "2028-02-29", end: "2028-03-01" });

    // The bounds reach the instance byte for byte. A date this server had
    // silently normalized would show up here as the date it was changed into.
    const calendar = sonarr.searches.find((search) => search.route === "calendar");
    expect(calendar?.query.get("start")).toBe("2028-02-29");
    expect(calendar?.query.get("end")).toBe("2028-03-01");
  });

  it("refuses an impossible calendar date without contacting the instance", async () => {
    const context = await sonarrContext();

    for (const impossible of ["2026-02-30", "2026-13-01"]) {
      const parsed = parseInput({ view: "calendar", start: impossible, end: "2026-12-01" });
      expect(parsed.success, impossible).toBe(false);
      // Nothing to dispatch: validation refused it, so no probe and no read.
      expect(context.registry.adapter("sonarr")).toBeDefined();
    }
    expect(sonarr.requests).toEqual([]);
  });

  it("refuses a media reference this process never issued before sending anything", async () => {
    const context = await sonarrContext();
    const result = await call(context, { view: "seasons", series: sampleReferences.media });

    expect(result.status).toBe("error");
    expect(result.errors.map((error) => error.code)).toEqual(["stale_reference"]);
    expect(sonarr.requests).toEqual([]);
  });

  it("returns every application's outcome when one of them is unusable", async () => {
    const healthy = await instance("sonarr");
    const broken = await instance("radarr", { unreachable: true });
    const context = createTestToolContext({
      environment: instanceEnvironment([healthy, broken]),
    });

    const result = await call(context, {
      view: "calendar",
      start: "2026-01-01",
      end: "2026-01-31",
    });

    expect(result.status).toBe("partial");
    expect(result.errors.map((error) => error.code)).toEqual(["partial_failure"]);
    expect(result.applications.map((outcome) => [outcome.application, outcome.status])).toEqual([
      ["sonarr", "ok"],
      ["radarr", "unavailable"],
    ]);

    const sonarrCalendar = dataFor(result, "sonarr");
    expect(sonarrCalendar.view).toBe("calendar");
    const radarrOutcome = result.applications[1];
    expect(radarrOutcome?.error?.code).toBe("unavailable_application");
    expect(radarrOutcome?.error?.remediation).toBeTruthy();

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(broken.apiKey);
    expect(serialized).not.toContain("127.0.0.1");
  });

  it("answers a view the selected application does not model as unsupported", async () => {
    const sonarrOnly = await instance("sonarr");
    const context = createTestToolContext({ environment: instanceEnvironment([sonarrOnly]) });

    const result = await call(context, { view: "movies", applications: ["sonarr", "prowlarr"] });

    expect(result.status).toBe("error");
    expect(
      result.applications.map((outcome) => [outcome.application, outcome.error?.code]),
    ).toEqual([
      ["sonarr", "unsupported_capability"],
      ["prowlarr", "unsupported_capability"],
    ]);
    expect(sonarrOnly.requests).toEqual([]);
  });

  it("answers every Radarr view against a recorded instance", async () => {
    const radarr = await instance("radarr");
    const state = createWorkflowState();
    const context = createTestToolContext({
      environment: instanceEnvironment([radarr]),
      state,
    });

    const movies = dataFor(await call(context, { view: "movies" }), "radarr");
    if (movies.view !== "movies") {
      throw new Error("Expected the movies view");
    }
    const reference = movies.items.find((item) => item.id === "8")?.reference;
    if (reference === undefined) {
      throw new Error("Expected the recorded movie");
    }

    const views: readonly Record<string, unknown>[] = [
      { view: "collections" },
      { view: "movie_files", movie: reference },
      { view: "missing_movies" },
      { view: "cutoff_unmet_movies" },
      { view: "calendar", start: "2026-01-01", end: "2026-03-01" },
      { view: "lookup", term: "example" },
    ];

    for (const args of views) {
      const data = dataFor(await call(context, args), "radarr");
      expect(data.view, String(args.view)).toBe(args.view);
      expect(data.items.length, String(args.view)).toBeGreaterThan(0);
    }
  });
});

describe("arr_library_query capability projection", () => {
  it("advertises each view exactly where an adapter models it", async () => {
    const sonarr = await instance("sonarr");
    const radarr = await instance("radarr");
    const context = createTestToolContext({
      environment: instanceEnvironment([sonarr, radarr]),
    });

    const report = await reportCapabilities(context, undefined);
    const viewsFor = (application: string) =>
      (
        report.applications.find((entry) => entry.application === application)?.data
          ?.supportedOperations ?? []
      )
        .filter((operation) => operation.tool === "arr_library_query")
        .map((operation) => operation.variant);

    expect(viewsFor("sonarr")).toEqual([
      "series",
      "seasons",
      "episodes",
      "episode_files",
      "missing_episodes",
      "cutoff_unmet_episodes",
      "calendar",
      "lookup",
    ]);
    expect(viewsFor("radarr")).toEqual([
      "movies",
      "collections",
      "movie_files",
      "missing_movies",
      "cutoff_unmet_movies",
      "calendar",
      "lookup",
    ]);
    // Prowlarr has no media library; it is reported without one rather than
    // being given an empty one.
    expect(viewsFor("prowlarr")).toEqual([]);

    for (const application of applicationIds) {
      const data = report.applications.find((entry) => entry.application === application)?.data;
      expect(
        data?.unimplementedOperations.filter((operation) => operation.tool === "arr_library_query"),
        application,
      ).toEqual([]);
    }
  });
});
