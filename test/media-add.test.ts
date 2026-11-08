import { beforeEach, describe, expect, it } from "vitest";
import type { MediaDefaults } from "../src/config/environment.js";
import type { AddResult, FindResult } from "../src/tools/media/schemas.js";
import { fixtureBody } from "./support/library.js";
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

describe("media_add title redaction", () => {
  const configuredKey = "0123456789abcdef0123456789abcdef";

  it("publishes no credential-bearing URL or configured key a title carried", async () => {
    const [existing, unadded] = instances.catalog("radarr");
    if (existing === undefined || unadded === undefined) {
      throw new Error("the recorded movie lookup holds two titles");
    }
    existing.title = "https://user:secret@example.invalid/path";
    unadded.title = `Example Leak ${configuredKey}`;
    const environment = { ...allApplicationsEnvironment, RADARR_API_KEY: configuredKey };

    const present = await add({ kind: "movie", id: existingMovie }, movieDefaults, environment);
    const added = await add({ kind: "movie", id: newMovie }, movieDefaults, environment);

    expect(present.content).toMatchObject({
      outcome: "already_in_library",
      title: "[redacted url]",
    });
    expect(added.content).toMatchObject({ outcome: "added", title: "Example Leak [redacted key]" });
    for (const { content, summary } of [present, added]) {
      for (const leaked of ["user:secret", "secret@", "example.invalid", configuredKey]) {
        expect(JSON.stringify(content), leaked).not.toContain(leaked);
        expect(summary, leaked).not.toContain(leaked);
      }
    }
  });

  it("omits a title that is nothing once sanitized and still adds", async () => {
    const [, unadded] = instances.catalog("radarr");
    if (unadded !== undefined) {
      unadded.title = "\u200b";
    }

    const { result, content } = await add({ kind: "movie", id: newMovie }, movieDefaults);

    expect(result.isError).toBe(false);
    expect(content.outcome).toBe("added");
    expect("title" in content).toBe(false);
  });
});

describe("media_add new-record settings", () => {
  it("keeps the tags the lookup proposed for either kind", async () => {
    for (const [application, kind, id, defaults] of [
      ["radarr", "movie", newMovie, movieDefaults],
      ["sonarr", "series", newSeries, seriesDefaults],
    ] as const) {
      const unadded = instances.catalog(application).find((record) => record.id === 0);
      if (unadded === undefined) {
        throw new Error(`the recorded ${application} lookup holds a title not in the library`);
      }
      unadded.tags = [3, 7];

      const { content } = await add({ kind, id }, defaults);

      expect(content.outcome, kind).toBe("added");
      const sent = creates().find((request) => request.application === application);
      expect(sent?.body?.tags, kind).toEqual([3, 7]);
    }
  });

  it("changes nothing the lookup proposed beyond folder, profile, monitoring, and search", async () => {
    const unadded = instances.catalog("sonarr").find((record) => record.id === 0);
    if (unadded === undefined) {
      throw new Error("the recorded series lookup holds a title not in the library");
    }
    const proposal = { ...unadded, tags: [5] };
    Object.assign(unadded, proposal);

    await add({ kind: "series", id: newSeries }, seriesDefaults);

    const sent = onlyCreate();
    const overridden = new Set(["rootFolderPath", "qualityProfileId", "monitored", "addOptions"]);
    for (const [field, value] of Object.entries(proposal)) {
      if (!overridden.has(field)) {
        expect(sent[field], field).toEqual(value);
      }
    }
    expect(
      Object.keys(sent)
        .filter((field) => !(field in proposal))
        .sort(),
    ).toEqual(["addOptions", "qualityProfileId", "rootFolderPath"]);
  });
});

