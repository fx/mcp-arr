import { beforeEach, describe, expect, it } from "vitest";
import type { MediaDefaults } from "../src/config/environment.js";
import type { AddResult, FindResult } from "../src/tools/media/schemas.js";
import {
  callMediaTool,
  createMediaContext,
  createMediaInstances,
  forbiddenTermsIn,
  type MediaInstances,
  noMediaDefaults,
  qualityProfileBody,
} from "./support/media.js";
import { allApplicationsEnvironment, testApiKeys } from "./support/tool-context.js";

/**
 * `media_add` over the recorded fixtures.
 *
 * Recorded, the movie instance has one root folder and two quality profiles,
 * and the series instance has two of each and three profiles. Each lookup holds
 * one title already in the library — movie 200001, series 100001 — and one that
 * is not — movie 200004, series 100004.
 */

const newMovie = 200_004;
const existingMovie = 200_001;
const newSeries = 100_004;
const existingSeries = 100_001;

const movieDefaults: MediaDefaults = {
  movie: { qualityProfile: "Example Bluray" },
  series: {},
};

const seriesDefaults: MediaDefaults = {
  movie: {},
  series: { qualityProfile: "Example HD", rootFolder: "/media/example/series" },
};

let instances: MediaInstances;

beforeEach(async () => {
  instances = await createMediaInstances();
});

function add(
  input: unknown,
  defaults: MediaDefaults = noMediaDefaults,
  environment = allApplicationsEnvironment,
) {
  return callMediaTool<AddResult>(
    "media_add",
    createMediaContext(instances, defaults, environment),
    input,
  );
}

function creates() {
  return instances.writes().filter((request) => request.method === "POST");
}

function onlyCreate(): Record<string, unknown> {
  const sent = creates();
  expect(sent).toHaveLength(1);
  return sent[0]?.body ?? {};
}

const radarrOnly = {
  RADARR_URL: allApplicationsEnvironment.RADARR_URL,
  RADARR_API_KEY: allApplicationsEnvironment.RADARR_API_KEY,
};

const leakedValues = [
  ...Object.values(testApiKeys),
  "example.invalid",
  "https://",
  "/api/",
  "lookup",
  "system/status",
];

function expectRedacted(serialized: string): void {
  for (const value of leakedValues) {
    expect(serialized, value).not.toContain(value);
  }
  expect(serialized.toLowerCase()).not.toMatch(/sonarr|radarr|prowlarr/u);
}

