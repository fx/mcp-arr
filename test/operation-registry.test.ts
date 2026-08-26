import { describe, expect, it } from "vitest";
import * as z4mini from "zod/v4-mini";
import type { ApplicationCapability } from "../src/adapters/registry.js";
import { applicationIds } from "../src/applications.js";
import { createWorkflowState } from "../src/state/workflow.js";
import { toolDefinitions } from "../src/tools/definitions.js";
import { dispatchOperation } from "../src/tools/dispatch.js";
import { toolNames } from "../src/tools/names.js";
import {
  checkOperationSupport,
  createOperationRegistry,
  type OperationDefinition,
  operationDefinitions,
  operationSideEffects,
  unsupportedOperationHandler,
} from "../src/tools/operations.js";
import { createTestToolContext, jsonResponse } from "./support/tool-context.js";

const registry = createOperationRegistry();

function operationFor(tool: (typeof toolNames)[number], variant: string | undefined) {
  const operation = registry.find(tool, variant);
  if (operation === undefined) {
    throw new Error(`Missing operation for ${tool}/${variant ?? "-"}`);
  }
  return operation;
}

function available(application: "sonarr" | "radarr" | "prowlarr", version: string) {
  return {
    application,
    status: "available",
    apiVersion: application === "prowlarr" ? "v1" : "v3",
    minimumVersion: "0.0.0",
    version,
  } satisfies ApplicationCapability;
}

/**
 * Collects the discriminator values a tool's published JSON Schema declares.
 *
 * Reading the published schema rather than probing the parser is what makes
 * this a contract check: a host and a calling model see exactly this set, so a
 * registry variant missing from it is unreachable in practice.
 */
function declaredVariants(tool: (typeof toolNames)[number]): Set<string> {
  const definition = toolDefinitions.find((candidate) => candidate.name === tool);
  const discriminator = definition?.discriminator;
  const found = new Set<string>();
  if (definition === undefined || discriminator === undefined) {
    return found;
  }

  const schema = z4mini.toJSONSchema(definition.inputSchema as never, {
    target: "draft-7",
    io: "input",
  }) as unknown;

  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) {
        visit(child);
      }
      return;
    }
    if (typeof node !== "object" || node === null) {
      return;
    }
    const record = node as Record<string, unknown>;
    const properties = record.properties as Record<string, unknown> | undefined;
    const property = properties?.[discriminator] as Record<string, unknown> | undefined;
    if (typeof property?.const === "string") {
      found.add(property.const);
    }
    if (Array.isArray(property?.enum)) {
      for (const value of property.enum) {
        if (typeof value === "string") {
          found.add(value);
        }
      }
    }
    for (const value of Object.values(record)) {
      visit(value);
    }
  };

  visit(schema);
  return found;
}

