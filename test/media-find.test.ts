import { beforeEach, describe, expect, it } from "vitest";
import { type MediaToolDefinition, mediaToolDefinitions } from "../src/tools/media/definitions.js";
import type { FindResult } from "../src/tools/media/schemas.js";
import { runMediaTool } from "../src/tools/register.js";
import {
  callMediaTool,
  createMediaContext,
  createMediaInstances,
  forbiddenTermsIn,
  type MediaInstances,
} from "./support/media.js";
import { allApplicationsEnvironment, testApiKeys } from "./support/tool-context.js";

/**
 * `media_find` over the recorded lookup fixtures.
 *
 * Each instance answers a lookup with its recorded list: one title already in
 * the library and one that is not, for movies and series alike.
 */

let instances: MediaInstances;

beforeEach(async () => {
  instances = await createMediaInstances();
});

function find(input: unknown, environment = allApplicationsEnvironment) {
  return callMediaTool<FindResult>(
    "media_find",
    createMediaContext(instances, undefined, environment),
    input,
  );
}

const sonarrOnly = {
  SONARR_URL: allApplicationsEnvironment.SONARR_URL,
  SONARR_API_KEY: allApplicationsEnvironment.SONARR_API_KEY,
};

const prowlarrOnly = {
  PROWLARR_URL: allApplicationsEnvironment.PROWLARR_URL,
  PROWLARR_API_KEY: allApplicationsEnvironment.PROWLARR_API_KEY,
};

/** Values no `media` result or summary may carry. */
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
  expect(forbiddenTermsIn(serialized), serialized).toEqual([]);
}

