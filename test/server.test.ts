import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolsetSelection } from "../src/config/environment.js";
import { createServer } from "../src/server.js";
import { publishedMediaToolNames, toolNames } from "../src/tools/names.js";
import { createMediaInstances } from "./support/media.js";
import { arrToolset, createTestToolContext } from "./support/tool-context.js";

/**
 * Read straight from the manifest rather than through the server's own helper.
 * Sharing the helper would let both sides agree on a wrong version, which is
 * exactly the drift this asserts against.
 */
const manifestVersion = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

const closeables: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(closeables.splice(0).map((closeable) => closeable.close()));
});

describe("createServer", () => {
  it("returns a fresh server with stable identity and the tool capability", async () => {
    const context = createTestToolContext();
    const first = createServer(context, arrToolset);
    const second = createServer(context, arrToolset);
    expect(first).not.toBe(second);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "server-factory-test", version: "1.0.0" });
    closeables.push(client, first, second);

    await first.connect(serverTransport);
    await client.connect(clientTransport);

    expect(client.getServerVersion()).toEqual({ name: "mcp-arr", version: manifestVersion });
    expect(client.getServerCapabilities()).toEqual({ tools: { listChanged: true } });
  });

  it("advertises the published package version rather than a frozen literal", async () => {
    expect(manifestVersion).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u);

    const first = createServer(createTestToolContext(), arrToolset);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "server-version-test", version: "1.0.0" });
    closeables.push(client, first);

    await first.connect(serverTransport);
    await client.connect(clientTransport);

    expect(client.getServerVersion()?.version).toBe(manifestVersion);
  });

  it("registers only the selected toolsets, arr before media", async () => {
    const listed = async (names: ToolsetSelection["names"]) => {
      const server = createServer(createTestToolContext(), {
        names,
        ...(names.includes("media") ? { media: { movie: {}, series: {} } } : {}),
      });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "server-toolset-test", version: "1.0.0" });
      closeables.push(client, server);
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      return (await client.listTools()).tools.map((tool) => tool.name);
    };

    expect(await listed(["arr"])).toEqual([...toolNames]);
    expect(await listed(["media"])).toEqual([...publishedMediaToolNames(false)]);
    expect(await listed(["arr", "media"])).toEqual([
      ...toolNames,
      ...publishedMediaToolNames(false),
    ]);
  });

  it("returns media results a client accepts against the published output schemas", async () => {
    const instances = await createMediaInstances();
    const server = createServer(createTestToolContext({ fetch: instances.fetch }), {
      names: ["media"],
      media: { movie: { qualityProfile: "Example Bluray" }, series: {} },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "server-media-test", version: "1.0.0" });
    closeables.push(client, server);
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    // The client caches each tool's output schema from the listing and
    // validates every structured result against it.
    await client.listTools();

    const found = await client.callTool({ name: "media_find", arguments: { text: "Example" } });
    expect(found.isError).toBe(false);
    const added = await client.callTool({
      name: "media_add",
      arguments: { kind: "movie", id: 200004 },
    });
    expect(added.structuredContent).toMatchObject({ outcome: "added" });
    const failed = await client.callTool({
      name: "media_add",
      arguments: { kind: "series", id: 100004 },
    });
    expect(failed.isError).toBe(true);
    expect(failed.structuredContent).toMatchObject({
      errors: [{ code: "deployment_configuration" }, { code: "deployment_configuration" }],
    });
  });
});
