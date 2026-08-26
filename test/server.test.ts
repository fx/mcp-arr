import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import { createTestToolContext } from "./support/tool-context.js";

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

    expect(client.getServerVersion()).toEqual({ name: "mcp-arr", version: "0.1.0" });
    expect(client.getServerCapabilities()).toEqual({ tools: { listChanged: true } });
  });
});
