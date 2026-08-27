import { beforeAll, describe, expect, it } from "vitest";
import {
  activityChangeRoutes,
  blocklistRecordState,
  blocklistRemovalEffects,
  checkHistoryFailure,
  type FailureHandlingPolicy,
  failurePolicyState,
  historyFailureEffects,
  historyRecordState,
  markHistoryFailed,
  maxRecordScanPages,
  readBlocklistRecord,
  readFailureHandlingPolicy,
  readHistoryRecord,
  reconcileHistoryFailure,
  removeBlocklistRecord,
} from "../src/adapters/activity/changes.js";
import { profileFor } from "../src/adapters/activity/media.js";
import type { BlocklistRecord, HistoryRecord } from "../src/adapters/activity/model.js";
import { UpstreamError } from "../src/http/errors.js";
import { activityFixture, servePagedRecords } from "./support/activity.js";
import { jsonResponse, libraryHarness, type UpstreamCall } from "./support/library.js";

/**
 * The history and blocklist mutation adapters, against the recorded fixtures.
 *
 * Everything that reaches an instance goes through the real upstream client with
 * an injected fetch, so the assertions cover the method, route, and body a real
 * Sonarr or Radarr would receive — which is the whole point for a module whose
 * two write paths are a POST that re-opens an acquisition and a DELETE.
 */

interface PagedBody {
  readonly records: readonly Record<string, unknown>[];
  readonly totalRecords?: number;
}

type FixtureBody = PagedBody | Record<string, unknown> | readonly unknown[];

const fixtures: Record<string, FixtureBody> = {};

/**
 * The recorded routes these tests answer with.
 *
 * The scoped history routes are recorded separately from the paged `history`
 * route rather than being emulated from it: they answer with a bare array where
 * `history` answers with a paged envelope, and serving one route's capture as
 * another's would mean the re-read this change adds was never held to a real
 * response from the endpoint it actually calls.
 */
const scopedHistoryRoutes = { sonarr: "history/series", radarr: "history/movie" } as const;

beforeAll(async () => {
  for (const application of ["sonarr", "radarr"] as const) {
    for (const route of [
      "history",
      scopedHistoryRoutes[application],
      "blocklist",
      "config/downloadclient",
    ]) {
      fixtures[`${application}/${route}`] = await activityFixture(application, route);
    }
  }
});

/** One scoped history route's recorded response, which is a bare array. */
function scopedHistory(application: "sonarr" | "radarr"): readonly unknown[] {
  const body = fixtures[`${application}/${scopedHistoryRoutes[application]}`];
  if (!Array.isArray(body)) {
    throw new Error(
      `Missing loaded fixture for ${application} ${scopedHistoryRoutes[application]}`,
    );
  }
  return body;
}

function paged(application: "sonarr" | "radarr", route: string): PagedBody {
  const body = fixtures[`${application}/${route}`];
  if (body === undefined || Array.isArray(body) || !("records" in body)) {
    throw new Error(`Missing loaded fixture for ${application} ${route}`);
  }
  return body as PagedBody;
}

function records(application: "sonarr" | "radarr", route: string): readonly unknown[] {
  return paged(application, route).records;
}

function config(application: "sonarr" | "radarr"): Record<string, unknown> {
  const body = fixtures[`${application}/config/downloadclient`];
  if (body === undefined || Array.isArray(body)) {
    throw new Error(`Missing loaded fixture for ${application} config/downloadclient`);
  }
  return body as Record<string, unknown>;
}

function harnessFor(
  application: "sonarr" | "radarr",
  respond: (call: UpstreamCall) => Response | Promise<Response>,
) {
  return libraryHarness(application, respond);
}

function foundHistory(lookup: Awaited<ReturnType<typeof readHistoryRecord>>): HistoryRecord {
  if (lookup.status !== "found") {
    throw new Error(`Expected a history record, got ${lookup.status}`);
  }
  return lookup.record;
}

function foundBlocklist(lookup: Awaited<ReturnType<typeof readBlocklistRecord>>): BlocklistRecord {
  if (lookup.status !== "found") {
    throw new Error(`Expected a blocklist record, got ${lookup.status}`);
  }
  return lookup.record;
}

