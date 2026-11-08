import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import type { ApplicationId } from "../src/applications.js";
import { mediaToolNames, publishedMediaToolNames, toolNames } from "../src/tools/names.js";
import {
  type FixtureInstance,
  instanceEnvironment,
  startFixtureInstance,
} from "./support/instance-server.js";
import { assertWellFormed, declaredKeywordPaths } from "./support/json-schema.js";
import { forbiddenTermsInText } from "./support/media.js";
import { assertCleanProtocolStdout, spawnBuiltServer } from "./support/spawned-stdio.js";

/**
 * The `media` toolset over stdio, read back off the wire from the built
 * server exactly as a host receives it.
 */

/**
 * Placeholder instances under the reserved `.invalid` domain. Listing tools
 * contacts nothing, so these only satisfy the startup check.
 */
const placeholderInstances = {
  SONARR_URL: "https://sonarr.example.invalid/sonarr",
  SONARR_API_KEY: "sonarr-secret-key",
  RADARR_URL: "https://radarr.example.invalid",
  RADARR_API_KEY: "radarr-secret-key",
};

interface PublishedTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

interface PublishedListing {
  readonly tools: readonly PublishedTool[];
  readonly bytes: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** The bytes one response occupied on the wire, its newline delimiter included. */
function responseBytes(stdout: string, id: number): number {
  const line = stdout
    .split("\n")
    .find((candidate) => candidate !== "" && (JSON.parse(candidate) as { id?: number }).id === id);
  if (line === undefined) {
    throw new Error(`The spawned server sent no response for request ${id}`);
  }
  return Buffer.byteLength(`${line}\n`, "utf8");
}

async function readListing(
  toolset: string | undefined,
  extra: Readonly<Record<string, string>>,
): Promise<PublishedListing> {
  const child = spawnBuiltServer({
    ...placeholderInstances,
    ...(toolset === undefined ? {} : { ARR_MCP_TOOLSET: toolset }),
    ...extra,
  });
  try {
    await child.initializeSession(1, LATEST_PROTOCOL_VERSION);
    const listed = (await child.request(2, "tools/list")) as {
      result?: { tools?: PublishedTool[] };
    };
    await child.terminateGracefully();
    return {
      tools: listed.result?.tools ?? [],
      bytes: responseBytes(child.stdout, 2),
      stdout: child.stdout,
      stderr: child.stderr,
    };
  } finally {
    await child.forceCleanup().catch(() => undefined);
  }
}

const listings = new Map<string, Promise<PublishedListing>>();

/** One spawn per selection, shared by every assertion that reads it. */
function listing(
  toolset: string | undefined,
  extra: Readonly<Record<string, string>> = {},
): Promise<PublishedListing> {
  const key = `${toolset ?? "(absent)"} ${JSON.stringify(extra)}`;
  let pending = listings.get(key);
  if (pending === undefined) {
    pending = readListing(toolset, extra);
    listings.set(key, pending);
  }
  return pending;
}

/** The setting that publishes `media_remove`. */
const removalEnabled = { ARR_MCP_MEDIA_ALLOW_REMOVE: "true" };

/**
 * The most the `media` listing may cost on the wire, in bytes.
 *
 * A recorded measurement plus a margin, as the `arr` listing's ceiling is: it
 * was read off a spawned server at 11,866 bytes with all six `media` tools
 * published, `media_remove` included, which is the listing the Media Toolset
 * specification caps at 12,000 bytes.
 *
 * The margin is smaller than the smallest single `media` tool definition —
 * which the test computes from the listing itself — so a regression that
 * publishes one tool twice, or republishes one in full, cannot hide under it.
 */
const mediaListingByteCeiling = 11_900;

/** The Media Toolset specification's cap on the complete listing. */
const mediaListingSpecificationCap = 12_000;

const rootCombinators = ["anyOf", "oneOf", "allOf"] as const;

/** The input properties the Media Toolset specification names for each tool. */
const specifiedInputs: Readonly<Record<string, readonly string[]>> = {
  media_find: ["text", "kind"],
  media_add: ["kind", "id", "resolution", "episodes"],
  media_status: ["kind", "id"],
  media_fix: ["kind", "id"],
  media_search_again: ["kind", "id", "season", "episode"],
  media_remove: ["kind", "id", "delete_files"],
};

const started: FixtureInstance[] = [];

async function instance(application: ApplicationId): Promise<FixtureInstance> {
  const running = await startFixtureInstance(application);
  started.push(running);
  return running;
}

afterEach(async () => {
  await Promise.all(started.splice(0).map((running) => running.close()));
});

interface ToolCallResult {
  result?: {
    isError?: boolean;
    content?: Array<{ type: string; text?: string }>;
    structuredContent?: Record<string, unknown>;
  };
}

describe("media toolset over stdio", () => {
  it("publishes five media tools, and media_remove only when removal is enabled", async () => {
    const without = await listing("media");
    const enabled = await listing("media", removalEnabled);
    const disabled = await listing("media", { ARR_MCP_MEDIA_ALLOW_REMOVE: "false" });

    expect(without.tools.map((tool) => tool.name)).toEqual([
      "media_find",
      "media_add",
      "media_status",
      "media_fix",
      "media_search_again",
    ]);
    expect(disabled.tools).toEqual(without.tools);
    expect(enabled.tools.map((tool) => tool.name)).toEqual([...mediaToolNames]);
    expect(enabled.tools.slice(0, -1)).toEqual(without.tools);
    for (const published of [without, enabled, disabled]) {
      assertCleanProtocolStdout(published.stdout);
      expect(published.stderr).toBe("");
    }
  });

  it("publishes the media tools with flat, closed input roots", async () => {
    const { tools, stdout, stderr } = await listing("media", removalEnabled);

    expect(tools.map((tool) => tool.name)).toEqual([...mediaToolNames]);
    for (const tool of tools) {
      const schema = tool.inputSchema ?? {};
      expect(schema.type, tool.name).toBe("object");
      expect(schema.additionalProperties, tool.name).toBe(false);
      for (const combinator of rootCombinators) {
        expect(schema[combinator], `${tool.name} publishes a root ${combinator}`).toBeUndefined();
      }
      assertWellFormed(schema, tool.name);
      expect(Object.keys((schema.properties ?? {}) as object).sort(), tool.name).toEqual(
        [...(specifiedInputs[tool.name] ?? [])].sort(),
      );
      expect(declaredKeywordPaths(schema, "maxLength"), tool.name).toEqual([]);
      expect(tool.outputSchema?.type, tool.name).toBe("object");
      assertWellFormed(tool.outputSchema ?? {}, `${tool.name} output`);
      expect(tool.description, tool.name).toBeTruthy();
      expect(tool.annotations, tool.name).toBeDefined();
    }
    // The bound left validation's published shape and is restated in prose.
    expect(tools[0]?.inputSchema?.description).toContain("text 200");
    // Text that is only whitespace is refused by a published pattern, so a
    // caller can see the rule a length alone would not state.
    expect(
      (tools[0]?.inputSchema?.properties as Record<string, Record<string, unknown>>)?.text?.pattern,
    ).toBe("\\S");
    // The rules between properties are stated from the unions that validate.
    const statusTool = tools.find((tool) => tool.name === "media_status");
    expect(statusTool?.inputSchema?.description).toContain("- no arguments\n- kind, id");
    const searchAgain = tools.find((tool) => tool.name === "media_search_again");
    expect(searchAgain?.inputSchema?.description).toContain(
      "- kind=movie, id\n- kind=series, id; optional season\n- kind=series, id, season, episode",
    );
    const annotations = Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations]));
    expect(annotations.media_status).toEqual({
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(annotations.media_fix).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
    expect(annotations.media_search_again).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
    expect(annotations.media_remove).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });

    assertCleanProtocolStdout(stdout);
    expect(stderr).toBe("");
  });

  it("names no application or application concept anywhere in a published media tool", async () => {
    const { tools } = await listing("media", removalEnabled);

    for (const tool of tools) {
      const published = JSON.stringify({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        annotations: tool.annotations,
      });
      expect(forbiddenTermsInText(published), tool.name).toEqual([]);
    }
  });

  it("proves the forbidden-term scan finds what it is written to find", () => {
    expect(forbiddenTermsInText('{"rootFolderPath":1}')).toEqual(["root folder"]);
    expect(forbiddenTermsInText("Pick a Quality_Profile")).toEqual(["quality profile"]);
    expect(forbiddenTermsInText("the qualityprofile route")).toEqual(["qualityprofile"]);
    expect(forbiddenTermsInText("Sonarr tags and a PLAN")).toEqual(["sonarr", "tags", "plan"]);
    expect(forbiddenTermsInText("opaqueReference")).toEqual(["opaque", "reference"]);
    expect(forbiddenTermsInText("a download_client")).toEqual(["download client"]);
    expect(forbiddenTermsInText("planet tagline")).toEqual([]);
  });

  it("keeps the media listing under its recorded ceiling, with a margin below one tool", async () => {
    const { tools, bytes } = await listing("media", removalEnabled);
    const smallestTool = Math.min(
      ...tools.map((tool) => Buffer.byteLength(JSON.stringify(tool), "utf8")),
    );

    expect(bytes, `tools/list is ${bytes} bytes`).toBeLessThanOrEqual(mediaListingByteCeiling);
    expect(mediaListingByteCeiling).toBeLessThanOrEqual(mediaListingSpecificationCap);
    expect(
      mediaListingByteCeiling - bytes,
      `margin over a ${smallestTool}-byte smallest tool`,
    ).toBeLessThan(smallestTool);
  });

  it("publishes both toolsets side by side, each tool exactly as it is alone", async () => {
    const arr = await listing("arr");
    const media = await listing("media");

    for (const toolset of ["media,arr", "arr,media", "all", " all "]) {
      const both = await listing(toolset);
      expect(
        both.tools.map((tool) => tool.name),
        toolset,
      ).toEqual([...toolNames, ...publishedMediaToolNames(false)]);
      expect(both.tools, toolset).toEqual([...arr.tools, ...media.tools]);
      assertCleanProtocolStdout(both.stdout);
      expect(both.stderr, toolset).toBe("");
    }
  });

  it("publishes exactly the arr toolset when no selection is made", async () => {
    const absent = await listing(undefined);
    const arr = await listing("arr");

    expect(absent.tools.map((tool) => tool.name)).toEqual([...toolNames]);
    expect(absent.tools).toEqual(arr.tools);
    expect(absent.bytes).toBe(arr.bytes);
  });

  it("refuses an unknown selection at startup without echoing it", async () => {
    const child = spawnBuiltServer({ ...placeholderInstances, ARR_MCP_TOOLSET: "medai" });
    try {
      const exit = await child.closed;
      expect(exit.code).toBe(1);
      expect(child.stdout).toBe("");
      expect(child.stderr).toContain("ARR_MCP_TOOLSET names an unknown toolset");
      expect(child.stderr).not.toContain("medai");
    } finally {
      await child.forceCleanup().catch(() => undefined);
    }
  });

  it("finds and adds a title over the protocol and keeps stdout clean", async () => {
    const sonarr = await instance("sonarr");
    const radarr = await instance("radarr");
    const child = spawnBuiltServer(
      {
        ...instanceEnvironment([sonarr, radarr]),
        ARR_MCP_TOOLSET: "media",
        ARR_MCP_MEDIA_MOVIE_QUALITY_PROFILE: "Example Bluray",
      },
      15_000,
    );

    try {
      await child.initializeSession(1, LATEST_PROTOCOL_VERSION);

      const found = (await child.request(2, "tools/call", {
        name: "media_find",
        arguments: { text: "Example" },
      })) as ToolCallResult;
      expect(found.result?.isError).toBe(false);
      const titles = (found.result?.structuredContent?.titles ?? []) as Array<{
        kind: string;
        id: number;
        in_library: boolean;
      }>;
      expect(titles.map((title) => [title.kind, title.id, title.in_library])).toEqual([
        ["movie", 200001, true],
        ["movie", 200004, false],
        ["series", 100001, true],
        ["series", 100004, false],
      ]);
      expect(found.result?.content?.[0]?.text).toBe(
        "media_find: found 4 title(s) (movie 2, series 2)",
      );

      const added = (await child.request(3, "tools/call", {
        name: "media_add",
        arguments: { kind: "movie", id: 200004 },
      })) as ToolCallResult;
      expect(added.result?.isError).toBe(false);
      expect(added.result?.structuredContent).toEqual({
        kind: "movie",
        id: 200004,
        title: "Example Unadded Movie",
        outcome: "added",
        warnings: [],
        errors: [],
      });
      expect(radarr.writes).toEqual([expect.objectContaining({ method: "POST", route: "movie" })]);
      expect(radarr.writes[0]?.body).toMatchObject({
        tmdbId: 200004,
        qualityProfileId: 2,
        rootFolderPath: "/media/example/movies",
        addOptions: { monitor: "movieOnly", searchForMovie: true },
      });

      const present = (await child.request(4, "tools/call", {
        name: "media_add",
        arguments: { kind: "series", id: 100001 },
      })) as ToolCallResult;
      expect(present.result?.structuredContent?.outcome).toBe("already_in_library");
      expect(sonarr.writes).toEqual([]);

      const ambiguous = (await child.request(5, "tools/call", {
        name: "media_add",
        arguments: { kind: "series", id: 100004 },
      })) as ToolCallResult;
      expect(ambiguous.result?.isError).toBe(true);
      expect(ambiguous.result?.content?.[0]?.text).toContain(
        "deployment_configuration (Ask this server's operator to set ARR_MCP_MEDIA_SERIES_QUALITY_PROFILE",
      );
      expect(sonarr.writes).toEqual([]);

      const invalid = (await child.request(6, "tools/call", {
        name: "media_add",
        arguments: { kind: "movie", id: 200004, episodes: "future" },
      })) as ToolCallResult;
      expect(invalid.result?.isError).toBe(true);

      await child.terminateGracefully();
      assertCleanProtocolStdout(child.stdout);
      expect(child.stderr).toBe("");
      for (const key of [sonarr.apiKey, radarr.apiKey]) {
        expect(child.stdout).not.toContain(key);
      }
    } finally {
      await child.forceCleanup().catch(() => undefined);
    }
  }, 30_000);
  it("reports, fixes, searches, and removes over the protocol and keeps stdout clean", async () => {
    const sonarr = await instance("sonarr");
    const radarr = await instance("radarr");
    const child = spawnBuiltServer(
      {
        ...instanceEnvironment([sonarr, radarr]),
        ARR_MCP_TOOLSET: "media",
        ...removalEnabled,
      },
      15_000,
    );

    try {
      await child.initializeSession(1, LATEST_PROTOCOL_VERSION);

      const status = (await child.request(2, "tools/call", {
        name: "media_status",
        arguments: { kind: "series", id: 100001 },
      })) as ToolCallResult;
      expect(status.result?.isError).toBe(false);
      expect(status.result?.structuredContent).toMatchObject({
        kind: "series",
        id: 100001,
        title: "Example Series",
        in_library: true,
        monitored: true,
        file_resolutions: ["720p", "1080p"],
        downloads: [
          {
            kind: "series",
            id: 100001,
            episodes: "S02E01",
            state: "stuck",
            resolution: "1080p",
            reason: "A file could not be matched to a movie or episode.",
            remedy: "none",
          },
          { episodes: "S01E01", state: "downloading", progress: 66, resolution: "1080p" },
        ],
        errors: [],
      });

      const fixed = (await child.request(3, "tools/call", {
        name: "media_fix",
        arguments: { kind: "series", id: 100001 },
      })) as ToolCallResult;
      expect(fixed.result?.isError).toBe(false);
      expect(fixed.result?.structuredContent).toEqual({
        kind: "series",
        id: 100001,
        title: "Example Series",
        downloads: [
          {
            title: "Example Series",
            episodes: "S02E01",
            action: "none",
            reason: "A file could not be matched to a movie or episode.",
          },
        ],
        remaining: 0,
        warnings: [],
        errors: [],
      });
      expect(fixed.result?.content?.[0]?.text).toBe(
        "media_fix: series 100001: 0 replaced, 0 import(s) started, 1 left alone, 0 remaining",
      );
      expect(sonarr.queueResolutions).toEqual([]);
      expect(sonarr.commands).toEqual([]);

      const searched = (await child.request(4, "tools/call", {
        name: "media_search_again",
        // Named by its number, so searched although it is not monitored.
        arguments: { kind: "series", id: 100001, season: 2, episode: 1 },
      })) as ToolCallResult;
      expect(searched.result?.isError).toBe(false);
      expect(searched.result?.structuredContent).toEqual({
        kind: "series",
        id: 100001,
        title: "Example Series",
        season: 2,
        episode: 1,
        searched: 1,
        warnings: [],
        errors: [],
      });
      expect(sonarr.commands).toEqual([
        { name: "EpisodeSearch", body: { name: "EpisodeSearch", episodeIds: [1003] } },
      ]);

      const removed = (await child.request(5, "tools/call", {
        name: "media_remove",
        arguments: { kind: "movie", id: 200003 },
      })) as ToolCallResult;
      expect(removed.result?.isError).toBe(false);
      expect(removed.result?.structuredContent).toEqual({
        kind: "movie",
        id: 200003,
        title: "Example Archived Movie",
        outcome: "removed",
        files_deleted: false,
        warnings: [],
        errors: [],
      });
      expect(radarr.requests).toContain("movie/10");
      // The double records a removal under its collection; movie 200003 is
      // library record 10, the only one it removed.
      expect(radarr.writes).toEqual([
        {
          method: "DELETE",
          route: "movie",
          query: { deleteFiles: "false", addImportExclusion: "false" },
        },
      ]);

      await child.terminateGracefully();
      assertCleanProtocolStdout(child.stdout);
      expect(child.stderr).toBe("");
      for (const key of [sonarr.apiKey, radarr.apiKey]) {
        expect(child.stdout).not.toContain(key);
      }
    } finally {
      await child.forceCleanup().catch(() => undefined);
    }
  }, 30_000);
});
