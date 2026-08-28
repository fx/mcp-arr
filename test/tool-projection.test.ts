import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ToolContext } from "../src/tools/dispatch.js";
import type { ToolName } from "../src/tools/names.js";
import {
  type FixtureInstance,
  instanceEnvironment,
  startFixtureInstance,
} from "./support/instance-server.js";
import { callTool, isRecord, payloadOutcomes } from "./support/projection.js";
import { createTestToolContext } from "./support/tool-context.js";

let sonarr: FixtureInstance;
let radarr: FixtureInstance;
let prowlarr: FixtureInstance;
let context: ToolContext;

interface Variant {
  readonly tool: ToolName;
  readonly label: string;
  readonly args: Record<string, unknown>;
}

let variants: readonly Variant[] = [];

/** One reference of each kind the variants below need, taken from a real answer. */
async function referenceFor(
  view: string,
  applications: readonly string[],
  identifier: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const tool = view === "queue" ? "arr_activity_query" : "arr_library_query";
  const answered = await callTool(tool, context, { view, applications, ...extra });
  const data = payloadOutcomes(answered.envelope)[0]?.[1]?.data;
  const items = isRecord(data) && Array.isArray(data.items) ? data.items.filter(isRecord) : [];
  const row = items.find((item) => item.id === identifier) ?? items[0];
  const reference = row?.reference;
  if (typeof reference !== "string") {
    throw new Error(`Expected a reference from the ${view} view`);
  }
  return reference;
}

beforeAll(async () => {
  sonarr = await startFixtureInstance("sonarr");
  radarr = await startFixtureInstance("radarr");
  prowlarr = await startFixtureInstance("prowlarr");
  context = createTestToolContext({
    environment: instanceEnvironment([sonarr, radarr, prowlarr]),
  });

  const series = await referenceFor("series", ["sonarr"], "12");
  const movie = await referenceFor("movies", ["radarr"], "8");
  const queue = await referenceFor("queue", ["sonarr"], "502");

  variants = [
    { tool: "arr_library_query", label: "series", args: { view: "series" } },
    { tool: "arr_library_query", label: "seasons", args: { view: "seasons", series } },
    { tool: "arr_library_query", label: "episodes", args: { view: "episodes", series } },
    {
      tool: "arr_library_query",
      label: "episode_files",
      args: { view: "episode_files", series },
    },
    { tool: "arr_library_query", label: "missing_episodes", args: { view: "missing_episodes" } },
    {
      tool: "arr_library_query",
      label: "cutoff_unmet_episodes",
      args: { view: "cutoff_unmet_episodes" },
    },
    { tool: "arr_library_query", label: "movies", args: { view: "movies" } },
    { tool: "arr_library_query", label: "collections", args: { view: "collections" } },
    { tool: "arr_library_query", label: "movie_files", args: { view: "movie_files", movie } },
    { tool: "arr_library_query", label: "missing_movies", args: { view: "missing_movies" } },
    {
      tool: "arr_library_query",
      label: "cutoff_unmet_movies",
      args: { view: "cutoff_unmet_movies" },
    },
    {
      tool: "arr_library_query",
      label: "calendar",
      args: { view: "calendar", start: "2026-01-01", end: "2026-03-01" },
    },
    { tool: "arr_library_query", label: "lookup", args: { view: "lookup", term: "example" } },

    { tool: "arr_activity_query", label: "queue_status", args: { view: "queue_status" } },
    { tool: "arr_activity_query", label: "queue", args: { view: "queue" } },
    { tool: "arr_activity_query", label: "queue_details", args: { view: "queue_details", queue } },
    { tool: "arr_activity_query", label: "history", args: { view: "history" } },
    { tool: "arr_activity_query", label: "blocklist", args: { view: "blocklist" } },
    { tool: "arr_activity_query", label: "health", args: { view: "health" } },
    { tool: "arr_activity_query", label: "commands", args: { view: "commands" } },
    { tool: "arr_activity_query", label: "disk_space", args: { view: "disk_space" } },
    { tool: "arr_activity_query", label: "indexer_status", args: { view: "indexer_status" } },
    {
      tool: "arr_activity_query",
      label: "indexer_statistics",
      args: { view: "indexer_statistics" },
    },

    {
      tool: "arr_config_observe",
      label: "indexers",
      args: { domain: "indexers", applications: ["sonarr"] },
    },
    {
      tool: "arr_config_observe",
      label: "quality_profiles",
      args: { domain: "quality_profiles", applications: ["sonarr"] },
    },
    {
      tool: "arr_config_observe",
      label: "tags",
      args: { domain: "tags", applications: ["sonarr"] },
    },

    {
      tool: "arr_release_search",
      label: "prowlarr_aggregate",
      args: { target: "prowlarr_aggregate", term: "example" },
    },

    {
      tool: "arr_import_inspect",
      label: "queue_item",
      args: { source: "queue_item", queue, applications: ["sonarr"] },
    },
  ];
}, 30_000);

afterAll(async () => {
  await Promise.all([sonarr?.close(), radarr?.close(), prowlarr?.close()]);
});

describe("the result of a collection query", () => {
  it("changes nothing at all when it is omitted", async () => {
    for (const variant of variants) {
      const answered = await callTool(variant.tool, context, variant.args);
      // Byte for byte against the envelope that same call produced, so a
      // projection that ever ran unasked — or a copy that reordered a key —
      // fails here rather than in whichever assertion happened to read the
      // field it moved.
      expect(JSON.stringify(answered.structured), `${variant.tool}/${variant.label}`).toBe(
        JSON.stringify(answered.envelope),
      );
      expect(
        payloadOutcomes(answered.envelope).length,
        `${variant.tool}/${variant.label}`,
      ).toBeGreaterThan(0);
    }
  }, 60_000);
});
