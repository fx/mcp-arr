import type { AdapterRegistry } from "./adapters/registry.js";
import { type EnvironmentConfiguration, loadEnvironment } from "./config/environment.js";
import { createHttpRuntime, type HttpEnvironmentConfiguration } from "./http-transport.js";
import { unrefStdin } from "./stdin.js";
import { createStdioRuntime } from "./stdio.js";

export type ShutdownSignal = "SIGINT" | "SIGTERM";

/**
 * One transport's server, whichever transport the process selected. The
 * process starts it once and closes it once; what it serves in between is the
 * transport's own business.
 */
export interface Runtime {
  /** Version-aware adapters for the configured applications. */
  readonly registry: AdapterRegistry;
  start(): Promise<void>;
  close(): Promise<void>;
}

export interface RuntimeFactories {
  stdio: (configuration: EnvironmentConfiguration) => Runtime;
  http: (configuration: HttpEnvironmentConfiguration) => Runtime;
}

const defaultRuntimeFactories: RuntimeFactories = {
  stdio: (configuration) => createStdioRuntime(configuration),
  http: (configuration) => createHttpRuntime(configuration),
};

/** Builds the runtime for the transport the configuration selected, and only that one. */
export function selectRuntime(
  configuration: EnvironmentConfiguration,
  factories: RuntimeFactories = defaultRuntimeFactories,
): Runtime {
  const { transport } = configuration;
  return transport.kind === "http"
    ? factories.http({ ...configuration, transport })
    : factories.stdio(configuration);
}

export interface ProcessDependencies {
  loadConfiguration: () => EnvironmentConfiguration;
  createRuntime: (configuration: EnvironmentConfiguration) => Runtime;
  addSignalListener: (signal: ShutdownSignal, listener: () => void) => void;
  removeSignalListener: (signal: ShutdownSignal, listener: () => void) => void;
  writeStderr: (message: string) => void;
  setExitCode: (code: number) => void;
  unrefStdin: () => void;
}

const defaultDependencies: ProcessDependencies = {
  loadConfiguration: () => loadEnvironment(),
  createRuntime: (configuration) => selectRuntime(configuration),
  addSignalListener: (signal, listener) => process.once(signal, listener),
  removeSignalListener: (signal, listener) => process.off(signal, listener),
  writeStderr: (message) => {
    process.stderr.write(message);
  },
  setExitCode: (code) => {
    process.exitCode = code;
  },
  unrefStdin,
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runProcess(
  dependencies: ProcessDependencies = defaultDependencies,
): Promise<void> {
  const signals: readonly ShutdownSignal[] = ["SIGINT", "SIGTERM"];
  let runtime: Runtime | undefined;
  let shutdownPromise: Promise<void> | undefined;

  const removeSignalListeners = (): void => {
    for (const signal of signals) {
      dependencies.removeSignalListener(signal, onSignal);
    }
  };

  const shutdown = (): Promise<void> => {
    shutdownPromise ??= (async () => {
      removeSignalListeners();
      try {
        await runtime?.close();
      } catch (error) {
        dependencies.writeStderr(`mcp-arr: shutdown failed: ${errorMessage(error)}\n`);
        dependencies.setExitCode(1);
      }
    })();

    return shutdownPromise;
  };

  function onSignal(): void {
    void shutdown();
  }

  for (const signal of signals) {
    dependencies.addSignalListener(signal, onSignal);
  }

  try {
    runtime = dependencies.createRuntime(dependencies.loadConfiguration());
    await runtime.start();
  } catch (error) {
    dependencies.writeStderr(`mcp-arr: startup failed: ${errorMessage(error)}\n`);
    dependencies.setExitCode(1);
    try {
      await shutdown();
    } finally {
      dependencies.unrefStdin();
    }
  }
}
