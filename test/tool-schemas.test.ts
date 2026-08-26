import { describe, expect, it } from "vitest";
import * as z4mini from "zod/v4-mini";
import { findToolDefinition, toolDefinitions } from "../src/tools/definitions.js";
import { toolNames } from "../src/tools/names.js";
import { operationDefinitions } from "../src/tools/operations.js";
import {
  defaultPageSize,
  isReferenceProperty,
  maxBulkItems,
  maxPageSize,
  referencePrefixes,
  referenceProperties,
} from "../src/tools/schemas/common.js";
import { sampleReferences, sampleToolInputs } from "./support/tool-context.js";

function inputJsonSchema(name: (typeof toolNames)[number]): Record<string, unknown> {
  const definition = findToolDefinition(name);
  if (definition === undefined) {
    throw new Error(`Missing definition for ${name}`);
  }
  return z4mini.toJSONSchema(definition.inputSchema as never, {
    target: "draft-7",
    io: "input",
  }) as unknown as Record<string, unknown>;
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

function collectPropertyNames(node: unknown, found: Set<string>): void {
  if (Array.isArray(node)) {
    for (const child of node) {
      collectPropertyNames(child, found);
    }
    return;
  }
  if (typeof node !== "object" || node === null) {
    return;
  }
  const record = node as Record<string, unknown>;
  const properties = record.properties;
  if (typeof properties === "object" && properties !== null) {
    for (const key of Object.keys(properties)) {
      found.add(key);
    }
  }
  for (const value of Object.values(record)) {
    collectPropertyNames(value, found);
  }
}

const referencePatterns = new Set(
  Object.values(referencePrefixes).map((prefix) => `^${prefix}_[A-Za-z0-9_-]{8,64}$`),
);

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
  it("publishes exactly the fifteen contracted tools", () => {
    expect(toolDefinitions.map((definition) => definition.name)).toEqual([...toolNames]);
    expect(toolNames).toHaveLength(15);
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
      const found = new Set<string>();
      collectPropertyNames(inputJsonSchema(definition.name), found);
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
    expect(mutationTools).toHaveLength(8);

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
    }

    expect(
      parseInput("arr_config_reconcile", {
        ...planApply,
        secrets: [{ name: "password", value: "resupplied" }],
      }).success,
    ).toBe(true);
    expect(
      parseInput("arr_library_change", {
        ...planApply,
        secrets: [{ name: "password", value: "resupplied" }],
      }).success,
    ).toBe(false);
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
