import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ToolContext } from "../src/tools/dispatch.js";
import { type ToolName, toolNames } from "../src/tools/names.js";
import { maxProjectionPathLength, maxProjectionPaths } from "../src/tools/schemas/projection.js";
import { type PayloadInventory, payloadInventory } from "../src/tools/schemas/publish-results.js";
import {
  type FixtureInstance,
  instanceEnvironment,
  startFixtureInstance,
} from "./support/instance-server.js";
import {
  callTool,
  definitionOf,
  isRecord,
  leafValues,
  outcomesOf,
  type Payload,
  payloadOutcomes,
  presentPaths,
  withoutPositions,
} from "./support/projection.js";
import { createTestToolContext, sampleToolInputs } from "./support/tool-context.js";

/**
 * The tools that accept a projection, pinned by name.
 *
 * Derived nowhere, on purpose: which tools let a caller name the fields they
 * want back is a fact about the published surface, and a change that adds or
 * removes one should have to say so here. `tool-stdio.test.ts` asserts the same
 * list against what the spawned server actually published, so the two cannot
 * both be wrong in the same direction.
 */
const projectingTools: readonly ToolName[] = [
  "arr_library_query",
  "arr_activity_query",
  "arr_release_search",
  "arr_import_inspect",
  "arr_config_observe",
];

function inventoryOf(name: ToolName): PayloadInventory {
  const inventory = payloadInventory(definitionOf(name).outputSchema);
  if (inventory === undefined) {
    throw new Error(`${name} publishes no payload inventory`);
  }
  return inventory;
}

/** The inventory entry the payload in hand belongs to, by position. */
function payloadIndex(inventory: PayloadInventory, data: Payload): number {
  const discriminator = inventory.discriminator;
  if (discriminator === undefined) {
    return 0;
  }
  const value = data[discriminator];
  return inventory.payloads.findIndex(
    (payload) => typeof value === "string" && payload.variants.includes(value),
  );
}

/**
 * A projection for one payload: paths the inventory publishes and this payload
 * really carries a value at, spread across the list rather than taken from one
 * end, so a nested field and a top-level one are both exercised.
 *
 * Chosen from what is present rather than from the inventory alone, because a
 * path naming an optional field the instance did not report would reduce the
 * comparison below to comparing nothing.
 */
function chooseProjection(inventory: PayloadInventory, data: Payload): readonly string[] {
  const index = payloadIndex(inventory, data);
  const published = new Set(inventory.payloads[index]?.paths ?? []);
  const usable = presentPaths(data).filter((path) => published.has(path));
  const deepestFirst = [...usable].sort(
    (left, right) => right.split(".").length - left.split(".").length || left.localeCompare(right),
  );
  const wanted = [0, 1, Math.floor(deepestFirst.length / 2), deepestFirst.length - 1];
  const chosen = new Set<string>();
  for (const position of wanted) {
    const path = deepestFirst[position];
    if (path !== undefined) {
      chosen.add(path);
    }
  }
  return [...chosen];
}

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

