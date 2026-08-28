import { beforeAll, describe, expect, it } from "vitest";
import { maxSearchIndexers } from "../src/adapters/acquisition/prowlarr.js";
import type { ReleaseSearchRequest } from "../src/adapters/acquisition/requests.js";
import {
  type ReleaseSearchOutcome,
  runReleaseSearch,
} from "../src/adapters/acquisition/service.js";
import { createManualClock } from "../src/state/clock.js";
import {
  expectError,
  expectOk,
  type HarnessOptions,
  jsonResponse,
  releasePaging,
  searchHarness,
  titlesOf,
  type UpstreamCall,
} from "./support/acquisition.js";
import { fixtureBody } from "./support/library.js";

/**
 * The Prowlarr aggregate search.
 *
 * Prowlarr tolerates individual indexer failures by design, so most of what
 * there is to check here is that a failure stays confined to the indexer it
 * happened to while the rest of the result still comes back — and that the
 * caller is told the result is not exhaustive.
 */

type Record_ = Record<string, unknown>;

const fixtures: { indexers: Record_[]; statuses: Record_[]; releases: Record_[] } = {
  indexers: [],
  statuses: [],
  releases: [],
};

beforeAll(async () => {
  fixtures.indexers = await fixtureBody<Record_[]>("prowlarr", "indexer");
  fixtures.statuses = await fixtureBody<Record_[]>("prowlarr", "indexerstatus");
  fixtures.releases = await fixtureBody<Record_[]>("prowlarr", "search");
});

/** A moment at which the recorded status disables indexer 3 and nothing else. */
const clock = createManualClock(Date.parse("2026-08-27T00:00:00Z"));

const aggregate: ReleaseSearchRequest = {
  target: "prowlarr_aggregate",
  detail: "summary",
  term: "example series",
  paging: releasePaging(),
};

interface Instance {
  readonly indexers?: unknown;
  readonly statuses?: unknown;
  readonly search: (indexerId: number) => Response | Promise<Response>;
}

/** The releases the recorded search returned, re-attributed to one indexer. */
function releasesFrom(indexerId: number, name: string): Record_[] {
  return fixtures.releases.map((release, index) => ({
    ...release,
    indexerId,
    indexer: name,
    guid: `example-indexer-${indexerId}-${index}`,
  }));
}

function respond(instance: Instance): (call: UpstreamCall) => Response | Promise<Response> {
  return (call) => {
    // An aggregate search is a read on all three routes. A stub that answered a
    // write with a search body would let a client that posted where it should
    // have read pass unnoticed, so the method is checked as strictly as the
    // route below is.
    if (call.init.method !== "GET") {
      throw new Error(`unexpected ${String(call.init.method)} to ${call.url.pathname}`);
    }
    switch (call.url.pathname) {
      case "/api/v1/indexer":
        return jsonResponse(instance.indexers ?? fixtures.indexers);
      case "/api/v1/indexerstatus":
        return jsonResponse(instance.statuses ?? fixtures.statuses);
      case "/api/v1/search":
        return instance.search(Number(call.url.searchParams.get("indexerIds")));
      default:
        throw new Error(`unexpected route ${call.url.pathname}`);
    }
  };
}

interface Run {
  readonly outcome: ReleaseSearchOutcome;
  readonly calls: readonly UpstreamCall[];
}

async function run(
  instance: Instance,
  request: ReleaseSearchRequest = aggregate,
  options: HarnessOptions = {},
): Promise<Run> {
  const harness = searchHarness("prowlarr", respond(instance), options);
  const outcome = await runReleaseSearch("prowlarr", harness.client, request, { clock });
  return { outcome, calls: harness.calls };
}

/** Which indexers this run actually asked, in the order it asked them. */
function searched(calls: readonly UpstreamCall[]): number[] {
  return calls
    .filter((call) => call.url.pathname === "/api/v1/search")
    .map((call) => Number(call.url.searchParams.get("indexerIds")));
}

