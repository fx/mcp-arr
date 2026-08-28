import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as z4mini from "zod/v4-mini";
import { findToolDefinition, toolDefinitions } from "../src/tools/definitions.js";
import { toolNames } from "../src/tools/names.js";
import { operationDefinitions } from "../src/tools/operations.js";
import {
  defaultPageSize,
  isReferenceProperty,
  maxBulkItems,
  maxPageSize,
  referenceKinds,
  referencePattern,
  referenceProperties,
} from "../src/tools/schemas/common.js";
import { objectInput, variantUnion } from "../src/tools/schemas/publish.js";
import {
  declaredKeywordPaths,
  declaredPropertyValues,
  publishedPropertyNames,
} from "./support/json-schema.js";
import { sampleReferences, sampleToolInputs } from "./support/tool-context.js";

/**
 * One schema as the JSON Schema a host receives, converted through the mini
 * build the server SDK itself uses. Shared by every assertion here that reads a
 * published input, so none of them can be measuring a different conversion than
 * the others.
 */
function publishedInput(schema: z.ZodType): Record<string, unknown> {
  return z4mini.toJSONSchema(schema as never, {
    target: "draft-7",
    io: "input",
  }) as unknown as Record<string, unknown>;
}

function inputJsonSchema(name: (typeof toolNames)[number]): Record<string, unknown> {
  const definition = findToolDefinition(name);
  if (definition === undefined) {
    throw new Error(`Missing definition for ${name}`);
  }
  return publishedInput(definition.inputSchema);
}

function parseInput(name: (typeof toolNames)[number], value: unknown) {
  const definition = findToolDefinition(name);
  if (definition === undefined) {
    throw new Error(`Missing definition for ${name}`);
  }
  return definition.inputSchema.safeParse(value);
}

function sampleFor(name: (typeof toolNames)[number]): Record<string, unknown> {
  return structuredClone(sampleToolInputs[name]);
}

/** Property names that would reintroduce a dispatcher through the back door. */
const forbiddenPropertyNames = [
  "path",
  "folderPath",
  "outputPath",
  "downloadUrl",
  "magnetUrl",
  "guid",
  "commandName",
  "command",
  "endpoint",
  "url",
  "baseUrl",
  "apiKey",
  "operation",
  "operationId",
  "method",
];

const referencePatterns = new Set(referenceKinds.map(referencePattern));

function isReferenceNode(node: unknown): boolean {
  if (typeof node !== "object" || node === null) {
    return false;
  }
  const record = node as Record<string, unknown>;
  if (typeof record.pattern === "string" && referencePatterns.has(record.pattern)) {
    return true;
  }
  return (
    isReferenceNode(record.items) || (record.anyOf as unknown[])?.some(isReferenceNode) === true
  );
}

/**
 * Collects the property names whose published schema is a reference.
 *
 * Derived from the JSON Schema a host actually receives rather than from the
 * Zod source, so the dispatcher's allowlist is checked against the contract
 * instead of against the code that produced it.
 */
function collectReferencePropertyNames(node: unknown, found: Set<string>): void {
  if (Array.isArray(node)) {
    for (const child of node) {
      collectReferencePropertyNames(child, found);
    }
    return;
  }
  if (typeof node !== "object" || node === null) {
    return;
  }
  const record = node as Record<string, unknown>;
  const properties = record.properties;
  if (typeof properties === "object" && properties !== null) {
    for (const [key, value] of Object.entries(properties)) {
      if (isReferenceNode(value)) {
        found.add(key);
      }
    }
  }
  for (const value of Object.values(record)) {
    collectReferencePropertyNames(value, found);
  }
}

