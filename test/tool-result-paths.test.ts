import { describe, expect, it } from "vitest";
import { z } from "zod";
import { findToolDefinition } from "../src/tools/definitions.js";
import { toolNames } from "../src/tools/names.js";
import {
  describePayloadPaths,
  type PayloadInventory,
  payloadInventory,
  publishedResultSchema,
} from "../src/tools/schemas/publish-results.js";

type Schema = Record<string, unknown>;

/** The tools whose result carries no per-application payload. */
const payloadFreeTools = ["arr_queue_resolve", "arr_activity_change", "arr_library_change"];

/** A path names fields and nothing else: no type, no bound, no annotation. */
const pathPattern = /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/u;

function isRecord(value: unknown): value is Schema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function alternativesOf(node: Schema): readonly Schema[] | undefined {
  const alternatives = node.anyOf ?? node.oneOf;
  return Array.isArray(alternatives) ? alternatives.filter(isRecord) : undefined;
}

/** One tool's payload node, as the converted schema declares it. */
function payloadOf(name: string): Schema | undefined {
  const definition = findToolDefinition(name as (typeof toolNames)[number]);
  if (definition === undefined) {
    throw new Error(`No definition for ${name}`);
  }
  const converted = z.toJSONSchema(definition.outputSchema, {
    target: "draft-7",
    io: "output",
  }) as Schema;
  const outcomes = isRecord(converted.properties) ? converted.properties.applications : undefined;
  const item = isRecord(outcomes) && isRecord(outcomes.items) ? outcomes.items : undefined;
  const declared =
    item !== undefined && isRecord(item.properties) ? item.properties.data : undefined;
  return isRecord(declared) ? declared : undefined;
}

/** The payloads a tool can return, as one node each. */
function payloadBranches(payload: Schema): readonly Schema[] {
  return alternativesOf(payload) ?? [payload];
}

/**
 * Every field name a payload declares, at any depth.
 *
 * Collected as names rather than as paths, and deliberately not with the test
 * support's `publishedPropertyNames`: that one recurses through every value it
 * finds, which reads the schema of a field actually called `properties` — and
 * a reconciliation payload has one — as if it were a property map.
 */
function declaredNames(node: Schema, into: Set<string>): Set<string> {
  for (const alternative of alternativesOf(node) ?? []) {
    declaredNames(alternative, into);
  }
  if (isRecord(node.items)) {
    declaredNames(node.items, into);
  }
  if (isRecord(node.properties)) {
    for (const [name, declared] of Object.entries(node.properties)) {
      into.add(name);
      if (isRecord(declared)) {
        declaredNames(declared, into);
      }
    }
  }
  return into;
}

/**
 * Every node reached by stepping through what a dot-path does not name:
 * an array, because a path carries no index, and alternatives, because a path
 * may name a field only one of them declares.
 */
function stepInto(node: Schema, into: Schema[]): Schema[] {
  const alternatives = alternativesOf(node);
  if (alternatives !== undefined) {
    for (const alternative of alternatives) {
      stepInto(alternative, into);
    }
    return into;
  }
  if (isRecord(node.items)) {
    return stepInto(node.items, into);
  }
  into.push(node);
  return into;
}

/**
 * Every node one dot-path can name, resolved a segment at a time from the
 * payload root — the reading a caller does, rather than the walk that produced
 * the path. An empty result means the path names nothing.
 */
function resolvePath(payload: Schema, path: string): readonly Schema[] {
  let reached = stepInto(payload, []);
  for (const segment of path.split(".")) {
    const next: Schema[] = [];
    for (const node of reached) {
      const declared = isRecord(node.properties) ? node.properties[segment] : undefined;
      if (isRecord(declared)) {
        stepInto(declared, next);
      }
    }
    reached = next;
  }
  return reached;
}

function inventoryOf(name: string): PayloadInventory | undefined {
  const definition = findToolDefinition(name as (typeof toolNames)[number]);
  return definition === undefined ? undefined : payloadInventory(definition.outputSchema);
}

/** The root description the tool publishes, as a host reads it. */
function publishedDescription(name: string): string | undefined {
  const definition = findToolDefinition(name as (typeof toolNames)[number]);
  if (definition === undefined) {
    throw new Error(`No definition for ${name}`);
  }
  const converted = z.toJSONSchema(publishedResultSchema(definition.outputSchema), {
    target: "draft-7",
    io: "output",
  }) as Schema;
  return typeof converted.description === "string" ? converted.description : undefined;
}

