import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ApplicationId } from "../src/applications.js";
import { createServer } from "../src/server.js";
import type { ToolContext } from "../src/tools/dispatch.js";
import { toolNames } from "../src/tools/names.js";
import type { VersionedFixture } from "./support/fixtures.js";
import {
  allApplicationsEnvironment,
  applicationForUrl,
  createTestToolContext,
  jsonResponse,
  loadStatusFixtures,
  sampleToolInputs,
  testApiKeys,
} from "./support/tool-context.js";

const closeables: Array<{ close(): Promise<void> }> = [];
let statusFixtures: ReadonlyMap<ApplicationId, VersionedFixture<Record<string, unknown>>>;

beforeAll(async () => {
  statusFixtures = await loadStatusFixtures();
});

afterEach(async () => {
  await Promise.all(closeables.splice(0).map((closeable) => closeable.close()));
});

function fixtureBody(application: ApplicationId): Record<string, unknown> {
  const fixture = statusFixtures.get(application);
  if (fixture === undefined) {
    throw new Error(`Missing loaded fixture for ${application}`);
  }
  return fixture.body;
}

async function connect(context: ToolContext): Promise<Client> {
  const server = createServer(context);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "tool-protocol-test", version: "1.0.0" });
  closeables.push(client, server);

  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

function fixtureContext(): ToolContext {
  return createTestToolContext({
    environment: allApplicationsEnvironment,
    fetch: async (url) => jsonResponse(fixtureBody(applicationForUrl(url))),
  });
}

function structured(result: CallToolResult): Record<string, unknown> {
  const content = result.structuredContent;
  if (content === undefined) {
    throw new Error("Expected structured content");
  }
  return content as Record<string, unknown>;
}

