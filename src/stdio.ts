import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createServer } from "./server.js";

export interface ConnectableServer {
  connect(transport: Transport): Promise<void>;
  close(): Promise<void>;
}

export interface StdioRuntime {
  start(): Promise<void>;
  close(): Promise<void>;
}

export interface StdioRuntimeDependencies {
  createServer: () => ConnectableServer;
  createTransport: () => Transport;
}

const defaultDependencies: StdioRuntimeDependencies = {
  createServer,
  createTransport: () => new StdioServerTransport(),
};

export function createStdioRuntime(
  dependencies: StdioRuntimeDependencies = defaultDependencies,
): StdioRuntime {
  const server = dependencies.createServer();
  const transport = dependencies.createTransport();
  let startPromise: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;
  let cleanupPromise: Promise<void> | undefined;

  const cleanup = (): Promise<void> => {
    cleanupPromise ??= server.close();
    return cleanupPromise;
  };

  return {
    start(): Promise<void> {
      if (closePromise !== undefined) {
        return Promise.reject(new Error("Cannot start a closed stdio runtime"));
      }

      startPromise ??= (async () => {
        try {
          await server.connect(transport);
        } catch (error) {
          await cleanup().catch(() => undefined);
          throw error;
        }
      })();

      return startPromise;
    },

    close(): Promise<void> {
      closePromise ??= (async () => {
        await startPromise?.catch(() => undefined);
        await cleanup();
      })();

      return closePromise;
    },
  };
}