describe("published tool surface", () => {
  it("publishes exactly the fourteen contracted tools", () => {
    expect(toolDefinitions.map((definition) => definition.name)).toEqual([...toolNames]);
    expect(toolNames).toHaveLength(14);
  });

  it("declares an object-rooted input schema and an output schema for every tool", () => {
    for (const definition of toolDefinitions) {
      const schema = inputJsonSchema(definition.name);
      expect(schema.type, `${definition.name} input root type`).toBe("object");

      const output = z4mini.toJSONSchema(definition.outputSchema as never, {
        target: "draft-7",
        io: "output",
      }) as unknown as Record<string, unknown>;
      expect(output.type, `${definition.name} output root type`).toBe("object");
      expect(output.additionalProperties, `${definition.name} output`).toBe(false);
    }
  });

  it("accepts its minimal sample arguments", () => {
    for (const name of toolNames) {
      expect(parseInput(name, sampleFor(name)).success, name).toBe(true);
    }
  });

  it("rejects an unknown property on every tool", () => {
    for (const name of toolNames) {
      const withExtra = { ...sampleFor(name), unexpectedProperty: "value" };
      expect(parseInput(name, withExtra).success, name).toBe(false);
    }
  });

  it("rejects an undeclared variant", () => {
    for (const definition of toolDefinitions) {
      const discriminator = definition.discriminator;
      if (discriminator === undefined) {
        continue;
      }
      const withBadVariant = { ...sampleFor(definition.name), [discriminator]: "not_a_variant" };
      expect(parseInput(definition.name, withBadVariant).success, definition.name).toBe(false);
    }
  });

  it("never accepts an internal operation identifier as a variant", () => {
    for (const definition of toolDefinitions) {
      const discriminator = definition.discriminator;
      if (discriminator === undefined) {
        continue;
      }
      for (const operation of operationDefinitions) {
        const attempt = { ...sampleFor(definition.name), [discriminator]: operation.id };
        expect(parseInput(definition.name, attempt).success, operation.id).toBe(false);
      }
    }
  });

  it("exposes no endpoint, path, command, credential, or operation-name property", () => {
    for (const definition of toolDefinitions) {
      const found = publishedPropertyNames(inputJsonSchema(definition.name));
      for (const forbidden of forbiddenPropertyNames) {
        expect(found.has(forbidden), `${definition.name} exposes ${forbidden}`).toBe(false);
      }
    }
  });

  it("bounds every collection query with a default and a hard maximum page size", () => {
    const collectionSamples = [
      ["arr_library_query", { view: "series" }],
      ["arr_activity_query", { view: "history" }],
      ["arr_config_observe", { domain: "tags" }],
      ["arr_release_search", { target: "prowlarr_aggregate", term: "example" }],
      ["arr_import_inspect", { source: "queue_item", queue: sampleReferences.queue }],
    ] as const;

    for (const [name, base] of collectionSamples) {
      const defaulted = parseInput(name, { ...base });
      expect(defaulted.success, name).toBe(true);
      expect(
        (defaulted.success ? defaulted.data : undefined) as { pageSize: number },
      ).toMatchObject({ pageSize: defaultPageSize, detail: "summary" });

      expect(parseInput(name, { ...base, pageSize: maxPageSize }).success, name).toBe(true);
      expect(parseInput(name, { ...base, pageSize: maxPageSize + 1 }).success, name).toBe(false);
      expect(parseInput(name, { ...base, pageSize: 0 }).success, name).toBe(false);
      expect(parseInput(name, { ...base, pageSize: 1.5 }).success, name).toBe(false);
      expect(parseInput(name, { ...base, detail: "everything" }).success, name).toBe(false);
    }
  });

  it("bounds bulk mutations to a reviewable number of references", () => {
    const references = Array.from(
      { length: maxBulkItems },
      (_, index) => `que_${String(index).padStart(8, "0")}`,
    );

    expect(
      parseInput("arr_queue_resolve", {
        intent: "ignore_tracking",
        mode: "apply",
        items: references,
      }).success,
    ).toBe(true);
    expect(
      parseInput("arr_queue_resolve", {
        intent: "ignore_tracking",
        mode: "apply",
        items: [...references, "que_99999999"],
      }).success,
    ).toBe(false);
    expect(
      parseInput("arr_queue_resolve", { intent: "ignore_tracking", mode: "apply", items: [] })
        .success,
    ).toBe(false);
  });

  it("requires an explicit mode on every mutation tool and rejects it on read tools", () => {
    for (const definition of toolDefinitions) {
      const sample = sampleFor(definition.name);
      const isMutation = "mode" in sample;
      if (isMutation) {
        const { mode: _mode, ...withoutMode } = sample;
        expect(parseInput(definition.name, withoutMode).success, definition.name).toBe(false);
        expect(
          parseInput(definition.name, { ...sample, mode: "plan" }).success,
          definition.name,
        ).toBe(true);
        expect(
          parseInput(definition.name, { ...sample, mode: "apply" }).success,
          definition.name,
        ).toBe(true);
        expect(
          parseInput(definition.name, { ...sample, mode: "force" }).success,
          definition.name,
        ).toBe(false);
      } else {
        expect(
          parseInput(definition.name, { ...sample, mode: "apply" }).success,
          definition.name,
        ).toBe(false);
      }
    }
  });

  it("binds every reference to its own kind", () => {
    expect(parseInput("arr_job_get", { job: sampleReferences.job }).success).toBe(true);
    expect(parseInput("arr_job_get", { job: sampleReferences.release }).success).toBe(false);
    expect(
      parseInput("arr_release_grab", { mode: "apply", releases: [sampleReferences.release] })
        .success,
    ).toBe(true);
    expect(
      parseInput("arr_release_grab", {
        mode: "apply",
        releases: [sampleReferences.importCandidate],
      }).success,
    ).toBe(false);
    expect(
      parseInput("arr_import_execute", {
        mode: "apply",
        candidates: [sampleReferences.release],
        importMode: "auto",
      }).success,
    ).toBe(false);
  });

  it("lists every reference-bearing property the dispatcher has to resolve", () => {
    const published = new Set<string>();
    for (const definition of toolDefinitions) {
      collectReferencePropertyNames(inputJsonSchema(definition.name), published);
    }

    // Equality in both directions: a property the schemas added but the
    // dispatcher does not know about would silently skip resolution, and a
    // property the dispatcher still lists after the schemas dropped it would be
    // dead policy nothing checks.
    expect([...published].sort()).toEqual([...referenceProperties].sort());
    for (const name of published) {
      expect(isReferenceProperty(name), name).toBe(true);
    }
  });

  it("requires the explicit choices the specifications call out", () => {
    expect(
      parseInput("arr_queue_resolve", {
        intent: "blocklist_and_remove",
        mode: "apply",
        items: [sampleReferences.queue],
      }).success,
    ).toBe(false);
    expect(
      parseInput("arr_queue_resolve", {
        intent: "blocklist_and_remove",
        mode: "apply",
        items: [sampleReferences.queue],
        replacementSearch: "suppress",
      }).success,
    ).toBe(true);

    const deleteMedia = {
      intent: "delete_media",
      mode: "apply",
      items: [sampleReferences.media],
      addImportListExclusion: false,
    };
    expect(parseInput("arr_library_change", deleteMedia).success).toBe(false);
    expect(parseInput("arr_library_change", { ...deleteMedia, deleteFiles: false }).success).toBe(
      true,
    );

    const addMedia = {
      intent: "add_media",
      mode: "apply",
      application: "sonarr",
      lookup: sampleReferences.media,
      rootFolder: sampleReferences.configuration,
      qualityProfile: sampleReferences.configuration,
      monitor: "all",
    };
    expect(parseInput("arr_library_change", addMedia).success).toBe(false);
    expect(parseInput("arr_library_change", { ...addMedia, searchOnAdd: false }).success).toBe(
      true,
    );
  });

  it("accepts a plan reference in place of a restated intent on every mutation tool", () => {
    const planApply = { mode: "apply", plan: sampleReferences.plan };
    const mutationTools = toolNames.filter((name) => "mode" in sampleToolInputs[name]);
    expect(mutationTools).toHaveLength(7);

    for (const name of mutationTools) {
      expect(parseInput(name, planApply).success, name).toBe(true);
      // Planning a plan reference has no meaning, so the form fixes the mode.
      expect(parseInput(name, { mode: "plan", plan: sampleReferences.plan }).success, name).toBe(
        false,
      );
      // A plan reference replaces the intent rather than accompanying it.
      expect(
        parseInput(name, { ...sampleFor(name), mode: "apply", plan: sampleReferences.plan })
          .success,
        name,
      ).toBe(false);
      expect(parseInput(name, { mode: "apply", plan: sampleReferences.job }).success, name).toBe(
        false,
      );
      // No tool accepts a transient secret any more, so the resupply form is
      // refused on every one of them rather than on all but the one that used
      // to declare it.
      expect(
        parseInput(name, { ...planApply, secrets: [{ name: "password", value: "resupplied" }] })
          .success,
        name,
      ).toBe(false);
    }
  });

  it("offers no plan-reference form on a read tool", () => {
    const readTools = toolNames.filter((name) => !("mode" in sampleToolInputs[name]));
    for (const name of readTools) {
      expect(parseInput(name, { mode: "apply", plan: sampleReferences.plan }).success, name).toBe(
        false,
      );
    }
  });
});