describe("media_find", () => {
  it("returns movie and series matches together when no kind is named", async () => {
    const { result, content, summary } = await find({ text: "The Office" });

    expect(result.isError).toBe(false);
    expect(content).toEqual({
      titles: [
        { kind: "movie", id: 200001, title: "Example Movie", year: 2021, in_library: true },
        {
          kind: "movie",
          id: 200004,
          title: "Example Unadded Movie",
          year: 2018,
          in_library: false,
        },
        { kind: "series", id: 100001, title: "Example Series", year: 2019, in_library: true },
        {
          kind: "series",
          id: 100004,
          title: "Example New Series",
          year: 2026,
          in_library: false,
        },
      ],
      unavailable: [],
      warnings: [],
      errors: [],
    });
    expect(summary).toBe("media_find: found 4 title(s) (movie 2, series 2)");
  });

  it("passes the search text through and changes nothing upstream", async () => {
    await find({ text: "The Office" });

    const lookups = instances.requests.filter((request) => request.route.endsWith("/lookup"));
    expect(lookups.map((request) => [request.application, request.query.term])).toEqual(
      expect.arrayContaining([
        ["radarr", "The Office"],
        ["sonarr", "The Office"],
      ]),
    );
    expect(lookups).toHaveLength(2);
    expect(instances.writes()).toEqual([]);
  });

  it("searches only the kind it is asked for", async () => {
    const { content } = await find({ text: "Example", kind: "series" });

    expect(content.titles.map((title) => title.kind)).toEqual(["series", "series"]);
    expect(instances.requests.some((request) => request.application === "radarr")).toBe(false);
  });

  it("searches every configured kind and skips one this deployment does not serve", async () => {
    const { result, content } = await find({ text: "Example" }, sonarrOnly);

    expect(result.isError).toBe(false);
    expect(content.titles.map((title) => title.kind)).toEqual(["series", "series"]);
    expect(content.unavailable).toEqual([]);
  });

  it("returns at most five titles per kind, in the order the source ranked them", async () => {
    const recorded = instances.catalog("radarr")[1] as Record<string, unknown>;
    instances.serve(
      "radarr",
      "movie/lookup",
      Array.from({ length: 8 }, (_, index) => ({
        ...recorded,
        id: 0,
        tmdbId: 300_000 + index,
        title: `Example Ranked ${index}`,
      })),
    );

    const { content } = await find({ text: "Example", kind: "movie" });

    expect(content.titles.map((title) => title.id)).toEqual([
      300_000, 300_001, 300_002, 300_003, 300_004,
    ]);
  });

  it("drops a result with no metadata id before applying the bound, and an unknown year", async () => {
    const recorded = instances.catalog("sonarr")[1] as Record<string, unknown>;
    instances.serve("sonarr", "series/lookup", [
      { ...recorded, tvdbId: null, title: "Example Unidentified" },
      { ...recorded, tvdbId: 0, title: "Example Zero" },
      ...Array.from({ length: 5 }, (_, index) => ({
        ...recorded,
        tvdbId: 400_000 + index,
        title: `Example Kept ${index}`,
        year: index === 0 ? 0 : 2020,
      })),
    ]);

    const { content } = await find({ text: "Example", kind: "series" });

    expect(content.titles.map((title) => title.id)).toEqual([
      400_000, 400_001, 400_002, 400_003, 400_004,
    ]);
    expect(content.titles[0]).toEqual({
      kind: "series",
      id: 400_000,
      title: "Example Kept 0",
      in_library: false,
    });
  });

  it("reports a kind whose source is down beside the other kind's matches", async () => {
    instances.stop("sonarr");

    const { result, content, summary } = await find({ text: "Example" });

    expect(result.isError).toBe(false);
    expect(content.titles.map((title) => title.kind)).toEqual(["movie", "movie"]);
    expect(content.unavailable).toEqual([
      {
        kind: "series",
        error: {
          code: "unavailable_application",
          message: "the source of TV series could not be reached",
          recoverable: true,
          remediation:
            "Retry later; if it persists, ask this server's operator to check the source of TV series.",
        },
      },
    ]);
    expect(content.errors).toEqual([]);
    expect(summary).toContain("series unavailable: unavailable_application (Retry later;");
    expect(summary).not.toContain("\n");
  });

  it("reports a kind whose instance is too old, or refuses its credentials, as unavailable", async () => {
    instances.serve("radarr", "system/status", { version: "5.0.0.1" });
    instances.failRoute("sonarr", "system/status", 401);

    const { result, content } = await find({ text: "Example" });

    expect(result.isError).toBe(true);
    expect(content.errors.map((error) => error.code)).toEqual([
      "unsupported_capability",
      "upstream_authentication",
    ]);
    expect(content.errors[0]?.remediation).toBe(
      "Ask this server's operator to upgrade the source of movies.",
    );
  });

  it("fails the call when no kind could be searched", async () => {
    instances.stop("sonarr");
    instances.failRoute("radarr", "movie/lookup", 500);

    const { result, content, summary } = await find({ text: "Example" });

    expect(result.isError).toBe(true);
    expect(content.titles).toEqual([]);
    expect(content.errors.map((error) => error.code)).toEqual([
      "unexpected_response",
      "unavailable_application",
    ]);
    expect(summary).toMatch(/^media_find: error; errors: unexpected_response \(/u);
    expect(summary).toContain("unavailable_application (");
  });

  it("refuses a named kind this deployment does not serve, without naming what serves it", async () => {
    const { result, content, summary } = await find({ text: "Example", kind: "movie" }, sonarrOnly);

    expect(result.isError).toBe(true);
    expect(content.errors).toEqual([
      {
        code: "unconfigured_application",
        message: "movies are not available on this server",
        recoverable: false,
        remediation: "Movies are not available on this server; ask its operator to configure them.",
      },
    ]);
    expect(instances.requests).toEqual([]);
    expect(summary).toContain("unconfigured_application (Movies are not available");
  });

  it("refuses when this deployment serves neither kind", async () => {
    const { result, content } = await find({ text: "Example" }, prowlarrOnly);

    expect(result.isError).toBe(true);
    expect(content.errors.map((error) => [error.code, error.remediation])).toEqual([
      [
        "unconfigured_application",
        "Movies are not available on this server; ask its operator to configure them.",
      ],
      [
        "unconfigured_application",
        "TV series are not available on this server; ask its operator to configure them.",
      ],
    ]);
  });

  it("holds the search text to between 1 and 200 characters", async () => {
    for (const text of ["", "x".repeat(201)]) {
      const { result, content } = await find({ text });
      expect(result.isError, String(text.length)).toBe(true);
      expect(content.errors.map((error) => error.code)).toEqual(["invalid_input"]);
    }
    expect(instances.requests).toEqual([]);

    const { result } = await find({ text: "x".repeat(200), kind: "movie" });
    expect(result.isError).toBe(false);
  });

  it("returns no credential, address, route, or application name, whatever fails", async () => {
    const outcomes = [await find({ text: "Example" })];
    instances.failRoute("sonarr", "series/lookup", 401);
    instances.failRoute("radarr", "movie/lookup", 429);
    outcomes.push(await find({ text: "Example" }));
    instances.stop("radarr");
    outcomes.push(await find({ text: "Example", kind: "movie" }));
    outcomes.push(await find({ text: "Example", kind: "movie" }, sonarrOnly));

    for (const { content, summary } of outcomes) {
      expectRedacted(JSON.stringify(content));
      expectRedacted(summary);
      expect(summary).not.toContain("\n");
      // A summary counts titles; it never repeats one.
      expect(summary).not.toContain("Example");
    }
  });
});

describe("the media run path", () => {
  const [findDefinition] = mediaToolDefinitions;

  it("replaces a handler that throws with a static unexpected response", async () => {
    if (findDefinition === undefined) {
      throw new Error("media_find is not defined");
    }
    const throwing: MediaToolDefinition = {
      ...findDefinition,
      handle: async () => {
        throw new Error(`GET https://radarr.example.invalid/api/v3?apikey=${testApiKeys.radarr}`);
      },
    };

    const result = await runMediaTool(throwing, createMediaContext(instances), { text: "x" });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      titles: [],
      unavailable: [],
      warnings: [],
      errors: [
        {
          code: "unexpected_response",
          message: "media_find: the call failed unexpectedly",
          recoverable: false,
          remediation:
            "Retry the call; if it fails again, ask this server's operator to report it.",
        },
      ],
    });
    expectRedacted(JSON.stringify(result));
  });

  it("replaces a result its own schema rejects", async () => {
    if (findDefinition === undefined) {
      throw new Error("media_find is not defined");
    }
    const malformed: MediaToolDefinition = {
      ...findDefinition,
      handle: async () => ({ warnings: [], errors: [], titles: "not a list" }) as never,
    };

    const result = await runMediaTool(malformed, createMediaContext(instances), { text: "x" });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      {
        type: "text",
        text: "media_find: error; errors: unexpected_response (Retry the call; if it fails again, ask this server's operator to report it.)",
      },
    ]);
  });
});

