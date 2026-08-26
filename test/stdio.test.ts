import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { describe, expect, it, vi } from "vitest";
import type { AdapterRegistry } from "../src/adapters/registry.js";
import { type EnvironmentConfiguration, parseEnvironment } from "../src/config/environment.js";
import {
  type ConnectableServer,
  createStdioRuntime,
  type StdioRuntimeDependencies,
} from "../src/stdio.js";

const configuration = parseEnvironment({
  SONARR_URL: "https://sonarr.example.invalid/sonarr",
  SONARR_API_KEY: "sonarr-secret-key",
});

function createDependencies(): {
  dependencies: StdioRuntimeDependencies;
  server: ConnectableServer;
  transport: Transport;
  registry: AdapterRegistry;
  registered: EnvironmentConfiguration[];
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
  const registry: AdapterRegistry = {
    adapters: [],
    adapter: () => undefined,
    probe: async () => [],
  };
  const registered: EnvironmentConfiguration[] = [];

  return {
    dependencies: {
      createServer: () => server,
      createTransport: () => transport,
      createRegistry: (received) => {
        registered.push(received);
        return registry;
      },
    },
    server,
    transport,
    registry,
    registered,
  };
}

describe("createStdioRuntime", () => {
  it("builds the adapter registry once from the supplied configuration", () => {
    const { dependencies, registry, registered } = createDependencies();
    const runtime = createStdioRuntime(configuration, dependencies);

    expect(runtime.registry).toBe(registry);
    expect(registered).toEqual([configuration]);
  });

  it("wires real adapters for the configured applications by default", () => {
    const runtime = createStdioRuntime(
      parseEnvironment({
        SONARR_URL: "https://sonarr.example.invalid/sonarr",
        SONARR_API_KEY: "sonarr-secret-key",
        PROWLARR_URL: "https://prowlarr.example.invalid",
        PROWLARR_API_KEY: "prowlarr-secret-key",
      }),
    );

    expect(runtime.registry.adapters.map((adapter) => adapter.application)).toEqual([
      "sonarr",
      "prowlarr",
    ]);
    expect(runtime.registry.adapter("sonarr")?.client.apiBaseUrl).toBe(
      "https://sonarr.example.invalid/sonarr/api/v3",
    );
    expect(runtime.registry.adapter("prowlarr")?.client.apiBaseUrl).toBe(
      "https://prowlarr.example.invalid/api/v1",
    );
    expect(runtime.registry.adapter("radarr")).toBeUndefined();
  });

  it("connects exactly once when started repeatedly", async () => {
    const { dependencies, server, transport } = createDependencies();
    const runtime = createStdioRuntime(configuration, dependencies);

    const firstStart = runtime.start();
    expect(runtime.start()).toBe(firstStart);
    await firstStart;

    expect(server.connect).toHaveBeenCalledOnce();
    expect(server.connect).toHaveBeenCalledWith(transport);
  });

  it("closes exactly once and cannot be restarted", async () => {
    const { dependencies, server } = createDependencies();
    const runtime = createStdioRuntime(configuration, dependencies);
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
    const runtime = createStdioRuntime(configuration, dependencies);

    await expect(runtime.start()).rejects.toBe(startupError);
    expect(server.close).toHaveBeenCalledOnce();
    await expect(runtime.close()).resolves.toBeUndefined();
    expect(server.close).toHaveBeenCalledOnce();
  });

  it("propagates a server cleanup failure without retrying it", async () => {
    const { dependencies, server } = createDependencies();
    const closeError = new Error("server close failed");
    vi.mocked(server.close).mockRejectedValueOnce(closeError);
    const runtime = createStdioRuntime(configuration, dependencies);

    const firstClose = runtime.close();
    expect(runtime.close()).toBe(firstClose);
    await expect(firstClose).rejects.toBe(closeError);
    expect(server.close).toHaveBeenCalledOnce();
  });
});