/**
 * Every issue message a rejected input produces, sorted.
 *
 * The whole list rather than a distinct set, so an issue that appears twice or
 * an extra one nobody asked for fails rather than collapsing into the expected
 * value; sorted rather than in Zod's own order, because what is pinned here is
 * the wording each mechanism produces and not the sequence it collects them in.
 */
function rejectionMessages(name: (typeof toolNames)[number], value: unknown): readonly string[] {
  const parsed = parseInput(name, value);
  if (parsed.success) {
    throw new Error(`${name} accepted an input this test requires it to reject`);
  }
  return parsed.error.issues.map((issue) => issue.message).sort();
}

/** A `strictObject` refusing a key it does not declare. */
const unrecognizedKey = 'Unrecognized key: "unexpectedProperty"';

/**
 * A plain `z.union` reporting that no member matched. It is the same string
 * whatever went wrong inside the members, which is exactly why the eight
 * mutation tools — whose intents are a discriminated union nested inside a
 * union with the plan-reference form — say this where the five read variant
 * tools name the property or the discriminator.
 */
const noAlternativeMatched = "Invalid input";

/** A `strictObject` reporting a required string that was not supplied. */
const missingRequiredString = "Invalid input: expected string, received undefined";

/**
 * Zod's own wording for a string longer than its schema allows.
 *
 * Captured by running the cases below against the implementation as it stood
 * before the bound stopped being published, rather than written from what the
 * sanitized publication was expected to produce. The whole promise of removing
 * a length from the schema a host reads is that the refusal a caller reads is
 * untouched, and an expectation derived from the new code would assert that
 * promise against itself.
 */
