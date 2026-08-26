import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { type AdapterRegistry, createAdapterRegistry } from "./adapters/registry.js";
import type { EnvironmentConfiguration } from "./config/environment.js";
import { createServer } from "./server.js";
import { createWorkflowState, type WorkflowState } from "./state/workflow.js";
import type { ToolContext } from "./tools/dispatch.js";
import { createOperationRegistry } from "./tools/operations.js";

export interface ConnectableServer {
  connect(transport: Transport): Promise<void>;
  close(): Promise<void>;
}

export interface StdioRuntime {
  /** Version-aware adapters for the configured applications. */
  readonly registry: AdapterRegistry;
  start(): Promise<void>;
  close(): Promise<void>;
}

export interface StdioRuntimeDependencies {
  createServer: (context: ToolContext) => ConnectableServer;
  createTransport: () => Transport;
  createRegistry: (configuration: EnvironmentConfiguration) => AdapterRegistry;
  createOperations: () => ToolContext["operations"];
  /**
   * Built once per runtime, which is what makes every reference, plan, receipt,
   * and job projection last exactly one process lifetime and no longer.
   */
  createState: () => WorkflowState;
}

const defaultDependencies: StdioRuntimeDependencies = {
  createServer,
  createTransport: () => new StdioServerTransport(),
  createRegistry: (configuration) => createAdapterRegistry(configuration),
  createOperations: () => createOperationRegistry(),
  createState: () => createWorkflowState(),
};

export function createStdioRuntime(
  configuration: EnvironmentConfiguration,
  dependencies: StdioRuntimeDependencies = defaultDependencies,
): StdioRuntime {
  const registry = dependencies.createRegistry(configuration);
  const server = dependencies.createServer({
    registry,
    operations: dependencies.createOperations(),
    state: dependencies.createState(),
  });
  const transport = dependencies.createTransport();
  let startPromise: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;
  let cleanupPromise: Promise<void> | undefined;

  const cleanup = (): Promise<void> => {
    cleanupPromise ??= server.close();
    return cleanupPromise;
  };

  return {
    registry,

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