describe("prowlarr aggregate search", () => {
  it("asks each enabled indexer separately and skips one the instance disabled", async () => {
    const { outcome, calls } = await run({
      search: (indexerId) => jsonResponse(releasesFrom(indexerId, `Example Indexer ${indexerId}`)),
    });

    const ok = expectOk(outcome);
    // Indexer 4 is disabled in configuration and 3 is held down by the
    // instance, so only 1 and 2 are ever asked.
    expect(searched(calls)).toEqual([1, 2]);
    const firstSearch = calls.find((call) => call.url.pathname === "/api/v1/search");
    expect(firstSearch?.url.searchParams.get("query")).toBe("example series");
    expect(firstSearch?.url.searchParams.get("type")).toBe("search");

    expect(ok.data.completeness).toEqual({
      complete: false,
      queried: 3,
      succeeded: 2,
      indexers: [
        { indexer: { id: 1, name: "Example Indexer A" }, state: "succeeded", releases: 2 },
        { indexer: { id: 2, name: "Example Indexer B" }, state: "succeeded", releases: 2 },
        {
          indexer: { id: 3, name: "Example Indexer C" },
          state: "blocked",
          releases: 0,
          reason: "the instance has disabled this indexer until 2099-01-01T00:00:00.000Z",
        },
      ],
    });
    expect(ok.data.items).toHaveLength(4);
    expect(ok.warnings).toContain("1 of 3 indexers did not answer; the result is not exhaustive");
  });

  it("returns the indexers that answered when another one fails", async () => {
    const { outcome, calls } = await run({
      search: (indexerId) =>
        indexerId === 1
          ? jsonResponse(releasesFrom(1, "Example Indexer A"))
          : jsonResponse({ message: "indexer unavailable" }, 502),
    });

    const ok = expectOk(outcome);
    expect(searched(calls)).toEqual([1, 2]);
    expect(ok.data.items).toHaveLength(2);
    for (const item of ok.data.items) {
      expect(item.identity.indexerId).toBe(1);
    }

    const outcomes = ok.data.completeness?.indexers ?? [];
    expect(outcomes.map((entry) => entry.state)).toEqual(["succeeded", "failed", "blocked"]);
    expect(ok.data.completeness).toMatchObject({ complete: false, queried: 3, succeeded: 1 });
    // The failure reason names the route and status, never a response body.
    expect(outcomes[1]?.reason).toContain("unexpected response");
    expect(outcomes[1]?.reason).not.toContain("indexer unavailable");
  });

  it("tells an indexer that ran out of time from one that failed", async () => {
    const { outcome } = await run(
      {
        search: (indexerId) =>
          indexerId === 1
            ? jsonResponse(releasesFrom(1, "Example Indexer A"))
            : new Promise<Response>(() => undefined),
      },
      aggregate,
      { timeoutMs: 5 },
    );

    const ok = expectOk(outcome);
    expect(ok.data.completeness?.indexers.map((entry) => entry.state)).toEqual([
      "succeeded",
      "timed_out",
      "blocked",
    ]);
    expect(ok.data.items).toHaveLength(2);
  });

  it("fails the whole search when the instance rejects the API key", async () => {
    const { outcome } = await run({ search: () => jsonResponse({}, 401) });

    const error = expectError(outcome);
    // One rejected key is not twenty indexer failures; it is one thing to fix.
    expect(error.code).toBe("upstream_authentication");
    expect(error.application).toBe("prowlarr");
  });

  it("reports an unreachable instance rather than an empty search", async () => {
    const harness = searchHarness("prowlarr", () => {
      throw new Error("connection refused");
    });

    const error = expectError(
      await runReleaseSearch("prowlarr", harness.client, aggregate, { clock }),
    );
    expect(error.code).toBe("unavailable_application");
    expect(harness.calls).toHaveLength(1);
  });

  it("still searches when the instance reports no indexer status, and says so", async () => {
    const { outcome, calls } = await run({
      statuses: { message: "not found" },
      search: (indexerId) => jsonResponse(releasesFrom(indexerId, `Example Indexer ${indexerId}`)),
    });

    const ok = expectOk(outcome);
    // Without the status endpoint nothing is known to be blocked, so the
    // indexer that would have been skipped is simply asked.
    expect(searched(calls)).toEqual([1, 2, 3]);
    expect(ok.data.completeness).toMatchObject({ complete: true, queried: 3, succeeded: 3 });
    expect(ok.warnings.join(" ")).toContain("did not report indexer status");
  });

  it("bounds how many indexers one search may query", async () => {
    const many = Array.from({ length: maxSearchIndexers + 5 }, (_unused, index) => ({
      id: index + 1,
      name: `Example Indexer ${index + 1}`,
      enable: true,
    }));

    const { outcome, calls } = await run({
      indexers: many,
      statuses: [],
      search: () => jsonResponse([]),
    });

    const ok = expectOk(outcome);
    expect(searched(calls)).toHaveLength(maxSearchIndexers);
    expect(ok.data.completeness).toMatchObject({
      complete: false,
      queried: maxSearchIndexers,
      succeeded: maxSearchIndexers,
    });
    expect(ok.warnings[0]).toContain(
      `only ${maxSearchIndexers} of ${many.length} enabled indexers were queried`,
    );
  });

  it("searches nothing when the instance has no enabled indexer", async () => {
    const { outcome, calls } = await run({
      indexers: [{ id: 1, name: "Example Indexer A", enable: false }],
      search: () => {
        throw new Error("no indexer may be searched");
      },
    });

    const ok = expectOk(outcome);
    expect(calls).toHaveLength(1);
    expect(ok.data.items).toEqual([]);
    expect(ok.warnings).toContain(
      "the instance has no enabled indexer, so this search reached none",
    );
  });
});