function tooLong(maximum: number): string {
  return `Too big: expected string to have <=${maximum} characters`;
}

/** `z.discriminatedUnion` reporting a value outside its declared set. */
function discriminatorMismatch(variants: readonly string[]): string {
  return `Invalid discriminator value. Expected ${variants.map((variant) => `'${variant}'`).join(" | ")}`;
}

/**
 * The discriminator values a tool's published schema declares, in the order it
 * declares them.
 *
 * Harvested from the schema rather than written out so that adding a variant
 * extends this test instead of breaking it: the discriminator wording
 * enumerates the accepted set, and the set is not what these assertions are
 * about.
 */
function declaredVariantValues(name: (typeof toolNames)[number]): readonly string[] {
  const discriminator = findToolDefinition(name)?.discriminator;
  return discriminator === undefined
    ? []
    : declaredPropertyValues(inputJsonSchema(name), discriminator);
}

/**
 * A tool whose input is a union of a direct intent and the plan-reference form.
 * Those are the eight mutation tools, and the outer plain union is what decides
 * their rejection wording.
 */
function isPlanReferenceTool(name: (typeof toolNames)[number]): boolean {
  return "mode" in sampleToolInputs[name];
}

/**
 * The exact wording of every class of refused input.
 *
 * These are the messages a caller reads when a call is refused, and they are
 * pinned as literals because the promise attached to any change in how the
 * schemas are *published* is that nothing about what is *accepted* — including
 * how a rejection reads — changes with it. The cases are chosen by the
 * mechanism that produces the message rather than by tool, so each one covers a
 * distinct code path rather than restating a neighbour.
 */
