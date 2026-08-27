import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { toolDefinitions } from "../src/tools/definitions.js";
import { toolNames } from "../src/tools/names.js";
import { assertWellFormed, publishedPropertyNames, schemaFailures } from "./support/json-schema.js";
import { assertCleanProtocolStdout, spawnBuiltServer } from "./support/spawned-stdio.js";
import { sampleToolInputs } from "./support/tool-context.js";

const sonarrApiKey = "sonarr-secret-key";

/**
 * The built server rejects startup without a complete instance pair, and the
 * reserved `.invalid` host guarantees that no request in this file can reach a
 * real instance.
 */
const configuredInstance = {
  SONARR_URL: "https://sonarr.example.invalid/sonarr",
  SONARR_API_KEY: sonarrApiKey,
};

function spawnServer(deadlineMs = 5_000) {
  return spawnBuiltServer(configuredInstance, deadlineMs);
}

/** The variant property each tool names, or `undefined` where it has none. */
const discriminators = new Map<string, string | undefined>(
  toolDefinitions.map((definition) => [definition.name as string, definition.discriminator]),
);

interface ToolListResult {
  result?: {
    tools?: Array<{
      name: string;
      description?: string;
      inputSchema?: Record<string, unknown>;
      outputSchema?: { type?: string };
      annotations?: Record<string, unknown>;
    }>;
  };
}

/**
 * The published input schemas, keyed by tool name, exactly as a host receives
 * them: read back off the wire from a spawned server rather than converted in
 * process, because an in-process conversion is what hid an empty published
 * schema behind a passing suite.
 */
async function listPublishedInputSchemas(): Promise<ReadonlyMap<string, Record<string, unknown>>> {
  const child = spawnServer();
  try {
    await child.initializeSession(1, LATEST_PROTOCOL_VERSION);
    const listed = (await child.request(2, "tools/list")) as ToolListResult;
    const published = new Map<string, Record<string, unknown>>();
    for (const tool of listed.result?.tools ?? []) {
      published.set(tool.name, tool.inputSchema ?? {});
    }
    await child.terminateGracefully();
    return published;
  } finally {
    await child.forceCleanup().catch(() => undefined);
  }
}

/**
 * The combinators a host drops a tool for carrying at the root of its input
 * schema. All three, and the root only: the same host never inspects a
 * combinator nested under a property.
 */
const rootCombinators = ["anyOf", "oneOf", "allOf"] as const;

/** The property-key shape a host requires of a published schema, at any depth. */
const propertyKeyPattern = /^[a-zA-Z0-9_.-]{1,64}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function offendingPropertyKeys(node: unknown, found: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const entry of node) {
      offendingPropertyKeys(entry, found);
    }
    return found;
  }
  if (!isRecord(node)) {
    return found;
  }
  if (isRecord(node.properties)) {
    for (const key of Object.keys(node.properties)) {
      if (!propertyKeyPattern.test(key)) {
        found.push(key);
      }
    }
  }
  for (const value of Object.values(node)) {
    offendingPropertyKeys(value, found);
  }
  return found;
}

interface ToolCallResult {
  result?: {
    isError?: boolean;
    content?: Array<{ type: string; text?: string }>;
    structuredContent?: {
      status?: string;
      errors?: Array<{ code?: string; remediation?: string }>;
      applications?: Array<{
        application: string;
        status: string;
        data?: { state?: string };
        error?: { code?: string; remediation?: string };
      }>;
    };
  };
}

