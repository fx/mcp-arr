import { beforeEach, describe, expect, it } from "vitest";
import { downloadIdentity } from "../src/adapters/activity/parse.js";
import { defaultScanLimit } from "../src/adapters/library/paging.js";
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
 * downloading S01E01 and 502 a blocked import of S02E01, an episode it lacks
 * and does not monitor — and movie 200002 is
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
      // S02E01 lacks its file, but is not monitored.
      missing: 0,
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
      "media_status: series 100001 in library, 2 had, 0 missing, 2 download(s) shown (1 stuck)",
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
      next_due: "2026-11-20T00:00:00.000Z",
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

  it("counts as missing only the released media it lacks and monitors", async () => {
    const lacking = instances.state("sonarr").episodes.find((episode) => episode.id === 1003);
    const series = instances.state("sonarr").titles.find((record) => record.id === 12);
    const movie = instances.state("radarr").titles.find((record) => record.id === 9);
    if (lacking === undefined || series === undefined || movie === undefined) {
      throw new Error("Recorded library records are missing");
    }
    const missing = async (kind: "series" | "movie", id: number) =>
      (await status({ kind, id })).content.missing;

    lacking.monitored = true;
    expect(await missing("series", 100_001)).toBe(1);
    // The episode is monitored, but its series is not.
    series.monitored = false;
    expect(await missing("series", 100_001)).toBe(0);
    // Not yet aired, so not missing however it is monitored.
    series.monitored = true;
    clock.set(Date.parse("2026-09-01T00:00:00Z"));
    expect(await missing("series", 100_001)).toBe(0);

    movie.isAvailable = true;
    expect(await missing("movie", 200_002)).toBe(1);
    movie.monitored = false;
    expect(await missing("movie", 200_002)).toBe(0);
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
    claims.markPending(key, {
      action: "import",
      application: "sonarr",
      commandId: "7001",
      attemptedAt: clock.now(),
      mediaId: 12,
      episodeIds: [1003],
    });
    instances
      .state("sonarr")
      .commands.set(7001, { id: 7001, name: "ManualImport", status: "started" });

    const importing = await status({ kind: "series", id: 100_001 });
    expect(importing.content.downloads?.[0]).toMatchObject({
      episodes: "S02E01",
      state: "importing",
    });
    expect(claims.pendingOf(key)).toBeDefined();

    instances.state("sonarr").commands.set(7001, {
      id: 7001,
      name: "ManualImport",
      status: "completed",
      result: "successful",
    });
    const ended = await status({ kind: "series", id: 100_001 });
    expect(ended.content.downloads?.[0]).toMatchObject({ state: "stuck" });
    expect(claims.pendingOf(key)).toBeUndefined();
  });

  it("refuses a kind without an id, and an id without a kind, before any request", async () => {
    for (const input of [{ kind: "series" }, { id: 100_001 }, { kind: "series", id: 0 }]) {
      const { content, result } = await status(input);

      expect(result.isError, JSON.stringify(input)).toBe(true);
      expect(content.errors.map((error) => error.code)).toEqual(["invalid_input"]);
    }
    expect(instances.requests).toEqual([]);
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
      { kind: "series", id: 100_001, title: "Example Series", date: "2026-08-26T20:15:00.000Z" },
      {
        kind: "movie",
        id: 200_002,
        title: "Example Awaited Movie",
        date: "2026-08-26T17:30:00.000Z",
      },
    ]);
    // The paged history read, newest first; the recorded history fits on one page.
    const history = instances.requests.filter((request) => request.route === "history");
    expect(history.map((request) => [request.application, request.query])).toEqual([
      ["radarr", { page: "1", pageSize: "100", sortKey: "date", sortDirection: "descending" }],
      ["sonarr", { page: "1", pageSize: "100", sortKey: "date", sortDirection: "descending" }],
    ]);

    clock.set(Date.parse("2026-09-05T00:00:00Z"));
    expect((await status({})).content.imported).toEqual([]);
  });

  it("pages the history back until it passes the week, and no further than five pages", async () => {
    clock.set(Date.parse("2026-08-28T00:00:00Z"));
    const [imported] = instances
      .state("sonarr")
      .history.filter((record) => record.eventType === "downloadFolderImported");
    const at = (hours: number) =>
      new Date(Date.parse("2026-08-27T00:00:00Z") - hours * 3_600_000).toISOString();
    const records = (count: number, from: number) =>
      Array.from({ length: count }, (_, index) => ({
        ...imported,
        id: 20_000 + from + index,
        date: at(from + index),
      }));
    const pages = () =>
      instances.requests.filter(
        (request) => request.application === "sonarr" && request.route === "history",
      ).length;

    // 150 records inside the week, then one older: the second page reaches it.
    instances.state("sonarr").history = [...records(150, 0), ...records(1, 24 * 9)];
    const reached = await status({});
    expect(pages()).toBe(2);
    expect(reached.content.warnings).toEqual([]);
    expect(reached.content.imported).toEqual([
      { kind: "series", id: 100_001, title: "Example Series", date: "2026-08-27T00:00:00.000Z" },
      expect.objectContaining({ kind: "movie" }),
    ]);

    // Six full pages inside the week: the read stops at five and says so.
    const before = pages();
    instances.state("sonarr").history = records(600, 0).map((record, index) => ({
      ...record,
      date: new Date(Date.parse("2026-08-27T00:00:00Z") - index * 60_000).toISOString(),
    }));
    const bounded = await status({});
    expect(pages() - before).toBe(5);
    expect(bounded.content.warnings).toContain(
      "the history was longer than could be read, so the imported list may be incomplete",
    );
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
        date: "2026-09-30T20:00:00.000Z",
      },
    ]);

    clock.set(Date.parse("2026-11-10T00:00:00Z"));
    expect((await status({})).content.upcoming).toEqual([
      {
        kind: "movie",
        id: 200_002,
        title: "Example Awaited Movie",
        date: "2026-11-20T00:00:00.000Z",
      },
    ]);
  });

  it("reports a movie due on a later release date once its cinema date has passed", async () => {
    // Recorded, movie 200001 opened in cinemas on 2021-06-01 and is released
    // digitally on 2021-08-01 and physically on 2021-09-01.
    clock.set(Date.parse("2021-07-25T06:00:00Z"));

    const { content } = await status({});

    expect(content.upcoming).toEqual([
      { kind: "movie", id: 200_001, title: "Example Movie", date: "2021-08-01T00:00:00.000Z" },
    ]);
    // The calendar view is asked for dates, as its contract states, not instants.
    const calendars = instances.requests.filter((request) => request.route === "calendar");
    expect(calendars.map((request) => [request.application, request.query])).toEqual([
      ["radarr", expect.objectContaining({ start: "2021-07-25", end: "2021-08-08" })],
      ["sonarr", expect.objectContaining({ start: "2021-07-25", end: "2021-08-08" })],
    ]);
  });

  it("reports a movie on its later release when an earlier one fell earlier the same day", async () => {
    // The cinema date is inside the window the calendar is asked for, which
    // starts at midnight, but it has already passed: the digital release is due.
    const movie = instances.state("radarr").calendar.find((record) => record.id === 8);
    if (movie === undefined) {
      throw new Error("No calendar movie 8");
    }
    movie.inCinemas = "2021-07-25T00:00:00Z";
    clock.set(Date.parse("2021-07-25T06:00:00Z"));

    const { content } = await status({});

    expect(content.upcoming).toEqual([
      { kind: "movie", id: 200_001, title: "Example Movie", date: "2021-08-01T00:00:00.000Z" },
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

  it("counts downloads, not rows, across every page of the queue", async () => {
    // 99 downloads fill most of the first page; a three-row season pack
    // straddles it and the second; 20 more downloads follow.
    const pack = [1003, 1004, 1001].map((episodeId, index) => ({
      ...failedRows(1)[0],
      id: 5_000 + index,
      episodeId,
      downloadId: "season-pack",
    }));
    const singles = failedRows(119);
    instances.state("sonarr").queue = [...singles.slice(0, 99), ...pack, ...singles.slice(99)];
    instances.state("radarr").queue = [];

    const { content } = await status({});

    expect(content.downloads).toHaveLength(10);
    expect(content.downloads_total).toBe(120);
    expect(content.warnings).toEqual([]);
    const pages = instances.requests.filter(
      (request) => request.application === "sonarr" && request.route === "queue",
    );
    expect(pages.map((request) => request.query.page)).toEqual(["1", "2"]);
  });

  it("counts only the downloads it read when the queue is longer than the bound, and says so", async () => {
    instances.state("sonarr").queue = failedRows(defaultScanLimit + 5);
    instances.state("radarr").queue = [];

    const { content } = await status({});

    expect(content.downloads_total).toBe(defaultScanLimit);
    expect(content.warnings).toContain(
      `the queue holds more than ${defaultScanLimit} entries, so downloads_total counts only ` +
        `the downloads among the first ${defaultScanLimit}; more may exist beyond them`,
    );
  });

  it("leaves out a download that belongs to no title, and says so", async () => {
    // Two rows of one unassociated download are one download.
    for (const id of [998, 999]) {
      instances
        .state("sonarr")
        .queue.push({ ...queueRow("sonarr", 502), id, seriesId: 0, downloadId: "orphan" });
    }

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
