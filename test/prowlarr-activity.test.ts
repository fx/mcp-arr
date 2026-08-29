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
    // The recorded body is in the order its own `sortKey`/`sortDirection`
    // declare, which is the order Prowlarr answers this route in.
    expect(records.map((record) => record.eventType)).toEqual([
      "release_grabbed",
      "indexer_query",
      "indexer_auth",
    ]);
    expect(records[1]?.indexer).toEqual({ application: "prowlarr", indexerId: 21 });
    expect(records[1]?.data).toEqual({
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
    // The recorded body is the four members Prowlarr 2.5.2.5491 sends for a
    // held-down indexer and no others. It carries neither `id` nor
    // `escalationLevel`, because the instance sends neither; an earlier
    // recording carried both and made the adapter's required `id` look
    // satisfied while every real read of this route was refused.
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

  it("reads a status row whatever unread members it carries", async () => {
    // The four members the mapper reads are the whole of what this view
    // depends on. A version that also sends the row's own identifier and its
    // backoff counter is read exactly as well, and neither reaches the result.
    const { outcome } = await run(
      { view: "indexer_status", detail: "summary", paging: paging() },
      () =>
        jsonResponse([
          {
            id: 13,
            escalationLevel: 9,
            indexerId: 5,
            initialFailure: "2026-08-01T00:00:00Z",
            mostRecentFailure: "2026-08-01T01:00:00Z",
            disabledTill: "2026-08-01T02:00:00Z",
          },
        ]),
    );

    expect(indexerStatuses(expectOk(outcome).data)).toEqual([
      {
        application: "prowlarr",
        indexer: { application: "prowlarr", indexerId: 5 },
        disabledUntil: "2026-08-01T02:00:00Z",
        initialFailure: "2026-08-01T00:00:00Z",
        mostRecentFailure: "2026-08-01T01:00:00Z",
      },
    ]);
  });

  it("still refuses a status row whose indexer identity it cannot use", async () => {
    // The tolerance is confined to members nothing reads. The identity the
    // result is built around is not one of them: `indexerId` is what the
    // returned indexer reference is, and a fraction cannot become one, so the
    // read fails rather than publishing a reference to indexer one and a half.
    // A fraction rather than a string is what pins that boundary, since a
    // string is refused by any numeric declaration while `1.5` is refused only
    // while the identity is still declared as a whole number.
    const { outcome } = await run(
      { view: "indexer_status", detail: "summary", paging: paging() },
      () => jsonResponse([{ indexerId: 1.5, disabledTill: "2026-08-01T02:00:00Z" }]),
    );

    expect(expectError(outcome).code).toBe("unexpected_response");
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
