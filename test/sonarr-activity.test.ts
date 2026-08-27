import { beforeAll, describe, expect, it } from "vitest";
import type { ActivityQueryRequest } from "../src/adapters/activity/requests.js";
import { type ActivityQueryOutcome, runActivityQuery } from "../src/adapters/activity/service.js";
import {
  activityFixture,
  blocklistRecords,
  commandActivity,
  diskConditions,
  expectError,
  expectOk,
  healthChecks,
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
  for (const route of [
    "queue/status",
    "queue",
    "queue/details",
    "history",
    "blocklist",
    "health",
    "command",
    "diskspace",
  ]) {
    fixtures[route] = await activityFixture("sonarr", route);
  }
});

function body(route: string): unknown {
  const value = fixtures[route];
  if (value === undefined) {
    throw new Error(`Missing loaded fixture for sonarr ${route}`);
  }
  return value;
}

function paged(route: string): PagedFixture {
  return body(route) as PagedFixture;
}

interface Run {
  readonly outcome: ActivityQueryOutcome;
  readonly calls: readonly UpstreamCall[];
}

async function run(
  request: ActivityQueryRequest,
  respond: (call: UpstreamCall) => Response | Promise<Response>,
): Promise<Run> {
  const harness = libraryHarness("sonarr", respond);
  const outcome = await runActivityQuery("sonarr", harness.client, request);
  return { outcome, calls: harness.calls };
}

function serving(route: string): (call: UpstreamCall) => Response {
  return () => jsonResponse(body(route));
}

