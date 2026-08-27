import { beforeAll, describe, expect, it } from "vitest";
import type { ActivityQueryRequest } from "../src/adapters/activity/requests.js";
import { type ActivityQueryOutcome, runActivityQuery } from "../src/adapters/activity/service.js";
import {
  activityFixture,
  commandActivity,
  expectError,
  expectOk,
  healthChecks,
  historyRecords,
  indexerStatistics,
  indexerStatuses,
  paging,
  servePagedRecords,
} from "./support/activity.js";
import { jsonResponse, libraryHarness, type UpstreamCall } from "./support/library.js";

interface PagedFixture {
  readonly totalRecords: number;
  readonly records: readonly Record<string, unknown>[];
}

const fixtures: Record<string, unknown> = {};

beforeAll(async () => {
  for (const route of ["history", "health", "command", "indexerstatus", "indexerstats"]) {
    fixtures[route] = await activityFixture("prowlarr", route);
  }
});

function body(route: string): unknown {
  const value = fixtures[route];
  if (value === undefined) {
    throw new Error(`Missing loaded fixture for prowlarr ${route}`);
  }
  return value;
}

async function run(
  request: ActivityQueryRequest,
  respond: (call: UpstreamCall) => Response | Promise<Response>,
): Promise<{ outcome: ActivityQueryOutcome; calls: readonly UpstreamCall[] }> {
  const harness = libraryHarness("prowlarr", respond);
  const outcome = await runActivityQuery("prowlarr", harness.client, request);
  return { outcome, calls: harness.calls };
}