function policy(
  replacementSearch: boolean | undefined,
  replacementSearchFromInteractiveSearch: boolean | undefined = replacementSearch,
): FailureHandlingPolicy {
  return { application: "sonarr", replacementSearch, replacementSearchFromInteractiveSearch };
}

function summaries(effects: readonly { readonly summary: string }[]): readonly string[] {
  return effects.map((effect) => effect.summary);
}

/** A page of `size` synthetic records, none of which is the one being sought. */
function filler(size: number, from: number): Record<string, unknown>[] {
  return Array.from({ length: size }, (_unused, index) => ({
    id: from + index,
    eventType: "grabbed",
    date: "2026-08-01T00:00:00Z",
    sourceTitle: "Example Filler",
  }));
}

describe("history record reads", () => {
  it("reads one record through the media route the reference retained", async () => {
    const harness = harnessFor("sonarr", () => jsonResponse(scopedHistory("sonarr")));
    const lookup = await readHistoryRecord(harness.client, profileFor("sonarr"), {
      historyRecordId: 9001,
      mediaId: 12,
    });

    const call = harness.calls[0];
    expect(call?.url.pathname).toBe("/api/v3/history/series");
    expect(call?.url.searchParams.get("seriesId")).toBe("12");
    expect(call?.init.method).toBe("GET");
    // One request, because the association is what bounds this read.
    expect(harness.calls).toHaveLength(1);
    expect(foundHistory(lookup)).toMatchObject({
      context: { application: "sonarr", historyRecordId: 9001, mediaId: 12 },
      eventType: "grabbed",
      title: "Example Series S01E01 Bluray-1080p",
    });
  });

  it("uses the movie route on Radarr and reports a record that route does not hold", async () => {
    const harness = harnessFor("radarr", () => jsonResponse(scopedHistory("radarr")));
    const profile = profileFor("radarr");

    const found = await readHistoryRecord(harness.client, profile, {
      historyRecordId: 9101,
      mediaId: 8,
    });
    expect(harness.calls[0]?.url.pathname).toBe("/api/v3/history/movie");
    expect(harness.calls[0]?.url.searchParams.get("movieId")).toBe("8");
    expect(foundHistory(found).context.mediaId).toBe(8);

    await expect(
      readHistoryRecord(harness.client, profile, { historyRecordId: 9999, mediaId: 8 }),
    ).resolves.toEqual({ status: "absent" });
  });

  it("walks the paged history when the record carries no association", async () => {
    const target = { ...(records("sonarr", "history")[0] as Record<string, unknown>), id: 9500 };
    const respond = servePagedRecords([...filler(100, 1), target], 101);
    const harness = harnessFor("sonarr", respond);

    const lookup = await readHistoryRecord(harness.client, profileFor("sonarr"), {
      historyRecordId: 9500,
    });

    expect(foundHistory(lookup).context.historyRecordId).toBe(9500);
    expect(harness.calls.map((call) => call.url.pathname)).toEqual([
      "/api/v3/history",
      "/api/v3/history",
    ]);
    expect(harness.calls.map((call) => call.url.searchParams.get("page"))).toEqual(["1", "2"]);
    // The full page size, because the walk is bounded by pages and asking for
    // fewer records per page would only make it walk further.
    expect(harness.calls[0]?.url.searchParams.get("pageSize")).toBe("100");
  });

  it("stops at the end of the collection rather than paging past it", async () => {
    const harness = harnessFor("sonarr", servePagedRecords(records("sonarr", "history")));

    await expect(
      readHistoryRecord(harness.client, profileFor("sonarr"), { historyRecordId: 9999 }),
    ).resolves.toEqual({ status: "absent" });
    expect(harness.calls).toHaveLength(1);
  });

  it("declines to page past its scan bound and says so", async () => {
    // Every page is full and the instance reports no total, so nothing but the
    // bound itself ends the walk.
    const harness = harnessFor("sonarr", (call) => {
      const page = Number(call.url.searchParams.get("page") ?? "1");
      return jsonResponse({ page, pageSize: 100, records: filler(100, page * 1000) });
    });

    await expect(
      readHistoryRecord(harness.client, profileFor("sonarr"), { historyRecordId: 9999 }),
    ).resolves.toEqual({ status: "beyond_scan" });
    // "Further back than this server will page" is not "no longer there", and
    // the bound is what keeps one mutation from becoming a hundred requests.
    expect(harness.calls).toHaveLength(maxRecordScanPages);
  });
});

