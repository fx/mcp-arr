import { fileURLToPath } from "node:url";
import { deserializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import { type JSONRPCMessage, LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import { spawnStdioProcess, withDeadline } from "./support/spawned-stdio.js";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

function spawnNode(args: readonly string[]) {
  return spawnStdioProcess({
    executable: process.execPath,
    args,
    cwd: projectRoot,
    env: process.env,
  });
}

describe("built stdio process", () => {
  it("accepts immediate initialization, keeps stdout clean, and exits on SIGTERM", async () => {
    const child = spawnNode(["dist/cli.js"]);

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
      await child.send(initializeRequest);

      const response = await child.response(1);
      expect(response).toMatchObject({
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          serverInfo: { name: "mcp-arr", version: "0.1.0" },
        },
      });
      await expect(child.response("absent", 10)).rejects.toThrow(
        "Timed out waiting for response absent",
      );
      await expect(child.response("absent", 10)).rejects.toThrow(
        "Timed out waiting for response absent",
      );

      await child.send({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      });
      await expect(child.terminateGracefully()).resolves.toEqual({ code: 0, signal: null });
      const stdoutLines = child.stdout.split("\n");
      expect(stdoutLines).toHaveLength(2);
      expect(stdoutLines[1]).toBe("");
      expect(deserializeMessage(stdoutLines[0] ?? "")).toEqual(response);
      expect(child.stderr).toBe("");
    } finally {
      await child.forceCleanup().catch(() => undefined);
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
    const child = spawnNode(["--input-type=module", "--eval", script]);

    try {
      await expect(withDeadline(child.exit, "fatal startup exit")).resolves.toEqual({
        code: 1,
        signal: null,
      });
      await expect(withDeadline(child.closed, "fatal startup close")).resolves.toEqual({
        code: 1,
        signal: null,
      });
      expect(child.stdout).toBe("");
      expect(child.stderr).toBe("mcp-arr: startup failed: forced startup failure\n");
    } finally {
      await child.forceCleanup().catch(() => undefined);
    }
  });

  it("awaits close before exposing all buffered output", async () => {
    const payload = "buffered diagnostic\n".repeat(4_096);
    const child = spawnNode([
      "--input-type=module",
      "--eval",
      `process.stderr.write(${JSON.stringify(payload)});`,
    ]);

    try {
      await expect(child.exit).resolves.toEqual({ code: 0, signal: null });
      await expect(child.closed).resolves.toEqual({ code: 0, signal: null });
      expect(child.stderr).toBe(payload);
    } finally {
      await child.forceCleanup().catch(() => undefined);
    }
  });

  it("rejects write callback and stream errors without uncaught stdin failures", async () => {
    const notification: JSONRPCMessage = {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    };
    const callbackChild = spawnNode(["--input-type=module", "--eval", "process.stdin.resume()"]);
    const eventChild = spawnNode(["--input-type=module", "--eval", "process.stdin.resume()"]);

    try {
      const callbackError = new Error("forced write callback failure");
      vi.spyOn(callbackChild.child.stdin, "write").mockImplementationOnce(((...args: unknown[]) => {
        const callback = args.at(-1);
        if (typeof callback === "function") {
          queueMicrotask(() => callback(callbackError));
        }
        return false;
      }) as typeof callbackChild.child.stdin.write);
      await expect(callbackChild.send(notification)).rejects.toBe(callbackError);

      const streamError = new Error("forced stdin stream failure");
      expect(() => eventChild.child.stdin.emit("error", streamError)).not.toThrow();
      await expect(eventChild.send(notification)).rejects.toBe(streamError);
    } finally {
      await Promise.all(
        [callbackChild, eventChild].map((child) => child.forceCleanup().catch(() => undefined)),
      );
    }
  });

  it("rejects sends after stdin closes", async () => {
    const child = spawnNode(["--input-type=module", "--eval", "undefined"]);

    try {
      await child.closed;
      await expect(
        child.send({ jsonrpc: "2.0", method: "notifications/initialized" }),
      ).rejects.toThrow("Spawned process stdin is not writable");
    } finally {
      await child.forceCleanup().catch(() => undefined);
    }
  });
});
