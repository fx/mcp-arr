import { describe, expect, it } from "vitest";
import {
  type LibraryQueryRequest,
  type LibraryView,
  libraryViewApplications,
  libraryViewMinimumVersions,
  libraryViews,
} from "../src/adapters/library/requests.js";
import { type LibraryQueryOutcome, runLibraryQuery } from "../src/adapters/library/service.js";
import { applicationIds } from "../src/applications.js";
import { operationDefinitions } from "../src/tools/operations.js";
import { maxPageSize } from "../src/tools/schemas/common.js";
import { fixtureBody, jsonResponse, libraryHarness, paging } from "./support/library.js";

/** One minimal request per view, carrying whatever that view requires. */
const requestForView: Readonly<Record<LibraryView, LibraryQueryRequest>> = {
  series: { view: "series", detail: "summary", paging: paging(25) },
  seasons: { view: "seasons", detail: "summary", seriesId: 12, paging: paging(25) },
  episodes: { view: "episodes", detail: "summary", seriesId: 12, paging: paging(25) },
  episode_files: { view: "episode_files", detail: "summary", seriesId: 12, paging: paging(25) },
  missing_episodes: { view: "missing_episodes", detail: "summary", paging: paging(25) },
  cutoff_unmet_episodes: {
    view: "cutoff_unmet_episodes",
    detail: "summary",
    paging: paging(25),
  },
  movies: { view: "movies", detail: "summary", paging: paging(25) },
  collections: { view: "collections", detail: "summary", paging: paging(25) },
  movie_files: { view: "movie_files", detail: "summary", movieId: 8, paging: paging(25) },
  missing_movies: { view: "missing_movies", detail: "summary", paging: paging(25) },
  cutoff_unmet_movies: { view: "cutoff_unmet_movies", detail: "summary", paging: paging(25) },
  calendar: {
    view: "calendar",
    detail: "summary",
    start: "2026-01-01",
    end: "2026-01-31",
    paging: paging(25),
  },
  lookup: { view: "lookup", detail: "summary", term: "example", paging: paging(25) },
};

function expectError(outcome: LibraryQueryOutcome) {
  if (outcome.status !== "error") {
    throw new Error("Expected an error outcome");
  }
  return outcome.error;
}

function expectOk(outcome: LibraryQueryOutcome) {
  if (outcome.status !== "ok") {
    throw new Error(`Expected an ok outcome, got ${outcome.error.code}`);
  }
  return outcome;
}

describe("library view support", () => {
  it("declares the same views and applications the operation registry does", () => {
    const registered = operationDefinitions
      .filter((operation) => operation.tool === "arr_library_query")
      .map((operation) => [operation.variant, [...operation.applications]] as const);

    expect(registered.map(([variant]) => variant).sort()).toEqual([...libraryViews].sort());
    for (const [variant, applications] of registered) {
      expect([variant, libraryViewApplications[variant as LibraryView]]).toEqual([
        variant,
        applications,
      ]);
    }
  });

  it("needs no version newer than each application's recorded minimum", () => {
    expect(libraryViewMinimumVersions).toEqual({});
  });

  it("refuses a view the selected application does not model, without a request", async () => {
    for (const view of libraryViews) {
      for (const application of applicationIds) {
        if (libraryViewApplications[view].includes(application as "sonarr" | "radarr")) {
          continue;
        }
        const harness = libraryHarness(application, () => {
          throw new Error("no upstream request may be sent for an unsupported view");
        });

        const error = expectError(
          await runLibraryQuery(application, harness.client, requestForView[view]),
        );
        expect(error.code).toBe("unsupported_capability");
        expect(error.application).toBe(application);
        expect(error.message).toContain(view);
        expect(harness.calls).toEqual([]);
      }
    }
  });

  it("keeps Prowlarr out of the library model entirely", async () => {
    const unsupported = await Promise.all(
      libraryViews.map(async (view) => {
        const harness = libraryHarness("prowlarr", () => {
          throw new Error("prowlarr has no library to read");
        });
        const outcome = await runLibraryQuery("prowlarr", harness.client, requestForView[view]);
        return expectError(outcome).code;
      }),
    );

    expect(new Set(unsupported)).toEqual(new Set(["unsupported_capability"]));
  });
});

