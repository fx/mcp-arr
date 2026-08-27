import { beforeAll, describe, expect, it } from "vitest";
import {
  addMediaPayload,
  createMedia,
  currentTagIds,
  monitorSelections,
  readConfigurationRecords,
  readLookupCandidate,
  readRecordResource,
  recordResourcePath,
  recordState,
  rewriteResource,
  supportsMonitorSelection,
  type UpstreamResource,
  writeResource,
} from "../src/adapters/library/changes.js";
import { fixtureBody, jsonResponse, libraryHarness, type UpstreamCall } from "./support/library.js";

/**
 * The library mutation adapters, exercised against the recorded fixtures.
 *
 * The rewriting functions are pure and are called directly; everything that
 * reaches an instance goes through the real upstream client with an injected
 * fetch, so the assertions cover the method, route, and body a real instance
 * would receive.
 */

const fixtures: Record<string, unknown> = {};

beforeAll(async () => {
  for (const route of ["series", "series/lookup", "rootfolder", "qualityprofile", "tag"]) {
    fixtures[`sonarr/${route}`] = await fixtureBody("sonarr", route);
  }
  for (const route of ["movie", "movie/lookup", "qualityprofile"]) {
    fixtures[`radarr/${route}`] = await fixtureBody("radarr", route);
  }
});

function body(application: "sonarr" | "radarr", route: string): unknown {
  const value = fixtures[`${application}/${route}`];
  if (value === undefined) {
    throw new Error(`Missing loaded fixture for ${application} ${route}`);
  }
  return value;
}

function records(application: "sonarr" | "radarr", route: string): readonly UpstreamResource[] {
  return body(application, route) as readonly UpstreamResource[];
}

function firstSeries(): UpstreamResource {
  const series = records("sonarr", "series")[0];
  if (series === undefined) {
    throw new Error("The recorded series fixture is empty");
  }
  return series;
}

function harnessFor(
  application: "sonarr" | "radarr",
  respond: (call: UpstreamCall) => Response | Promise<Response>,
) {
  return libraryHarness(application, respond);
}

async function readBody(call: UpstreamCall): Promise<Record<string, unknown>> {
  const raw = call.init.body;
  if (typeof raw !== "string") {
    throw new Error("Expected a serialized JSON request body");
  }
  return JSON.parse(raw) as Record<string, unknown>;
}

describe("library mutation reads", () => {
  it("re-reads a lookup candidate by its metadata identifier", async () => {
    const harness = harnessFor("sonarr", () => jsonResponse(body("sonarr", "series/lookup")));
    const candidate = await readLookupCandidate(harness.client, "sonarr", "series_lookup", 100004);

    expect(harness.calls[0]?.url.pathname).toBe("/api/v3/series/lookup");
    // The term names the identifier rather than the title the caller searched
    // for, so the candidate that comes back is the one the reference stands for.
    expect(harness.calls[0]?.url.searchParams.get("term")).toBe("tvdb:100004");
    expect(harness.calls[0]?.init.method).toBe("GET");
    expect(candidate).toMatchObject({ metadataId: 100004, title: "Example New Series" });
    expect(candidate?.existingId).toBeUndefined();
  });

  it("reports the library record a candidate already is", async () => {
    const harness = harnessFor("sonarr", () => jsonResponse(body("sonarr", "series/lookup")));
    const candidate = await readLookupCandidate(harness.client, "sonarr", "series_lookup", 100001);

    expect(candidate?.existingId).toBe(12);
  });

  it("answers with nothing when the metadata source no longer offers the candidate", async () => {
    const harness = harnessFor("radarr", () => jsonResponse(body("radarr", "movie/lookup")));

    await expect(
      readLookupCandidate(harness.client, "radarr", "movie_lookup", 999999),
    ).resolves.toBeUndefined();
  });

  it("reduces each configuration list to identity and name", async () => {
    const harness = harnessFor("sonarr", (call) =>
      jsonResponse(body("sonarr", call.url.pathname.replace("/api/v3/", ""))),
    );

    await expect(
      readConfigurationRecords(harness.client, "sonarr", "root_folder"),
    ).resolves.toEqual([
      { id: 1, name: "/media/example/series" },
      { id: 2, name: "/media/example/archive" },
    ]);
    await expect(
      readConfigurationRecords(harness.client, "sonarr", "quality_profile"),
    ).resolves.toEqual([
      { id: 1, name: "Example HD" },
      { id: 2, name: "Example Anime HD" },
      { id: 4, name: "Example Any" },
    ]);
    // A tag names itself with a label rather than a name, and the reduction
    // reports it under the same property so one matcher serves every kind.
    await expect(readConfigurationRecords(harness.client, "sonarr", "tag")).resolves.toEqual([
      { id: 3, name: "example-tag" },
      { id: 4, name: "example-archive" },
      { id: 5, name: "example-review" },
    ]);
    expect(harness.calls.map((call) => call.url.pathname)).toEqual([
      "/api/v3/rootfolder",
      "/api/v3/qualityprofile",
      "/api/v3/tag",
    ]);
  });

  it("reads a season through the series resource that holds it", async () => {
    const harness = harnessFor("sonarr", () => jsonResponse(firstSeries()));
    await readRecordResource(harness.client, "sonarr", "season", 12);

    expect(harness.calls[0]?.url.pathname).toBe("/api/v3/series/12");
    // A series and any of its seasons are one resource, which is why a caller
    // grouping records by the thing it will write groups them by this path.
    expect(recordResourcePath("season", 12)).toBe(recordResourcePath("series", 12));
    expect(recordResourcePath("movie", 12)).not.toBe(recordResourcePath("series", 12));
  });
});

