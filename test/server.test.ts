import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import { createTestToolContext } from "./support/tool-context.js";

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
    const first = createServer(context);
    const second = createServer(context);
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

    const first = createServer(createTestToolContext());
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "server-version-test", version: "1.0.0" });
    closeables.push(client, first);

    await first.connect(serverTransport);
    await client.connect(clientTransport);

    expect(client.getServerVersion()?.version).toBe(manifestVersion);
  });
});