describe("library query bounds", () => {
  it("rejects a page size outside the published bound before any request", async () => {
    for (const pageSize of [0, -1, 1.5, maxPageSize + 1]) {
      const harness = libraryHarness("sonarr", () => {
        throw new Error("no upstream request may be sent for an unusable page size");
      });

      const error = expectError(
        await runLibraryQuery("sonarr", harness.client, {
          view: "series",
          detail: "summary",
          paging: paging(pageSize),
        }),
      );
      expect(error.code).toBe("invalid_input");
      expect(error.message).toContain(`between 1 and ${maxPageSize}`);
      expect(harness.calls).toEqual([]);
    }
  });

  it("rejects a continuation that belongs to a different query", async () => {
    const series = await fixtureBody("sonarr", "series");
    const first = expectOk(
      await runLibraryQuery("sonarr", libraryHarness("sonarr", () => jsonResponse(series)).client, {
        view: "series",
        detail: "summary",
        paging: paging(2),
      }),
    );

    const harness = libraryHarness("sonarr", () => {
      throw new Error("no upstream request may be sent for a foreign continuation");
    });
    const error = expectError(
      await runLibraryQuery("sonarr", harness.client, {
        view: "series",
        detail: "summary",
        monitored: true,
        paging: paging(2, first.continuation.cursor),
      }),
    );

    expect(error.code).toBe("invalid_input");
    expect(error.message).toContain("different query");
    expect(harness.calls).toEqual([]);
  });

  it("rejects a continuation this server never minted", async () => {
    const harness = libraryHarness("sonarr", () => {
      throw new Error("no upstream request may be sent for a forged continuation");
    });

    const error = expectError(
      await runLibraryQuery("sonarr", harness.client, {
        view: "series",
        detail: "summary",
        paging: paging(2, "notacursor"),
      }),
    );
    expect(error.code).toBe("invalid_input");
    expect(error.message).toContain("not issued by this server");
    expect(harness.calls).toEqual([]);
  });

  it("bounds an unpaged upstream collection instead of returning all of it", async () => {
    const template = (await fixtureBody<readonly Record<string, unknown>[]>("sonarr", "series"))[0];
    const many = Array.from({ length: 200 }, (_unused, index) => ({
      ...template,
      id: 1000 + index,
      title: `Example Series ${index}`,
    }));

    const ok = expectOk(
      await runLibraryQuery("sonarr", libraryHarness("sonarr", () => jsonResponse(many)).client, {
        view: "series",
        detail: "summary",
        paging: paging(10),
      }),
    );

    expect(ok.data.items).toHaveLength(10);
    expect(ok.continuation).toMatchObject({ pageSize: 10, returned: 10, hasMore: true });
  });
});

describe("query missing media", () => {
  it("returns bounded Sonarr episodes and Radarr movies, each carrying its application", async () => {
    const [sonarrBody, radarrBody] = await Promise.all([
      fixtureBody("sonarr", "wanted/missing"),
      fixtureBody("radarr", "wanted/missing"),
    ]);

    const [episodes, movies] = await Promise.all([
      runLibraryQuery("sonarr", libraryHarness("sonarr", () => jsonResponse(sonarrBody)).client, {
        view: "missing_episodes",
        detail: "summary",
        paging: paging(2),
      }),
      runLibraryQuery("radarr", libraryHarness("radarr", () => jsonResponse(radarrBody)).client, {
        view: "missing_movies",
        detail: "summary",
        paging: paging(2),
      }),
    ]);

    const episodePage = expectOk(episodes);
    const moviePage = expectOk(movies);

    expect(episodePage.data.view).toBe("missing_episodes");
    expect(moviePage.data.view).toBe("missing_movies");

    for (const item of episodePage.data.items) {
      expect(item).toMatchObject({
        media: { application: "sonarr", ref: { application: "sonarr", kind: "episode" } },
        wanted: { reason: "missing" },
      });
    }
    for (const item of moviePage.data.items) {
      expect(item).toMatchObject({
        media: { application: "radarr", ref: { application: "radarr", kind: "movie" } },
        wanted: { reason: "missing" },
      });
    }

    // Both pages are bounded, and both say a further page exists.
    expect(episodePage.continuation).toMatchObject({ pageSize: 2, returned: 2, hasMore: true });
    expect(moviePage.continuation).toMatchObject({ pageSize: 2, returned: 2, hasMore: true });
  });
});
