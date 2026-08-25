import { describe, expect, it, vi } from "vitest";
import { type ProcessDependencies, runProcess, type ShutdownSignal } from "../src/process.js";
import type { StdioRuntime } from "../src/stdio.js";

function createHarness(runtime: StdioRuntime): {
  dependencies: ProcessDependencies;
  listeners: Map<ShutdownSignal, () => void>;
  diagnostics: string[];
  exitCodes: number[];
} {
  const listeners = new Map<ShutdownSignal, () => void>();
  const diagnostics: string[] = [];
  const exitCodes: number[] = [];

  return {
    listeners,
    diagnostics,
    exitCodes,
    dependencies: {
      createRuntime: () => runtime,
      addSignalListener: (signal, listener) => {
        listeners.set(signal, listener);
      },
      removeSignalListener: (signal, listener) => {
        if (listeners.get(signal) === listener) {
          listeners.delete(signal);
        }
      },
      writeStderr: (message) => {
        diagnostics.push(message);
      },
      setExitCode: (code) => {
        exitCodes.push(code);
      },
    },
  };
}

function createRuntime(): StdioRuntime {
  return {
    start: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
}

describe("runProcess", () => {
  it("installs signal handlers before startup and shuts down only once", async () => {
    const order: string[] = [];
    const runtime = createRuntime();
    vi.mocked(runtime.start).mockImplementationOnce(async () => {
      order.push("start");
    });
    const harness = createHarness(runtime);
    const originalAddSignalListener = harness.dependencies.addSignalListener;
    harness.dependencies.addSignalListener = (signal, listener) => {
      order.push(signal);
      originalAddSignalListener(signal, listener);
    };

    await runProcess(harness.dependencies);

    expect(order).toEqual(["SIGINT", "SIGTERM", "start"]);
    const signalListener = harness.listeners.get("SIGTERM");
    expect(signalListener).toBeDefined();
    signalListener?.();
    signalListener?.();

    await vi.waitFor(() => expect(runtime.close).toHaveBeenCalledOnce());
    expect(harness.listeners.size).toBe(0);
    expect(harness.diagnostics).toEqual([]);
    expect(harness.exitCodes).toEqual([]);
  });

  it("reports fatal startup errors to stderr and cleans up", async () => {
    const runtime = createRuntime();
    vi.mocked(runtime.start).mockRejectedValueOnce(new Error("broken startup"));
    const harness = createHarness(runtime);

    await runProcess(harness.dependencies);

    expect(harness.diagnostics).toEqual(["mcp-arr: startup failed: broken startup\n"]);
    expect(harness.exitCodes).toEqual([1]);
    expect(runtime.close).toHaveBeenCalledOnce();
    expect(harness.listeners.size).toBe(0);
  });

  it("handles runtime construction failures without leaving signal handlers", async () => {
    const runtime = createRuntime();
    const harness = createHarness(runtime);
    harness.dependencies.createRuntime = () => {
      throw new Error("construction failed");
    };

    await runProcess(harness.dependencies);

    expect(harness.diagnostics).toEqual(["mcp-arr: startup failed: construction failed\n"]);
    expect(harness.exitCodes).toEqual([1]);
    expect(runtime.close).not.toHaveBeenCalled();
    expect(harness.listeners.size).toBe(0);
  });

  it("reports shutdown errors once and marks the process unsuccessful", async () => {
    const runtime = createRuntime();
    vi.mocked(runtime.close).mockRejectedValueOnce(new Error("broken shutdown"));
    const harness = createHarness(runtime);

    await runProcess(harness.dependencies);
    harness.listeners.get("SIGINT")?.();

    await vi.waitFor(() => {
      expect(harness.diagnostics).toEqual(["mcp-arr: shutdown failed: broken shutdown\n"]);
    });
    expect(harness.exitCodes).toEqual([1]);
    expect(runtime.close).toHaveBeenCalledOnce();
  });
});
