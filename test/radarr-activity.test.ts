import { beforeAll, describe, expect, it } from "vitest";
import type { ActivityQueryRequest } from "../src/adapters/activity/requests.js";
import { type ActivityQueryOutcome, runActivityQuery } from "../src/adapters/activity/service.js";
import {
  activityFixture,
  blocklistRecords,
  expectOk,
  historyRecords,
  paging,
  queueDetail,
  queueItems,
  queueSummary,
  servePagedRecords,
} from "./support/activity.js";
import { jsonResponse, libraryHarness, type UpstreamCall } from "./support/library.js";

interface PagedFixture {
  readonly totalRecords: number;
  readonly records: readonly Record<string, unknown>[];
}

const fixtures: Record<string, unknown> = {};

beforeAll(async () => {
  for (const route of ["queue/status", "queue", "queue/details", "history", "blocklist"]) {
    fixtures[route] = await activityFixture("radarr", route);
  }
});

function body(route: string): unknown {
  const value = fixtures[route];
  if (value === undefined) {
    throw new Error(`Missing loaded fixture for radarr ${route}`);
  }
  return value;
}

function paged(route: string): PagedFixture {
  return body(route) as PagedFixture;
}

async function run(
  request: ActivityQueryRequest,
  respond: (call: UpstreamCall) => Response | Promise<Response>,
): Promise<{ outcome: ActivityQueryOutcome; calls: readonly UpstreamCall[] }> {
  const harness = libraryHarness("radarr", respond);
  const outcome = await runActivityQuery("radarr", harness.client, request);
  return { outcome, calls: harness.calls };
}

describe("radarr activity reads", () => {
  it("maps the queue counters", async () => {
    const { outcome } = await run(
      { view: "queue_status", detail: "summary", paging: paging() },
      () => jsonResponse(body("queue/status")),
    );

    expect(queueSummary(expectOk(outcome).data)).toMatchObject({
      application: "radarr",
      totalCount: 3,
      unknownCount: 0,
      warnings: true,
    });
  });

  it("associates queue rows with movies and names the fallback row a pending release", async () => {
    const source = paged("queue");
    const { outcome, calls } = await run(
      { view: "queue", detail: "full", paging: paging() },
      servePagedRecords(source.records, source.totalRecords),
    );

    expect(calls[0]?.url.searchParams.get("includeUnknownMovieItems")).toBe("true");
    expect(calls[0]?.url.searchParams.get("includeMovie")).toBe("true");

    const items = queueItems(expectOk(outcome).data);
    expect(items.map((item) => [item.kind, item.evidence.status])).toEqual([
      ["tracked_download", "downloading"],
      ["tracked_download", "completed"],
      ["pending_release", "fallback"],
    ]);
    expect(items[0]?.media).toEqual({ application: "radarr", kind: "movie", id: "8" });
    // Radarr has no episodes, so no queue row may claim one.
    expect(items.every((item) => item.episode === undefined)).toBe(true);
    expect(items[1]?.evidence.trackedState).toBe("import_pending");
    expect(items[1]?.evidence.statusMessages[0]?.messages).toEqual([
      "Not an upgrade for existing movie file",
    ]);
    expect(items[1]?.progress).toMatchObject({ sizeBytes: 21474836480, remainingBytes: 0 });
  });

  it("scopes a focused queue read with the movie parameter", async () => {
    const { outcome, calls } = await run(
      { view: "queue_details", detail: "summary", queueItemId: 601, mediaId: 8, paging: paging() },
      () => jsonResponse(body("queue/details")),
    );

    expect(calls[0]?.url.searchParams.get("movieId")).toBe("8");
    expect(queueDetail(expectOk(outcome).data).context).toEqual({
      application: "radarr",
      kind: "tracked_download",
      queueItemId: 601,
      mediaId: 8,
    });
  });

  it("uses the movie-scoped history route when exactly one movie is named", async () => {
    const { outcome, calls } = await run(
      { view: "history", detail: "summary", mediaIds: [8], paging: paging() },
      () => jsonResponse(paged("history").records),
    );

    expect(calls[0]?.url.pathname).toBe("/api/v3/history/movie");
    expect(calls[0]?.url.searchParams.get("movieId")).toBe("8");
    const records = historyRecords(expectOk(outcome).data);
    expect(records.map((record) => record.eventType)).toEqual(["grabbed"]);
    expect(records[0]?.media).toEqual({ application: "radarr", kind: "movie", id: "8" });
    // `data` is a `full` payload; a summary read carries none of it.
    expect(records[0]?.data).toBeUndefined();
  });

  it("maps a blocklist record for a movie", async () => {
    const source = paged("blocklist");
    const { outcome } = await run(
      { view: "blocklist", detail: "summary", paging: paging() },
      servePagedRecords(source.records, source.totalRecords),
    );

    expect(blocklistRecords(expectOk(outcome).data)[0]).toMatchObject({
      application: "radarr",
      context: { application: "radarr", blocklistRecordId: 7101 },
      media: { application: "radarr", kind: "movie", id: "10" },
      quality: "WEBDL-1080p",
    });
  });
});