describe("history failure reconciliation", () => {
  const grabbed = {
    id: 9001,
    seriesId: 12,
    eventType: "grabbed",
    date: "2026-08-27T09:39:00Z",
    sourceTitle: "Example Series S01E01 Bluray-1080p",
    downloadId: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
  };
  const failedFor = (id: number) => ({
    ...grabbed,
    id,
    eventType: "downloadFailed",
    date: "2026-08-27T10:00:00Z",
  });

  it("refuses to confirm from a failure that predates the mutation", async () => {
    // The instance already holds a download-failed event for this download when
    // the mutation is validated, and holds exactly the same one afterwards.
    const existing = [grabbed, failedFor(9500)];
    const harness = harnessFor("sonarr", () => jsonResponse(existing));
    const profile = profileFor("sonarr");

    const lookup = await readHistoryRecord(harness.client, profile, {
      historyRecordId: 9001,
      mediaId: 12,
    });
    if (lookup.status !== "found") {
      throw new Error("Expected the recorded grab");
    }
    expect(lookup.priorFailureIds).toEqual([9500]);

    // Nothing new appeared, so nothing is established — reporting `confirmed`
    // here would settle a receipt as succeeded on evidence that was already
    // there before the write.
    await expect(
      reconcileHistoryFailure(harness.client, profile, lookup.record, lookup.priorFailureIds),
    ).resolves.toEqual({ status: "unconfirmed" });
  });

  it("confirms from a failure that appeared after the mutation was validated", async () => {
    const before = [grabbed];
    const after = [grabbed, failedFor(9600)];
    let reads = 0;
    const harness = harnessFor("sonarr", () => {
      reads += 1;
      return jsonResponse(reads === 1 ? before : after);
    });
    const profile = profileFor("sonarr");

    const lookup = await readHistoryRecord(harness.client, profile, {
      historyRecordId: 9001,
      mediaId: 12,
    });
    if (lookup.status !== "found") {
      throw new Error("Expected the recorded grab");
    }
    expect(lookup.priorFailureIds).toEqual([]);

    await expect(
      reconcileHistoryFailure(harness.client, profile, lookup.record, lookup.priorFailureIds),
    ).resolves.toEqual({ status: "confirmed" });
  });

  it("establishes nothing for a grab the instance recorded no download identity for", async () => {
    const { downloadId: _dropped, ...anonymous } = grabbed;
    const harness = harnessFor("sonarr", () => jsonResponse([anonymous, failedFor(9700)]));
    const profile = profileFor("sonarr");

    const lookup = await readHistoryRecord(harness.client, profile, {
      historyRecordId: 9001,
      mediaId: 12,
    });
    if (lookup.status !== "found") {
      throw new Error("Expected the recorded grab");
    }

    // With nothing to match on, there is no evidence either way.
    await expect(
      reconcileHistoryFailure(harness.client, profile, lookup.record, lookup.priorFailureIds),
    ).resolves.toEqual({ status: "unconfirmed" });
  });
});

describe("blocklist record reads", () => {
  it("re-reads one blocked release and everything re-allowing it would bring back", async () => {
    const harness = harnessFor("sonarr", servePagedRecords(records("sonarr", "blocklist")));
    const lookup = await readBlocklistRecord(harness.client, profileFor("sonarr"), 7001);

    expect(harness.calls[0]?.url.pathname).toBe("/api/v3/blocklist");
    expect(harness.calls[0]?.init.method).toBe("GET");
    expect(foundBlocklist(lookup)).toMatchObject({
      application: "sonarr",
      context: { blocklistRecordId: 7001 },
      title: "Example Series S02E01 WEBDL-1080p",
      media: { kind: "series", id: "12" },
      episodes: [{ kind: "episode", id: "1003" }],
      protocol: "torrent",
    });
  });

  it("reports a record the instance no longer blocks as absent", async () => {
    const harness = harnessFor("radarr", servePagedRecords(records("radarr", "blocklist")));

    await expect(readBlocklistRecord(harness.client, profileFor("radarr"), 7999)).resolves.toEqual({
      status: "absent",
    });
  });
});

