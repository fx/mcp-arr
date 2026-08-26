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

const apiKey = testApiKeys.radarr;

const fixtures: Record<string, unknown> = {};

beforeAll(async () => {
  for (const route of [
    "movie",
    "movie/lookup",
    "collection",
    "moviefile",
    "wanted/missing",
    "wanted/cutoff",
    "calendar",
  ]) {
    fixtures[route] = await fixtureBody("radarr", route);
  }
});

function body(route: string): unknown {
  const value = fixtures[route];
  if (value === undefined) {
    throw new Error(`Missing loaded fixture for radarr ${route}`);
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
  const harness = libraryHarness("radarr", respond);
  const outcome = await runLibraryQuery("radarr", harness.client, request);
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

describe("radarr library reads", () => {
  it("maps a movie into the normalized model without its nested file record", async () => {
    const { outcome, calls } = await run(
      { view: "movies", detail: "summary", paging: paging(2) },
      serving("movie"),
    );

    const ok = expectOk(outcome);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.pathname).toBe("/api/v3/movie");
    expect(calls[0]?.url.search).toBe("");
    expect(calls[0]?.init.method).toBe("GET");

    expect(mediaItems(ok.data)[0]).toEqual({
      application: "radarr",
      ref: { application: "radarr", kind: "movie", id: "8" },
      title: "Example Movie",
      sortTitle: "example movie",
      year: 2021,
      monitoring: { monitored: true, monitoredChildren: undefined, totalChildren: undefined },
      status: "released",
      added: "2024-02-01T09:30:00Z",
      statistics: { fileCount: 1, sizeOnDiskBytes: 2147483648 },
      qualityProfile: { application: "radarr", kind: "quality_profile", id: "2" },
      rootFolder: undefined,
      tags: [{ application: "radarr", kind: "tag", id: "7" }],
      detail: undefined,
      radarr: {
        kind: "movie",
        tmdbId: 200001,
        imdbId: "tt0000001",
        minimumAvailability: "released",
        hasFile: true,
        studio: "Example Studio",
        collection: { tmdbId: 300001, title: "Example Collection" },
        releaseDates: {
          inCinemas: "2021-06-01T00:00:00Z",
          physicalRelease: "2021-09-01T00:00:00Z",
          digitalRelease: "2021-08-01T00:00:00Z",
        },
      },
    });
    // The upstream record nests a whole movieFile; a summary must not carry it.
    expect(JSON.stringify(mediaItems(ok.data)[0])).not.toContain("Bluray-1080p");
    expect(ok.continuation).toMatchObject({ pageSize: 2, returned: 2, hasMore: true });
  });

  it("filters movies by monitored state and by identifier and continues by cursor", async () => {
    const unmonitored = expectOk(
      (
        await run(
          { view: "movies", detail: "summary", monitored: false, paging: paging(25) },
          serving("movie"),
        )
      ).outcome,
    );
    expect(mediaItems(unmonitored.data).map((item) => item.ref.id)).toEqual(["10"]);

    const selected = expectOk(
      (
        await run(
          { view: "movies", detail: "summary", ids: [9, 10], paging: paging(25) },
          serving("movie"),
        )
      ).outcome,
    );
    expect(mediaItems(selected.data).map((item) => item.ref.id)).toEqual(["9", "10"]);

    const first = expectOk(
      (await run({ view: "movies", detail: "summary", paging: paging(2) }, serving("movie")))
        .outcome,
    );
    const second = expectOk(
      (
        await run(
          { view: "movies", detail: "summary", paging: paging(2, first.continuation.cursor) },
          serving("movie"),
        )
      ).outcome,
    );
    expect(mediaItems(second.data).map((item) => item.ref.id)).toEqual(["10"]);
    expect(second.continuation).toEqual({ pageSize: 2, returned: 1, hasMore: false });
  });

  it("adds alternate titles and the root folder only at the full detail level", async () => {
    const summary = expectOk(
      (await run({ view: "movies", detail: "summary", paging: paging(1) }, serving("movie")))
        .outcome,
    );
    expect(mediaItems(summary.data)[0]?.detail).toBeUndefined();

    const full = expectOk(
      (await run({ view: "movies", detail: "full", paging: paging(1) }, serving("movie"))).outcome,
    );
    expect(mediaItems(full.data)[0]).toMatchObject({
      rootFolder: { application: "radarr", kind: "root_folder", id: "/media/example/movies" },
      detail: {
        overview: "A sanitized movie overview recorded only to fix the payload shape",
        genres: ["Drama"],
        runtimeMinutes: 118,
        certification: "PG-13",
        path: "/media/example/movies/Example Movie (2021)",
        alternateTitles: ["Example Movie Alternate"],
      },
    });
  });

  it("maps collections with their member counts rather than their members", async () => {
    const { outcome, calls } = await run(
      { view: "collections", detail: "summary", paging: paging(25) },
      serving("collection"),
    );

    const ok = expectOk(outcome);
    expect(calls[0]?.url.pathname).toBe("/api/v3/collection");
    expect(mediaItems(ok.data)[0]).toMatchObject({
      ref: { application: "radarr", kind: "collection", id: "21" },
      title: "Example Collection",
      monitoring: { monitored: true, monitoredChildren: 1, totalChildren: 2 },
      radarr: { kind: "collection", tmdbId: 300001, movieCount: 2, searchOnAdd: false },
    });
    expect(JSON.stringify(ok.data.items)).not.toContain("Example Movie Sequel");

    const monitored = expectOk(
      (
        await run(
          { view: "collections", detail: "summary", monitored: true, paging: paging(25) },
          serving("collection"),
        )
      ).outcome,
    );
    expect(mediaItems(monitored.data).map((item) => item.ref.id)).toEqual(["21"]);
  });

  it("maps movie files, including the edition and full-detail media info", async () => {
    const { outcome, calls } = await run(
      { view: "movie_files", detail: "summary", movieId: 8, paging: paging(25) },
      serving("moviefile"),
    );

    const ok = expectOk(outcome);
    expect(calls[0]?.url.pathname).toBe("/api/v3/moviefile");
    expect(Object.fromEntries(calls[0]?.url.searchParams ?? [])).toEqual({ movieId: "8" });
    expect(mediaFiles(ok.data)[0]).toEqual({
      application: "radarr",
      ref: { application: "radarr", kind: "movie_file", id: "501" },
      parent: { application: "radarr", kind: "movie", id: "8" },
      relativePath: "Example Movie (2021) Bluray-1080p.mkv",
      sizeBytes: 2147483648,
      dateAdded: "2024-02-02T10:00:00Z",
      quality: "Bluray-1080p",
      languages: ["English"],
      releaseGroup: "EXAMPLEGRP",
      detail: undefined,
      radarr: { movieId: 8, edition: "Director Cut" },
    });

    const full = expectOk(
      (
        await run(
          { view: "movie_files", detail: "full", movieId: 8, paging: paging(25) },
          serving("moviefile"),
        )
      ).outcome,
    );
    expect(mediaFiles(full.data)[0]).toMatchObject({
      detail: {
        path: "/media/example/movies/Example Movie (2021)/Example Movie (2021) Bluray-1080p.mkv",
        customFormats: ["Example Format"],
        customFormatScore: 25,
        mediaInfo: { videoCodec: "x264", audioChannels: 5.1, runTime: "45:12" },
      },
    });
  });

  it("pages missing and cutoff-unmet movies upstream", async () => {
    const { outcome, calls } = await run(
      { view: "missing_movies", detail: "summary", monitored: true, paging: paging(2) },
      serving("wanted/missing"),
    );

    const ok = expectOk(outcome);
    expect(calls[0]?.url.pathname).toBe("/api/v3/wanted/missing");
    expect(Object.fromEntries(calls[0]?.url.searchParams ?? [])).toEqual({
      page: "1",
      pageSize: "2",
      monitored: "true",
    });
    expect(ok.data.items).toEqual([
      expect.objectContaining({
        wanted: { reason: "missing", expectedAt: "2026-11-20T00:00:00Z" },
      }),
      expect.objectContaining({
        wanted: { reason: "missing", expectedAt: "2004-08-10T00:00:00Z" },
      }),
    ]);
    expect(ok.continuation).toMatchObject({ pageSize: 2, returned: 2, hasMore: true });

    const next = await run(
      {
        view: "missing_movies",
        detail: "summary",
        monitored: true,
        paging: paging(2, ok.continuation.cursor),
      },
      serving("wanted/missing"),
    );
    expect(next.calls[0]?.url.searchParams.get("page")).toBe("2");

    const cutoff = await run(
      { view: "cutoff_unmet_movies", detail: "summary", paging: paging(2) },
      serving("wanted/cutoff"),
    );
    const cutoffOk = expectOk(cutoff.outcome);
    expect(cutoff.calls[0]?.url.pathname).toBe("/api/v3/wanted/cutoff");
    expect(cutoff.calls[0]?.url.searchParams.has("monitored")).toBe(false);
    expect(wantedItems(cutoffOk.data)[0]).toMatchObject({ wanted: { reason: "cutoff_unmet" } });
    expect(cutoffOk.continuation).toMatchObject({ returned: 1, hasMore: false });
  });

  it("reads a dated calendar window and leaves an unknown end absent", async () => {
    const { outcome, calls } = await run(
      {
        view: "calendar",
        detail: "summary",
        start: "2021-08-01",
        end: "2026-12-31",
        paging: paging(25),
      },
      serving("calendar"),
    );

    const ok = expectOk(outcome);
    expect(Object.fromEntries(calls[0]?.url.searchParams ?? [])).toEqual({
      start: "2021-08-01",
      end: "2026-12-31",
      unmonitored: "true",
    });
    expect(calendarEvents(ok.data)[0]).toMatchObject({
      start: "2021-08-01T00:00:00Z",
      end: "2021-08-01T01:58:00.000Z",
      hasFile: true,
      media: { ref: { kind: "movie", id: "8" } },
    });
    // A record with no usable runtime keeps its identity and reports no end.
    expect(calendarEvents(ok.data)[1]).toMatchObject({
      start: "2026-11-20T00:00:00Z",
      end: undefined,
      hasFile: false,
    });
  });

  it("looks a movie up without implying an add", async () => {
    const { outcome, calls } = await run(
      { view: "lookup", detail: "summary", term: "example movie", paging: paging(25) },
      serving("movie/lookup"),
    );

    const ok = expectOk(outcome);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.pathname).toBe("/api/v3/movie/lookup");
    expect(calls[0]?.url.searchParams.get("term")).toBe("example movie");
    expect(calls[0]?.init.method).toBe("GET");

    expect(lookupResults(ok.data)).toEqual([
      {
        application: "radarr",
        title: "Example Movie",
        sortTitle: "example movie",
        year: 2021,
        status: "released",
        existing: { application: "radarr", kind: "movie", id: "8" },
        detail: undefined,
        radarr: { tmdbId: 200001, imdbId: "tt0000001", studio: "Example Studio" },
      },
      {
        application: "radarr",
        title: "Example Unadded Movie",
        sortTitle: "example unadded movie",
        year: 2018,
        status: "released",
        existing: undefined,
        detail: undefined,
        radarr: { tmdbId: 200004, imdbId: "tt0000004", studio: "Example Other Studio" },
      },
    ]);
  });

  it("reports statistics it was never given as absent rather than as zero", async () => {
    const [recorded] = body("movie") as readonly Record<string, unknown>[];
    const silent = without(recorded ?? {}, "hasFile", "sizeOnDisk");

    const page = expectOk(
      (
        await run({ view: "movies", detail: "summary", paging: paging(25) }, () =>
          jsonResponse([silent]),
        )
      ).outcome,
    );
    expect(mediaItems(page.data)[0]?.statistics).toBeUndefined();
    expect(JSON.stringify(mediaItems(page.data)[0])).not.toContain("fileCount");

    // A movie the instance says has no file really does have none.
    const known = expectOk(
      (
        await run({ view: "movies", detail: "summary", paging: paging(25) }, () =>
          jsonResponse([{ ...silent, hasFile: false }]),
        )
      ).outcome,
    );
    expect(mediaItems(known.data)[0]?.statistics).toEqual({
      fileCount: 0,
      sizeOnDiskBytes: undefined,
    });
  });

  it("refuses a lookup identifier that is not a whole number", async () => {
    const results = body("movie/lookup") as readonly Record<string, unknown>[];

    const { outcome } = await run(
      { view: "lookup", detail: "summary", term: "example movie", paging: paging(25) },
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
      ["upstream_rejection", () => jsonResponse({ message: "bad request" }, 422)],
      ["stale_reference", () => jsonResponse({ message: "not found" }, 404)],
      ["rate_limit", () => jsonResponse({ message: "slow down" }, 429)],
      [
        "unavailable_application",
        () => {
          throw new TypeError(`fetch failed for ${apiKey}`);
        },
      ],
      ["unexpected_response", () => jsonResponse({ records: "not a list" })],
    ] as const;

    for (const [code, respond] of failures) {
      const { outcome } = await run(
        { view: "lookup", detail: "summary", term, paging: paging(25) },
        respond,
      );
      const error = expectError(outcome);
      expect(error.code).toBe(code);
      expect(error.application).toBe("radarr");
      const serialized = `${error.message}\n${JSON.stringify(error)}`;
      expect(serialized).not.toContain(apiKey);
      expect(serialized).not.toContain(term);
    }
  });
});