describe("media_add reports the resolution of the record it describes", () => {
  const cases = [
    {
      application: "radarr",
      kind: "movie",
      id: newMovie,
      defaults: movieDefaults,
      route: "qualityprofile",
      profiles: [
        qualityProfileBody(1, "Example HD", 720),
        qualityProfileBody(2, "Example Bluray", 2160),
      ],
    },
    {
      application: "sonarr",
      kind: "series",
      id: newSeries,
      defaults: seriesDefaults,
      route: "qualityprofile",
      profiles: [
        qualityProfileBody(1, "Example HD", 2160),
        qualityProfileBody(2, "Example SD", 480),
      ],
    },
  ] as const;

  it("reports the profile another call added the title with when this create's answer was lost", async () => {
    for (const { application, kind, id, defaults, route, profiles } of cases) {
      instances.serve(application, route, profiles);
      instances.loseCreateAnswers(application);
      // Another call adds the title first, with the profile this one would
      // not choose for 2160p.
      const otherProfile = kind === "movie" ? 1 : 2;
      instances.beforeCreate(() => {
        instances.beforeCreate(undefined);
        instances.addBehindOurBack(application, id, otherProfile);
      });

      const { result, content } = await add({ kind, id, resolution: "2160p" }, defaults);

      expect(result.isError, kind).toBe(false);
      expect(content.outcome, kind).toBe("added");
      expect(content.resolution, kind).toBe(kind === "movie" ? "720p" : "480p");
      expect(content.warnings, kind).toEqual([]);
    }
  });

  it("reports the profile this call's own create used when its answer was lost", async () => {
    for (const { application, kind, id, defaults, route, profiles } of cases) {
      instances.serve(application, route, profiles);
      instances.loseCreateAnswers(application);

      const { content } = await add({ kind, id, resolution: "2160p" }, defaults);

      expect(content).toMatchObject({ outcome: "added", resolution: "2160p" });
    }
  });

  it("reports the profile a confirmed create's own record carries", async () => {
    for (const { application, kind, id, defaults, route, profiles } of cases) {
      instances.serve(application, route, profiles);
      instances.answerCreatesWith(application, { qualityProfileId: kind === "movie" ? 1 : 2 });

      const { content } = await add({ kind, id, resolution: "2160p" }, defaults);

      expect(content, kind).toMatchObject({
        outcome: "added",
        resolution: kind === "movie" ? "720p" : "480p",
      });
    }
  });

  it("omits the resolution with a warning when a confirmed record's profile is unknown", async () => {
    for (const { application, kind, id, defaults, route, profiles } of cases) {
      instances.serve(application, route, profiles);
      instances.answerCreatesWith(application, { qualityProfileId: 99 });

      const { content } = await add({ kind, id, resolution: "2160p" }, defaults);

      expect(content.outcome, kind).toBe("added");
      expect(content.resolution, kind).toBeUndefined();
      expect(content.warnings, kind).toEqual([
        "the resolution this title already targets could not be read, so none is reported",
      ]);
    }
  });

  it("omits the resolution with a warning when the re-read record's profile is unknown", async () => {
    for (const { application, kind, id, defaults, route, profiles } of cases) {
      instances.serve(application, route, profiles);
      instances.silenceCreates(application);
      instances.beforeCreate(() => {
        instances.beforeCreate(undefined);
        instances.addBehindOurBack(application, id, 99);
      });

      const { result, content } = await add({ kind, id, resolution: "2160p" }, defaults);

      // Another call's create won the race; this one was refused.
      expect(result.isError, kind).toBe(false);
      expect(content.outcome, kind).toBe("already_in_library");
      expect(content.resolution, kind).toBeUndefined();
      expect(content.warnings, kind).toEqual([
        "the resolution this title already targets could not be read, so none is reported",
      ]);
    }
  });

  it("omits the resolution with a warning when an unconfirmed create's record names an unknown profile", async () => {
    for (const { application, kind, id, defaults, route, profiles } of cases) {
      instances.serve(application, route, profiles);
      instances.loseCreateAnswers(application);
      instances.beforeCreate(() => {
        instances.beforeCreate(undefined);
        instances.addBehindOurBack(application, id, 99);
      });

      const { content } = await add({ kind, id, resolution: "2160p" }, defaults);

      expect(content.outcome, kind).toBe("added");
      expect(content.resolution, kind).toBeUndefined();
      expect(content.warnings, kind).toEqual([
        "the resolution this title already targets could not be read, so none is reported",
      ]);
    }
  });
});

