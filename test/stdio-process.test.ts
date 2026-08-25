import { fileURLToPath } from "node:url";
import { deserializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import { type JSONRPCMessage, LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
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
      child.send(initializeRequest);

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

      child.send({
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
      expect(child.stdout).toBe("");
      expect(child.stderr).toBe("mcp-arr: startup failed: forced startup failure\n");
    } finally {
      await child.forceCleanup().catch(() => undefined);
    }
  });
});
