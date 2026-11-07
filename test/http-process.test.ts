import { spawn } from "node:child_process";
import {
  createServer as createPlainServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server,
} from "node:http";
import { type AddressInfo, createServer as createNetServer } from "node:net";
import { fileURLToPath } from "node:url";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { type ObservedChildProcess, observeChildProcess } from "../scripts/child-process.mjs";
import { isCleanTermination } from "../scripts/platform-command.mjs";
import { publishedMediaToolNames, toolNames } from "../src/tools/names.js";
import { instanceEnvironment, startFixtureInstance } from "./support/instance-server.js";
import { serverEnvironment, withDeadline } from "./support/spawned-stdio.js";
import { startStagedUpstream } from "./support/staged-upstream.js";

/**
 * The built server in HTTP mode, launched the way a container launches it:
 * the packaged entry point, a command environment, and no stdin at all.
 */

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const token = "0123456789abcdef".repeat(4);

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

/** A port that was free a moment ago: bound, read, and released. */
async function freePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

interface SpawnedHttpServer {
  readonly observed: ObservedChildProcess;
  readonly port: number;
  kill(signal: NodeJS.Signals): boolean;
  /** Resolves once the startup line is on stderr, or rejects if the process exits first. */
  readonly listening: Promise<void>;
}

