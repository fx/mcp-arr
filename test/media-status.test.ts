import { beforeEach, describe, expect, it } from "vitest";
import { downloadIdentity } from "../src/adapters/activity/parse.js";
import { createManualClock, type ManualClock } from "../src/state/clock.js";
import { createDownloadClaims, type DownloadClaims } from "../src/state/download-claims.js";
import { downloadReasons } from "../src/tools/media/downloads.js";
import type { StatusResult } from "../src/tools/media/schemas.js";
import {
  callMediaTool,
  createMediaContext,
  forbiddenTermsIn,
  noMediaDefaults,
} from "./support/media.js";
import { type ActivityInstances, createActivityInstances } from "./support/media-activity.js";
import { allApplicationsEnvironment } from "./support/tool-context.js";

/**
 * `media_status` over the recorded library, queue, history, and calendar.
 *
 * Recorded, series 100001 is library record 12 with two queue rows — 501
 * downloading S01E01 and 502 a blocked import of S02E01 — and movie 200002 is
 * record 9, whose one row 602 is pending import with a warning. The recorded
 * import scans match their files to other episodes and another movie, so
 * neither blocked import can be finished.
 */

type UpstreamRecord = Record<string, unknown>;

let instances: ActivityInstances;
let claims: DownloadClaims;
let clock: ManualClock;

beforeEach(async () => {
  instances = await createActivityInstances();
  claims = createDownloadClaims();
  clock = createManualClock(Date.parse("2026-11-07T00:00:00Z"));
});

function status(input: unknown, environment = allApplicationsEnvironment) {
  return callMediaTool<StatusResult>(
    "media_status",
    createMediaContext(instances, noMediaDefaults, environment, { claims, clock }),
    input,
  );
}

function queueRow(application: "sonarr" | "radarr", id: number): UpstreamRecord {
  const row = instances.state(application).queue.find((candidate) => candidate.id === id);
  if (row === undefined) {
    throw new Error(`No queue row ${id}`);
  }
  return structuredClone(row);
}

function failedRows(count: number): UpstreamRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    ...queueRow("sonarr", 502),
    id: 800 + index,
    status: "failed",
    trackedDownloadState: "failed",
    trackedDownloadStatus: "error",
    downloadId: `download-${index}`,
  }));
}