describe("tool protocol surface", () => {
  it("lists exactly the fifteen tools with closed input and declared output schemas", async () => {
    const client = await connect(fixtureContext());
    const { tools } = await client.listTools();

    expect(tools.map((tool: Tool) => tool.name)).toEqual([...toolNames]);
    for (const tool of tools) {
      expect(tool.inputSchema.type, tool.name).toBe("object");
      expect(tool.description, tool.name).toBeTruthy();
      expect(tool.outputSchema, tool.name).toBeDefined();
      expect(tool.outputSchema?.type, tool.name).toBe("object");
      expect(tool.annotations, tool.name).toBeDefined();
      expect(typeof tool.annotations?.readOnlyHint, tool.name).toBe("boolean");
    }
  });

  it("annotates read tools as read-only and destructive tools honestly", async () => {
    const client = await connect(fixtureContext());
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((tool: Tool) => [tool.name, tool]));

    expect(byName.get("arr_library_query")?.annotations).toMatchObject({
      readOnlyHint: true,
      idempotentHint: true,
    });
    expect(byName.get("arr_library_change")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    });
    expect(byName.get("arr_release_search")?.annotations).toMatchObject({
      readOnlyHint: true,
      openWorldHint: true,
    });
    expect(byName.get("arr_activity_change")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
    });
  });

  it("returns validated structured content and a text summary for arr_capabilities", async () => {
    const client = await connect(fixtureContext());
    // listTools caches the published output schema, so callTool validates the
    // structured content against exactly what a host would have received.
    await client.listTools();

    const result = (await client.callTool({
      name: "arr_capabilities",
      arguments: {},
    })) as CallToolResult;

    expect(result.isError).toBe(false);
    const content = structured(result);
    expect(content.status).toBe("ok");
    expect(
      (content.applications as Array<{ application: string; data: { state: string } }>).map(
        (outcome) => [outcome.application, outcome.data.state],
      ),
    ).toEqual([
      ["sonarr", "available"],
      ["radarr", "available"],
      ["prowlarr", "available"],
    ]);
    expect(result.content?.[0]).toMatchObject({ type: "text" });
  });

  it("returns an unsupported_capability error without contacting any instance", async () => {
    const requested: string[] = [];
    const client = await connect(
      createTestToolContext({
        environment: allApplicationsEnvironment,
        fetch: async (url) => {
          requested.push(url);
          return jsonResponse(fixtureBody(applicationForUrl(url)));
        },
      }),
    );
    await client.listTools();

    const result = (await client.callTool({
      name: "arr_library_query",
      arguments: { view: "movies", applications: ["sonarr", "prowlarr"] },
    })) as CallToolResult;

    expect(requested).toEqual([]);
    expect(result.isError).toBe(true);
    const content = structured(result);
    expect(content.status).toBe("error");
    const outcomes = content.applications as Array<{
      application: string;
      status: string;
      error: { code: string; remediation: string };
    }>;
    expect(outcomes.map((outcome) => [outcome.application, outcome.error.code])).toEqual([
      ["sonarr", "unsupported_capability"],
      ["prowlarr", "unsupported_capability"],
    ]);
    expect(outcomes[0]?.error.remediation.length).toBeGreaterThan(0);

    // A host commonly surfaces only the text when a call reports failure, so
    // the code and the remediation have to survive into it rather than being
    // computed, attached, and never seen.
    expect(result.content?.[0]).toEqual({
      type: "text",
      text: "arr_library_query: error; sonarr unsupported, prowlarr unsupported; errors: unsupported_capability (Call arr_capabilities to list the operations this instance supports.)",
    });
  });

  it("reports an unconfigured application without requiring placeholder credentials", async () => {
    const client = await connect(
      createTestToolContext({
        environment: {
          SONARR_URL: "https://sonarr.example.invalid/sonarr",
          SONARR_API_KEY: testApiKeys.sonarr,
        },
        fetch: async () => jsonResponse(fixtureBody("sonarr")),
      }),
    );
    await client.listTools();

    const result = (await client.callTool({
      name: "arr_library_query",
      arguments: { view: "movies" },
    })) as CallToolResult;

    const outcomes = structured(result).applications as Array<{
      application: string;
      status: string;
      error: { code: string };
    }>;
    expect(outcomes).toEqual([
      expect.objectContaining({ application: "radarr", status: "unconfigured" }),
    ]);
    expect(outcomes[0]?.error.code).toBe("unconfigured_application");
  });

  it("rejects an unknown property and an undeclared variant before dispatching", async () => {
    const requested: string[] = [];
    const client = await connect(
      createTestToolContext({
        environment: allApplicationsEnvironment,
        fetch: async (url) => {
          requested.push(url);
          return jsonResponse(fixtureBody(applicationForUrl(url)));
        },
      }),
    );

    const unknownProperty = (await client.callTool({
      name: "arr_library_query",
      arguments: { view: "series", unexpectedProperty: true },
    })) as CallToolResult;
    expect(unknownProperty.isError).toBe(true);
    expect(JSON.stringify(unknownProperty.content)).toContain("Input validation error");

    const undeclaredVariant = (await client.callTool({
      name: "arr_library_query",
      arguments: { view: "everything" },
    })) as CallToolResult;
    expect(undeclaredVariant.isError).toBe(true);

    expect(requested).toEqual([]);
  });

  it("rejects a plan reference this process never issued without sending anything", async () => {
    const requested: string[] = [];
    const client = await connect(
      createTestToolContext({
        environment: allApplicationsEnvironment,
        fetch: async (url) => {
          requested.push(url);
          return jsonResponse(fixtureBody(applicationForUrl(url)));
        },
      }),
    );
    await client.listTools();

    const result = (await client.callTool({
      name: "arr_library_change",
      arguments: { mode: "apply", plan: "pln_00000001" },
    })) as CallToolResult;

    expect(requested).toEqual([]);
    expect(result.isError).toBe(true);
    const content = structured(result);
    expect(content.status).toBe("error");
    expect(content.applications).toEqual([]);
    expect((content.errors as Array<{ code: string }>).map((error) => error.code)).toEqual([
      "stale_plan",
    ]);
  });

  it("accepts every published tool's minimal arguments and answers with its own envelope", async () => {
    const client = await connect(fixtureContext());
    await client.listTools();

    for (const name of toolNames) {
      const result = (await client.callTool({
        name,
        arguments: sampleToolInputs[name],
      })) as CallToolResult;

      const content = structured(result);
      expect(["ok", "partial", "error"], name).toContain(content.status);
      expect(Array.isArray(content.applications), name).toBe(true);
      expect(JSON.stringify(result), name).not.toContain(testApiKeys.sonarr);
    }
  });
});