describe("media_add exact-key redaction", () => {
  it("removes a configured key that matches no credential shape from the title", async () => {
    const [, unadded] = instances.catalog("radarr");
    if (unadded !== undefined) {
      unadded.title = "Example Plain-Key-Value-77 Title";
    }

    const { content, summary } = await add({ kind: "movie", id: newMovie }, movieDefaults, {
      ...allApplicationsEnvironment,
      RADARR_API_KEY: "Plain-Key-Value-77",
    });

    expect(content).toMatchObject({ outcome: "added", title: "Example [redacted key] Title" });
    expect(JSON.stringify(content)).not.toContain("Plain-Key-Value-77");
    expect(summary).not.toContain("Plain-Key-Value-77");
  });

  it("omits a title carrying a key too short to mark, such as key-123, and still reports the add", async () => {
    const existing = instances.catalog("sonarr").find((record) => Number(record.id) > 0);
    if (existing !== undefined) {
      existing.title = "Example key-123 Leak";
    }

    const { result, content, summary } = await add(
      { kind: "series", id: existingSeries },
      seriesDefaults,
      { ...allApplicationsEnvironment, SONARR_API_KEY: "key-123" },
    );

    expect(result.isError).toBe(false);
    expect(content.outcome).toBe("already_in_library");
    expect("title" in content).toBe(false);
    expect(JSON.stringify(content)).not.toContain("key-123");
    expect(summary).not.toContain("key-123");
  });
});

describe("media_add over the quality profiles newer instances record", () => {
  // Captured with every profile's quality list populated, Radarr's with two
  // profiles cut off at a group; see `test/media-resolution.test.ts` for what
  // each profile resolves to.
  const cases = [
    {
      application: "radarr",
      version: "6.4.4.10685",
      kind: "movie",
      id: newMovie,
      folder: {},
      choices: [
        ["1080p", undefined, 7],
        ["1080p", "HD-1080p", 4],
        ["2160p", undefined, 5],
        ["2160p", "WEB/HDTV 4k", 8],
        ["576p", undefined, 2],
      ],
    },
    {
      application: "sonarr",
      version: "4.0.20.3014",
      kind: "series",
      id: newSeries,
      folder: { rootFolder: "/media/example/series" },
      choices: [
        ["1080p", undefined, 4],
        ["1080p", "HD - 720p/1080p", 6],
        ["2160p", undefined, 5],
        ["2160p", "Max Ultra HD", 8],
        ["576p", undefined, 2],
      ],
    },
  ] as const;

  it("adds with the profile the resolution rule chooses among them", async () => {
    for (const { application, version, kind, id, folder, choices } of cases) {
      const body = await fixtureBody(application, "qualityprofile", { version });
      for (const [resolution, qualityProfile, expected] of choices) {
        const label = `${kind} ${resolution} ${String(qualityProfile)}`;
        instances = await createMediaInstances();
        instances.serve(application, "qualityprofile", body);
        const kindDefaults = {
          ...folder,
          ...(qualityProfile === undefined ? {} : { qualityProfile }),
        };
        const defaults: MediaDefaults =
          kind === "movie"
            ? { movie: kindDefaults, series: {} }
            : { movie: {}, series: kindDefaults };

        const { content } = await add({ kind, id, resolution }, defaults);

        expect(content, label).toMatchObject({
          outcome: "added",
          resolution: resolution === "576p" ? "480p" : resolution,
        });
        expect(onlyCreate(), label).toMatchObject({ qualityProfileId: expected });
      }
    }
  });
});

describe("media_add redaction across token boundaries", () => {
  const configuredKey = "Plain-Key-Value-77";

  for (const [label, title] of [
    ["key as the user", `https://${configuredKey}:private-password@internal.example/path`],
    ["key as the password", `https://user:${configuredKey}@internal.example/path`],
    ["key in a query string", `https://internal.example/feed?apikey=${configuredKey}&x=1`],
  ] as const) {
    it(`redacts a URL carrying the key whole: ${label}`, async () => {
      const [, unadded] = instances.catalog("radarr");
      if (unadded !== undefined) {
        unadded.title = title;
      }

      const { content, summary } = await add({ kind: "movie", id: newMovie }, movieDefaults, {
        ...allApplicationsEnvironment,
        RADARR_API_KEY: configuredKey,
      });

      expect(content).toMatchObject({ outcome: "added", title: "[redacted url]" });
      for (const text of [JSON.stringify(content), summary]) {
        for (const leaked of [configuredKey, "private-password", "internal.example", "apikey"]) {
          expect(text.toLowerCase(), leaked).not.toContain(leaked.toLowerCase());
        }
      }
    });
  }
});
