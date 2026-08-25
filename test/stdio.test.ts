import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { describe, expect, it, vi } from "vitest";
import {
  type ConnectableServer,
  createStdioRuntime,
  type StdioRuntimeDependencies,
} from "../src/stdio.js";

function createDependencies(): {
  dependencies: StdioRuntimeDependencies;
  server: ConnectableServer;
  transport: Transport;
} {
  const transport: Transport = {
    start: vi.fn(async () => undefined),
    send: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  const server: ConnectableServer = {
    connect: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };

  return {
    dependencies: {
      createServer: () => server,
      createTransport: () => transport,
    },
    server,
    transport,
  };
}

describe("createStdioRuntime", () => {
  it("connects exactly once when started repeatedly", async () => {
    const { dependencies, server, transport } = createDependencies();
    const runtime = createStdioRuntime(dependencies);

    const firstStart = runtime.start();
    expect(runtime.start()).toBe(firstStart);
    await firstStart;

    expect(server.connect).toHaveBeenCalledOnce();
    expect(server.connect).toHaveBeenCalledWith(transport);
  });

  it("closes exactly once and cannot be restarted", async () => {
    const { dependencies, server } = createDependencies();
    const runtime = createStdioRuntime(dependencies);
    await runtime.start();

    const firstClose = runtime.close();
    expect(runtime.close()).toBe(firstClose);
    await firstClose;

    expect(server.close).toHaveBeenCalledOnce();
    await expect(runtime.start()).rejects.toThrow("Cannot start a closed stdio runtime");
  });

  it("cleans up a partially connected server without replacing the startup error", async () => {
    const { dependencies, server } = createDependencies();
    const startupError = new Error("connect failed");
    vi.mocked(server.connect).mockRejectedValueOnce(startupError);
    const runtime = createStdioRuntime(dependencies);

    await expect(runtime.start()).rejects.toBe(startupError);
    expect(server.close).toHaveBeenCalledOnce();
    await expect(runtime.close()).resolves.toBeUndefined();
    expect(server.close).toHaveBeenCalledOnce();
  });

  it("falls back to closing the transport when server cleanup fails", async () => {
    const { dependencies, server, transport } = createDependencies();
    const closeError = new Error("server close failed");
    vi.mocked(server.close).mockRejectedValueOnce(closeError);
    const runtime = createStdioRuntime(dependencies);

    await expect(runtime.close()).rejects.toBe(closeError);
    expect(transport.close).toHaveBeenCalledOnce();
  });
});