describe("media_status for one title", () => {
  it("reports a series in the library with its downloads", async () => {
    const { content, result, summary } = await status({ kind: "series", id: 100_001 });

    expect(result.isError).toBe(false);
    expect(content).toEqual({
      kind: "series",
      id: 100_001,
      title: "Example Series",
      in_library: true,
      monitored: true,
      file_resolutions: ["720p", "1080p"],
      have: 2,
      missing: 1,
      downloads: [
        {
          kind: "series",
          id: 100_001,
          title: "Example Series",
          episodes: "S02E01",
          state: "stuck",
          resolution: "1080p",
          reason: downloadReasons.unmatched,
          remedy: "none",
        },
        {
          kind: "series",
          id: 100_001,
          title: "Example Series",
          episodes: "S01E01",
          state: "downloading",
          resolution: "1080p",
          progress: 66,
        },
      ],
      warnings: [],
      errors: [],
    });
    expect(summary).toBe(
      "media_status: series 100001 in library, 2 had, 1 missing, 2 download(s) shown (1 stuck)",
    );
    expect(forbiddenTermsIn(JSON.stringify(content))).toEqual([]);
  });

  it("reports a movie's next due date and what it lacks", async () => {
    const { content } = await status({ kind: "movie", id: 200_002 });

    expect(content).toMatchObject({
      kind: "movie",
      id: 200_002,
      title: "Example Awaited Movie",
      in_library: true,
      have: 0,
      missing: 0,
      next_due: "2026-11-20T00:00:00Z",
      downloads: [
        {
          state: "stuck",
          resolution: "2160p",
          reason: downloadReasons.otherTitle,
          remedy: "none",
        },
      ],
    });
  });

  it("reports a title not in the library with nothing else about it", async () => {
    const { content, result } = await status({ kind: "movie", id: 999_999 });

    expect(result.isError).toBe(false);
    expect(content).toEqual({
      kind: "movie",
      id: 999_999,
      in_library: false,
      warnings: [],
      errors: [],
    });
  });

  it("lists ten downloads and the total it cut them from", async () => {
    instances.state("sonarr").queue = failedRows(12);

    const { content } = await status({ kind: "series", id: 100_001 });

    expect(content.downloads).toHaveLength(10);
    expect(content.downloads_total).toBe(12);
    expect(content.downloads?.every((download) => download.remedy === "replace")).toBe(true);
  });

  it("reports a season pack once, naming every episode it covers", async () => {
    instances.state("sonarr").queue = [1003, 1004].map((episodeId, index) => ({
      ...queueRow("sonarr", 502),
      id: 700 + index,
      episodeId,
      status: "failed",
      trackedDownloadState: "failed",
    }));

    const { content } = await status({ kind: "series", id: 100_001 });

    expect(content.downloads).toEqual([
      expect.objectContaining({ episodes: "S02E01–E02", state: "stuck", remedy: "replace" }),
    ]);
    expect(content.downloads_total).toBeUndefined();
  });

  it("reports a download this process is importing as importing until the import ends", async () => {
    const key = `sonarr\u0000id:${downloadIdentity(String(queueRow("sonarr", 502).downloadId))}`;
    claims.tryClaim(key);
    claims.markImporting(key, { application: "sonarr", commandId: "7001" });
    instances
      .state("sonarr")
      .commands.set(7001, { id: 7001, name: "ManualImport", status: "started" });

    const importing = await status({ kind: "series", id: 100_001 });
    expect(importing.content.downloads?.[0]).toMatchObject({
      episodes: "S02E01",
      state: "importing",
    });
    expect(claims.importOf(key)).toBeDefined();

    instances.state("sonarr").commands.set(7001, {
      id: 7001,
      name: "ManualImport",
      status: "completed",
      result: "successful",
    });
    const ended = await status({ kind: "series", id: 100_001 });
    expect(ended.content.downloads?.[0]).toMatchObject({ state: "stuck" });
    expect(claims.importOf(key)).toBeUndefined();
  });

  it("refuses a kind without an id", async () => {
    const { content, result } = await status({ kind: "series" });

    expect(result.isError).toBe(true);
    expect(content.errors.map((error) => error.code)).toEqual(["invalid_input"]);
  });
});