describe("input rejection messages", () => {
  it("words an unknown property the way the form that refused it does", () => {
    for (const name of toolNames) {
      const withExtra = { ...sampleFor(name), unexpectedProperty: "value" };
      expect(rejectionMessages(name, withExtra), name).toEqual(
        isPlanReferenceTool(name) ? [noAlternativeMatched] : [unrecognizedKey],
      );
    }
  });

  it("words an undeclared discriminator value by naming the accepted set", () => {
    for (const definition of toolDefinitions) {
      const discriminator = definition.discriminator;
      if (discriminator === undefined) {
        continue;
      }
      const name = definition.name;
      const withBadVariant = { ...sampleFor(name), [discriminator]: "not_a_variant" };
      expect(rejectionMessages(name, withBadVariant), name).toEqual(
        isPlanReferenceTool(name)
          ? [noAlternativeMatched]
          : [discriminatorMismatch(declaredVariantValues(name))],
      );
    }
  });

  it("words a variant-required property that was not supplied", () => {
    // One case per variant tool that has a required argument beyond its own
    // discriminator. `arr_config_observe` is absent because none of its sixteen
    // domains requires anything else, so it has no such case to word.
    const cases: ReadonlyArray<
      readonly [(typeof toolNames)[number], Record<string, unknown>, readonly string[]]
    > = [
      ["arr_library_query", { view: "seasons" }, [missingRequiredString]],
      ["arr_activity_query", { view: "queue_details" }, [missingRequiredString]],
      ["arr_release_search", { target: "radarr_movie" }, [missingRequiredString]],
      ["arr_import_inspect", { source: "queue_item" }, [missingRequiredString]],
      ["arr_search_start", { target: "sonarr_series", mode: "plan" }, [noAlternativeMatched]],
      ["arr_release_grab", { mode: "apply" }, [noAlternativeMatched]],
      ["arr_queue_resolve", { intent: "ignore_tracking", mode: "plan" }, [noAlternativeMatched]],
      [
        "arr_activity_change",
        { intent: "mark_history_failed", mode: "plan" },
        [noAlternativeMatched],
      ],
      [
        "arr_import_execute",
        { mode: "plan", candidates: [sampleReferences.importCandidate] },
        [noAlternativeMatched],
      ],
      [
        "arr_library_change",
        { intent: "set_monitoring", mode: "plan", items: [sampleReferences.media] },
        [noAlternativeMatched],
      ],
      ["arr_job_cancel", { mode: "apply" }, [noAlternativeMatched]],
    ];

    for (const [name, input, expected] of cases) {
      expect(rejectionMessages(name, input), name).toEqual(expected);
    }
  });

  it("words an over-length value by naming the maximum it exceeds", () => {
    // Every bounded string in the corpus, at both depths it occurs at: a root
    // property of a variant, and a property of a nested mapping object. These
    // are the values whose bound the published schema no longer states, so
    // they are the ones whose refusal has to be shown to be unchanged.
    const cases: ReadonlyArray<
      readonly [(typeof toolNames)[number], Record<string, unknown>, string]
    > = [
      ["arr_library_query", { view: "lookup", term: "x".repeat(201) }, tooLong(200)],
      ["arr_library_query", { view: "series", cursor: "c".repeat(513) }, tooLong(512)],
      ["arr_activity_query", { view: "history", cursor: "c".repeat(513) }, tooLong(512)],
      ["arr_release_search", { target: "prowlarr_aggregate", term: "x".repeat(201) }, tooLong(200)],
      ["arr_config_observe", { domain: "tags", cursor: "c".repeat(513) }, tooLong(512)],
      [
        "arr_import_inspect",
        {
          source: "candidate_reprocess",
          candidate: sampleReferences.importCandidate,
          mapping: { releaseGroup: "x".repeat(121) },
        },
        tooLong(120),
      ],
      [
        "arr_library_change",
        {
          intent: "update_file_metadata",
          mode: "plan",
          files: [sampleReferences.mediaFile],
          changes: { releaseGroup: "x".repeat(121) },
        },
        tooLong(120),
      ],
    ];

    for (const [name, input, expected] of cases) {
      expect(rejectionMessages(name, input), `${name} ${expected}`).toEqual([expected]);
    }
  });

  it("words a reference of the wrong kind by naming the kind it wanted", () => {
    expect(rejectionMessages("arr_job_get", { job: sampleReferences.release })).toEqual([
      "must be a job reference",
    ]);
    expect(
      rejectionMessages("arr_job_cancel", { mode: "apply", job: sampleReferences.release }),
    ).toEqual(["must be a job reference"]);
  });

  it("words a plan reference restated alongside its intent", () => {
    const mutationTools = toolNames.filter(isPlanReferenceTool);
    expect(mutationTools).toHaveLength(7);

    for (const name of mutationTools) {
      const both = { ...sampleFor(name), mode: "apply", plan: sampleReferences.plan };
      expect(rejectionMessages(name, both), name).toEqual([noAlternativeMatched]);
    }
  });

  it("carries a refinement's own message out of the variant it belongs to", () => {
    expect(
      rejectionMessages("arr_library_query", {
        view: "calendar",
        start: "2026-08-31",
        end: "2026-08-01",
      }),
    ).toEqual([
      "start and end must be real dates, in order, and cover at most 366 days including both bounds",
    ]);
    expect(
      rejectionMessages("arr_library_change", {
        intent: "update_file_metadata",
        mode: "plan",
        files: [sampleReferences.mediaFile],
        changes: {},
      }),
    ).toEqual(["at least one file metadata field must be supplied"]);
  });
});

