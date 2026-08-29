import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deserializeMessage, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import { type JSONRPCMessage, LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import { isCleanTermination } from "../scripts/platform-command.mjs";
import {
  configurationVariables,
  serverEnvironment,
  spawnStdioProcess,
  withDeadline,
} from "./support/spawned-stdio.js";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
/**
 * Read here rather than through the server's own manifest helper: the built
 * process has to agree with what the package declares, and sharing the helper
 * would let both sides be wrong together.
 */
const manifestVersion = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;
const sonarrApiKey = "sonarr-secret-key";

function without(env: NodeJS.ProcessEnv, names: readonly string[]): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !names.includes(name)));
}

/** The environment this suite spawns the built server with. */
const configuredEnvironment: NodeJS.ProcessEnv = serverEnvironment({
  SONARR_URL: "https://sonarr.example.invalid/sonarr",
  SONARR_API_KEY: sonarrApiKey,
});

function environmentWithout(...names: readonly string[]): NodeJS.ProcessEnv {
  return without(configuredEnvironment, names);
}

function spawnNode(args: readonly string[], env: NodeJS.ProcessEnv = configuredEnvironment) {
  return spawnStdioProcess({
    executable: process.execPath,
    args,
    cwd: projectRoot,
    env,
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
          serverInfo: { name: "mcp-arr", version: manifestVersion },
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
      const termination = await child.terminateGracefully();
      expect(isCleanTermination(termination)).toBe(true);
      await expect(child.exit).resolves.toEqual(termination);
      await expect(child.closed).resolves.toEqual(termination);
      const stdoutLines = child.stdout.split("\n");
      expect(stdoutLines).toHaveLength(2);
      expect(stdoutLines[1]).toBe("");
      expect(deserializeMessage(stdoutLines[0] ?? "")).toEqual(response);
      expect(child.stderr).toBe("");
    } finally {
      await child.forceCleanup().catch(() => undefined);
    }
  });

  it("rejects an unconfigured environment before opening a session", async () => {
    const child = spawnNode(["dist/cli.js"], environmentWithout(...configurationVariables));

    try {
      await expect(withDeadline(child.exit, "unconfigured exit")).resolves.toEqual({
        code: 1,
        signal: null,
      });
      await expect(withDeadline(child.closed, "unconfigured close")).resolves.toEqual({
        code: 1,
        signal: null,
      });
      expect(child.stdout).toBe("");
      expect(child.stderr).toContain("mcp-arr: startup failed: invalid environment configuration:");
      expect(child.stderr).toContain("no application is configured");
      expect(child.stderr).toContain("SONARR_URL");
    } finally {
      await child.forceCleanup().catch(() => undefined);
    }
  });

  it("rejects an incomplete pair without echoing any configured value", async () => {
    const child = spawnNode(["dist/cli.js"], environmentWithout("SONARR_API_KEY"));

    try {
      await expect(withDeadline(child.exit, "incomplete pair exit")).resolves.toEqual({
        code: 1,
        signal: null,
      });
      expect(child.stdout).toBe("");
      expect(child.stderr).toBe(
        "mcp-arr: startup failed: invalid environment configuration: " +
          "SONARR_API_KEY is required when SONARR_URL is set\n",
      );
      expect(child.stderr).not.toContain(sonarrApiKey);
      expect(child.stderr).not.toContain("sonarr.example.invalid");
    } finally {
      await child.forceCleanup().catch(() => undefined);
    }
  });

  it("rejects an unusable upstream timeout without echoing the configured value", async () => {
    const child = spawnNode(["dist/cli.js"], {
      ...configuredEnvironment,
      ARR_UPSTREAM_TIMEOUT_MS: "abc",
    });

    try {
      await expect(withDeadline(child.exit, "invalid timeout exit")).resolves.toEqual({
        code: 1,
        signal: null,
      });
      expect(child.stdout).toBe("");
      expect(child.stderr).toBe(
        "mcp-arr: startup failed: invalid environment configuration: " +
          "ARR_UPSTREAM_TIMEOUT_MS must be a whole number of milliseconds between 1 and 600000\n",
      );
      expect(child.stderr).not.toContain("abc");
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
        // Kept in step with EnvironmentConfiguration by hand: this literal is
        // inside a template string, so tsc does not type-check it.
        loadConfiguration: () => ({ instances: [], upstreamTimeoutMs: 30_000 }),
        createRuntime: () => ({
          registry: { adapters: [], adapter: () => undefined, probe: async () => [] },
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

  it("keeps response waiters valid after exit until stdout closes", async () => {
    const beforeExit: JSONRPCMessage = { jsonrpc: "2.0", id: 99, result: { phase: "before" } };
    const afterExit: JSONRPCMessage = { jsonrpc: "2.0", id: 100, result: { phase: "after" } };
    const framedResponses = serializeMessage(beforeExit) + serializeMessage(afterExit);
    const script = `
      process.stdin.once("data", () => {
        process.stdout.write(${JSON.stringify(framedResponses)});
        process.stdin.unref();
      });
    `;
    const child = spawnNode(["--input-type=module", "--eval", script]);
    child.child.stdout.pause();

    try {
      const pendingBeforeExit = child.response(99);
      const pendingAfterExit = new Promise<JSONRPCMessage>((resolve, reject) => {
        child.child.once("exit", () => {
          child.response(100).then(resolve, reject);
          child.child.stdout.resume();
        });
      });
      await child.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      await expect(child.exit).resolves.toEqual({ code: 0, signal: null });

      await expect(pendingBeforeExit).resolves.toEqual(beforeExit);
      await expect(pendingAfterExit).resolves.toEqual(afterExit);
      await expect(child.closed).resolves.toEqual({ code: 0, signal: null });
    } finally {
      child.child.stdout.resume();
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

  it("times out stalled stdin writes and cleans their pending state", async () => {
    const notification: JSONRPCMessage = {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    };
    const child = spawnNode(["--input-type=module", "--eval", "process.stdin.resume()"]);

    try {
      let completeWrite: ((error?: Error | null) => void) | undefined;
      const write = vi.spyOn(child.child.stdin, "write").mockImplementationOnce(((
        ...args: unknown[]
      ) => {
        const callback = args.at(-1);
        if (typeof callback === "function") {
          completeWrite = callback as (error?: Error | null) => void;
        }
        return false;
      }) as typeof child.child.stdin.write);

      await expect(child.send(notification, 10)).rejects.toThrow(
        "Timed out waiting for spawned process stdin write",
      );
      completeWrite?.();
      write.mockRestore();
      await expect(child.send(notification)).resolves.toBeUndefined();
    } finally {
      await child.forceCleanup().catch(() => undefined);
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