describe("prowlarr release normalization", () => {
  it("claims no acceptance decision and reports indexer categories at full detail", async () => {
    const { outcome } = await run(
      { ...{ search: () => jsonResponse(fixtures.releases) }, statuses: [] },
      { ...aggregate, detail: "full" },
    );

    const ok = expectOk(outcome);
    const [first] = ok.data.items;
    expect(first?.release).toMatchObject({
      application: "prowlarr",
      protocol: "torrent",
      prowlarr: { grabs: 311, files: 1 },
    });
    // Prowlarr holds no profile, so it judges nothing.
    expect(first?.release.decision).toBeUndefined();
    expect(first?.release.detail).toMatchObject({
      categories: ["TV", "TV HD"],
      indexerFlags: ["freeleech"],
    });
  });

  /**
   * Prowlarr's category taxonomy is slash-delimited by construction, and the
   * subcategory is the half that carries the information: a live instance
   * reports `TV` alongside `TV/HD`, and an indexer that reports only the leaf
   * reports nothing else at all. Scrubbing that away empties the field the model
   * documents as the indexer's category names, so the ordinary value is pinned
   * here rather than left to the canary tests.
   */
  it("publishes a slash-delimited category name rather than scrubbing it away", async () => {
    const categorized = fixtures.releases.map((release) => ({
      ...release,
      categories: [{ name: "TV" }, { name: "TV/HD" }],
    }));

    const ok = expectOk(
      (
        await run(
          { statuses: [], search: () => jsonResponse(categorized) },
          { ...aggregate, detail: "full" },
        )
      ).outcome,
    );

    expect(ok.data.items[0]?.release.detail?.categories).toEqual(["TV", "TV/HD"]);
  });

  it("keeps a leaf-only category list rather than emptying it", async () => {
    const leafOnly = fixtures.releases.map((release) => ({
      ...release,
      categories: [{ name: "Movies/UHD" }],
    }));

    const ok = expectOk(
      (
        await run(
          { statuses: [], search: () => jsonResponse(leafOnly) },
          { ...aggregate, detail: "full" },
        )
      ).outcome,
    );

    expect(ok.data.items[0]?.release.detail?.categories).toEqual(["Movies/UHD"]);
  });

  /**
   * The category field is one of only three that publish a separator at all, so
   * it is the surface where a planted path would travel if the tolerance were
   * wider than its own description. Each of these is a shape the taxonomy rule
   * refuses for a different reason — a third segment, a UNC prefix, a drive
   * letter, a dot, a backslash — and a category list that is nothing but markers
   * is dropped rather than published.
   */
  it("still takes a path an indexer planted in a category name", async () => {
    const planted = fixtures.releases.map((release) => ({
      ...release,
      categories: [
        { name: "/media/private/tv" },
        { name: "\\\\server\\share\\Private" },
        { name: "C:\\Media\\tv" },
        { name: "tracker.example.invalid/rss" },
        { name: "server\\share" },
        { name: "https://tracker.example.invalid/rules?apikey=SECRET" },
      ],
    }));

    const ok = expectOk(
      (
        await run(
          { statuses: [], search: () => jsonResponse(planted) },
          { ...aggregate, detail: "full" },
        )
      ).outcome,
    );

    expect(ok.data.items[0]?.release.detail?.categories).toBeUndefined();
  });

  /**
   * A path with a space in it is the shape a shape-only rule is worst at: every
   * head rule stops at the first space, so the tail arrives as a fresh token
   * that looks exactly like a two-level category. It is refused here because the
   * taxonomy rule spares a token only when it is the whole value, and this one
   * is what a redaction left behind. What survives is the final bare word, which
   * carries no separator and so names no directory level.
   */
  it("refuses a category that is only the tail of a path a rule already cut", async () => {
    const planted = fixtures.releases.map((release) => ({
      ...release,
      categories: [{ name: "\\\\server\\share$\\Private Stash\\Home Movies" }],
    }));

    const ok = expectOk(
      (
        await run(
          { statuses: [], search: () => jsonResponse(planted) },
          { ...aggregate, detail: "full" },
        )
      ).outcome,
    );

    expect(ok.data.items[0]?.release.detail?.categories).toEqual(["[redacted] Movies"]);
  });

  it("orders the merged result deterministically and pages it by whole pages", async () => {
    const instance: Instance = {
      statuses: [],
      search: (indexerId) => jsonResponse(releasesFrom(indexerId, `Example Indexer ${indexerId}`)),
    };

    const first = expectOk(
      (await run(instance, { ...aggregate, paging: releasePaging(3) })).outcome,
    );
    expect(first.continuation).toMatchObject({ pageSize: 3, returned: 3, hasMore: true });

    const second = expectOk(
      (
        await run(instance, {
          ...aggregate,
          paging: releasePaging(3, first.continuation.cursor),
        })
      ).outcome,
    );

    // Newest first, then title, then indexer, then GUID: a total order, so the
    // two pages never overlap and never skip a release.
    expect(titlesOf(first.data.items)).toEqual([
      "Example Series S01E02 1080p WEB-DL x264-EXAMPLEGRP",
      "Example Series S01E02 1080p WEB-DL x264-EXAMPLEGRP",
      "Example Series S01E02 1080p WEB-DL x264-EXAMPLEGRP",
    ]);
    expect(first.data.items.map((item) => item.identity.indexerId)).toEqual([1, 2, 3]);
    expect(second.data.items.map((item) => item.identity.indexerId)).toEqual([1, 2, 3]);
    expect(second.continuation.hasMore).toBe(false);
  });

  /**
   * A category is a name the indexer publishes, exactly as a flag is, and it is
   * the one label only this adapter maps — so the canary goes into it here, and
   * the search runs at full detail, where the category list actually reaches a
   * caller.
   */
  it("never lets a protected URL from an indexer reach a mapped result", async () => {
    const canary = "CANARY-5c1d7e-DO-NOT-LEAK";
    const poisoned = fixtures.releases.map((release) => ({
      ...release,
      downloadUrl: `https://tracker.example.invalid/dl?apikey=${canary}`,
      magnetUrl: `magnet:?xt=urn:btih:${canary}`,
      infoUrl: `https://tracker.example.invalid/info?id=${canary}`,
      categories: [
        { name: `TV, see https://tracker.example.invalid/cats?apikey=${canary}` },
        { name: `/media/private/${canary}/tv` },
      ],
    }));

    const ok = expectOk(
      (
        await run(
          { statuses: [], search: () => jsonResponse(poisoned) },
          {
            ...aggregate,
            detail: "full",
          },
        )
      ).outcome,
    );

    const serialized = JSON.stringify(ok.data.items.map((item) => item.release));
    expect(serialized).not.toContain(canary);
    expect(serialized).not.toContain("://");
    expect(serialized).not.toContain("magnet:");
    // What the category still said is kept; the one that was only a path is not
    // published as a bare marker.
    expect(ok.data.items[0]?.release.detail?.categories).toEqual(["TV, see [redacted]"]);
  });

  it("never lets an indexer's own credentials out of the indexer definition", async () => {
    // The indexer resource carries each private tracker's configured
    // credentials, and this adapter reads that route only to learn which
    // indexers to ask.
    const canary = "CANARY-2b90af-DO-NOT-LEAK";
    const indexers = fixtures.indexers.map((indexer) => ({
      ...indexer,
      // An operator names their own indexers, and naming one after the tracker
      // it points at is an ordinary way to do it — so the name is a label like
      // any other and is scrubbed rather than reported verbatim.
      name: `Example Indexer, see https://tracker.example.invalid/${canary}`,
      fields: [
        { name: "apiKey", value: canary },
        { name: "baseUrl", value: `https://tracker.example.invalid/${canary}` },
      ],
      privacy: "private",
    }));

    const ok = expectOk(
      (
        await run({
          indexers,
          statuses: [],
          search: (indexerId) => jsonResponse(releasesFrom(indexerId, "Example Indexer A")),
        })
      ).outcome,
    );

    const serialized = JSON.stringify(ok);
    expect(serialized).not.toContain(canary);
    expect(serialized).not.toContain("://");
    // Only the identity and the name the outcome reports survive the read.
    for (const outcome of ok.data.completeness?.indexers ?? []) {
      expect(Object.keys(outcome.indexer).sort()).toEqual(["id", "name"]);
    }
  });
});