describe("library resource rewriting", () => {
  it("changes only the named fields and reports whether anything moved", () => {
    const series = firstSeries();
    const rewritten = rewriteResource(series, {
      kind: "series",
      changes: { monitored: false, qualityProfileId: 4 },
    });

    expect(rewritten.status).toBe("ok");
    if (rewritten.status !== "ok") {
      return;
    }
    expect(rewritten.changed).toBe(true);
    expect(rewritten.resource.monitored).toBe(false);
    expect(rewritten.resource.qualityProfileId).toBe(4);
    // Every field this project does not model travels back untouched, because
    // these APIs replace the whole resource.
    expect(rewritten.resource.titleSlug).toBe(series.titleSlug);
    expect(rewritten.resource.seasons).toEqual(series.seasons);
  });

  it("reports an unchanged rewrite rather than sending an identical resource", () => {
    const rewritten = rewriteResource(firstSeries(), {
      kind: "series",
      changes: { monitored: true },
    });

    expect(rewritten).toMatchObject({ status: "ok", changed: false });
  });

  it("flips one season's monitoring and leaves its siblings alone", () => {
    const series = firstSeries();
    const rewritten = rewriteResource(series, {
      kind: "season",
      seasonNumber: 2,
      changes: { monitored: true },
    });

    expect(rewritten.status).toBe("ok");
    if (rewritten.status !== "ok") {
      return;
    }
    expect(rewritten.changed).toBe(true);
    expect(rewritten.resource.seasons).toEqual([
      expect.objectContaining({ seasonNumber: 1, monitored: true }),
      expect.objectContaining({ seasonNumber: 2, monitored: true }),
    ]);
    expect(series.seasons).toEqual([
      expect.objectContaining({ seasonNumber: 1, monitored: true }),
      expect.objectContaining({ seasonNumber: 2, monitored: false }),
    ]);
  });

  it("refuses a season the series no longer has, and a season edit that is not monitoring", () => {
    expect(
      rewriteResource(firstSeries(), {
        kind: "season",
        seasonNumber: 99,
        changes: { monitored: true },
      }),
    ).toEqual({ status: "blocked", reason: "that season is no longer part of this series" });

    expect(
      rewriteResource(firstSeries(), {
        kind: "season",
        seasonNumber: 1,
        changes: { qualityProfileId: 4 },
      }),
    ).toEqual({ status: "blocked", reason: "a season accepts only a monitoring change" });
  });

  it("keeps a record's own folder when it is re-pointed at another root", () => {
    const rewritten = rewriteResource(firstSeries(), {
      kind: "series",
      changes: { rootFolderPath: "/media/example/archive" },
    });

    expect(rewritten).toMatchObject({
      status: "ok",
      changed: true,
      resource: {
        rootFolderPath: "/media/example/archive",
        path: "/media/example/archive/Example Series",
      },
    });
  });

  it("refuses to re-point a record whose current path it was never told", () => {
    const { path: _path, ...pathless } = firstSeries();

    expect(
      rewriteResource(pathless as UpstreamResource, {
        kind: "series",
        changes: { rootFolderPath: "/media/example/archive" },
      }),
    ).toMatchObject({ status: "blocked" });
  });

  it("writes Radarr's own spelling of a normalized availability value", () => {
    const movie = records("radarr", "movie")[0];
    if (movie === undefined) {
      throw new Error("The recorded movie fixture is empty");
    }

    expect(
      rewriteResource(movie, { kind: "movie", changes: { minimumAvailability: "in_cinemas" } }),
    ).toMatchObject({
      status: "ok",
      changed: true,
      resource: { minimumAvailability: "inCinemas" },
    });
    // The values that are already spelled alike upstream go through unchanged.
    expect(
      rewriteResource(movie, { kind: "movie", changes: { minimumAvailability: "announced" } }),
    ).toMatchObject({ resource: { minimumAvailability: "announced" } });
  });

  it("replaces the tag list with the identifiers it is given", () => {
    const series = firstSeries();
    expect(currentTagIds(series)).toEqual([3]);

    const rewritten = rewriteResource(series, { kind: "series", changes: { tagIds: [3, 5] } });
    expect(rewritten).toMatchObject({ status: "ok", changed: true, resource: { tags: [3, 5] } });

    const unchanged = rewriteResource(series, { kind: "series", changes: { tagIds: [3] } });
    expect(unchanged).toMatchObject({ status: "ok", changed: false });
  });

  it("fingerprints only the state a change depends on", () => {
    const series = firstSeries();
    const state = recordState(series);

    expect(state).toMatchObject({ id: 12, monitored: true, qualityProfileId: 1, tags: [3] });
    // A field a mutation cannot change must not move the fingerprint, or every
    // plan would go stale the moment an unrelated statistic did.
    expect(recordState({ ...series, statistics: { episodeCount: 99 } })).toEqual(state);
    expect(recordState({ ...series, monitored: false })).not.toEqual(state);
    expect(recordState(series, 2)).toMatchObject({ seasonNumber: 2, present: true });
    expect(recordState(series, 99)).toMatchObject({ present: false });
  });
});

