import { beforeAll, describe, expect, it } from "vitest";
import type { LibraryQueryRequest } from "../src/adapters/library/requests.js";
import { type LibraryQueryOutcome, runLibraryQuery } from "../src/adapters/library/service.js";
import {
  calendarEvents,
  fixtureBody,
  jsonResponse,
  libraryHarness,
  lookupResults,
  mediaFiles,
  mediaItems,
  paging,
  type UpstreamCall,
  wantedItems,
  without,
} from "./support/library.js";
import { testApiKeys } from "./support/tool-context.js";

const apiKey = testApiKeys.sonarr;

const fixtures: Record<string, unknown> = {};

beforeAll(async () => {
  for (const route of [
    "series",
    "series/lookup",
    "episode",
    "episodefile",
    "wanted/missing",
    "wanted/cutoff",
    "calendar",
  ]) {
    fixtures[route] = await fixtureBody("sonarr", route);
  }
});

function body(route: string): unknown {
  const value = fixtures[route];
  if (value === undefined) {
    throw new Error(`Missing loaded fixture for sonarr ${route}`);
  }
  return value;
}

interface Run {
  readonly outcome: LibraryQueryOutcome;
  readonly calls: readonly UpstreamCall[];
}

async function run(
  request: LibraryQueryRequest,
  respond: (call: UpstreamCall) => Response | Promise<Response>,
): Promise<Run> {
  const harness = libraryHarness("sonarr", respond);
  const outcome = await runLibraryQuery("sonarr", harness.client, request);
  return { outcome, calls: harness.calls };
}

function serving(route: string): (call: UpstreamCall) => Response {
  return () => jsonResponse(body(route));
}

function expectOk(outcome: LibraryQueryOutcome) {
  if (outcome.status !== "ok") {
    throw new Error(`Expected an ok outcome, got ${outcome.error.code}: ${outcome.error.message}`);
  }
  return outcome;
}

function expectError(outcome: LibraryQueryOutcome) {
  if (outcome.status !== "error") {
    throw new Error("Expected an error outcome");
  }
  return outcome.error;
}