describe("prowlarr activity reads", () => {
  it("maps indexer history through the allowlisted data members only", async () => {
    const source = body("history") as PagedFixture;
    const { outcome, calls } = await run(
      { view: "history", detail: "full", paging: paging() },
      servePagedRecords(source.records, source.totalRecords),
    );

    expect(calls[0]?.url.pathname).toBe("/api/v1/history");
    const records = historyRecords(expectOk(outcome).data);
    expect(records.map((record) => record.eventType)).toEqual([
      "indexer_query",
      "release_grabbed",
      "indexer_auth",
    ]);
    expect(records[0]?.indexer).toEqual({ application: "prowlarr", indexerId: 21 });
    expect(records[0]?.data).toEqual({
      queryType: "tvsearch",
      queryResults: 42,
      elapsedTimeMs: 812,
    });
    expect(records[2]?.successful).toBe(false);

    // The search term and the calling application are in the upstream bag and
    // in neither mapped record.
    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain("example series");
    expect(serialized).not.toContain("Sonarr");
  });

  it("maps indexer failure state", async () => {
    const { outcome, calls } = await run(
      { view: "indexer_status", detail: "summary", paging: paging() },
      () => jsonResponse(body("indexerstatus")),
    );

    expect(calls[0]?.url.pathname).toBe("/api/v1/indexerstatus");
    // The recorded fixture is the one change 0005 already captured for this
    // route; reading the same route twice does not justify a second recording
    // of it. `escalationLevel` is in that payload and in neither result: it is
    // upstream backoff bookkeeping, not evidence a caller can act on.
    expect(indexerStatuses(expectOk(outcome).data)).toEqual([
      {
        application: "prowlarr",
        indexer: { application: "prowlarr", indexerId: 2 },
        disabledUntil: "2026-06-01T05:00:00Z",
        initialFailure: "2026-06-01T00:00:00Z",
        mostRecentFailure: "2026-06-01T04:00:00Z",
      },
      {
        application: "prowlarr",
        indexer: { application: "prowlarr", indexerId: 3 },
        disabledUntil: "2099-01-01T00:00:00Z",
        initialFailure: "2026-08-26T18:00:00Z",
        mostRecentFailure: "2026-08-27T06:00:00Z",
      },
    ]);
  });

  it("distinguishes an indexer that has failed from one currently disabled", async () => {
    // Every record in the recorded fixture is currently disabled, so the other
    // half of the distinction is supplied inline rather than by extending a
    // fixture another change owns. `disabledUntil` absent is what says an
    // indexer failed before but is back in rotation now — the difference
    // between "this cannot have answered the search" and "this could have".
    const { outcome } = await run(
      { view: "indexer_status", detail: "summary", paging: paging() },
      () =>
        jsonResponse([
          {
            id: 13,
            indexerId: 4,
            initialFailure: "2026-08-01T00:00:00Z",
            mostRecentFailure: "2026-08-01T01:00:00Z",
            disabledTill: null,
          },
        ]),
    );

    const statuses = indexerStatuses(expectOk(outcome).data);
    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.disabledUntil).toBeUndefined();
    expect(statuses[0]?.mostRecentFailure).toBe("2026-08-01T01:00:00Z");
  });

  it("passes the statistics window to the instance and maps the indexer aggregate", async () => {
    const { outcome, calls } = await run(
      {
        view: "indexer_statistics",
        detail: "summary",
        since: "2026-08-01T00:00:00Z",
        until: "2026-08-27T00:00:00Z",
        paging: paging(),
      },
      () => jsonResponse(body("indexerstats")),
    );

    expect(calls[0]?.url.pathname).toBe("/api/v1/indexerstats");
    expect(calls[0]?.url.searchParams.get("startDate")).toBe("2026-08-01T00:00:00Z");
    expect(calls[0]?.url.searchParams.get("endDate")).toBe("2026-08-27T00:00:00Z");
    expect(indexerStatistics(expectOk(outcome).data)[1]).toEqual({
      application: "prowlarr",
      indexer: { application: "prowlarr", indexerId: 22, name: "Example Usenet Indexer" },
      queries: 118,
      grabs: 9,
      rssQueries: 90,
      authQueries: 12,
      failedQueries: 40,
      failedGrabs: 3,
      failedRssQueries: 11,
      failedAuthQueries: 12,
      averageResponseTimeMs: 15021,
    });
  });

  /**
   * The caller-host and user-agent aggregates cannot be recorded in a fixture:
   * the fixture contract refuses a payload with keys named that way, which is
   * exactly the point. The hostile shape is therefore supplied inline, so the
   * adapter is still made to face the payload a real instance would send.
   */
  it("never maps the caller-host or user-agent aggregates", async () => {
    const { outcome } = await run(
      { view: "indexer_statistics", detail: "full", paging: paging() },
      () =>
        jsonResponse({
          indexers: [
            {
              indexerId: 21,
              indexerName: "Example Indexer",
              numberOfQueries: 5,
              numberOfGrabs: 1,
              averageResponseTime: 100,
            },
          ],
          hosts: [
            { host: "CANARY-HOST-9d1f4c2b7a6e5f3d", numberOfQueries: 5, numberOfGrabs: 1 },
            { host: "CANARY-HOST-1a2b3c4d5e6f7a8b", numberOfQueries: 2, numberOfGrabs: 0 },
          ],
          userAgents: [
            { userAgent: "CANARY-AGENT-7f6e5d4c3b2a1908", numberOfQueries: 5, numberOfGrabs: 1 },
          ],
        }),
    );

    const serialized = JSON.stringify(indexerStatistics(expectOk(outcome).data));
    expect(serialized).not.toContain("CANARY-HOST");
    expect(serialized).not.toContain("CANARY-AGENT");
    expect(serialized).not.toContain("host");
    expect(serialized).not.toContain("userAgent");
    expect(indexerStatistics(expectOk(outcome).data)).toHaveLength(1);
  });

  it("reads health and command activity", async () => {
    const health = await run({ view: "health", detail: "summary", paging: paging() }, () =>
      jsonResponse(body("health")),
    );
    expect(healthChecks(expectOk(health.outcome).data)[0]).toEqual({
      application: "prowlarr",
      severity: "warning",
      source: "IndexerStatusCheck",
      message: "Indexers unavailable due to failures: Example Usenet Indexer",
    });

    const commands = await run({ view: "commands", detail: "summary", paging: paging() }, () =>
      jsonResponse(body("command")),
    );
    expect(commandActivity(expectOk(commands.outcome).data)[0]).toMatchObject({
      application: "prowlarr",
      name: "ApplicationIndexerSync",
      status: "completed",
    });
  });

  it("refuses the views prowlarr does not model before sending anything", async () => {
    for (const view of ["queue", "queue_status", "blocklist", "disk_space"] as const) {
      const { outcome, calls } = await run({ view, detail: "summary", paging: paging() }, () =>
        jsonResponse([]),
      );
      expect(expectError(outcome).code).toBe("unsupported_capability");
      expect(calls).toHaveLength(0);
    }
  });
});
