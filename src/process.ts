import { createStdioRuntime, type StdioRuntime } from "./stdio.js";

export type ShutdownSignal = "SIGINT" | "SIGTERM";

export interface ProcessDependencies {
  createRuntime: () => StdioRuntime;
  addSignalListener: (signal: ShutdownSignal, listener: () => void) => void;
  removeSignalListener: (signal: ShutdownSignal, listener: () => void) => void;
  writeStderr: (message: string) => void;
  setExitCode: (code: number) => void;
}

const defaultDependencies: ProcessDependencies = {
  createRuntime: createStdioRuntime,
  addSignalListener: (signal, listener) => process.once(signal, listener),
  removeSignalListener: (signal, listener) => process.off(signal, listener),
  writeStderr: (message) => {
    process.stderr.write(message);
  },
  setExitCode: (code) => {
    process.exitCode = code;
  },
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runProcess(
  dependencies: ProcessDependencies = defaultDependencies,
): Promise<void> {
  const signals: readonly ShutdownSignal[] = ["SIGINT", "SIGTERM"];
  let runtime: StdioRuntime | undefined;
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
    runtime = dependencies.createRuntime();
    await runtime.start();
  } catch (error) {
    dependencies.writeStderr(`mcp-arr: startup failed: ${errorMessage(error)}\n`);
    dependencies.setExitCode(1);
    await shutdown();
  }
}