/**
 * The merge itself, over a union written here rather than over a shipped tool.
 *
 * The flattening's whole purpose is that the accepted set of every property
 * reaches the root, where a host will read it. Whether that survives a property
 * being *documented* is not a question any shipped tool can answer today —
 * none of them describes a variant's discriminator — so it is asked of a union
 * built for the purpose, which is also the form the regression would first take.
 * The same goes for a union the merge must refuse: every shipped one conforms,
 * so the wording of that refusal can only be pinned against one written here.
 */
describe("published variant merge", () => {
  it("collapses a described choice into one root enum rather than a nested anyOf", () => {
    const union = variantUnion(
      z.union([
        z.strictObject({
          mode: z.enum(["plan"]).describe("Validates without changing anything."),
          items: z.string(),
        }),
        z.strictObject({
          mode: z.enum(["apply"]),
          items: z.string(),
        }),
      ]),
    );

    const published = publishedInput(union);
    const properties = published.properties as Record<string, unknown>;

    // A description asserts nothing about the value, so it cannot be the reason
    // a property stops advertising what it accepts. Publishing the alternatives
    // instead would put the accepted set under the one combinator a host never
    // inspects — the same failure the flat root exists to prevent, reintroduced
    // one property at a time.
    //
    // And the collapse has to carry the description with it. The collapsed node
    // is built by hand, so text a variant wrote survives only by being copied
    // across; nothing else republishes it, and losing it here would delete it
    // from the published schema outright rather than merely relocate it.
    expect(properties.mode).toEqual({
      type: "string",
      enum: ["plan", "apply"],
      description: "Validates without changing anything.",
    });
  });

  it("keeps each alternative's own description where the shapes cannot collapse", () => {
    const union = variantUnion(
      z.union([
        z.strictObject({
          target: z.string().describe("The single item to act on."),
          items: z.string(),
        }),
        z.strictObject({
          target: z.array(z.string()).describe("Every item to act on."),
          items: z.string(),
        }),
      ]),
    );

    const published = publishedInput(union);
    const properties = published.properties as Record<string, unknown>;

    // Distinct shapes are published verbatim as alternatives, so there is
    // nothing to carry: each keeps the description it was declared with.
    expect(properties.target).toEqual({
      anyOf: [
        { type: "string", description: "The single item to act on." },
        { type: "array", items: { type: "string" }, description: "Every item to act on." },
      ],
    });
  });

  it("names the offending variant when one is not a closed object", () => {
    // A module-load throw aborts the whole server, not one tool, so the message
    // is the only thing a reader has to go on. It has to say which variant of
    // which union it means, and what identifies a converted variant is what it
    // declares — its property names, and the values fixing its discriminator.
    expect(() =>
      variantUnion(
        z.union([
          z.strictObject({ mode: z.literal("plan"), items: z.string() }),
          z.object({ mode: z.literal("apply"), plan: z.string() }),
        ]),
      ),
    ).toThrow(
      'Every variant of a published union must be a closed object; found "object" with ' +
        "additionalProperties null, on the variant declaring mode=apply, plan",
    );
  });
});

/**
 * The sanitizing, over inputs written here rather than over a shipped tool.
 *
 * Two of the three questions it has to answer cannot be asked of the shipped
 * corpus at all. No plain-object tool declares a length bound today, and that
 * is the one publication path with no variant documentation for the sentence to
 * join — so the mechanism is proven on a bound added here, which is also the
 * form the regression would first take. Nor does any tool bound one property
 * differently in two forms, which is what decides whether stripping before the
 * merge or after it is the same thing.
 */