describe("media_status overview", () => {
  it("lists stuck downloads first, then each kind's in queue order", async () => {
    const { content, result } = await status({});

    expect(result.isError).toBe(false);
    expect(content.kinds).toEqual(["movie", "series"]);
    expect(
      content.downloads?.map((download) => [
        download.kind,
        download.id,
        download.state,
        download.episodes,
      ]),
    ).toEqual([
      ["movie", 200_002, "stuck", undefined],
      ["series", 100_001, "stuck", "S02E01"],
      ["movie", 200_001, "downloading", undefined],
      ["series", 100_001, "downloading", "S01E01"],
      ["series", 100_002, "waiting", "S01E02"],
    ]);
    expect(content.downloads?.[0]).toMatchObject({
      reason: downloadReasons.otherTitle,
      remedy: "none",
    });
    expect(content.downloads_total).toBeUndefined();
  });

  it("reports the imports of the last seven days, newest first, one per title", async () => {
    clock.set(Date.parse("2026-08-28T00:00:00Z"));

    const { content } = await status({});

    expect(content.imported).toEqual([
      { kind: "series", id: 100_001, title: "Example Series", date: "2026-08-26T20:15:00Z" },
      { kind: "movie", id: 200_002, title: "Example Awaited Movie", date: "2026-08-26T17:30:00Z" },
    ]);
    const since = instances.requests.filter((request) => request.route === "history/since");
    expect(since.map((request) => request.query.date)).toEqual([
      "2026-08-21T00:00:00.000Z",
      "2026-08-21T00:00:00.000Z",
    ]);

    clock.set(Date.parse("2026-09-05T00:00:00Z"));
    expect((await status({})).content.imported).toEqual([]);
  });

  it("reports what is due in the next fourteen days", async () => {
    clock.set(Date.parse("2026-09-20T00:00:00Z"));

    const { content } = await status({});

    expect(content.upcoming).toEqual([
      {
        kind: "series",
        id: 100_001,
        title: "Example Series",
        episodes: "S02E01",
        date: "2026-09-30T20:00:00Z",
      },
    ]);

    clock.set(Date.parse("2026-11-10T00:00:00Z"));
    expect((await status({})).content.upcoming).toEqual([
      { kind: "movie", id: 200_002, title: "Example Awaited Movie", date: "2026-11-20T00:00:00Z" },
    ]);
  });

  it("cuts the downloads to ten and reports the total", async () => {
    instances.state("sonarr").queue = failedRows(12);

    const { content } = await status({});

    expect(content.downloads).toHaveLength(10);
    // Stuck first, and the movie kind before the series kind.
    expect(content.downloads?.map((download) => download.kind)).toEqual([
      "movie",
      ...Array.from({ length: 9 }, () => "series"),
    ]);
    expect(content.downloads_total).toBe(14);
  });

  it("leaves out a download that belongs to no title, and says so", async () => {
    instances
      .state("sonarr")
      .queue.push({ ...queueRow("sonarr", 502), id: 999, seriesId: 0, downloadId: "orphan" });

    const { content } = await status({});

    expect(content.downloads).toHaveLength(5);
    expect(content.warnings).toContain(
      "1 download(s) in the queue belong to no title in the library and are not listed",
    );
  });

  it("reports a kind it could not read beside the kind it could", async () => {
    instances.intercept((request) => {
      if (request.application === "radarr" && request.route !== "system/status") {
        throw new TypeError("fetch failed");
      }
      return undefined;
    });

    const { content, result, summary } = await status({});

    expect(result.isError).toBe(false);
    expect(content.errors.map((error) => error.code)).toEqual(["unavailable_application"]);
    expect(content.errors[0]?.remediation).toContain("movies");
    expect(content.downloads?.map((download) => download.kind)).toEqual([
      "series",
      "series",
      "series",
    ]);
    expect(summary).toContain("errors: unavailable_application");
  });

  it("fails when no kind could be read", async () => {
    instances.intercept((request) =>
      request.route === "system/status" ? undefined : new Response("{}", { status: 503 }),
    );

    const { content, result } = await status({});

    expect(result.isError).toBe(true);
    expect(content.downloads).toBeUndefined();
    expect(content.errors).toHaveLength(2);
  });

  it("sends nothing but reads and the import re-decisions that change nothing", async () => {
    // One file the series' blocked download can import, so its remedy is
    // confirmed all the way through the instance's own re-decision.
    const [scanned] = instances.state("sonarr").manualimport;
    instances.state("sonarr").manualimport = [
      {
        ...scanned,
        path: "/media/example/downloads/complete/example-series/Example Series - S02E01.mkv",
        seasonNumber: 2,
        episodes: [{ id: 1003, seasonNumber: 2, episodeNumber: 1 }],
        rejections: [],
      },
    ];

    const overview = await status({});
    expect(overview.content.downloads?.[1]).toMatchObject({ remedy: "import" });
    await status({ kind: "series", id: 100_001 });
    await status({ kind: "movie", id: 200_002 });

    expect(instances.mutations()).toEqual([]);
    expect(
      new Set(
        instances.requests
          .filter((request) => request.method !== "GET")
          .map((request) => request.route),
      ),
    ).toEqual(new Set(["manualimport"]));
  });
});