describe("sonarr queue reads", () => {
  it("maps the queue counters", async () => {
    const { outcome, calls } = await run(
      { view: "queue_status", detail: "summary", paging: paging() },
      serving("queue/status"),
    );

    const ok = expectOk(outcome);
    expect(calls[0]?.url.pathname).toBe("/api/v3/queue/status");
    expect(calls[0]?.init.method).toBe("GET");
    expect(queueSummary(ok.data)).toEqual({
      application: "sonarr",
      totalCount: 4,
      count: 4,
      unknownCount: 1,
      errors: false,
      warnings: true,
      unknownErrors: false,
      unknownWarnings: true,
    });
    expect(ok.continuation).toEqual({ pageSize: 25, returned: 1, hasMore: false });
  });

  it("maps every queue item kind, status, and tracked state", async () => {
    const { outcome } = await run(
      { view: "queue", detail: "full", paging: paging() },
      servePagedRecords(paged("queue").records, paged("queue").totalRecords),
    );

    const items = queueItems(expectOk(outcome).data);
    expect(items.map((item) => [item.kind, item.evidence.status])).toEqual([
      ["tracked_download", "downloading"],
      ["tracked_download", "completed"],
      ["pending_release", "delay"],
      ["tracked_download", "warning"],
    ]);
    expect(items.map((item) => item.evidence.trackedState)).toEqual([
      "downloading",
      "import_blocked",
      undefined,
      "import_pending",
    ]);

    const blocked = items[1];
    expect(blocked?.context).toEqual({
      application: "sonarr",
      kind: "tracked_download",
      queueItemId: 502,
      mediaId: 12,
    });
    expect(blocked?.media).toEqual({ application: "sonarr", kind: "series", id: "12" });
    expect(blocked?.episode).toEqual({ application: "sonarr", kind: "episode", id: "1003" });
    expect(blocked?.evidence.trackedStatus).toBe("warning");
    expect(blocked?.evidence.statusMessages[0]?.messages).toEqual([
      "One or more episodes expected in this release were not imported or missing",
      "Found matching series via grab history, but release was matched to series by ID",
    ]);
    expect(blocked?.quality).toBe("Bluray-1080p");
    expect(blocked?.languages).toEqual(["English"]);
    expect(blocked?.origin?.downloadClient).toBe("Example Usenet Client");

    // A row upstream could not associate keeps its evidence and loses only the
    // association: zero is not an identifier.
    const unknown = items[3];
    expect(unknown?.media).toBeUndefined();
    expect(unknown?.episode).toBeUndefined();
    expect(unknown?.context.mediaId).toBeUndefined();
    expect(unknown?.evidence.errorMessage).toBe(
      "The download client reported an unrecoverable transfer error",
    );
  });

  it("omits the download identifier and reports only a stable digest", async () => {
    const { outcome } = await run(
      { view: "queue", detail: "full", paging: paging() },
      servePagedRecords(paged("queue").records, paged("queue").totalRecords),
    );

    const items = queueItems(expectOk(outcome).data);
    const serialized = JSON.stringify(items);
    // Counted, not assumed. An assertion that runs zero times passes without
    // checking anything, so the fixture is held to supplying both fields
    // rather than the loop quietly becoming a no-op if one disappears.
    let downloadIds = 0;
    let outputPaths = 0;
    for (const record of paged("queue").records) {
      if (typeof record.downloadId === "string") {
        downloadIds += 1;
        expect(serialized).not.toContain(record.downloadId);
      }
      if (typeof record.outputPath === "string") {
        outputPaths += 1;
        expect(serialized).not.toContain(record.outputPath);
      }
    }
    expect(downloadIds).toBeGreaterThan(0);
    expect(outputPaths).toBeGreaterThan(0);
    // The same download digests alike, and two different ones do not.
    expect(items[0]?.origin?.downloadIdentity).toMatch(/^[0-9a-f]{16}$/u);
    expect(items[0]?.origin?.downloadIdentity).not.toBe(items[1]?.origin?.downloadIdentity);
    expect(items[2]?.origin?.downloadIdentity).toBeUndefined();
  });

  it("asks the instance for one page instead of fetching the whole queue", async () => {
    const source = paged("queue");
    const first = await run(
      { view: "queue", detail: "summary", paging: paging(2) },
      servePagedRecords(source.records, source.totalRecords),
    );

    const firstOk = expectOk(first.outcome);
    expect(first.calls[0]?.url.searchParams.get("page")).toBe("1");
    expect(first.calls[0]?.url.searchParams.get("pageSize")).toBe("2");
    expect(first.calls[0]?.url.searchParams.get("includeUnknownSeriesItems")).toBe("true");
    expect(queueItems(firstOk.data).map((item) => item.context.queueItemId)).toEqual([501, 502]);
    expect(firstOk.continuation.hasMore).toBe(true);

    const cursor = firstOk.continuation.cursor;
    expect(cursor).toBeDefined();
    const second = await run(
      { view: "queue", detail: "summary", paging: paging(2, cursor) },
      servePagedRecords(source.records, source.totalRecords),
    );

    const secondOk = expectOk(second.outcome);
    expect(second.calls[0]?.url.searchParams.get("page")).toBe("2");
    expect(queueItems(secondOk.data).map((item) => item.context.queueItemId)).toEqual([503, 504]);
    expect(secondOk.continuation.hasMore).toBe(false);
    expect(secondOk.continuation.cursor).toBeUndefined();
  });

  it("filters the returned page by media without widening the upstream request", async () => {
    const source = paged("queue");
    const { outcome, calls } = await run(
      { view: "queue", detail: "summary", mediaIds: [13], paging: paging() },
      servePagedRecords(source.records, source.totalRecords),
    );

    expect(calls).toHaveLength(1);
    const items = queueItems(expectOk(outcome).data);
    expect(items.map((item) => item.context.queueItemId)).toEqual([503]);
    // The instance still holds four rows, so the page is short but not final.
    expect(expectOk(outcome).continuation).toMatchObject({ returned: 1, hasMore: false });
  });

  it("scopes a focused queue read to the media record the reference retained", async () => {
    const { outcome, calls } = await run(
      { view: "queue_details", detail: "summary", queueItemId: 502, mediaId: 12, paging: paging() },
      serving("queue/details"),
    );

    expect(calls[0]?.url.pathname).toBe("/api/v3/queue/details");
    expect(calls[0]?.url.searchParams.get("seriesId")).toBe("12");
    const item = queueDetail(expectOk(outcome).data);
    expect(item.context.queueItemId).toBe(502);
    expect(item.evidence.trackedState).toBe("import_blocked");
    expect(item.evidence.statusMessages).toHaveLength(1);
  });

  it("reports a queue item that is no longer queued as a stale reference", async () => {
    const { outcome } = await run(
      {
        view: "queue_details",
        detail: "summary",
        queueItemId: 9999,
        mediaId: 12,
        paging: paging(),
      },
      serving("queue/details"),
    );

    expect(expectError(outcome).code).toBe("stale_reference");
  });
});