describe("media_find title redaction", () => {
  /** The shape every *arr instance generates its API key in: 32 hex characters. */
  const configuredKey = "0123456789abcdef0123456789abcdef";

  it("publishes no credential-bearing URL or configured key a title carried", async () => {
    const recorded = instances.catalog("radarr")[1] as Record<string, unknown>;
    instances.serve("radarr", "movie/lookup", [
      { ...recorded, tmdbId: 300_001, title: "https://user:secret@example.invalid/path" },
      { ...recorded, tmdbId: 300_002, title: `Example Leak ${configuredKey}` },
      { ...recorded, tmdbId: 300_003, title: `Example Glued${configuredKey}Title` },
    ]);

    const { content, summary } = await find(
      { text: "Example", kind: "movie" },
      { ...allApplicationsEnvironment, RADARR_API_KEY: configuredKey },
    );

    const serialized = JSON.stringify(content);
    for (const leaked of ["user:secret", "secret@", "example.invalid", configuredKey]) {
      expect(serialized, leaked).not.toContain(leaked);
      expect(summary, leaked).not.toContain(leaked);
    }
    // The title is kept, with what it must not carry replaced by a marker.
    expect(content.titles.map((title) => [title.id, title.title])).toEqual([
      [300_001, "[redacted url]"],
      // The configured key is known exactly, so it is named as a key rather
      // than caught by the identifier shape.
      [300_002, "Example Leak [redacted key]"],
      [300_003, "Example Glued[redacted key]Title"],
    ]);
  });

  it("drops a result whose title is nothing once sanitized", async () => {
    const recorded = instances.catalog("radarr")[1] as Record<string, unknown>;
    instances.serve("radarr", "movie/lookup", [
      { ...recorded, tmdbId: 300_004, title: "\u200b\u0000" },
      { ...recorded, tmdbId: 300_005, title: "Example \u202eKept" },
    ]);

    const { content } = await find({ text: "Example", kind: "movie" });

    expect(content.titles.map((title) => [title.id, title.title])).toEqual([
      [300_005, "Example Kept"],
    ]);
  });
});

describe("media_find exact-key redaction", () => {
  it("removes a configured key that matches no credential shape from a title", async () => {
    const configuredKey = "Plain-Key-Value-77";
    const recorded = instances.catalog("radarr")[1] as Record<string, unknown>;
    instances.serve("radarr", "movie/lookup", [
      { ...recorded, tmdbId: 310_001, title: `Example ${configuredKey} Title` },
      { ...recorded, tmdbId: 310_002, title: `Example Glued${configuredKey.toUpperCase()}` },
    ]);

    const { content, summary } = await find(
      { text: "Example", kind: "movie" },
      { ...allApplicationsEnvironment, RADARR_API_KEY: configuredKey },
    );

    expect(content.titles.map((title) => title.title)).toEqual([
      "Example [redacted key] Title",
      "Example Glued[redacted key]",
    ]);
    for (const text of [JSON.stringify(content), summary]) {
      expect(text.toLowerCase()).not.toContain(configuredKey.toLowerCase());
    }
  });

  it("withholds a title carrying a key too short to mark, such as key-123", async () => {
    const recorded = instances.catalog("sonarr")[1] as Record<string, unknown>;
    instances.serve("sonarr", "series/lookup", [
      { ...recorded, tvdbId: 410_001, title: "Example key-123 Leak" },
      { ...recorded, tvdbId: 410_002, title: "Example Clean" },
    ]);

    const { content, summary } = await find(
      { text: "Example", kind: "series" },
      { ...allApplicationsEnvironment, SONARR_API_KEY: "key-123" },
    );

    expect(content.titles.map((title) => [title.id, title.title])).toEqual([
      [410_002, "Example Clean"],
    ]);
    expect(JSON.stringify(content)).not.toContain("key-123");
    expect(summary).not.toContain("key-123");
  });

  it("redacts another kind's configured key as well", async () => {
    const recorded = instances.catalog("radarr")[1] as Record<string, unknown>;
    instances.serve("radarr", "movie/lookup", [
      { ...recorded, tmdbId: 310_003, title: "Example Series-Key-Value Crossed" },
    ]);

    const { content } = await find(
      { text: "Example", kind: "movie" },
      { ...allApplicationsEnvironment, SONARR_API_KEY: "Series-Key-Value" },
    );

    expect(content.titles.map((title) => title.title)).toEqual(["Example [redacted key] Crossed"]);
  });
});