describe("media_add", () => {
  it("adds a movie monitored, under the only root folder, and starts its search", async () => {
    const { result, content, summary } = await add({ kind: "movie", id: newMovie }, movieDefaults);

    expect(result.isError).toBe(false);
    expect(content).toEqual({
      kind: "movie",
      id: newMovie,
      title: "Example Unadded Movie",
      outcome: "added",
      warnings: [],
      errors: [],
    });
    const sent = onlyCreate();
    expect(creates()[0]?.route).toBe("movie");
    expect(sent).toMatchObject({
      tmdbId: newMovie,
      title: "Example Unadded Movie",
      // Every other setting comes from what the lookup proposed.
      minimumAvailability: "released",
      rootFolderPath: "/media/example/movies",
      qualityProfileId: 2,
      monitored: true,
      tags: [],
      addOptions: { monitor: "movieOnly", searchForMovie: true },
    });
    expect(summary).toBe("media_add: added movie 200004");
  });

  it("adds a series with every episode monitored by default", async () => {
    const { content } = await add({ kind: "series", id: newSeries }, seriesDefaults);

    expect(content.outcome).toBe("added");
    expect(creates()[0]?.route).toBe("series");
    expect(onlyCreate()).toMatchObject({
      tvdbId: newSeries,
      seriesType: "standard",
      rootFolderPath: "/media/example/series",
      qualityProfileId: 1,
      monitored: true,
      tags: [],
      addOptions: {
        monitor: "all",
        searchForMissingEpisodes: true,
        searchForCutoffUnmetEpisodes: false,
      },
    });
  });

  it("adds a series for new episodes only", async () => {
    await add({ kind: "series", id: newSeries, episodes: "future" }, seriesDefaults);

    expect(onlyCreate()).toMatchObject({
      monitored: true,
      addOptions: { monitor: "future", searchForMissingEpisodes: true },
    });
  });

  it("refuses an episodes choice for a movie before contacting anything", async () => {
    const { result, content } = await add(
      { kind: "movie", id: newMovie, episodes: "future" },
      movieDefaults,
    );

    expect(result.isError).toBe(true);
    expect(content.errors.map((error) => error.code)).toEqual(["invalid_input"]);
    expect(instances.requests).toEqual([]);
  });

  it("accepts a pair media_find returned, unchanged", async () => {
    const context = createMediaContext(instances, seriesDefaults);
    const found = await callMediaTool<FindResult>("media_find", context, {
      text: "Example",
      kind: "series",
    });
    const unadded = found.content.titles.find((title) => !title.in_library);
    expect(unadded).toBeDefined();

    const added = await callMediaTool<AddResult>("media_add", context, {
      kind: unadded?.kind,
      id: unadded?.id,
    });

    expect(added.content).toMatchObject({ kind: "series", id: newSeries, outcome: "added" });
  });

  describe("a title already in the library", () => {
    it("is reported already_in_library and sends nothing", async () => {
      const { result, content, summary } = await add(
        { kind: "series", id: existingSeries, episodes: "future" },
        seriesDefaults,
      );

      expect(result.isError).toBe(false);
      expect(content).toEqual({
        kind: "series",
        id: existingSeries,
        title: "Example Series",
        outcome: "already_in_library",
        warnings: [],
        errors: [],
      });
      expect(instances.writes()).toEqual([]);
      expect(summary).toBe("media_add: already_in_library series 100001");
    });

    it("consults no default, so a stale or ambiguous one cannot fail it", async () => {
      const stale: MediaDefaults = {
        movie: { qualityProfile: "Example Gone", rootFolder: "/media/example/gone" },
        series: { qualityProfile: "Example Gone", rootFolder: "/media/example/gone" },
      };

      for (const [kind, id] of [
        ["movie", existingMovie],
        ["series", existingSeries],
      ] as const) {
        const { result, content } = await add({ kind, id, resolution: "2160p" }, stale);
        expect(result.isError, kind).toBe(false);
        expect(content.outcome, kind).toBe("already_in_library");
      }
      // Without defaults the series instance would be ambiguous on both counts.
      const ambiguous = await add({ kind: "series", id: existingSeries });
      expect(ambiguous.content.outcome).toBe("already_in_library");
      expect(instances.writes()).toEqual([]);
      expect(instances.requests.some((request) => request.route === "rootfolder")).toBe(false);
    });

    it("reports the resolution its existing profile targets, not the one asked for", async () => {
      instances.serve("sonarr", "qualityprofile", [
        qualityProfileBody(1, "Example HD", 720, [480, 720]),
        qualityProfileBody(2, "Example UHD", 2160),
      ]);

      const { content, summary } = await add(
        { kind: "series", id: existingSeries, resolution: "2160p" },
        seriesDefaults,
      );

      expect(content).toMatchObject({ outcome: "already_in_library", resolution: "720p" });
      expect(instances.writes()).toEqual([]);
      expect(summary).toBe("media_add: already_in_library series 100001 at 720p");
    });

    it("omits the resolution with a warning when the existing profile cannot be read", async () => {
      instances.failRoute("radarr", "qualityprofile", 500);

      const { result, content, summary } = await add({ kind: "movie", id: existingMovie });

      expect(result.isError).toBe(false);
      expect(content.outcome).toBe("already_in_library");
      expect(content.resolution).toBeUndefined();
      expect(content.warnings).toEqual([
        "the resolution this title already targets could not be read, so none is reported",
      ]);
      expect(summary).toBe("media_add: already_in_library movie 200001; 1 warning(s)");
    });

    it("reads the record for its profile when the lookup does not carry one", async () => {
      const [existing] = instances.catalog("radarr");
      if (existing !== undefined) {
        delete existing.qualityProfileId;
      }
      instances.serve("radarr", "qualityprofile", [qualityProfileBody(2, "Example Bluray", 1080)]);
      instances.serve("radarr", "movie/8", { id: 8, qualityProfileId: 2 });

      const { content } = await add({ kind: "movie", id: existingMovie });

      expect(content).toMatchObject({ outcome: "already_in_library", resolution: "1080p" });
      expect(instances.requests.some((request) => request.route === "movie/8")).toBe(true);
    });
  });

  it("cannot create a duplicate when added twice", async () => {
    const first = await add({ kind: "movie", id: newMovie }, movieDefaults);
    const second = await add({ kind: "movie", id: newMovie }, movieDefaults);

    expect(first.content.outcome).toBe("added");
    expect(second.content.outcome).toBe("already_in_library");
    expect(creates()).toHaveLength(1);
  });

  it("reports already_in_library when another call added the title between check and create", async () => {
    instances.beforeCreate(() => {
      instances.beforeCreate(undefined);
      instances.addBehindOurBack("sonarr", newSeries);
    });

    const { result, content } = await add({ kind: "series", id: newSeries }, seriesDefaults);

    expect(result.isError).toBe(false);
    expect(content).toMatchObject({
      kind: "series",
      id: newSeries,
      outcome: "already_in_library",
    });
    expect(creates()).toHaveLength(1);
  });

  it("settles concurrent adds of one title as one added and one already present", async () => {
    const context = createMediaContext(instances, movieDefaults);
    const outcomes = await Promise.all(
      [0, 1].map(() =>
        callMediaTool<AddResult>("media_add", context, { kind: "movie", id: newMovie }),
      ),
    );

    expect(outcomes.map(({ content }) => content.outcome).sort()).toEqual([
      "added",
      "already_in_library",
    ]);
    expect(outcomes.every(({ result }) => result.isError === false)).toBe(true);
    // The instance holds one record, whatever reached it.
    expect(
      instances
        .catalog("radarr")
        .filter((record) => record.tmdbId === newMovie && Number(record.id) > 0),
    ).toHaveLength(1);
  });

  it("reports a refusal that was not a duplicate", async () => {
    instances.failRoute("radarr", "movie", 400, "POST");

    const { result, content } = await add({ kind: "movie", id: newMovie }, movieDefaults);

    expect(result.isError).toBe(true);
    expect(content.errors).toEqual([
      {
        code: "upstream_rejection",
        message: "the source of movies refused the request",
        recoverable: true,
        remediation: "Find the title again and retry with the kind and id it returned.",
      },
    ]);
  });

  it("reports added when the create went unconfirmed but the title is now in the library", async () => {
    instances.silenceCreates("radarr");

    const { result, content } = await add({ kind: "movie", id: newMovie }, movieDefaults);

    expect(result.isError).toBe(false);
    expect(content.outcome).toBe("added");
  });

  it("reports an unexpected response when a failed create left nothing behind", async () => {
    instances.failRoute("radarr", "movie", 500, "POST");

    const { result, content } = await add({ kind: "movie", id: newMovie }, movieDefaults);

    expect(result.isError).toBe(true);
    expect(content.errors.map((error) => error.code)).toEqual(["unexpected_response"]);
  });

  it("fails with not_found for an id the metadata source does not know", async () => {
    const { result, content, summary } = await add({ kind: "movie", id: 999_999 }, movieDefaults);

    expect(result.isError).toBe(true);
    expect(content.errors).toEqual([
      {
        code: "not_found",
        message: "no title of that kind has that id",
        recoverable: true,
        remediation: "Search for the title again and use an id the search returned.",
      },
    ]);
    expect(instances.writes()).toEqual([]);
    expect(summary).toBe(
      "media_add: error; errors: not_found (Search for the title again and use an id the search returned.)",
    );
  });

  it("refuses a kind this deployment does not serve, naming the kind", async () => {
    const { result, content } = await add(
      { kind: "series", id: newSeries },
      noMediaDefaults,
      radarrOnly,
    );

    expect(result.isError).toBe(true);
    expect(content.errors).toEqual([
      {
        code: "unconfigured_application",
        message: "TV series are not available on this server",
        recoverable: false,
        remediation:
          "TV series are not available on this server; ask its operator to configure them.",
      },
    ]);
    expect(instances.requests).toEqual([]);
  });

  it("reports an unreachable source without adding anything", async () => {
    instances.stop("radarr");

    const { result, content } = await add({ kind: "movie", id: newMovie }, movieDefaults);

    expect(result.isError).toBe(true);
    expect(content.errors.map((error) => error.code)).toEqual(["unavailable_application"]);
  });

  describe("deployment defaults", () => {
    it("fails with every ambiguous default named and adds nothing", async () => {
      const { result, content, summary } = await add({ kind: "series", id: newSeries });

      expect(result.isError).toBe(true);
      expect(content.errors.map((error) => [error.code, error.remediation])).toEqual([
        [
          "deployment_configuration",
          "Ask this server's operator to set ARR_MCP_MEDIA_SERIES_ROOT_FOLDER to the root folder new TV series should use.",
        ],
        [
          "deployment_configuration",
          "Ask this server's operator to set ARR_MCP_MEDIA_SERIES_QUALITY_PROFILE to the quality profile new TV series should use.",
        ],
      ]);
      expect(content.errors.every((error) => !error.recoverable)).toBe(true);
      expect(instances.writes()).toEqual([]);
      expect(summary).toContain("ARR_MCP_MEDIA_SERIES_QUALITY_PROFILE");
      expect(summary).not.toContain("\n");
    });

    it("lets a resolution choose the profile where no default is configured", async () => {
      instances.serve("sonarr", "qualityprofile", [
        qualityProfileBody(1, "Example HD", 720),
        qualityProfileBody(2, "Example Full HD", 1080),
      ]);
      const folderOnly: MediaDefaults = {
        movie: {},
        series: { rootFolder: "/media/example/archive" },
      };

      const without = await add({ kind: "series", id: newSeries }, folderOnly);
      expect(without.content.errors.map((error) => error.remediation)).toEqual([
        "Ask this server's operator to set ARR_MCP_MEDIA_SERIES_QUALITY_PROFILE to the quality profile new TV series should use.",
      ]);
      expect(instances.writes()).toEqual([]);

      const withResolution = await add(
        { kind: "series", id: newSeries, resolution: "1080p" },
        folderOnly,
      );
      expect(withResolution.content).toMatchObject({ outcome: "added", resolution: "1080p" });
      expect(onlyCreate()).toMatchObject({
        rootFolderPath: "/media/example/archive",
        qualityProfileId: 2,
      });
    });

    it("uses the only quality profile when there is one and none is configured", async () => {
      instances.serve("radarr", "qualityprofile", [qualityProfileBody(7, "Example Only", 1080)]);

      const { content } = await add({ kind: "movie", id: newMovie });

      expect(content).toMatchObject({ outcome: "added", resolution: "1080p" });
      expect(onlyCreate()).toMatchObject({ qualityProfileId: 7 });
    });

    it("refuses a configured default that names nothing, even with a resolution", async () => {
      instances.serve("radarr", "qualityprofile", [qualityProfileBody(2, "Example Bluray", 1080)]);
      const stale: MediaDefaults = {
        movie: { qualityProfile: "Example Gone", rootFolder: "/media/example/gone" },
        series: {},
      };

      for (const resolution of [undefined, "1080p"]) {
        const { result, content } = await add(
          { kind: "movie", id: newMovie, ...(resolution === undefined ? {} : { resolution }) },
          stale,
        );
        expect(result.isError, String(resolution)).toBe(true);
        expect(
          content.errors.map((error) => error.remediation),
          String(resolution),
        ).toEqual([
          "Ask this server's operator to correct ARR_MCP_MEDIA_MOVIE_ROOT_FOLDER to name an existing root folder.",
          "Ask this server's operator to correct ARR_MCP_MEDIA_MOVIE_QUALITY_PROFILE to name an existing quality profile.",
        ]);
      }
      expect(instances.writes()).toEqual([]);
    });

    it("matches a configured root folder by its exact path", async () => {
      const trailing: MediaDefaults = {
        movie: { qualityProfile: "Example Bluray", rootFolder: "/media/example/movies/" },
        series: {},
      };

      const { content } = await add({ kind: "movie", id: newMovie }, trailing);

      expect(content.errors.map((error) => error.code)).toEqual(["deployment_configuration"]);
      expect(instances.writes()).toEqual([]);
    });

    it("names the variable when the instance has no root folder at all", async () => {
      instances.serve("radarr", "rootfolder", []);

      const { content } = await add({ kind: "movie", id: newMovie }, movieDefaults);

      expect(content.errors.map((error) => error.remediation)).toEqual([
        "Ask this server's operator to create a root folder for movies and set ARR_MCP_MEDIA_MOVIE_ROOT_FOLDER to it.",
      ]);
    });

    it("resolves defaults when a title is added, so a failed read adds nothing", async () => {
      instances.failRoute("radarr", "rootfolder", 503);

      const { result, content } = await add({ kind: "movie", id: newMovie }, movieDefaults);

      expect(result.isError).toBe(true);
      expect(content.errors.map((error) => error.code)).toEqual(["unexpected_response"]);
      expect(instances.writes()).toEqual([]);
    });
  });

  describe("resolution", () => {
    it("uses the 2160p profile when asked for 4K", async () => {
      instances.serve("radarr", "qualityprofile", [
        qualityProfileBody(1, "Example HD", 720),
        qualityProfileBody(2, "Example Full HD", 1080),
        qualityProfileBody(3, "Example UHD", 2160),
      ]);

      const { content, summary } = await add(
        { kind: "movie", id: newMovie, resolution: "2160p" },
        noMediaDefaults,
      );

      expect(content).toMatchObject({ outcome: "added", resolution: "2160p" });
      expect(onlyCreate()).toMatchObject({ qualityProfileId: 3 });
      expect(summary).toBe("media_add: added movie 200004 at 2160p");
    });

    it("uses the nearest profile when the one asked for does not exist, and says so", async () => {
      instances.serve("sonarr", "qualityprofile", [
        qualityProfileBody(1, "Example HD", 720),
        qualityProfileBody(2, "Example Full HD", 1080),
      ]);

      const { content } = await add(
        { kind: "series", id: newSeries, resolution: "2160p" },
        { movie: {}, series: { rootFolder: "/media/example/series" } },
      );

      expect(content).toMatchObject({ outcome: "added", resolution: "1080p" });
      expect(onlyCreate()).toMatchObject({ qualityProfileId: 2 });
    });

    it("prefers the configured default among equally good profiles", async () => {
      instances.serve("radarr", "qualityprofile", [
        qualityProfileBody(1, "Example A", 1080),
        qualityProfileBody(2, "Example Bluray", 1080, [720, 1080]),
      ]);

      await add({ kind: "movie", id: newMovie, resolution: "1080p" }, movieDefaults);

      expect(onlyCreate()).toMatchObject({ qualityProfileId: 2 });
    });

    it("fails when no profile states a resolution, telling the operator what to change", async () => {
      const { result, content } = await add(
        { kind: "movie", id: newMovie, resolution: "1080p" },
        movieDefaults,
      );

      expect(result.isError).toBe(true);
      expect(content.errors).toEqual([
        {
          code: "deployment_configuration",
          message: "no quality profile for movies has a cutoff with a known resolution",
          recoverable: false,
          remediation:
            "Ask this server's operator to give a quality profile for movies a cutoff quality with a known resolution.",
        },
      ]);
      expect(instances.writes()).toEqual([]);
    });

    it("reports no resolution for a profile whose cutoff states none", async () => {
      const { content } = await add({ kind: "movie", id: newMovie }, movieDefaults);

      expect(content.outcome).toBe("added");
      expect("resolution" in content).toBe(false);
    });
  });

  it("returns no credential, address, route, or application name, whatever happens", async () => {
    const outcomes = [
      await add({ kind: "movie", id: newMovie }, movieDefaults),
      await add({ kind: "series", id: existingSeries }),
      await add({ kind: "series", id: newSeries }),
      await add({ kind: "movie", id: 999_999 }),
      await add({ kind: "movie", id: newMovie, resolution: "720p" }),
    ];
    instances.failRoute("sonarr", "series/lookup", 401);
    outcomes.push(await add({ kind: "series", id: newSeries }));
    instances.stop("radarr");
    outcomes.push(await add({ kind: "movie", id: newMovie }));
    outcomes.push(await add({ kind: "series", id: newSeries }, noMediaDefaults, radarrOnly));

    for (const { content, summary } of outcomes) {
      expectRedacted(JSON.stringify(content));
      expectRedacted(summary);
      expect(summary).not.toContain("\n");
      expect(summary).not.toContain("Example");
      for (const error of content.errors) {
        // Only a failure addressed to the operator may name the instance's
        // own settings; everything a caller can act on avoids them.
        if (error.code !== "deployment_configuration") {
          expect(forbiddenTermsIn(`${error.message} ${error.remediation}`), error.code).toEqual([]);
        }
      }
    }
  });
});
