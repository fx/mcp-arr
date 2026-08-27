import { describe, expect, it } from "vitest";
import {
  type ActivityQueryRequest,
  type ActivityView,
  activityViewApplications,
  activityViews,
  withinWindow,
} from "../src/adapters/activity/requests.js";
import { runActivityQuery } from "../src/adapters/activity/service.js";
import { applicationIds } from "../src/applications.js";
import { operationDefinitions } from "../src/tools/operations.js";
import { maxPageSize } from "../src/tools/schemas/common.js";
import { expectError, expectOk, paging, servePagedRecords } from "./support/activity.js";
import { jsonResponse, libraryHarness } from "./support/library.js";

/** One minimal request per view, carrying whatever that view requires. */
const requestForView: Readonly<Record<ActivityView, ActivityQueryRequest>> = {
  queue_status: { view: "queue_status", detail: "summary", paging: paging() },
  queue: { view: "queue", detail: "summary", paging: paging() },
  queue_details: {
    view: "queue_details",
    detail: "summary",
    queueItemId: 501,
    mediaId: 12,
    paging: paging(),
  },
  history: { view: "history", detail: "summary", paging: paging() },
  blocklist: { view: "blocklist", detail: "summary", paging: paging() },
  health: { view: "health", detail: "summary", paging: paging() },
  commands: { view: "commands", detail: "summary", paging: paging() },
  disk_space: { view: "disk_space", detail: "summary", paging: paging() },
  indexer_status: { view: "indexer_status", detail: "summary", paging: paging() },
  indexer_statistics: { view: "indexer_statistics", detail: "summary", paging: paging() },
};

describe("activity view support", () => {
  it("declares the same views and applications the operation registry does", () => {
    const registered = operationDefinitions
      .filter((operation) => operation.tool === "arr_activity_query")
      .map((operation) => [operation.variant, [...operation.applications]] as const);

    // Every registered variant is now implemented, so the two lists match
    // exactly rather than one of them carrying a pending exception.
    expect(registered).toEqual(
      activityViews.map((view) => [view, [...activityViewApplications[view]]]),
    );
  });

  it("refuses a view an application does not model before sending a request", async () => {
    for (const view of activityViews) {
      for (const application of applicationIds) {
        if (activityViewApplications[view].includes(application)) {
          continue;
        }
        const harness = libraryHarness(application, () => jsonResponse([]));
        const outcome = await runActivityQuery(application, harness.client, requestForView[view]);
        expect(expectError(outcome).code).toBe("unsupported_capability");
        expect(harness.calls).toHaveLength(0);
      }
    }
  });
});

describe("activity query paging and failure handling", () => {
  it("refuses a page size outside the published bounds", async () => {
    for (const pageSize of [0, -1, maxPageSize + 1, 1.5]) {
      const harness = libraryHarness("sonarr", () => jsonResponse([]));
      const outcome = await runActivityQuery("sonarr", harness.client, {
        view: "health",
        detail: "summary",
        paging: paging(pageSize),
      });
      expect(expectError(outcome).code).toBe("invalid_input");
      expect(harness.calls).toHaveLength(0);
    }
  });

  it("refuses a continuation minted for a different query", async () => {
    const records = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const harness = libraryHarness("sonarr", servePagedRecords(records));
    const first = await runActivityQuery("sonarr", harness.client, {
      view: "history",
      detail: "summary",
      paging: paging(2),
    });
    const cursor = expectOk(first).continuation.cursor;
    expect(cursor).toBeDefined();

    const mismatched = await runActivityQuery("sonarr", harness.client, {
      view: "history",
      detail: "full",
      paging: paging(2, cursor),
    });
    const error = expectError(mismatched);
    expect(error.code).toBe("invalid_input");
    expect(error.message).toContain("different query");

    const malformed = await runActivityQuery("sonarr", harness.client, {
      view: "history",
      detail: "summary",
      paging: paging(2, "not-a-cursor"),
    });
    expect(expectError(malformed).message).toContain("not issued by this server");
  });

  it("reports an unreachable instance as an unavailable application", async () => {
    const harness = libraryHarness("radarr", () => {
      throw new Error("connection refused");
    });
    const outcome = await runActivityQuery("radarr", harness.client, requestForView.queue_status);

    const error = expectError(outcome);
    expect(error.code).toBe("unavailable_application");
    expect(error.application).toBe("radarr");
    expect(error.recoverable).toBe(true);
    // The thrown message is the boundary's, never the underlying one.
    expect(error.message).not.toContain("connection refused");
  });

  it("reports a payload it cannot map without quoting it", async () => {
    const harness = libraryHarness("sonarr", () =>
      jsonResponse({ totalCount: "four", secret: "CANARY-SECRET-42" }),
    );
    const outcome = await runActivityQuery("sonarr", harness.client, requestForView.queue_status);

    const error = expectError(outcome);
    expect(error.code).toBe("unexpected_response");
    expect(error.message).not.toContain("CANARY-SECRET-42");
  });
});

describe("activity date windows", () => {
  it("keeps a record whose date it cannot read rather than dropping evidence", () => {
    const window = { since: "2026-01-01T00:00:00Z", until: "2026-01-31T00:00:00Z" };
    expect(withinWindow(undefined, window)).toBe(true);
    expect(withinWindow("not a date", window)).toBe(true);
    expect(withinWindow("2026-01-15T00:00:00Z", window)).toBe(true);
    expect(withinWindow("2025-12-31T23:59:59Z", window)).toBe(false);
    expect(withinWindow("2026-02-01T00:00:00Z", window)).toBe(false);
    expect(withinWindow("1999-01-01T00:00:00Z", {})).toBe(true);
  });
});