describe("history and blocklist writes", () => {
  it("marks exactly one history record failed", async () => {
    const harness = harnessFor("sonarr", () => new Response(null, { status: 200 }));
    await markHistoryFailed(harness.client, 9001);

    const call = harness.calls[0];
    expect(call?.url.pathname).toBe("/api/v3/history/failed/9001");
    expect(call?.init.method).toBe("POST");
    expect(call?.init.body).toBe("{}");
    // The route names a history record, never a queue row: failing a grab and
    // resolving an active download are different operations upstream too.
    expect(activityChangeRoutes.historyFailed).toBe("history/failed");
  });

  it("removes exactly one blocklist record and sends no body", async () => {
    const harness = harnessFor("radarr", () => new Response(null, { status: 200 }));
    await removeBlocklistRecord(harness.client, 7101);

    const call = harness.calls[0];
    expect(call?.url.pathname).toBe("/api/v3/blocklist/7101");
    expect(call?.init.method).toBe("DELETE");
    expect(call?.init.body).toBeUndefined();
    // Neither application's bulk or clear-all route is reachable from here.
    expect(call?.url.pathname).not.toContain("bulk");
  });

  it("surfaces an unreachable instance as an upstream failure rather than an answer", async () => {
    const harness = harnessFor("sonarr", () => {
      throw new Error("connection refused");
    });

    const failure = await readFailureHandlingPolicy(harness.client, "sonarr").catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(UpstreamError);
    if (failure instanceof UpstreamError) {
      expect(failure.kind).toBe("unavailable");
      expect(failure.message).not.toContain("sonarr-secret-key");
    }
  });
});

describe("failed-download handling", () => {
  it("reads whether the instance redownloads failed grabs", async () => {
    const sonarr = harnessFor("sonarr", () => jsonResponse(config("sonarr")));
    await expect(readFailureHandlingPolicy(sonarr.client, "sonarr")).resolves.toEqual({
      application: "sonarr",
      replacementSearch: true,
      replacementSearchFromInteractiveSearch: true,
    });
    expect(sonarr.calls[0]?.url.pathname).toBe("/api/v3/config/downloadclient");
    expect(sonarr.calls[0]?.init.method).toBe("GET");

    const radarr = harnessFor("radarr", () => jsonResponse(config("radarr")));
    await expect(readFailureHandlingPolicy(radarr.client, "radarr")).resolves.toEqual({
      application: "radarr",
      replacementSearch: false,
      replacementSearchFromInteractiveSearch: false,
    });
  });

  it("reports a setting the instance omitted as unknown rather than as off", async () => {
    const harness = harnessFor("sonarr", () => jsonResponse({ id: 1 }));

    await expect(readFailureHandlingPolicy(harness.client, "sonarr")).resolves.toEqual({
      application: "sonarr",
      replacementSearch: undefined,
      replacementSearchFromInteractiveSearch: undefined,
    });
    // The read set keeps the three answers apart too, so a plan made against an
    // unknown setting does not match one made against a disabled setting.
    expect(failurePolicyState(policy(undefined))).toEqual({
      replacementSearch: null,
      replacementSearchFromInteractiveSearch: null,
    });
    expect(failurePolicyState(policy(false))).toEqual({
      replacementSearch: false,
      replacementSearchFromInteractiveSearch: false,
    });
    // The interactive exclusion changes the prediction, so it has to change the
    // read set as well or a plan would survive it being turned off.
    expect(failurePolicyState(policy(true, false))).not.toEqual(failurePolicyState(policy(true)));
  });
});