describe("library mutation writes", () => {
  it("creates a Sonarr series from the candidate the instance returned", async () => {
    const harness = harnessFor("sonarr", () => jsonResponse(body("sonarr", "series/lookup")));
    const candidate = await readLookupCandidate(harness.client, "sonarr", "series_lookup", 100004);
    if (candidate === undefined) {
      throw new Error("Expected the recorded candidate");
    }

    const payload = addMediaPayload("sonarr", candidate, {
      rootFolderPath: "/media/example/series",
      qualityProfileId: 4,
      tagIds: [3],
      monitor: "future",
      searchOnAdd: false,
    });

    expect(payload).toMatchObject({
      tvdbId: 100004,
      titleSlug: "example-new-series",
      rootFolderPath: "/media/example/series",
      qualityProfileId: 4,
      monitored: true,
      tags: [3],
      addOptions: {
        monitor: "future",
        // Never defaulted to true: adding a record launches no search unless
        // the caller asked for one.
        searchForMissingEpisodes: false,
        searchForCutoffUnmetEpisodes: false,
      },
    });
  });

  it("adds an unmonitored Radarr movie without a search", async () => {
    const harness = harnessFor("radarr", () => jsonResponse(body("radarr", "movie/lookup")));
    const candidate = await readLookupCandidate(harness.client, "radarr", "movie_lookup", 200004);
    if (candidate === undefined) {
      throw new Error("Expected the recorded candidate");
    }

    expect(
      addMediaPayload("radarr", candidate, {
        rootFolderPath: "/media/example/movies",
        qualityProfileId: 2,
        tagIds: [],
        monitor: "none",
        searchOnAdd: false,
      }),
    ).toMatchObject({
      tmdbId: 200004,
      monitored: false,
      addOptions: { monitor: "none", searchForMovie: false },
    });
  });

  it("reports a create the instance did not confirm", async () => {
    const empty = harnessFor("sonarr", () => new Response(null, { status: 201 }));
    await expect(
      createMedia(empty.client, "sonarr", { title: "Example" }),
    ).resolves.toBeUndefined();

    // A body that is not a record with a real identifier confirms nothing
    // either, and is an unexpected response rather than a success.
    const malformed = harnessFor("sonarr", () => jsonResponse({}, 201));
    await expect(createMedia(malformed.client, "sonarr", { title: "Example" })).rejects.toThrow();

    const unsaved = harnessFor("sonarr", () => jsonResponse({ id: 0 }, 201));
    await expect(
      createMedia(unsaved.client, "sonarr", { title: "Example" }),
    ).resolves.toBeUndefined();
  });

  it("sends a rewritten record back to the route it came from", async () => {
    const harness = harnessFor("sonarr", () => jsonResponse({ ok: true }));
    const rewritten = rewriteResource(firstSeries(), {
      kind: "series",
      changes: { monitored: false },
    });
    if (rewritten.status !== "ok") {
      throw new Error("Expected a usable rewrite");
    }

    await writeResource(harness.client, recordResourcePath("series", 12), rewritten.resource);

    const call = harness.calls[0];
    expect(call?.url.pathname).toBe("/api/v3/series/12");
    expect(call?.init.method).toBe("PUT");
    expect(call === undefined ? undefined : await readBody(call)).toMatchObject({
      id: 12,
      monitored: false,
      titleSlug: "example-series",
    });
  });

  it("names the monitor selections each application actually models", () => {
    expect(monitorSelections.radarr).toEqual(["none", "all"]);
    expect(supportsMonitorSelection("sonarr", "future")).toBe(true);
    // Radarr monitors a movie or does not; a season-shaped selection would be a
    // rule it cannot honour.
    expect(supportsMonitorSelection("radarr", "future")).toBe(false);
  });
});
