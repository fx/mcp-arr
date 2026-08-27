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
  for (const route of ["history", "health", "command"]) {
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
