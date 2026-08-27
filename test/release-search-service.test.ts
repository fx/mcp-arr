import { describe, expect, it } from "vitest";
import {
  type ReleaseRequestFor,
  type ReleaseSearchRequest,
  type ReleaseSearchTarget,
  releaseSearchApplications,
  releaseSearchMinimumVersions,
  releaseSearchTargets,
} from "../src/adapters/acquisition/requests.js";
import { runReleaseSearch } from "../src/adapters/acquisition/service.js";
import { applicationIds } from "../src/applications.js";
import { operationDefinitions } from "../src/tools/operations.js";
import { maxPageSize } from "../src/tools/schemas/common.js";
import {
  expectError,
  expectOk,
  jsonResponse,
  releasePaging,
  searchHarness,
} from "./support/acquisition.js";
import { fixtureBody } from "./support/library.js";

const episodeSearch: ReleaseRequestFor<"sonarr_episode"> = {
  target: "sonarr_episode",
  detail: "summary",
  episodeId: 42,
  paging: releasePaging(),
};

const movieSearch: ReleaseRequestFor<"radarr_movie"> = {
  target: "radarr_movie",
  detail: "summary",
  movieId: 8,
  paging: releasePaging(),
};

/** One minimal request per target, carrying whatever that target requires. */
const requestForTarget: Readonly<Record<ReleaseSearchTarget, ReleaseSearchRequest>> = {
  sonarr_episode: episodeSearch,
  sonarr_season: {
    target: "sonarr_season",
    detail: "summary",
    seriesId: 12,
    seasonNumber: 1,
    paging: releasePaging(),
  },
  radarr_movie: movieSearch,
  prowlarr_aggregate: {
    target: "prowlarr_aggregate",
    detail: "summary",
    term: "example series",
    paging: releasePaging(),
  },
};

describe("release search target support", () => {
  it("declares the same targets and applications the operation registry does", () => {
    const registered = operationDefinitions
      .filter((operation) => operation.tool === "arr_release_search")
      .map((operation) => [operation.variant, [...operation.applications]] as const);

    expect(registered.map(([variant]) => variant).sort()).toEqual([...releaseSearchTargets].sort());
    for (const [variant, applications] of registered) {
      expect([variant, releaseSearchApplications[variant as ReleaseSearchTarget]]).toEqual([
        variant,
        applications,
      ]);
    }
  });

  it("needs no version newer than each application's recorded minimum", () => {
    expect(releaseSearchMinimumVersions).toEqual({});
  });

  it("refuses a target the selected application does not model, without a request", async () => {
    for (const target of releaseSearchTargets) {
      for (const application of applicationIds) {
        if (releaseSearchApplications[target].includes(application)) {
          continue;
        }
        const harness = searchHarness(application, () => {
          throw new Error("no upstream request may be sent for an unsupported target");
        });

        const error = expectError(
          await runReleaseSearch(application, harness.client, requestForTarget[target]),
        );
        expect(error.code).toBe("unsupported_capability");
        expect(error.application).toBe(application);
        expect(error.message).toContain(target);
        expect(harness.calls).toEqual([]);
      }
    }
  });
});

describe("release search bounds", () => {
  it("rejects a page size outside the published bound before any request", async () => {
    for (const pageSize of [0, -1, 1.5, maxPageSize + 1]) {
      const harness = searchHarness("sonarr", () => {
        throw new Error("no upstream request may be sent for an unusable page size");
      });

      const error = expectError(
        await runReleaseSearch("sonarr", harness.client, {
          ...episodeSearch,
          paging: releasePaging(pageSize),
        }),
      );
      expect(error.code).toBe("invalid_input");
      expect(error.message).toContain(`between 1 and ${maxPageSize}`);
      expect(harness.calls).toEqual([]);
    }
  });

  it("pages a search by whole pages and refuses a cursor from another search", async () => {
    const releases = await fixtureBody("sonarr", "release");
    const first = expectOk(
      await runReleaseSearch(
        "sonarr",
        searchHarness("sonarr", () => jsonResponse(releases)).client,
        { ...episodeSearch, paging: releasePaging(2) },
      ),
    );
    expect(first.continuation).toMatchObject({ pageSize: 2, returned: 2, hasMore: true });

    const next = expectOk(
      await runReleaseSearch(
        "sonarr",
        searchHarness("sonarr", () => jsonResponse(releases)).client,
        {
          ...episodeSearch,
          paging: releasePaging(2, first.continuation.cursor),
        },
      ),
    );
    expect(next.data.items).toHaveLength(1);
    expect(next.continuation.hasMore).toBe(false);

    // The same cursor against a different episode names a different search.
    const foreign = searchHarness("sonarr", () => {
      throw new Error("no upstream request may be sent for a foreign continuation");
    });
    const error = expectError(
      await runReleaseSearch("sonarr", foreign.client, {
        ...episodeSearch,
        episodeId: 43,
        paging: releasePaging(2, first.continuation.cursor),
      }),
    );
    expect(error.code).toBe("invalid_input");
    expect(error.message).toContain("different search");
    expect(foreign.calls).toEqual([]);
  });

  it("rejects a continuation this server never minted", async () => {
    const harness = searchHarness("radarr", () => {
      throw new Error("no upstream request may be sent for a forged continuation");
    });

    const error = expectError(
      await runReleaseSearch("radarr", harness.client, {
        ...movieSearch,
        paging: releasePaging(2, "notacursor"),
      }),
    );
    expect(error.code).toBe("invalid_input");
    expect(error.message).toContain("not issued by this server");
    expect(harness.calls).toEqual([]);
  });
});

describe("release search failures", () => {
  it("reports an unreachable application without touching the others", async () => {
    const harness = searchHarness("sonarr", () => {
      throw new Error("connection refused");
    });

    const error = expectError(
      await runReleaseSearch("sonarr", harness.client, requestForTarget.sonarr_episode),
    );
    expect(error.code).toBe("unavailable_application");
    expect(error.application).toBe("sonarr");
    expect(error.recoverable).toBe(true);
    // The thrown reason never reaches the caller-visible message.
    expect(error.message).not.toContain("connection refused");
  });

  it("reports a payload it cannot map as an unexpected response", async () => {
    const harness = searchHarness("radarr", () => jsonResponse({ releases: "not a list" }));

    const error = expectError(
      await runReleaseSearch("radarr", harness.client, requestForTarget.radarr_movie),
    );
    expect(error.code).toBe("unexpected_response");
    expect(error.message).not.toContain("not a list");
  });
});