describe("sonarr library reads", () => {
  it("maps a series into the normalized model and bounds the page", async () => {
    const { outcome, calls } = await run(
      { view: "series", detail: "summary", paging: paging(2) },
      serving("series"),
    );

    const ok = expectOk(outcome);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.pathname).toBe("/api/v3/series");
    expect(calls[0]?.url.search).toBe("");
    expect(calls[0]?.init.method).toBe("GET");

    expect(ok.data.view).toBe("series");
    expect(ok.data.items[0]).toEqual({
      application: "sonarr",
      ref: { application: "sonarr", kind: "series", id: "12" },
      title: "Example Series",
      sortTitle: "example series",
      year: 2019,
      monitoring: { monitored: true, monitoredChildren: 1, totalChildren: 2 },
      status: "continuing",
      added: "2024-01-05T12:00:00Z",
      statistics: { fileCount: 2, sizeOnDiskBytes: 2048 },
      qualityProfile: { application: "sonarr", kind: "quality_profile", id: "1" },
      rootFolder: undefined,
      tags: [{ application: "sonarr", kind: "tag", id: "3" }],
      detail: undefined,
      sonarr: {
        kind: "series",
        seriesType: "standard",
        network: "Example Network",
        tvdbId: 100001,
        ended: false,
        seasonCount: 2,
      },
    });
    expect(ok.continuation).toMatchObject({ pageSize: 2, returned: 2, hasMore: true });
    expect(ok.continuation.cursor).toMatch(/^[A-Za-z0-9_-]+$/u);
  });

  it("continues an adapter-bounded page through its cursor", async () => {
    const first = expectOk(
      (await run({ view: "series", detail: "summary", paging: paging(2) }, serving("series")))
        .outcome,
    );

    const { outcome } = await run(
      { view: "series", detail: "summary", paging: paging(2, first.continuation.cursor) },
      serving("series"),
    );

    const second = expectOk(outcome);
    expect(mediaItems(second.data).map((item) => item.ref.id)).toEqual(["14"]);
    expect(second.continuation).toEqual({ pageSize: 2, returned: 1, hasMore: false });
  });

  it("filters series by monitored state and by identifier", async () => {
    const unmonitored = expectOk(
      (
        await run(
          { view: "series", detail: "summary", monitored: false, paging: paging(25) },
          serving("series"),
        )
      ).outcome,
    );
    expect(mediaItems(unmonitored.data).map((item) => item.ref.id)).toEqual(["14"]);

    const selected = expectOk(
      (
        await run(
          { view: "series", detail: "summary", ids: [13], paging: paging(25) },
          serving("series"),
        )
      ).outcome,
    );
    expect(mediaItems(selected.data).map((item) => item.ref.id)).toEqual(["13"]);
  });

  it("omits nested detail by default and adds it only at the full level", async () => {
    const summary = expectOk(
      (await run({ view: "series", detail: "summary", paging: paging(1) }, serving("series")))
        .outcome,
    );
    const summarySeries = mediaItems(summary.data)[0];
    expect(summarySeries?.detail).toBeUndefined();
    expect(summarySeries?.rootFolder).toBeUndefined();
    expect(JSON.stringify(summarySeries)).not.toContain("sanitized series overview");

    const full = expectOk(
      (await run({ view: "series", detail: "full", paging: paging(1) }, serving("series"))).outcome,
    );
    expect(mediaItems(full.data)[0]).toMatchObject({
      rootFolder: { application: "sonarr", kind: "root_folder", id: "/media/example/series" },
      detail: {
        overview: "A sanitized series overview recorded only to fix the payload shape",
        genres: ["Drama", "Mystery"],
        runtimeMinutes: 45,
        certification: "TV-14",
        path: "/media/example/series/Example Series",
      },
    });
  });

  it("reads seasons from the series record they belong to", async () => {
    const seriesFixture = body("series") as readonly Record<string, unknown>[];
    const { outcome, calls } = await run(
      { view: "seasons", detail: "summary", seriesId: 12, paging: paging(25) },
      () => jsonResponse(seriesFixture[0]),
    );

    const ok = expectOk(outcome);
    expect(calls[0]?.url.pathname).toBe("/api/v3/series/12");
    expect(ok.data.items).toHaveLength(2);
    expect(mediaItems(ok.data)[0]).toMatchObject({
      ref: { application: "sonarr", kind: "season", id: "12/1" },
      monitoring: { monitored: true },
      sonarr: { kind: "season", seriesId: 12, seasonNumber: 1, episodeCount: 2 },
    });

    const monitored = expectOk(
      (
        await run(
          { view: "seasons", detail: "summary", seriesId: 12, monitored: true, paging: paging(25) },
          () => jsonResponse(seriesFixture[0]),
        )
      ).outcome,
    );
    expect(mediaItems(monitored.data).map((item) => item.ref.id)).toEqual(["12/1"]);
  });

  it("keeps both aired and absolute episode numbering", async () => {
    const { outcome, calls } = await run(
      { view: "episodes", detail: "summary", seriesId: 13, seasonNumber: 1, paging: paging(25) },
      serving("episode"),
    );

    const ok = expectOk(outcome);
    expect(calls[0]?.url.pathname).toBe("/api/v3/episode");
    expect(Object.fromEntries(calls[0]?.url.searchParams ?? [])).toEqual({
      seriesId: "13",
      seasonNumber: "1",
    });

    const absolute = mediaItems(ok.data).find((item) => item.ref.id === "1002");
    expect(absolute).toEqual({
      application: "sonarr",
      ref: { application: "sonarr", kind: "episode", id: "1002" },
      title: "Example Absolute Episode",
      sortTitle: undefined,
      year: undefined,
      monitoring: { monitored: true, monitoredChildren: undefined, totalChildren: undefined },
      status: undefined,
      added: undefined,
      statistics: undefined,
      qualityProfile: undefined,
      rootFolder: undefined,
      tags: undefined,
      detail: undefined,
      sonarr: {
        kind: "episode",
        seriesId: 13,
        seriesTitle: undefined,
        seasonNumber: 1,
        episodeNumber: 2,
        absoluteEpisodeNumber: 14,
        airDate: "2021-07-14",
        airDateUtc: "2021-07-14T14:30:00Z",
        hasFile: true,
        finaleType: undefined,
      },
    });

    // The aired-only episode keeps its aired numbering and reports no absolute
    // number rather than inventing one.
    const aired = mediaItems(ok.data).find((item) => item.ref.id === "1001");
    expect(aired).toMatchObject({
      sonarr: { seasonNumber: 1, episodeNumber: 1, absoluteEpisodeNumber: undefined },
    });
  });

  it("maps episode files and filters them by season", async () => {
    const { outcome, calls } = await run(
      { view: "episode_files", detail: "summary", seriesId: 12, paging: paging(25) },
      serving("episodefile"),
    );

    const ok = expectOk(outcome);
    expect(Object.fromEntries(calls[0]?.url.searchParams ?? [])).toEqual({ seriesId: "12" });
    expect(mediaFiles(ok.data)[0]).toEqual({
      application: "sonarr",
      ref: { application: "sonarr", kind: "episode_file", id: "2001" },
      parent: { application: "sonarr", kind: "series", id: "12" },
      relativePath: "Season 01/Example Series - S01E01 - Example Pilot Bluray-1080p.mkv",
      sizeBytes: 1073741824,
      dateAdded: "2024-01-06T08:15:00Z",
      quality: "Bluray-1080p",
      languages: ["English"],
      releaseGroup: "EXAMPLEGRP",
      detail: undefined,
      sonarr: { seriesId: 12, seasonNumber: 1, episodeIds: [1001] },
    });

    const secondSeason = expectOk(
      (
        await run(
          {
            view: "episode_files",
            detail: "full",
            seriesId: 12,
            seasonNumber: 2,
            paging: paging(25),
          },
          serving("episodefile"),
        )
      ).outcome,
    );
    expect(mediaFiles(secondSeason.data).map((item) => item.ref.id)).toEqual(["2003"]);
    expect(mediaFiles(secondSeason.data)[0]).toMatchObject({
      detail: {
        path: "/media/example/series/Example Series/Season 02/Example Series - S02E02 - Example Follow Up WEBDL-720p.mkv",
        customFormats: undefined,
        customFormatScore: 0,
        mediaInfo: { videoCodec: "x264", audioCodec: "EAC3", resolution: "1920x1080" },
      },
    });
  });

  it("pages missing and cutoff-unmet episodes upstream", async () => {
    const { outcome, calls } = await run(
      { view: "missing_episodes", detail: "summary", monitored: true, paging: paging(2) },
      serving("wanted/missing"),
    );

    const ok = expectOk(outcome);
    expect(calls[0]?.url.pathname).toBe("/api/v3/wanted/missing");
    expect(Object.fromEntries(calls[0]?.url.searchParams ?? [])).toEqual({
      page: "1",
      pageSize: "2",
      includeSeries: "true",
      monitored: "true",
    });
    expect(ok.data.items).toEqual([
      expect.objectContaining({
        wanted: { reason: "missing", expectedAt: "2026-09-30T20:00:00Z" },
      }),
      expect.objectContaining({
        wanted: { reason: "missing", expectedAt: "2021-07-14T14:30:00Z" },
      }),
    ]);
    // The upstream total says a third record exists beyond this window.
    expect(ok.continuation).toMatchObject({ pageSize: 2, returned: 2, hasMore: true });

    const next = await run(
      {
        view: "missing_episodes",
        detail: "summary",
        monitored: true,
        paging: paging(2, ok.continuation.cursor),
      },
      serving("wanted/missing"),
    );
    expect(next.calls[0]?.url.searchParams.get("page")).toBe("2");

    const cutoff = await run(
      { view: "cutoff_unmet_episodes", detail: "summary", paging: paging(2) },
      serving("wanted/cutoff"),
    );
    const cutoffOk = expectOk(cutoff.outcome);
    expect(cutoff.calls[0]?.url.pathname).toBe("/api/v3/wanted/cutoff");
    expect(cutoff.calls[0]?.url.searchParams.has("monitored")).toBe(false);
    expect(wantedItems(cutoffOk.data)[0]).toMatchObject({
      media: { sonarr: { seriesTitle: "Example Series" } },
      wanted: { reason: "cutoff_unmet" },
    });
    expect(cutoffOk.continuation).toMatchObject({ returned: 1, hasMore: false });
  });

  it("reads a dated calendar window and derives each event's end", async () => {
    const { outcome, calls } = await run(
      {
        view: "calendar",
        detail: "summary",
        start: "2019-04-01",
        end: "2019-04-30",
        paging: paging(25),
      },
      serving("calendar"),
    );

    const ok = expectOk(outcome);
    expect(Object.fromEntries(calls[0]?.url.searchParams ?? [])).toEqual({
      start: "2019-04-01",
      end: "2019-04-30",
      includeSeries: "true",
      // An unfiltered calendar asks for unmonitored records too, rather than
      // silently inheriting Sonarr's monitored-only default.
      unmonitored: "true",
    });
    expect(calendarEvents(ok.data)[0]).toMatchObject({
      start: "2019-04-01T20:00:00Z",
      end: "2019-04-01T20:45:00.000Z",
      hasFile: true,
      media: { ref: { kind: "episode", id: "1001" } },
    });

    const monitoredOnly = await run(
      {
        view: "calendar",
        detail: "summary",
        start: "2019-04-01",
        end: "2026-12-31",
        monitored: true,
        paging: paging(25),
      },
      serving("calendar"),
    );
    expect(monitoredOnly.calls[0]?.url.searchParams.get("unmonitored")).toBe("false");
    expect(expectOk(monitoredOnly.outcome).data.items).toHaveLength(1);
  });

  it("falls back to the series runtime when the episode reports none", async () => {
    const [first, ...rest] = body("calendar") as readonly Record<string, unknown>[];
    // Zero is how Sonarr says it does not know an episode's runtime.
    const withoutRuntime = [{ ...first, runtime: 0 }, ...rest];

    const { outcome } = await run(
      {
        view: "calendar",
        detail: "summary",
        start: "2019-04-01",
        end: "2019-04-30",
        paging: paging(25),
      },
      () => jsonResponse(withoutRuntime),
    );

    expect(calendarEvents(expectOk(outcome).data)[0]).toMatchObject({
      start: "2019-04-01T20:00:00Z",
      end: "2019-04-01T20:45:00.000Z",
    });
  });

  it("looks a series up without implying an add", async () => {
    const { outcome, calls } = await run(
      { view: "lookup", detail: "summary", term: "example series", paging: paging(25) },
      serving("series/lookup"),
    );

    const ok = expectOk(outcome);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.pathname).toBe("/api/v3/series/lookup");
    expect(calls[0]?.url.searchParams.get("term")).toBe("example series");
    expect(calls[0]?.init.method).toBe("GET");

    expect(lookupResults(ok.data)).toEqual([
      {
        application: "sonarr",
        title: "Example Series",
        sortTitle: "example series",
        year: 2019,
        status: "continuing",
        // Already in the library, so the result points at the existing record.
        existing: { application: "sonarr", kind: "series", id: "12" },
        detail: undefined,
        sonarr: { tvdbId: 100001, seriesType: "standard", network: "Example Network" },
      },
      {
        application: "sonarr",
        title: "Example New Series",
        sortTitle: "example new series",
        year: 2026,
        status: "upcoming",
        existing: undefined,
        detail: undefined,
        sonarr: { tvdbId: 100004, seriesType: "standard", network: "Example Streamer" },
      },
    ]);
  });

  it("reports statistics it was never given as absent rather than as zero", async () => {
    const [recorded] = body("series") as readonly Record<string, unknown>[];
    const series = recorded ?? {};
    const seasons = (series.seasons as readonly Record<string, unknown>[]).map((season) =>
      without(season, "statistics"),
    );
    const silent = { ...without(series, "statistics"), seasons };

    const seriesPage = expectOk(
      (
        await run({ view: "series", detail: "summary", paging: paging(25) }, () =>
          jsonResponse([silent]),
        )
      ).outcome,
    );
    // Not `fileCount: 0`: that would state the series has no files, which is
    // a different claim from the instance having reported nothing.
    expect(mediaItems(seriesPage.data)[0]?.statistics).toBeUndefined();
    expect(JSON.stringify(mediaItems(seriesPage.data)[0])).not.toContain("fileCount");

    const seasonPage = expectOk(
      (
        await run({ view: "seasons", detail: "summary", seriesId: 12, paging: paging(25) }, () =>
          jsonResponse(silent),
        )
      ).outcome,
    );
    expect(mediaItems(seasonPage.data)[0]?.statistics).toBeUndefined();

    // A figure the instance really did report survives, zero included.
    const partial = { ...silent, statistics: { sizeOnDisk: 0 } };
    const partialPage = expectOk(
      (
        await run({ view: "series", detail: "summary", paging: paging(25) }, () =>
          jsonResponse([partial]),
        )
      ).outcome,
    );
    expect(mediaItems(partialPage.data)[0]?.statistics).toEqual({
      fileCount: undefined,
      sizeOnDiskBytes: 0,
    });
  });

  it("refuses a lookup identifier that is not a whole number", async () => {
    const results = body("series/lookup") as readonly Record<string, unknown>[];

    const { outcome } = await run(
      { view: "lookup", detail: "summary", term: "example series", paging: paging(25) },
      () => jsonResponse(results.map((result) => ({ ...result, id: 1.5 }))),
    );

    // A fractional id would reach a media reference, which is the identity
    // later changes key media on.
    expect(expectError(outcome).code).toBe("unexpected_response");
  });

  it("normalizes every upstream failure and never quotes the key or the term", async () => {
    const term = "sensitive lookup term";
    const failures = [
      ["upstream_authentication", () => jsonResponse({ message: `rejected ${apiKey}` }, 401)],
      ["upstream_rejection", () => jsonResponse({ message: "bad request" }, 400)],
      ["stale_reference", () => jsonResponse({ message: "not found" }, 404)],
      ["rate_limit", () => jsonResponse({ message: "slow down" }, 429)],
      [
        "unavailable_application",
        () => {
          throw new TypeError(`fetch failed for ${apiKey}`);
        },
      ],
      // A body this server cannot map is reported as an unexpected response
      // rather than being partially mapped or echoed back.
      ["unexpected_response", () => jsonResponse({ notAnArray: true })],
    ] as const;

    for (const [code, respond] of failures) {
      const { outcome } = await run(
        { view: "lookup", detail: "summary", term, paging: paging(25) },
        respond,
      );
      const error = expectError(outcome);
      expect(error.code).toBe(code);
      expect(error.application).toBe("sonarr");
      expect(error.remediation).not.toBe("");
      const serialized = `${error.message}\n${JSON.stringify(error)}`;
      expect(serialized).not.toContain(apiKey);
      expect(serialized).not.toContain(term);
    }
  });
});