describe("sonarr history, blocklist, health, command, and disk reads", () => {
  it("pages history upstream when nothing narrows it", async () => {
    const source = paged("history");
    const { outcome, calls } = await run(
      { view: "history", detail: "full", paging: paging(2) },
      servePagedRecords(source.records, source.totalRecords),
    );

    expect(calls[0]?.url.pathname).toBe("/api/v3/history");
    expect(calls[0]?.url.searchParams.get("page")).toBe("1");
    const records = historyRecords(expectOk(outcome).data);
    expect(records.map((record) => record.eventType)).toEqual([
      "grabbed",
      "download_folder_imported",
    ]);
    expect(records[0]?.context).toEqual({ application: "sonarr", historyRecordId: 9001 });
    expect(records[0]?.media).toEqual({ application: "sonarr", kind: "series", id: "12" });
    expect(records[0]?.data).toEqual({
      indexer: "Example Indexer",
      releaseGroup: "ExampleGroup",
      sizeBytes: 3221225472,
      publishedDate: "2026-08-26T00:00:00Z",
      protocol: "1",
      downloadClient: "Example Client",
    });
    // The imported and dropped canonical paths upstream reports are not mapped.
    expect(JSON.stringify(records)).not.toContain("/media/example");
  });

  it("uses the media-scoped history route when exactly one record is named", async () => {
    const { outcome, calls } = await run(
      { view: "history", detail: "summary", mediaIds: [12], paging: paging() },
      () => jsonResponse(paged("history").records),
    );

    expect(calls[0]?.url.pathname).toBe("/api/v3/history/series");
    expect(calls[0]?.url.searchParams.get("seriesId")).toBe("12");
    // The scoped route is asked for one series and the filter is applied to
    // what it answered, so a record for another series cannot slip through.
    expect(
      historyRecords(expectOk(outcome).data).map((record) => record.context.historyRecordId),
    ).toEqual([9001, 9002, 9003]);
  });

  it("uses the since route for a lower date bound and applies the upper one itself", async () => {
    const { outcome, calls } = await run(
      {
        view: "history",
        detail: "summary",
        since: "2026-08-25T00:00:00Z",
        until: "2026-08-26T23:59:59Z",
        paging: paging(),
      },
      () => jsonResponse(paged("history").records),
    );

    expect(calls[0]?.url.pathname).toBe("/api/v3/history/since");
    expect(calls[0]?.url.searchParams.get("date")).toBe("2026-08-25T00:00:00Z");
    expect(
      historyRecords(expectOk(outcome).data).map((record) => record.context.historyRecordId),
    ).toEqual([9002, 9003]);
  });

  it("maps blocklist records without describing them as deleted media", async () => {
    const source = paged("blocklist");
    const { outcome } = await run(
      { view: "blocklist", detail: "summary", paging: paging() },
      servePagedRecords(source.records, source.totalRecords),
    );

    const records = blocklistRecords(expectOk(outcome).data);
    expect(records[0]).toEqual({
      application: "sonarr",
      context: { application: "sonarr", blocklistRecordId: 7001 },
      title: "Example Series S02E01 WEBDL-1080p",
      date: "2026-08-25T11:00:05Z",
      media: { application: "sonarr", kind: "series", id: "12" },
      episodes: [{ application: "sonarr", kind: "episode", id: "1003" }],
      quality: "WEBDL-1080p",
      protocol: "torrent",
      indexer: "Example Indexer",
      message: "The release was blocked after the download failed",
    });
    expect(records[1]?.episodes).toBeUndefined();
  });

  it("maps health checks without their outbound wiki links", async () => {
    const { outcome, calls } = await run(
      { view: "health", detail: "summary", paging: paging() },
      serving("health"),
    );

    expect(calls[0]?.url.pathname).toBe("/api/v3/health");
    const checks = healthChecks(expectOk(outcome).data);
    expect(checks).toEqual([
      {
        application: "sonarr",
        severity: "warning",
        source: "ImportListStatusCheck",
        message: "Lists unavailable due to failures: Example List",
      },
      {
        application: "sonarr",
        severity: "error",
        source: "DownloadClientCheck",
        message: "Unable to communicate with the configured download client",
      },
    ]);
  });

  it("reads command activity without being able to start one", async () => {
    const { outcome, calls } = await run(
      { view: "commands", detail: "summary", paging: paging() },
      serving("command"),
    );

    expect(calls.every((call) => call.init.method === "GET")).toBe(true);
    const commands = commandActivity(expectOk(outcome).data);
    expect(commands.map((command) => [command.name, command.status])).toEqual([
      ["RefreshSeries", "started"],
      ["RssSync", "completed"],
    ]);
    expect(commands[0]?.context).toEqual({ application: "sonarr", commandId: 3001 });
  });

  it("names a volume without reporting its canonical path", async () => {
    const { outcome } = await run(
      { view: "disk_space", detail: "summary", paging: paging() },
      serving("diskspace"),
    );

    expect(diskConditions(expectOk(outcome).data)).toEqual([
      { application: "sonarr", label: "Media", freeBytes: 214748364800, totalBytes: 1099511627776 },
      {
        application: "sonarr",
        label: "downloads",
        freeBytes: 53687091200,
        totalBytes: 107374182400,
      },
    ]);
  });
});