describe("internal operation registry", () => {
  it("holds unique identifiers and unique public variants", () => {
    const ids = operationDefinitions.map((operation) => operation.id);
    expect(new Set(ids).size).toBe(ids.length);

    const variants = operationDefinitions.map(
      (operation) => `${operation.tool}/${operation.variant ?? "-"}`,
    );
    expect(new Set(variants).size).toBe(variants.length);
  });

  it("rejects a duplicated identifier at construction", () => {
    const first = operationDefinitions[0];
    if (first === undefined) {
      throw new Error("The operation inventory must not be empty");
    }
    expect(() => createOperationRegistry([first, first])).toThrow("Duplicate operation id");

    const clashing: OperationDefinition = { ...first, id: "job.get" };
    expect(() => createOperationRegistry([first, clashing])).toThrow(
      first.id === "job.get" ? "Duplicate operation id" : "Duplicate operation variant",
    );
  });

  it("declares every operation against real applications and a known side effect", () => {
    for (const operation of operationDefinitions) {
      expect(operation.applications.length, operation.id).toBeGreaterThan(0);
      for (const application of operation.applications) {
        expect(applicationIds).toContain(application);
      }
      expect(operationSideEffects).toContain(operation.sideEffect);
      expect(toolNames).toContain(operation.tool);
    }
  });

  it("classifies destructive and job-starting operations honestly", () => {
    expect(operationFor("arr_queue_resolve", "remove_from_client_and_delete_data").sideEffect).toBe(
      "destructive",
    );
    expect(operationFor("arr_queue_resolve", "ignore_tracking").sideEffect).toBe("mutate");
    expect(operationFor("arr_library_change", "delete_media").sideEffect).toBe("destructive");
    expect(operationFor("arr_library_change", "set_monitoring").sideEffect).toBe("mutate");
    expect(operationFor("arr_search_start", "sonarr_series").sideEffect).toBe("start_job");
    expect(operationFor("arr_config_reconcile", "test_provider").sideEffect).toBe("external");
    expect(operationFor("arr_library_query", "series").sideEffect).toBe("read");
  });

  it("covers exactly the variants the public schemas declare", () => {
    for (const definition of toolDefinitions) {
      const declared = registry.forTool(definition.name).map((operation) => operation.variant);

      if (definition.name === "arr_capabilities") {
        // The meta tool reports the inventory; it is not an entry in it.
        expect(declared).toEqual([]);
        continue;
      }

      expect(declared.length, definition.name).toBeGreaterThan(0);
      if (definition.discriminator === undefined) {
        expect(declared).toEqual([undefined]);
        continue;
      }

      const published = declaredVariants(definition.name);
      expect([...published].sort(), definition.name).toEqual([...declared].sort());
      expect(published.has("not_a_variant"), definition.name).toBe(false);
    }
  });

  it("cannot be reached with an internal identifier or another tool's variant", () => {
    for (const operation of operationDefinitions) {
      for (const tool of toolNames) {
        expect(registry.find(tool, operation.id)).toBeUndefined();
      }
      if (operation.variant !== undefined) {
        const otherTools = toolNames.filter((tool) => tool !== operation.tool);
        for (const tool of otherTools) {
          const found = registry.find(tool, operation.variant);
          expect(found === undefined || found.tool === tool).toBe(true);
        }
      }
    }
    expect(registry.find("arr_library_query", undefined)).toBeUndefined();
    expect(registry.find("arr_job_get", "job.get")).toBeUndefined();
  });

  it("gates an operation on the application it declares", () => {
    const seriesQuery = operationFor("arr_library_query", "series");

    expect(checkOperationSupport(seriesQuery, available("sonarr", "4.0.19.2979"))).toEqual({
      status: "supported",
    });
    expect(checkOperationSupport(seriesQuery, available("prowlarr", "2.5.2.5491"))).toEqual({
      status: "unsupported",
      reason: "application",
    });
  });

  it("gates an operation on its own recorded minimum version", () => {
    const gated: OperationDefinition = {
      ...operationFor("arr_library_query", "series"),
      minimumVersions: { sonarr: "4.1.0.0" },
    };

    expect(checkOperationSupport(gated, available("sonarr", "4.0.19.2979"))).toEqual({
      status: "unsupported",
      reason: "version",
      requiredVersion: "4.1.0.0",
    });
    expect(checkOperationSupport(gated, available("sonarr", "4.1.0.0"))).toEqual({
      status: "supported",
    });
    expect(checkOperationSupport(gated, available("sonarr", "4.2.0.1"))).toEqual({
      status: "supported",
    });
  });

  it("propagates the application's own state before considering the operation", () => {
    const seriesQuery = operationFor("arr_library_query", "series");

    expect(
      checkOperationSupport(seriesQuery, { application: "sonarr", status: "unconfigured" }),
    ).toEqual({ status: "unconfigured" });
    expect(
      checkOperationSupport(seriesQuery, {
        application: "sonarr",
        status: "unavailable",
        apiVersion: "v3",
        minimumVersion: "4.0.19.2979",
        failure: { kind: "timeout", message: "sonarr: the request timed out" },
      }),
    ).toMatchObject({ status: "unavailable" });
    expect(
      checkOperationSupport(seriesQuery, {
        application: "sonarr",
        status: "unsupported",
        apiVersion: "v3",
        minimumVersion: "4.0.19.2979",
        version: "3.0.0.0",
      }),
    ).toEqual({ status: "unsupported", reason: "version", requiredVersion: "4.0.19.2979" });
  });

  it("reports every declared operation as not implemented yet", async () => {
    const outcome = await unsupportedOperationHandler({
      application: "sonarr",
      adapter: {
        application: "sonarr",
        apiVersion: "v3",
        minimumVersion: "4.0.19.2979",
        client: {
          application: "sonarr",
          apiBaseUrl: "https://sonarr.example.invalid/api/v3",
          get: async () => ({}),
        },
        probe: async () => available("sonarr", "4.0.19.2979"),
      },
      mode: "read",
      input: {},
      state: createWorkflowState(),
    });

    expect(outcome.status).toBe("error");
    expect(outcome.status === "error" ? outcome.error.code : undefined).toBe(
      "unsupported_capability",
    );
  });

  it("dispatches through the registered handler for a supported application", async () => {
    const invoked: string[] = [];
    const operations: readonly OperationDefinition[] = [
      {
        ...operationFor("arr_library_query", "series"),
        handler: async ({ application, mode }) => {
          invoked.push(`${application}:${mode}`);
          return { status: "ok", data: { probed: true } };
        },
      },
    ];
    const context = createTestToolContext({
      operations,
      fetch: async () => jsonResponse({ appName: "Sonarr", version: "4.0.19.2979" }),
    });

    const result = await dispatchOperation(context, {
      tool: "arr_library_query",
      variant: "series",
      applications: undefined,
      mode: "read",
      planReference: undefined,
      input: { view: "series" },
    });

    expect(invoked).toEqual(["sonarr:read"]);
    expect(result.status).toBe("ok");
    expect(result.applications).toEqual([
      { application: "sonarr", status: "ok", warnings: [], data: { probed: true } },
    ]);
  });

  it("never probes an application the operation does not declare", async () => {
    const requested: string[] = [];
    const context = createTestToolContext({
      fetch: async (url) => {
        requested.push(url);
        return jsonResponse({ appName: "Sonarr", version: "4.0.19.2979" });
      },
    });

    const result = await dispatchOperation(context, {
      tool: "arr_library_query",
      variant: "movies",
      applications: ["sonarr", "prowlarr"],
      mode: "read",
      planReference: undefined,
      input: { view: "movies" },
    });

    expect(requested).toEqual([]);
    expect(result.status).toBe("error");
    expect(result.applications.map((outcome) => [outcome.application, outcome.status])).toEqual([
      ["sonarr", "unsupported"],
      ["prowlarr", "unsupported"],
    ]);
    expect(result.applications[0]?.error?.code).toBe("unsupported_capability");
  });

  it("targets each application once even when it is named twice", async () => {
    const requested: string[] = [];
    const context = createTestToolContext({
      fetch: async (url) => {
        requested.push(url);
        return jsonResponse({ appName: "Sonarr", version: "4.0.19.2979" });
      },
    });

    const result = await dispatchOperation(context, {
      tool: "arr_library_query",
      variant: "series",
      applications: ["sonarr", "sonarr"],
      mode: "read",
      planReference: undefined,
      input: { view: "series" },
    });

    expect(requested).toHaveLength(1);
    expect(result.applications).toHaveLength(1);
  });

  it("returns an unsupported capability when no operation matches the request", async () => {
    const context = createTestToolContext();
    const result = await dispatchOperation(context, {
      tool: "arr_library_query",
      variant: "library.query.series",
      applications: undefined,
      mode: "read",
      planReference: undefined,
      input: {},
    });

    expect(result.status).toBe("error");
    expect(result.applications).toEqual([]);
    expect(result.errors.map((error) => error.code)).toEqual(["unsupported_capability"]);
  });
});
