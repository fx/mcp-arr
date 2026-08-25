import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  deserializeMessage,
  ReadBuffer,
  serializeMessage,
} from "@modelcontextprotocol/sdk/shared/stdio.js";
import { type JSONRPCMessage, LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

function withDeadline<T>(promise: Promise<T>, label: string, timeoutMs = 2_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

describe("built stdio process", () => {
  it("accepts immediate initialization, keeps stdout clean, and exits on SIGTERM", async () => {
    const child = spawn(process.execPath, ["dist/cli.js"], {
      cwd: projectRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const readBuffer = new ReadBuffer();
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
      },
    );

    let resolveInitialize: ((message: JSONRPCMessage) => void) | undefined;
    let rejectInitialize: ((error: unknown) => void) | undefined;
    const initializeResponse = new Promise<JSONRPCMessage>((resolve, reject) => {
      resolveInitialize = resolve;
      rejectInitialize = reject;
    });

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
      try {
        readBuffer.append(chunk);
        for (
          let message = readBuffer.readMessage();
          message !== null;
          message = readBuffer.readMessage()
        ) {
          if ("id" in message && message.id === 1) {
            resolveInitialize?.(message);
          }
        }
      } catch (error) {
        rejectInitialize?.(error);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    try {
      const initializeRequest: JSONRPCMessage = {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "stdio-integration-test", version: "1.0.0" },
        },
      };
      child.stdin.write(serializeMessage(initializeRequest));

      const response = await withDeadline(initializeResponse, "initialize response");
      expect(response).toMatchObject({
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          serverInfo: { name: "mcp-arr", version: "0.1.0" },
        },
      });

      child.stdin.write(
        serializeMessage({
          jsonrpc: "2.0",
          method: "notifications/initialized",
        }),
      );
      expect(child.kill("SIGTERM")).toBe(true);

      const exit = await withDeadline(exitPromise, "graceful process exit");
      expect(exit).toEqual({ code: 0, signal: null });
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stdoutLines = stdout.split("\n");
      expect(stdoutLines).toHaveLength(2);
      expect(stdoutLines[1]).toBe("");
      expect(deserializeMessage(stdoutLines[0] ?? "")).toEqual(response);
      expect(Buffer.concat(stderrChunks).toString("utf8")).toBe("");
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await withDeadline(exitPromise, "process cleanup").catch(() => undefined);
    }
  });

  it("exits after a fatal startup failure while stdin remains open", async () => {
    const processModuleUrl = new URL("../dist/process.js", import.meta.url).href;
    const script = `
      import { runProcess } from ${JSON.stringify(processModuleUrl)};
      process.stdin.ref();
      await runProcess({
        createRuntime: () => ({
          start: async () => { throw new Error("forced startup failure"); },
          close: async () => undefined,
        }),
        addSignalListener: (signal, listener) => process.once(signal, listener),
        removeSignalListener: (signal, listener) => process.off(signal, listener),
        writeStderr: (message) => process.stderr.write(message),
        setExitCode: (code) => { process.exitCode = code; },
        unrefStdin: () => process.stdin.unref(),
      });
    `;
    const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: projectRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
      },
    );

    try {
      await expect(withDeadline(exitPromise, "fatal startup exit")).resolves.toEqual({
        code: 1,
        signal: null,
      });
      expect(Buffer.concat(stdoutChunks).toString("utf8")).toBe("");
      expect(Buffer.concat(stderrChunks).toString("utf8")).toBe(
        "mcp-arr: startup failed: forced startup failure\n",
      );
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await withDeadline(exitPromise, "fatal startup process cleanup").catch(() => undefined);
    }
  });
});