describe("effect mapping", () => {
  const record: HistoryRecord = {
    application: "sonarr",
    context: { application: "sonarr", historyRecordId: 9001, mediaId: 12 },
    eventType: "grabbed",
    date: "2026-08-27T09:39:00Z",
    title: "Example Series S01E01 Bluray-1080p",
  };

  it("discloses the blocklist effect as certain and the search as the setting decides", () => {
    const enabled = historyFailureEffects([record], policy(true));
    // Every effect is requested as well as predicted, because a direct apply
    // never reads a plan's predictions and the search is exactly what such a
    // caller most needs to be told about.
    expect(summaries(enabled.requested)).toEqual([
      "mark the grab of “Example Series S01E01 Bluray-1080p” failed",
      "blocklist “Example Series S01E01 Bluray-1080p” so this instance does not grab it again",
      expect.stringContaining("start a replacement search"),
    ]);
    expect(summaries(enabled.predicted)).toEqual(summaries(enabled.requested));
    expect(enabled.warnings).toEqual([]);

    const disabled = historyFailureEffects([record], policy(false));
    expect(summaries(disabled.predicted).at(-1)).toContain("no replacement search follows");
    expect(disabled.predicted.at(-1)?.severity).toBe("informational");
  });

  it("says a search may follow when the instance did not report its handling", () => {
    const unknown = historyFailureEffects([record], policy(undefined));

    expect(summaries(unknown.predicted).at(-1)).toContain("may follow");
    expect(unknown.predicted.at(-1)?.severity).toBe("consequential");
    expect(unknown.warnings).toEqual([
      "this instance did not report whether it redownloads failed grabs, so a replacement search may follow",
    ]);
  });

  it("withdraws the certainty when the instance excludes interactive grabs", () => {
    const excluded = historyFailureEffects([record], policy(true, false));

    // The instance redownloads failed grabs but not the interactively grabbed
    // ones, and nothing in a history record says which kind this was — so the
    // search is disclosed as possible rather than as certain.
    expect(summaries(excluded.predicted).at(-1)).toContain("may follow");
    expect(summaries(excluded.predicted).at(-1)).toContain("interactive search");
    expect(excluded.warnings).toEqual([
      "this instance excludes interactively grabbed releases from automatic redownload, and its history does not record which searches were interactive",
    ]);

    // An instance that did not report the second setting has not established it
    // either, so it gets the same withdrawal rather than the benefit of a fact
    // nothing read.
    // Built literally rather than through the helper, whose default would fill
    // the omitted setting in and hide exactly the case under test.
    const unreported = historyFailureEffects([record], {
      application: "sonarr",
      replacementSearch: true,
      replacementSearchFromInteractiveSearch: undefined,
    });
    expect(summaries(unreported.predicted).at(-1)).toContain("may follow");
    expect(unreported.warnings).toEqual([
      "this instance did not report how it treats interactively grabbed releases, so whether a replacement search follows is not established",
    ]);

    // The exclusion is moot where nothing is redownloaded at all.
    expect(
      summaries(historyFailureEffects([record], policy(false, false)).predicted).at(-1),
    ).toContain("no replacement search follows");
  });

  it("counts a multi-record selection rather than naming one of them", () => {
    const second: HistoryRecord = {
      ...record,
      context: { application: "sonarr", historyRecordId: 9005, mediaId: 13 },
      title: "Example Anime S01E02 WEBDL-720p",
    };
    const many = historyFailureEffects([record, second], policy(true));

    // Naming the first of two would say the mutation affects that release while
    // it silently acts on the other, which is false about the very thing a plan
    // exists to state.
    expect(summaries(many.requested)[0]).toBe("mark the grab of 2 grabbed releases failed");
    expect(summaries(many.requested).join(" ")).not.toContain("Example Series S01E01");
    expect(summaries(many.requested)[1]).toContain("does not grab them again");
  });

  it("names the release even when the instance recorded no title", () => {
    const untitled = historyFailureEffects([{ ...record, title: undefined }], policy(true));

    expect(summaries(untitled.requested)[0]).toBe("mark the grab of the grabbed release failed");
  });

  it("describes a blocklist removal as re-allowing rather than as deleting", () => {
    const blocked: BlocklistRecord = {
      application: "radarr",
      context: { application: "radarr", blocklistRecordId: 7101 },
      title: "Example Fallback 2019 WEBDL-1080p",
    };
    const effects = blocklistRemovalEffects("radarr", [blocked]);

    expect(summaries(effects.predicted)).toContain(
      "no media file, download-client payload, or queue item is removed by this change",
    );
    expect(summaries(effects.predicted).some((summary) => summary.includes("grabbed again"))).toBe(
      true,
    );
    // The one word a caller is most likely to read as deletion is used only of
    // the blocklist record itself.
    for (const summary of summaries(effects.predicted).slice(1)) {
      expect(summary).not.toMatch(/delete/iu);
    }
  });

  it("refuses a history record that records something other than a grab", () => {
    expect(checkHistoryFailure(record)).toEqual({ status: "ok" });
    expect(checkHistoryFailure({ ...record, eventType: "download_folder_imported" })).toMatchObject(
      {
        status: "blocked",
        reason: expect.stringContaining("download folder imported"),
      },
    );
  });
});