describe("published length bounds", () => {
  it("names a bound stripped from a plain object, which publishes no variant prose", () => {
    const input = objectInput(
      z.strictObject({
        token: z.string().min(4).max(64),
        tags: z.array(z.string().max(16)).max(3),
      }),
    );
    const published = publishedInput(input);

    expect(declaredKeywordPaths(published, "maxLength")).toEqual([]);
    // The whole of the description, not a fragment of it: a plain object has
    // nothing else generated for it, so what a caller reads about the ceiling
    // is exactly this sentence or nothing at all.
    expect(published.description).toBe(
      "Maximum lengths in characters, enforced but not published: token 64, tags 16. " +
        "A bound named for an array property bounds each of its elements.",
    );

    // What the length is traded for stays published. A pattern or a minimum
    // constrains the admissible alphabet far more usefully than a ceiling, and
    // an item count is the half a caller acts on.
    expect(declaredKeywordPaths(published, "minLength")).toEqual(["token declares minLength 4"]);
    expect(declaredKeywordPaths(published, "maxItems")).toEqual(["tags declares maxItems 3"]);

    // And the bound still refuses what it always refused. Removing it from
    // publication is the whole change; removing it from validation would be a
    // different one.
    expect(input.safeParse({ token: "x".repeat(65), tags: [] }).success).toBe(false);
    expect(input.safeParse({ token: "x".repeat(64), tags: ["short"] }).success).toBe(true);
    expect(input.safeParse({ token: "abcd", tags: ["x".repeat(17)] }).success).toBe(false);
  });

  it("names a bound stripped from a variant union beneath its variant prose", () => {
    const union = variantUnion(
      z.union([
        z.strictObject({ view: z.literal("search"), term: z.string().max(200) }),
        z.strictObject({ view: z.literal("page"), cursor: z.string().max(512) }),
      ]),
    );
    const published = publishedInput(union);

    expect(declaredKeywordPaths(published, "maxLength")).toEqual([]);
    const description = String(published.description);
    expect(description).toContain("Supply exactly one of these forms in full");
    // Last, so the variant lines stay a contiguous block a reader — and the
    // wire test's line parser — can read as one list.
    expect(description.split("\n").at(-1)).toBe(
      "Maximum lengths in characters, enforced but not published: term 200, cursor 512.",
    );
  });

  it("keeps the array half of a bound a later form applies to elements", () => {
    // The scalar form comes first deliberately. One bound sighted twice is one
    // bound to name, but the second sighting is the only one that says the
    // length applies to each element rather than to the property — so dropping
    // it as a duplicate would leave the description silent about exactly the
    // form whose path needs explaining.
    const union = variantUnion(
      z.union([
        z.strictObject({ view: z.literal("one"), thing: z.string().max(5) }),
        z.strictObject({ view: z.literal("many"), thing: z.array(z.string().max(5)) }),
      ]),
    );
    const published = publishedInput(union);

    expect(declaredKeywordPaths(published, "maxLength")).toEqual([]);
    expect(String(published.description).split("\n").at(-1)).toBe(
      "Maximum lengths in characters, enforced but not published: thing 5. " +
        "A bound named for an array property bounds each of its elements.",
    );
  });

  it("reaches every nesting a converted bound can sit in, not the ones in use today", () => {
    // The three shapes a walk written from the current corpus misses. A tuple
    // publishes its elements as an `items` *list* rather than one schema, a
    // record publishes its keys under `propertyNames`, and a tuple rest under
    // `additionalItems` — and a bound the walk never visits is one that reaches
    // a host's grammar compiler while CI stays green, which is the whole
    // failure this change exists to prevent.
    const input = objectInput(
      z.strictObject({
        pair: z.tuple([z.string().max(5), z.string().max(9)]),
        rest: z.tuple([z.string().max(7)], z.string().max(11)),
        dict: z.record(z.string().max(6), z.string().max(12)),
      }),
    );
    const published = publishedInput(input);

    expect(declaredKeywordPaths(published, "maxLength")).toEqual([]);
    expect(published.description).toBe(
      "Maximum lengths in characters, enforced but not published: pair 5 or 9, rest 7 or 11, " +
        "dict 6 or 12. A bound named for an array property bounds each of its elements.",
    );
    expect(input.safeParse({ pair: ["x".repeat(6), "y"], rest: ["z"], dict: {} }).success).toBe(
      false,
    );
  });

  it("collapses two forms that bound one property differently, and names both bounds", () => {
    const union = variantUnion(
      z.union([
        z.strictObject({ view: z.literal("short"), term: z.string().max(20) }),
        z.strictObject({ view: z.literal("long"), term: z.string().max(200) }),
      ]),
    );
    const published = publishedInput(union);
    const properties = published.properties as Record<string, unknown>;

    // This is why the stripping runs before the branches are merged. Merged
    // first, the two shapes differ only in the bound and would be published as
    // a nested `anyOf` of two strings — the one combinator a host never
    // inspects — and stripping it afterwards would leave two identical
    // alternatives behind. Stripped first, they are one shape.
    expect(properties.term).toEqual({ type: "string" });
    expect(String(published.description).split("\n").at(-1)).toBe(
      "Maximum lengths in characters, enforced but not published: term 20 or 200.",
    );
  });
});