function spawnHttpServer(environment: Readonly<Record<string, string>>, port: number) {
  let announce: () => void = () => undefined;
  const announced = new Promise<void>((resolve) => {
    announce = resolve;
  });
  let stderr = "";
  const child = spawn(process.execPath, ["dist/cli.js"], {
    cwd: projectRoot,
    env: serverEnvironment({
      ...environment,
      ARR_MCP_TRANSPORT: "http",
      ARR_MCP_HTTP_PORT: String(port),
      ARR_MCP_AUTH_TOKEN: token,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const observed = observeChildProcess(child, {
    onStderrChunk: (chunk) => {
      stderr += chunk.toString("utf8");
      if (stderr.includes("\n")) {
        announce();
      }
    },
  });
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    await withDeadline(observed.closed, "spawned HTTP server cleanup", 5_000).catch(
      () => undefined,
    );
  });
  const exitedEarly = observed.exit.then(({ code, signal }) => {
    throw new Error(
      `The server exited before listening (code=${String(code)}, signal=${String(signal)}): ${observed.stderr}`,
    );
  });
  return {
    observed,
    port,
    kill: (signal: NodeJS.Signals) => child.kill(signal),
    listening: withDeadline(Promise.race([announced, exitedEarly]), "the startup line", 5_000),
  } satisfies SpawnedHttpServer;
}

interface Exchange {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

function post(port: number, body: string, authorization = `Bearer ${token}`): Promise<Exchange> {
  return new Promise<Exchange>((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/mcp",
        agent: false,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: authorization,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("error", reject);
        response.once("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.once("error", reject);
    request.end(body);
  });
}

/** The error code a fresh connection to the port fails with, or `connected`. */
function connectOutcome(port: number): Promise<string> {
  return new Promise<string>((resolve) => {
    const request = httpRequest(
      { host: "127.0.0.1", port, method: "GET", path: "/healthz", agent: false },
      (response) => {
        response.resume();
        resolve("connected");
      },
    );
    request.once("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? "error"));
    request.end();
  });
}

const capabilitiesCall = JSON.stringify({
  jsonrpc: "2.0",
  id: 2,
  method: "tools/call",
  params: { name: "arr_capabilities", arguments: {} },
});

describe("built HTTP process", () => {
  it("publishes the selected toolsets and names them at startup", async () => {
    const sonarr = await startFixtureInstance("sonarr");
    cleanups.push(() => sonarr.close());
    const server = spawnHttpServer(
      { ...instanceEnvironment([sonarr]), ARR_MCP_TOOLSET: "all" },
      await freePort(),
    );
    await server.listening;

    const listed = await post(
      server.port,
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    );
    expect(listed.status).toBe(200);
    const tools = (JSON.parse(listed.body) as { result: { tools: { name: string }[] } }).result
      .tools;
    expect(tools.map((tool) => tool.name)).toEqual([
      ...toolNames,
      ...publishedMediaToolNames(false),
    ]);

    expect(server.kill("SIGTERM")).toBe(true);
    await withDeadline(server.observed.closed, "SIGTERM exit", 5_000);
    expect(server.observed.stderr).toBe(
      `mcp-arr: listening on http://127.0.0.1:${String(server.port)}/mcp with the arr and media toolsets\n`,
    );
  }, 15_000);

  it("serves a tool call with the token, refuses a wrong one, and exits on SIGTERM", async () => {
    const sonarr = await startFixtureInstance("sonarr");
    cleanups.push(() => sonarr.close());
    const server = spawnHttpServer(instanceEnvironment([sonarr]), await freePort());
    await server.listening;

    const initialized = await post(
      server.port,
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "http-process-test", version: "1.0.0" },
        },
      }),
    );
    expect(initialized.status).toBe(200);
    expect(initialized.headers["mcp-session-id"]).toBeUndefined();

    const called = await post(server.port, capabilitiesCall);
    expect(called.status).toBe(200);
    expect(JSON.parse(called.body)).toMatchObject({ id: 2, result: { isError: false } });
    expect(sonarr.requests).toContain("system/status");

    const refused = await post(server.port, capabilitiesCall, "Bearer wrong");
    expect(refused.status).toBe(401);
    expect(refused.headers["www-authenticate"]).toBe(
      'Bearer realm="mcp-arr", error="invalid_token"',
    );

    expect(server.kill("SIGTERM")).toBe(true);
    const exit = await withDeadline(server.observed.closed, "SIGTERM exit", 5_000);
    expect(isCleanTermination(exit)).toBe(true);
    expect(server.observed.stdout).toBe("");
    expect(server.observed.stderr).toBe(
      `mcp-arr: listening on http://127.0.0.1:${String(server.port)}/mcp with the arr toolset\n`,
    );
    expect(server.observed.stderr).not.toContain(token);
    expect(server.observed.stderr).not.toContain(sonarr.apiKey);
  }, 15_000);

  it("on SIGTERM during a call, refuses new connections and exits by the upstream deadline", async () => {
    let received = 0;
    const hanging: Server = createPlainServer(() => {
      received += 1;
    });
    await new Promise<void>((resolve) => hanging.listen(0, "127.0.0.1", resolve));
    cleanups.push(async () => {
      hanging.closeAllConnections();
      await new Promise<void>((resolve) => hanging.close(() => resolve()));
    });
    const upstreamPort = (hanging.address() as AddressInfo).port;
    const server = spawnHttpServer(
      {
        SONARR_URL: `http://127.0.0.1:${String(upstreamPort)}`,
        SONARR_API_KEY: "sonarr-hanging-key",
        ARR_UPSTREAM_TIMEOUT_MS: "1000",
      },
      await freePort(),
    );
    await server.listening;

    const inProgress = post(server.port, capabilitiesCall);
    await expect.poll(() => received, { timeout: 3_000 }).toBe(1);
    expect(server.kill("SIGTERM")).toBe(true);
    await expect
      .poll(() => connectOutcome(server.port), { timeout: 3_000, interval: 20 })
      .toBe("ECONNREFUSED");

    const answered = await inProgress;
    expect(answered.status).toBe(200);
    expect(answered.headers.connection).toBe("close");
    const exit = await withDeadline(server.observed.closed, "SIGTERM exit", 5_000);
    expect(isCleanTermination(exit)).toBe(true);
    expect(server.observed.stderr).toBe(
      `mcp-arr: listening on http://127.0.0.1:${String(server.port)}/mcp with the arr toolset\n`,
    );
    expect(server.observed.stderr).not.toContain(token);
  }, 15_000);

  it("on SIGTERM during a multi-stage call, exits within the upstream timeout", async () => {
    // The probe is answered just inside its deadline, so the library read that
    // follows starts with a fresh one reaching far past the drain.
    const timeoutMs = 2_000;
    const upstream = await startStagedUpstream(1_800);
    cleanups.push(() => upstream.close());
    const server = spawnHttpServer(
      {
        SONARR_URL: upstream.url,
        SONARR_API_KEY: "sonarr-staged-key",
        ARR_UPSTREAM_TIMEOUT_MS: String(timeoutMs),
      },
      await freePort(),
    );
    await server.listening;

    const inProgress = post(
      server.port,
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "arr_library_query", arguments: { view: "series" } },
      }),
    ).catch((error: unknown) => error);
    await expect.poll(() => upstream.received.length, { timeout: 3_000 }).toBe(1);
    const signalledAt = Date.now();
    expect(server.kill("SIGTERM")).toBe(true);
    const exit = await withDeadline(server.observed.closed, "SIGTERM exit", 8_000);
    const elapsed = Date.now() - signalledAt;
    await inProgress;

    expect(isCleanTermination(exit)).toBe(true);
    expect(upstream.received).toHaveLength(2);
    expect(elapsed).toBeLessThan(timeoutMs + 700);
    expect(upstream.open()).toBe(0);
    expect(server.observed.stderr).toBe(
      `mcp-arr: listening on http://127.0.0.1:${String(server.port)}/mcp with the arr toolset\n`,
    );
  }, 15_000);

  it("exits 1 naming the address and port when the port is taken", async () => {
    const occupant = createNetServer();
    await new Promise<void>((resolve) => occupant.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => occupant.close(() => resolve())));
    const { port } = occupant.address() as AddressInfo;
    const server = spawnHttpServer(
      { SONARR_URL: "https://sonarr.example.invalid", SONARR_API_KEY: "sonarr-secret-key" },
      port,
    );

    await expect(withDeadline(server.observed.closed, "bind failure exit", 5_000)).resolves.toEqual(
      { code: 1, signal: null },
    );
    expect(server.observed.stdout).toBe("");
    expect(server.observed.stderr).toBe(
      `mcp-arr: startup failed: cannot listen on 127.0.0.1:${String(port)} (EADDRINUSE)\n`,
    );
  });

  it("refuses to start without a usable token, naming the variable and not the value", async () => {
    const port = await freePort();
    const shortToken = "short-token-value-20";
    const child = spawn(process.execPath, ["dist/cli.js"], {
      cwd: projectRoot,
      env: serverEnvironment({
        SONARR_URL: "https://sonarr.example.invalid",
        SONARR_API_KEY: "sonarr-secret-key",
        ARR_MCP_TRANSPORT: "http",
        ARR_MCP_HTTP_PORT: String(port),
        ARR_MCP_AUTH_TOKEN: shortToken,
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const observed = observeChildProcess(child);

    await expect(withDeadline(observed.closed, "short token exit", 5_000)).resolves.toEqual({
      code: 1,
      signal: null,
    });
    expect(observed.stderr).toBe(
      "mcp-arr: startup failed: invalid environment configuration: " +
        "ARR_MCP_AUTH_TOKEN must be 32 to 4096 characters from the RFC 6750 b64token alphabet\n",
    );
    expect(observed.stderr).not.toContain(shortToken);
    await expect(connectOutcome(port)).resolves.toBe("ECONNREFUSED");
  });
});