describe("the projection argument", () => {
  it("is bounded at or above the widest and deepest payload the server publishes", () => {
    let widest = 0;
    let deepest = 0;
    let measured = 0;

    for (const name of toolNames) {
      const inventory = payloadInventory(definitionOf(name).outputSchema);
      if (inventory === undefined) {
        continue;
      }
      for (const payload of inventory.payloads) {
        measured += 1;
        widest = Math.max(widest, payload.paths.length);
        for (const path of payload.paths) {
          deepest = Math.max(deepest, path.length);
        }
      }
    }

    // A loop is only a check if it ran.
    expect(measured, "payloads measured").toBeGreaterThan(0);
    // Both bounds are floors read off what the tools advertise, not numbers
    // anybody preferred: a bound below either would refuse a projection naming
    // exactly the paths a tool publishes. A payload that later grows a wider or
    // deeper shape fails here rather than silently making a published path
    // unselectable.
    expect(maxProjectionPaths, `widest payload publishes ${widest} paths`).toBeGreaterThanOrEqual(
      widest,
    );
    expect(maxProjectionPathLength, `deepest path is ${deepest} characters`).toBeGreaterThanOrEqual(
      deepest,
    );
  });

  it("is accepted by every collection query and by no other tool", () => {
    for (const name of toolNames) {
      const definition = definitionOf(name);
      const accepted = definition.inputSchema.safeParse({
        ...sampleToolInputs[name],
        projection: ["items"],
      }).success;
      expect(accepted, `${name} accepts a projection`).toBe(projectingTools.includes(name));
    }
  });

  it("refuses a projection past either bound", () => {
    const definition = definitionOf("arr_library_query");
    const path = "a".repeat(maxProjectionPathLength);

    expect(
      definition.inputSchema.safeParse({ view: "movies", projection: [path] }).success,
      "at the path-length bound",
    ).toBe(true);
    expect(
      definition.inputSchema.safeParse({ view: "movies", projection: [`${path}a`] }).success,
      "past the path-length bound",
    ).toBe(false);

    const paths = Array.from({ length: maxProjectionPaths }, (_value, index) => `path${index}`);
    expect(
      definition.inputSchema.safeParse({ view: "movies", projection: paths }).success,
      "at the count bound",
    ).toBe(true);
    expect(
      definition.inputSchema.safeParse({ view: "movies", projection: [...paths, "one_more"] })
        .success,
      "past the count bound",
    ).toBe(false);
    expect(
      definition.inputSchema.safeParse({ view: "movies", projection: [] }).success,
      "an empty projection",
    ).toBe(false);
  });

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

  it("returns only values the same call would have returned unprojected", async () => {
    const covered = new Map<ToolName, Set<number>>();

    for (const variant of variants) {
      const inventory = inventoryOf(variant.tool);
      const unprojected = await callTool(variant.tool, context, variant.args);
      const first = payloadOutcomes(unprojected.envelope)[0];
      if (first === undefined) {
        throw new Error(`${variant.tool}/${variant.label} returned no payload`);
      }
      const projection = chooseProjection(inventory, first[1].data as Payload);
      expect(projection.length, `${variant.tool}/${variant.label} projection`).toBeGreaterThan(0);

      const projected = await callTool(variant.tool, context, { ...variant.args, projection });
      const where = `${variant.tool}/${variant.label} ${projection.join(",")}`;
      expect(projected.isError, where).toBe(false);
      // Every path resolved, so the call has nothing to warn about.
      expect(projected.structured.warnings, where).toEqual(projected.envelope.warnings);

      const outcomes = payloadOutcomes(projected.structured);
      expect(outcomes.length, where).toBeGreaterThan(0);

      for (const [index, outcome] of outcomes) {
        const source = outcomesOf(projected.envelope)[index]?.data;
        const label = `${where} #${index}`;
        expect(isRecord(source), label).toBe(true);
        covered.set(
          variant.tool,
          (covered.get(variant.tool) ?? new Set()).add(
            payloadIndex(inventory, (isRecord(source) ? source : {}) as Payload),
          ),
        );

        const returned = leafValues(outcome.data);
        const available = leafValues(source);
        expect(returned.size, `${label} selected nothing`).toBeGreaterThan(0);
        // Value by value against the unprojected envelope, not against an
        // expected literal: a projection may only ever hand back something the
        // same call already had.
        for (const [path, value] of returned) {
          expect(available.has(path), `${label} invented ${path}`).toBe(true);
          expect(value, `${label} ${path}`).toEqual(available.get(path));
        }
        // And nothing beyond what was named, plus the discriminator that says
        // which payload this is. Narrowed to the paths this application's own
        // answer carries a value at: two instances answering one view return
        // the same payload shape, and a field only one of them reports is a
        // path the other cannot hand back.
        const carried = new Set(presentPaths(isRecord(source) ? source : {}));
        const expected = new Set(projection.filter((path) => carried.has(path)));
        if (inventory.discriminator !== undefined) {
          expected.add(inventory.discriminator);
        }
        expect(
          [...new Set([...returned.keys()].map(withoutPositions))].sort(),
          `${label} selection`,
        ).toEqual([...expected].sort());
      }
    }

    // Every payload each projecting tool can return was exercised, so no
    // payload shape reaches a caller without having been compared.
    for (const name of projectingTools) {
      expect([...(covered.get(name) ?? new Set())].length, `${name} payloads covered`).toBe(
        inventoryOf(name).payloads.length,
      );
    }
  }, 90_000);

  it("cannot be written so as to remove the envelope, an outcome's fields, or the discriminator", async () => {
    const inventory = inventoryOf("arr_library_query");
    const baseline = await callTool("arr_library_query", context, { view: "movies" });
    const envelopeKeys = Object.keys(baseline.structured).sort();
    expect(envelopeKeys).toEqual(["applications", "errors", "status", "warnings"]);

    // The three things a projection must never remove, named the three ways a
    // caller could try: outright, by a prefix of them, and by naming nothing
    // that matches at all.
    const attempts: readonly (readonly string[])[] = [
      ["status"],
      ["applications"],
      ["warnings"],
      ["errors"],
      ["application"],
      ["continuation"],
      ["view"],
      ["view.value"],
      ["items"],
      ["no_such_field"],
    ];

    for (const projection of attempts) {
      const answered = await callTool("arr_library_query", context, { view: "movies", projection });
      const where = `projection ${projection.join(",")}`;

      expect(Object.keys(answered.structured).sort(), where).toEqual(envelopeKeys);
      expect(answered.structured.status, where).toBe(baseline.structured.status);
      expect(answered.isError, where).toBe(false);

      const outcomes = payloadOutcomes(answered.structured);
      expect(outcomes.length, where).toBeGreaterThan(0);
      for (const [index, outcome] of outcomes) {
        const { data: _selected, ...reported } = outcome;
        const { data: _returned, ...unchanged } = outcomesOf(answered.envelope)[index] ?? {};
        // Everything the outcome says about the call itself, untouched: which
        // application answered, whether it partly failed, whether more pages
        // exist.
        expect(reported, `${where} #${index}`).toEqual(unchanged);
        // And the payload still says which of the tool's payloads it is.
        const data = isRecord(outcome.data) ? outcome.data : {};
        expect(data[inventory.discriminator ?? ""], `${where} #${index}`).toBe("movies");
      }
    }
  }, 60_000);

  it("warns about what did not match and still returns what did", async () => {
    const answered = await callTool("arr_library_query", context, {
      view: "movies",
      projection: ["items.title", "items.titel"],
    });

    expect(answered.isError).toBe(false);
    expect(answered.structured.status).toBe("ok");

    const warnings = Array.isArray(answered.structured.warnings)
      ? answered.structured.warnings
      : [];
    const before = Array.isArray(answered.envelope.warnings) ? answered.envelope.warnings : [];
    // One warning, however many paths missed and however many applications
    // could not offer them.
    expect(warnings.length).toBe(before.length + 1);
    const warning = String(warnings[warnings.length - 1]);
    expect(warning).toContain("items.titel");
    // Beside the paths that were available where reading it stopped, so the
    // caller corrects the guess inside this call rather than paying a round
    // trip for the listing.
    expect(warning).toContain("items.title");
    expect(warning).toContain("items.year");
    // The text half counts it too, so both halves describe the same call.
    expect(answered.summary).toContain(`${warnings.length} warning(s)`);

    const outcome = payloadOutcomes(answered.structured)[0]?.[1];
    const data = isRecord(outcome?.data) ? outcome.data : {};
    const items = Array.isArray(data.items) ? data.items.filter(isRecord) : [];
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual(["title"]);
    }
    expect(data.view).toBe("movies");
    // The record counts still describe what the query matched rather than what
    // the projection kept, because a caller pages on them.
    const continuation = outcomesOf(answered.structured)[0]?.continuation;
    expect(isRecord(continuation) ? continuation.returned : undefined).toBe(items.length);
  }, 30_000);
});