describe("mutation read sets", () => {
  const record: HistoryRecord = {
    application: "sonarr",
    context: { application: "sonarr", historyRecordId: 9001, mediaId: 12 },
    eventType: "grabbed",
    date: "2026-08-27T09:39:00Z",
    title: "Example Series S01E01 Bluray-1080p",
    successful: true,
  };

  it("fingerprints only what decides what the mutation would do", () => {
    const state = historyRecordState(record);

    expect(state).toEqual({
      id: 9001,
      eventType: "grabbed",
      date: "2026-08-27T09:39:00Z",
      successful: true,
      mediaId: 12,
    });
    // A field the mutation cannot act on must not move the fingerprint, or a
    // plan would go stale because an unrelated detail did.
    expect(historyRecordState({ ...record, quality: "WEBDL-1080p" })).toEqual(state);
    expect(historyRecordState({ ...record, eventType: "download_failed" })).not.toEqual(state);

    const blocked: BlocklistRecord = {
      application: "sonarr",
      context: { application: "sonarr", blocklistRecordId: 7001 },
      date: "2026-08-25T11:00:05Z",
      protocol: "torrent",
      media: { application: "sonarr", kind: "series", id: "12" },
      message: "The release was blocked after the download failed",
    };
    expect(blocklistRecordState(blocked)).toEqual({
      id: 7001,
      date: "2026-08-25T11:00:05Z",
      protocol: "torrent",
      mediaId: "12",
    });
    expect(blocklistRecordState({ ...blocked, message: "Reworded upstream" })).toEqual(
      blocklistRecordState(blocked),
    );
  });
});

describe("mutation reads and untrusted payloads", () => {
  const canary = "CANARY-0010-DO-NOT-LEAK";

  // The payloads below are built here rather than loaded, and that is not a gap
  // in the fixture coverage: the fixture contract refuses a secret-bearing or
  // identifying value outright, so a hostile response cannot be recorded as one.
  // A planted canary has to be planted.
  it("keeps a planted secret out of the record, its effects, and its read set", async () => {
    const trackerHost = ["tracker", "example", "invalid"].join(".");
    const harness = harnessFor("sonarr", () =>
      jsonResponse([
        {
          id: 9001,
          seriesId: 12,
          eventType: "grabbed",
          date: "2026-08-27T09:39:00Z",
          sourceTitle: "Example Series S01E01 Bluray-1080p",
          // Every field below is one upstream really fills and this server
          // really refuses: the raw download identifier, an outbound URL, and
          // canonical paths on the operator's disk.
          downloadId: `${canary}-download-id`,
          data: {
            downloadUrl: `https://${trackerHost}/download?apikey=${canary}`,
            torrentInfoHash: canary,
            droppedPath: `/media/private/${canary}`,
            importedPath: `/media/private/${canary}`,
            message: `Grabbed from https://${trackerHost}/details?id=${canary}`,
          },
        },
      ]),
    );

    const record = foundHistory(
      await readHistoryRecord(harness.client, profileFor("sonarr"), {
        historyRecordId: 9001,
        mediaId: 12,
      }),
    );

    expect(JSON.stringify(record)).not.toContain(canary);
    expect(JSON.stringify(historyRecordState(record))).not.toContain(canary);
    expect(JSON.stringify(historyFailureEffects([record], policy(true)))).not.toContain(canary);
  });

  it("keeps a planted secret out of a blocked release and its effects", async () => {
    const trackerHost = ["tracker", "example", "invalid"].join(".");
    const harness = harnessFor("radarr", () =>
      jsonResponse({
        page: 1,
        pageSize: 100,
        totalRecords: 1,
        records: [
          {
            id: 7101,
            movieId: 10,
            sourceTitle: "Example Fallback 2019 WEBDL-1080p",
            date: "2026-08-20T12:00:05Z",
            protocol: "torrent",
            message: `Blocked, see https://${trackerHost}/rules?apikey=${canary}`,
          },
        ],
      }),
    );

    const record = foundBlocklist(
      await readBlocklistRecord(harness.client, profileFor("radarr"), 7101),
    );

    expect(record.message).not.toContain(canary);
    expect(JSON.stringify(record)).not.toContain(canary);
    expect(JSON.stringify(blocklistRemovalEffects(record.application, [record]))).not.toContain(
      canary,
    );
  });
});