describe("built stdio tool surface", () => {
  it("publishes the fifteen tools with their schemas and keeps stdout clean", async () => {
    const child = spawnServer();

    try {
      await child.initializeSession(1, LATEST_PROTOCOL_VERSION);
      const listed = (await child.request(2, "tools/list")) as ToolListResult;
      const tools = listed.result?.tools ?? [];

      expect(tools.map((tool) => tool.name)).toEqual([...toolNames]);
      for (const tool of tools) {
        expect(tool.inputSchema?.type, tool.name).toBe("object");
        // A root combinator is not a style question. A host that filters tool
        // definitions drops the tool outright when it finds one, so publishing
        // alternatives at the root costs a caller the whole tool rather than
        // some of its detail — and the object root the protocol asks for is
        // satisfied at the same time as the combinator is present, which is how
        // thirteen tools passed the assertion above while being unusable.
        for (const combinator of rootCombinators) {
          expect(
            tool.inputSchema?.[combinator],
            `${tool.name} publishes a root ${combinator}`,
          ).toBeUndefined();
        }
        // Closed at the root as well: a caller reading the schema has to be
        // able to tell that a property it does not find there is one the tool
        // does not accept.
        expect(tool.inputSchema?.additionalProperties, tool.name).toBe(false);
        expect(offendingPropertyKeys(tool.inputSchema), tool.name).toEqual([]);
        assertWellFormed(tool.inputSchema ?? {}, tool.name);
        // An object root satisfied on its own is what let every variant tool
        // publish `{"type":"object","properties":{}}`, so the arguments have to
        // be asserted here rather than beside this: a tool that publishes no
        // argument name tells a caller nothing it can send.
        const published = [...publishedPropertyNames(tool.inputSchema)];
        expect(published, `${tool.name} publishes no argument`).not.toHaveLength(0);
        const discriminator = discriminators.get(tool.name);
        if (discriminator !== undefined) {
          expect(published, tool.name).toContain(discriminator);
        }

        expect(tool.outputSchema?.type, tool.name).toBe("object");
        expect(tool.description, tool.name).toBeTruthy();
        expect(tool.annotations, tool.name).toBeDefined();
      }

      await child.terminateGracefully();
      assertCleanProtocolStdout(child.stdout);
      expect(child.stderr).toBe("");
    } finally {
      await child.forceCleanup().catch(() => undefined);
    }
  });

  it("publishes a schema that admits what each tool accepts and refuses what it rejects", async () => {
    const published = await listPublishedInputSchemas();

    for (const name of toolNames) {
      const schema = published.get(name);
      expect(schema, name).toBeDefined();
      if (schema === undefined) {
        continue;
      }

      const accepted = structuredClone(sampleToolInputs[name]) as Record<string, unknown>;
      expect(schemaFailures(schema, accepted), `${name} accepted arguments`).toEqual([]);

      // The same object with one property the tool does not declare. The tool
      // refuses it at runtime, so a published schema that admits it would tell
      // a host something untrue about the call.
      const rejected = { ...accepted, unexpectedProperty: "value" };
      expect(schemaFailures(schema, rejected), `${name} rejected arguments`).not.toEqual([]);

      const discriminator = discriminators.get(name);
      if (discriminator !== undefined) {
        // The variant is the half that never reached the wire. A published
        // schema carrying no alternative admits any value here.
        const undeclaredVariant = { ...accepted, [discriminator]: "not_a_variant" };
        expect(schemaFailures(schema, undeclaredVariant), `${name} undeclared variant`).not.toEqual(
          [],
        );
      }
    }
  });

  it("returns the unsupported_capability error without contacting an instance", async () => {
    const child = spawnServer();

    try {
      await child.initializeSession(1, LATEST_PROTOCOL_VERSION);
      const called = (await child.request(2, "tools/call", {
        name: "arr_library_query",
        arguments: { view: "movies", applications: ["sonarr"] },
      })) as ToolCallResult;

      expect(called.result?.isError).toBe(true);
      expect(called.result?.structuredContent?.status).toBe("error");
      const outcomes = called.result?.structuredContent?.applications ?? [];
      expect(outcomes.map((outcome) => [outcome.application, outcome.error?.code])).toEqual([
        ["sonarr", "unsupported_capability"],
      ]);
      expect(outcomes[0]?.error?.remediation).toBeTruthy();
      expect(called.result?.content?.[0]?.type).toBe("text");

      await child.terminateGracefully();
      assertCleanProtocolStdout(child.stdout);
      expect(child.stderr).toBe("");
      expect(child.stdout).not.toContain(sonarrApiKey);
    } finally {
      await child.forceCleanup().catch(() => undefined);
    }
  });

  it("answers both job tools locally with clean stdout and no upstream request", async () => {
    const child = spawnServer();

    try {
      await child.initializeSession(1, LATEST_PROTOCOL_VERSION);
      // A freshly started server holds no job, so a syntactically valid
      // reference is by definition one this process never issued. Answering it
      // is entirely process-local: nothing is probed, and the envelope still
      // conforms to the tool's published output schema.
      const read = (await child.request(2, "tools/call", {
        name: "arr_job_get",
        arguments: { job: "job_00000001" },
      })) as ToolCallResult;
      const cancelled = (await child.request(3, "tools/call", {
        name: "arr_job_cancel",
        arguments: { mode: "apply", job: "job_00000001" },
      })) as ToolCallResult;

      for (const called of [read, cancelled]) {
        expect(called.result?.isError).toBe(true);
        expect(called.result?.structuredContent?.status).toBe("error");
        expect(called.result?.structuredContent?.errors?.map((error) => error.code)).toEqual([
          "stale_reference",
        ]);
        expect(called.result?.structuredContent?.errors?.[0]?.remediation).toBeTruthy();
        expect(called.result?.content?.[0]?.type).toBe("text");
      }

      await child.terminateGracefully();
      assertCleanProtocolStdout(child.stdout);
      expect(child.stderr).toBe("");
      expect(child.stdout).not.toContain(sonarrApiKey);
    } finally {
      await child.forceCleanup().catch(() => undefined);
    }
  });

  it("answers arr_capabilities with structured content for every application", async () => {
    const child = spawnServer(20_000);

    try {
      await child.initializeSession(1, LATEST_PROTOCOL_VERSION);
      // Only Sonarr is configured and its reserved `.invalid` host cannot
      // resolve, so the report is deterministic: one unreachable instance and
      // two unconfigured ones, with the whole result still succeeding.
      const called = (await child.request(2, "tools/call", {
        name: "arr_capabilities",
        arguments: {},
      })) as ToolCallResult;

      expect(called.result?.isError).toBe(false);
      expect(called.result?.structuredContent?.status).toBe("ok");
      expect(
        (called.result?.structuredContent?.applications ?? []).map((outcome) => [
          outcome.application,
          outcome.status,
          outcome.data?.state,
        ]),
      ).toEqual([
        ["sonarr", "ok", "unavailable"],
        ["radarr", "ok", "unconfigured"],
        ["prowlarr", "ok", "unconfigured"],
      ]);
      // The summary has to agree with the structured half. Asserting only that
      // it mentions the tool name is what let it claim "sonarr ok" while the
      // report beside it said the instance was unreachable.
      expect(called.result?.content?.[0]?.text).toBe(
        "arr_capabilities: no application available; sonarr unavailable, radarr unconfigured, prowlarr unconfigured",
      );

      await child.terminateGracefully();
      assertCleanProtocolStdout(child.stdout);
      expect(child.stderr).toBe("");
      expect(child.stdout).not.toContain(sonarrApiKey);
      expect(child.stdout).not.toContain("sonarr.example.invalid");
    } finally {
      await child.forceCleanup().catch(() => undefined);
    }
  }, 30_000);
});