describe("published payload paths", () => {
  it("publishes an inventory for every tool that has a payload and none for the rest", () => {
    for (const name of toolNames) {
      const payload = payloadOf(name);
      const inventory = inventoryOf(name);

      if (payloadFreeTools.includes(name)) {
        // Nothing can be reached into, so an inventory would advertise a
        // surface the tool does not have.
        expect(payload, name).toBeUndefined();
        expect(inventory, name).toBeUndefined();
        expect(publishedDescription(name), name).toBeUndefined();
        continue;
      }

      expect(payload, name).toBeDefined();
      expect(inventory, name).toBeDefined();
      expect(inventory?.payloads.length, name).toBe(payloadBranches(payload ?? {}).length);
      expect(publishedDescription(name), name).toBe(
        describePayloadPaths(inventory as PayloadInventory),
      );
    }
    expect(payloadFreeTools.every((name) => (toolNames as readonly string[]).includes(name))).toBe(
      true,
    );
  });

  it("resolves every published path to a leaf of the schema it came from", () => {
    for (const name of toolNames) {
      const payload = payloadOf(name);
      const inventory = inventoryOf(name);
      if (payload === undefined || inventory === undefined) {
        continue;
      }
      const branches = payloadBranches(payload);

      for (const [index, published] of inventory.payloads.entries()) {
        const branch = branches[index] ?? {};
        expect(published.paths.length, `${name} payload ${index}`).toBeGreaterThan(0);

        for (const path of published.paths) {
          expect(path, `${name} ${path}`).toMatch(pathPattern);
          const reached = resolvePath(branch, path);
          // Resolving is what a projection will do, so a path that does not
          // resolve is one this server advertised and could never honour.
          expect(reached.length, `${name} ${path} resolves`).toBeGreaterThan(0);
          // And it resolves to a leaf. An interior node would leave a caller
          // guessing what to descend into, which is the question listing
          // leaves removes rather than answers.
          expect(
            reached.filter((node) => isRecord(node.properties)),
            `${name} ${path} is interior`,
          ).toEqual([]);
        }
      }
    }
  });

  it("leaves no field of any payload unnamed", () => {
    for (const name of toolNames) {
      const payload = payloadOf(name);
      const inventory = inventoryOf(name);
      if (payload === undefined || inventory === undefined) {
        continue;
      }
      const branches = payloadBranches(payload);

      for (const [index, published] of inventory.payloads.entries()) {
        // Every field the payload declares at any depth, collected without
        // reference to a path — against every segment the published paths are
        // built from. The two sets being equal is the whole claim: nothing the
        // schema declares goes unnamed, and nothing is named that the schema
        // does not declare.
        const declared = declaredNames(branches[index] ?? {}, new Set());
        const named = new Set(published.paths.flatMap((path) => path.split(".")));
        expect([...named].sort(), `${name} payload ${index}`).toEqual([...declared].sort());
      }
    }
  });

  it("groups a discriminated payload by the value that selects it", () => {
    const library = inventoryOf("arr_library_query");
    expect(library?.discriminator).toBe("view");

    const movies = library?.payloads.find((payload) => payload.variant === "movies");
    // The doc's own example, pinned: a caller copies this into a projection
    // verbatim, and finds it under the view it belongs to rather than in a
    // merged list belonging to no view.
    expect(movies?.paths).toContain("items.radarr.tmdbId");
    expect(movies?.paths).toContain("items.title");
    expect(movies?.paths).not.toContain("items.radarr");
    // A path that belongs to another view is absent from this one, which is
    // what grouping buys over a union of every field the tool can return.
    expect(movies?.paths).not.toContain("items.sonarr.tvdbId");

    // Sixteen configuration domains answer with three payload shapes, so the
    // property that names one payload is `family` and not the sixteen-value
    // `domain` beside it.
    expect(inventoryOf("arr_config_observe")?.discriminator).toBe("family");

    // Nothing distinguishes the three reconciliation payloads, so they are
    // published as alternatives rather than labelled with a value no result
    // carries.
    const reconcile = inventoryOf("arr_config_reconcile");
    expect(reconcile?.discriminator).toBeUndefined();
    expect(reconcile?.payloads.map((payload) => payload.variant)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("names every value a discriminated payload can be selected by", () => {
    for (const name of toolNames) {
      const inventory = inventoryOf(name);
      const discriminator = inventory?.discriminator;
      if (inventory === undefined || discriminator === undefined) {
        continue;
      }
      const branches = payloadBranches(payloadOf(name) ?? {});
      const declared = branches.map((branch) => {
        const node = isRecord(branch.properties) ? branch.properties[discriminator] : undefined;
        return isRecord(node) && typeof node.const === "string" ? node.const : undefined;
      });

      expect(
        inventory.payloads.map((payload) => payload.variant),
        name,
      ).toEqual(declared);
      expect(
        declared.filter((value) => value === undefined),
        name,
      ).toEqual([]);

      // And every one of them survives into the prose, so a caller reading a
      // value in the wild can find the payload it goes with.
      const described = describePayloadPaths(inventory);
      for (const value of declared) {
        expect(described, `${name} ${String(value)}`).toContain(`${discriminator}=`);
        expect(
          described.split("\n").some((line) => {
            const label = line.startsWith(`- ${discriminator}=`)
              ? (line.slice(`- ${discriminator}=`.length).split(":")[0] ?? "")
              : "";
            return label.split("|").includes(String(value));
          }),
          `${name} ${String(value)}`,
        ).toBe(true);
      }
    }
  });
});
