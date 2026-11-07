import {
  createServer as createPlainServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type OutgoingHttpHeaders,
  type Server,
} from "node:http";
import { type AddressInfo, createServer as createNetServer } from "node:net";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { type EnvironmentRecord, parseEnvironment } from "../src/config/environment.js";
import {
  createFailedAuthenticationThrottle,
  createHttpRuntime,
  defaultHttpRuntimeDependencies,
  type HttpEnvironmentConfiguration,
  type HttpRuntime,
  type HttpRuntimeDependencies,
} from "../src/http-transport.js";
import { createManualClock, type ManualClock } from "../src/state/clock.js";
import {
  type FixtureInstance,
  type FixtureInstanceOptions,
  instanceEnvironment,
  startFixtureInstance,
} from "./support/instance-server.js";

/**
 * The HTTP transport over real sockets, against a recorded upstream.
 *
 * Every request opens its own connection, so nothing a test observes can be
 * explained by a connection the server happened to remember. Every refusal is
 * also checked against the upstream's own request log: a refused request must
 * never reach an instance, and "the status code was right" proves nothing
 * about that on its own.
 */

/** 64 hexadecimal characters, as `openssl rand -hex 32` prints. */
const token = "0123456789abcdef".repeat(4);
const wrongToken = "fedcba9876543210".repeat(4);
const mib = 1_048_576;

interface Exchange {
  readonly status: number;
  readonly reason: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

interface SendOptions {
  readonly method?: string;
  readonly path?: string;
  readonly headers?: OutgoingHttpHeaders;
  readonly body?: string | Buffer;
  /** Sent one write at a time, with no declared length, so the body is chunked. */
  readonly chunks?: readonly Buffer[];
}

/** Opens a new connection, sends one request, and reads the whole answer. */
function send(port: number, options: SendOptions = {}): Promise<Exchange> {
  return new Promise<Exchange>((resolve, reject) => {
    let answered = false;
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: options.method ?? "POST",
        path: options.path ?? "/mcp",
        headers: options.headers ?? {},
        agent: false,
      },
      (response) => {
        answered = true;
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("error", reject);
        response.once("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            reason: response.statusMessage ?? "",
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    // A refusal that closes its connection can race the rest of a body this
    // client is still writing. The answer is what is under test, so a write
    // error after it arrived is not a failure.
    request.once("error", (error) => {
      if (!answered) {
        reject(error);
      }
    });
    if (options.chunks !== undefined) {
      for (const chunk of options.chunks) {
        request.write(chunk);
      }
      request.end();
      return;
    }
    request.end(options.body);
  });
}

function mcpHeaders(extra: OutgoingHttpHeaders = {}): OutgoingHttpHeaders {
  return {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${token}`,
    ...extra,
  };
}

function initializeBody(id: number): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "http-transport-test", version: "1.0.0" },
    },
  });
}

function requestBody(id: number, method: string, params?: Record<string, unknown>): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method,
    ...(params === undefined ? {} : { params }),
  });
}

function refusalBody(message: string): unknown {
  return { jsonrpc: "2.0", error: { code: -32000, message }, id: null };
}

interface Harness {
  readonly runtime: HttpRuntime;
  readonly port: number;
  readonly clock: ManualClock;
  readonly stderr: string[];
  readonly stdinUnrefs: () => number;
  /** Every answer this harness received, for asserting what never crossed the wire. */
  readonly exchanges: Exchange[];
  send(options?: SendOptions): Promise<Exchange>;
  /** A JSON-RPC request with the configured token; returns the exchange and its message. */
  call(
    id: number,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<{ exchange: Exchange; message: Record<string, unknown> }>;
}

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function fixture(
  application: FixtureInstance["application"],
  options: FixtureInstanceOptions = {},
): Promise<FixtureInstance> {
  const running = await startFixtureInstance(application, options);
  cleanups.push(() => running.close());
  return running;
}

/**
 * The configuration the environment would produce for these instances, with
 * the listener moved to an ephemeral port no environment value could name.
 */
function configurationFor(
  instances: EnvironmentRecord,
  upstreamTimeoutMs = 5_000,
  listener: { host?: string; port?: number } = {},
): HttpEnvironmentConfiguration {
  const parsed = parseEnvironment({
    ...instances,
    ARR_MCP_TRANSPORT: "http",
    ARR_MCP_AUTH_TOKEN: token,
    ARR_UPSTREAM_TIMEOUT_MS: String(upstreamTimeoutMs),
  });
  if (parsed.transport.kind !== "http") {
    throw new Error("Expected the HTTP transport");
  }
  return {
    ...parsed,
    transport: {
      ...parsed.transport,
      host: listener.host ?? "127.0.0.1",
      port: listener.port ?? 0,
    },
  };
}

function createRuntimeFor(
  configuration: HttpEnvironmentConfiguration,
  overrides: Partial<HttpRuntimeDependencies> = {},
): { runtime: HttpRuntime; clock: ManualClock; stderr: string[]; stdinUnrefs: () => number } {
  const clock = createManualClock(1_000_000);
  const stderr: string[] = [];
  let unrefs = 0;
  const runtime = createHttpRuntime(configuration, {
    ...defaultHttpRuntimeDependencies,
    writeStderr: (message) => {
      stderr.push(message);
    },
    unrefStdin: () => {
      unrefs += 1;
    },
    now: () => clock.now(),
    ...overrides,
  });
  cleanups.push(() => runtime.close());
  return { runtime, clock, stderr, stdinUnrefs: () => unrefs };
}

async function startHarness(
  instances: EnvironmentRecord,
  upstreamTimeoutMs = 5_000,
  overrides: Partial<HttpRuntimeDependencies> = {},
): Promise<Harness> {
  const created = createRuntimeFor(configurationFor(instances, upstreamTimeoutMs), overrides);
  await created.runtime.start();
  const port = created.runtime.address()?.port;
  if (port === undefined) {
    throw new Error("The runtime did not report a bound port");
  }
  const exchanges: Exchange[] = [];
  const harnessSend = async (options: SendOptions = {}): Promise<Exchange> => {
    const exchange = await send(port, options);
    exchanges.push(exchange);
    return exchange;
  };
  return {
    ...created,
    port,
    exchanges,
    send: harnessSend,
    async call(id, method, params) {
      const exchange = await harnessSend({
        headers: mcpHeaders({ "MCP-Protocol-Version": LATEST_PROTOCOL_VERSION }),
        body: requestBody(id, method, params),
      });
      return { exchange, message: JSON.parse(exchange.body) as Record<string, unknown> };
    },
  };
}

async function sonarrHarness(
  options: FixtureInstanceOptions = {},
): Promise<{ harness: Harness; sonarr: FixtureInstance }> {
  const sonarr = await fixture("sonarr", options);
  return { sonarr, harness: await startHarness(instanceEnvironment([sonarr])) };
}

function expectJsonRefusal(exchange: Exchange, status: number, message: string): void {
  expect(exchange.status).toBe(status);
  expect(exchange.reason).toBe(message);
  expect(exchange.headers["content-type"]).toBe("application/json");
  expect(JSON.parse(exchange.body)).toEqual(refusalBody(message));
}

/** A hanging upstream: it accepts every request and never answers one. */
async function startHangingUpstream(): Promise<{ url: string; received: () => number }> {
  let received = 0;
  const server: Server = createPlainServer(() => {
    received += 1;
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${String(port)}`, received: () => received };
}

describe("HTTP transport lifecycle", () => {
  it("writes one startup line naming the bound address and toolset, then releases stdin", async () => {
    const { harness } = await sonarrHarness();

    expect(harness.stderr).toEqual([
      `mcp-arr: listening on http://127.0.0.1:${String(harness.port)}/mcp with the arr toolset\n`,
    ]);
    expect(harness.stdinUnrefs()).toBe(1);
    await harness.runtime.start();
    expect(harness.stderr).toHaveLength(1);
  });

  it("rejects startup naming the address and port when the port is taken", async () => {
    const occupant = createNetServer();
    await new Promise<void>((resolve) => occupant.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => occupant.close(() => resolve())));
    const { port } = occupant.address() as AddressInfo;
    const sonarr = await fixture("sonarr");
    const created = createRuntimeFor(
      configurationFor(instanceEnvironment([sonarr]), 5_000, { port }),
    );

    await expect(created.runtime.start()).rejects.toThrow(
      `cannot listen on 127.0.0.1:${String(port)} (EADDRINUSE)`,
    );
    expect(created.stderr).toEqual([]);
    expect(created.stdinUnrefs()).toBe(0);
    await expect(created.runtime.close()).resolves.toBeUndefined();
  });

  it("brackets an IPv6 address in the bind diagnostic", async () => {
    const sonarr = await fixture("sonarr");
    // A documentation-range address no host is assigned, so the bind fails
    // whatever the machine's IPv6 support.
    const created = createRuntimeFor(
      configurationFor(instanceEnvironment([sonarr]), 5_000, { host: "2001:db8::1", port: 9797 }),
    );

    await expect(created.runtime.start()).rejects.toThrow(
      /^cannot listen on \[2001:db8::1\]:9797 \([A-Z]+\)$/u,
    );
  });

  it("closes without having started, and refuses to start once closed", async () => {
    const sonarr = await fixture("sonarr");
    const created = createRuntimeFor(configurationFor(instanceEnvironment([sonarr])));

    await created.runtime.close();
    await created.runtime.close();
    await expect(created.runtime.start()).rejects.toThrow("Cannot start a closed HTTP runtime");
    expect(created.runtime.address()).toBeUndefined();
  });

  it("stops accepting connections on close and lets an in-progress call finish", async () => {
    const upstream = await startHangingUpstream();
    const harness = await startHarness(
      { SONARR_URL: upstream.url, SONARR_API_KEY: "sonarr-hanging-key" },
      1_000,
    );

    const inProgress = harness.call(1, "tools/call", { name: "arr_capabilities", arguments: {} });
    await expect.poll(() => upstream.received(), { timeout: 2_000 }).toBe(1);
    const closed = harness.runtime.close();
    await expect(send(harness.port, { method: "GET", path: "/healthz" })).rejects.toMatchObject({
      code: "ECONNREFUSED",
    });

    // The call is waiting on the upstream deadline, which answers it.
    const { exchange, message } = await inProgress;
    expect(exchange.status).toBe(200);
    expect(exchange.headers.connection).toBe("close");
    expect(message).toMatchObject({ id: 1, result: { isError: false } });
    await expect(closed).resolves.toBeUndefined();
  });

  it("abandons a request still in progress at the upstream deadline", async () => {
    const sonarr = await fixture("sonarr");
    let connects = 0;
    const harness = await startHarness(instanceEnvironment([sonarr]), 200, {
      createServer: () => ({
        connect: () => {
          connects += 1;
          return new Promise<void>(() => undefined);
        },
        close: async () => undefined,
      }),
    });

    const hung = harness.send({ headers: mcpHeaders(), body: requestBody(1, "tools/list") });
    await expect.poll(() => connects, { timeout: 2_000 }).toBe(1);
    const startedAt = Date.now();
    await harness.runtime.close();
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(elapsed).toBeLessThan(2_000);
    await expect(hung).rejects.toMatchObject({ code: "ECONNRESET" });
    expect(sonarr.requests).toEqual([]);
  });
});

describe("HTTP transport paths and methods", () => {
  it("answers the health path without authentication and without contacting any instance", async () => {
    const { harness, sonarr } = await sonarrHarness({ unreachable: true });

    const health = await harness.send({ method: "GET", path: "/healthz" });
    expect(health.status).toBe(200);
    expect(health.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(health.body)).toEqual({ status: "ok" });

    const head = await harness.send({ method: "HEAD", path: "/healthz" });
    expect(head.status).toBe(200);
    expect(head.body).toBe("");

    for (const method of ["POST", "PUT", "DELETE"]) {
      const refused = await harness.send({ method, path: "/healthz", headers: mcpHeaders() });
      expectJsonRefusal(refused, 405, "Method Not Allowed");
      expect(refused.headers.allow).toBe("GET, HEAD");
    }
    for (const exchange of harness.exchanges) {
      expect(exchange.body).not.toMatch(/sonarr|radarr|prowlarr|arr_|0\.3|127\.0\.0\.1/iu);
    }
    expect(sonarr.requests).toEqual([]);
  });

  it("answers every other path 404, OAuth discovery included, even with the token", async () => {
    const { harness, sonarr } = await sonarrHarness();

    for (const path of [
      "/",
      "/mcp/",
      "/MCP",
      "/%6Dcp",
      "/mcp/tools",
      "/healthz/",
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-authorization-server",
      "/.well-known/openid-configuration",
      "/register",
    ]) {
      for (const method of ["GET", "POST"]) {
        const answered = await harness.send({
          method,
          path,
          headers: mcpHeaders(),
          ...(method === "POST" ? { body: initializeBody(1) } : {}),
        });
        expectJsonRefusal(answered, 404, "Not Found");
      }
    }
    expect(sonarr.requests).toEqual([]);
  });

  it("answers any method but POST on the endpoint 405, before asking for a credential", async () => {
    const { harness, sonarr } = await sonarrHarness();

    for (const method of ["GET", "DELETE", "PUT", "PATCH", "HEAD"]) {
      const refused = await harness.send({ method });
      expect(refused.status).toBe(405);
      expect(refused.headers.allow).toBe("POST");
      expect(refused.headers["www-authenticate"]).toBeUndefined();
      if (method !== "HEAD") {
        expectJsonRefusal(refused, 405, "Method Not Allowed");
      }
    }
    expect(sonarr.requests).toEqual([]);
  });

  it("serves the endpoint whatever query string it carries", async () => {
    const { harness } = await sonarrHarness();

    const answered = await harness.send({
      path: "/mcp?client=example",
      headers: mcpHeaders(),
      body: initializeBody(1),
    });
    expect(answered.status).toBe(200);
  });
});

describe("HTTP transport origin validation", () => {
  it("refuses every origin-bearing request, even with the correct token", async () => {
    const { harness, sonarr } = await sonarrHarness();

    for (const origin of ["https://attacker.example", "null", ""]) {
      const refused = await harness.send({
        headers: mcpHeaders({ Origin: origin }),
        body: requestBody(1, "tools/call", { name: "arr_capabilities", arguments: {} }),
      });
      expectJsonRefusal(refused, 403, "Forbidden");
      expect(refused.headers.connection).toBe("close");
      expect(refused.headers["www-authenticate"]).toBeUndefined();
    }
    expect(sonarr.requests).toEqual([]);
  });

  it("does not count an origin-bearing wrong guess toward the throttle", async () => {
    const { harness, sonarr } = await sonarrHarness();

    for (let attempt = 0; attempt < 12; attempt += 1) {
      const refused = await harness.send({
        headers: mcpHeaders({
          Origin: "https://attacker.example",
          Authorization: `Bearer ${wrongToken}`,
        }),
        body: initializeBody(1),
      });
      expectJsonRefusal(refused, 403, "Forbidden");
    }
    const accepted = await harness.send({ headers: mcpHeaders(), body: initializeBody(2) });
    expect(accepted.status).toBe(200);
    expect(sonarr.requests).toEqual([]);
  });
});

describe("HTTP transport bearer authentication", () => {
  it("challenges a request with no credential", async () => {
    const { harness, sonarr } = await sonarrHarness();
    const { Authorization: _omitted, ...withoutCredential } = mcpHeaders();

    const refused = await harness.send({ headers: withoutCredential, body: initializeBody(1) });
    expectJsonRefusal(refused, 401, "Unauthorized");
    expect(refused.headers["www-authenticate"]).toBe('Bearer realm="mcp-arr"');
    expect(refused.headers.connection).toBe("close");
    expect(sonarr.requests).toEqual([]);
  });

  it("refuses a wrong token as invalid without sending anything upstream", async () => {
    const { harness, sonarr } = await sonarrHarness();

    for (const presented of [wrongToken, token.slice(0, -1), `${token}0`, token.toUpperCase()]) {
      const refused = await harness.send({
        headers: mcpHeaders({ Authorization: `Bearer ${presented}` }),
        body: requestBody(1, "tools/call", { name: "arr_capabilities", arguments: {} }),
      });
      expectJsonRefusal(refused, 401, "Unauthorized");
      expect(refused.headers["www-authenticate"]).toBe(
        'Bearer realm="mcp-arr", error="invalid_token"',
      );
      expect(refused.headers.connection).toBe("close");
      expect(JSON.stringify(refused)).not.toContain(presented);
      expect(JSON.stringify(refused)).not.toContain(token);
    }
    expect(sonarr.requests).toEqual([]);
    expect(harness.stderr).toHaveLength(1);
  });

  it("refuses a credential that is not one well-formed bearer token as a bad request", async () => {
    const { harness, sonarr } = await sonarrHarness();

    for (const authorization of [
      `Basic ${token}`,
      "Bearer",
      "Bearer ",
      `Bearer ${token} extra`,
      `Bearer ${token},more`,
      `Bearer "${token}"`,
      `Bearer =${token}`,
      `Token ${token}`,
      token,
      [`Bearer ${token}`, `Bearer ${token}`],
      [`Bearer ${wrongToken}`, `Bearer ${token}`],
    ]) {
      const refused = await harness.send({
        headers: mcpHeaders({ Authorization: authorization }),
        body: initializeBody(1),
      });
      expectJsonRefusal(refused, 400, "Bad Request");
      expect(refused.headers["www-authenticate"]).toBe(
        'Bearer realm="mcp-arr", error="invalid_request"',
      );
      expect(refused.headers.connection).toBe("close");
      expect(refused.body).not.toContain(token);
      // Each of these counts toward the throttle, so move past any window.
      harness.clock.advance(60_000);
    }
    expect(sonarr.requests).toEqual([]);
  });

  it("accepts the scheme in any case and more than one space before the token", async () => {
    const { harness } = await sonarrHarness();

    for (const authorization of [`bearer ${token}`, `BEARER ${token}`, `Bearer   ${token}`]) {
      const accepted = await harness.send({
        headers: mcpHeaders({ Authorization: authorization }),
        body: initializeBody(1),
      });
      expect(accepted.status).toBe(200);
    }
  });

  it("ignores a token in the query string or the body", async () => {
    const { harness, sonarr } = await sonarrHarness();
    const { Authorization: _omitted, ...withoutCredential } = mcpHeaders();

    const inQuery = await harness.send({
      path: `/mcp?access_token=${token}`,
      headers: withoutCredential,
      body: initializeBody(1),
    });
    expectJsonRefusal(inQuery, 401, "Unauthorized");
    expect(inQuery.headers["www-authenticate"]).toBe('Bearer realm="mcp-arr"');

    const inBody = await harness.send({
      headers: { ...withoutCredential, "Content-Type": "application/x-www-form-urlencoded" },
      body: `access_token=${token}`,
    });
    expectJsonRefusal(inBody, 401, "Unauthorized");
    expect(inBody.headers["www-authenticate"]).toBe('Bearer realm="mcp-arr"');
    expect(sonarr.requests).toEqual([]);
  });
});

describe("HTTP transport failed-authentication throttling", () => {
  async function guess(harness: Harness, presented = wrongToken): Promise<Exchange> {
    return harness.send({
      headers: mcpHeaders({ Authorization: `Bearer ${presented}` }),
      body: initializeBody(1),
    });
  }

  it("throttles an address after 10 wrong guesses without evaluating the correct token", async () => {
    const { harness, sonarr } = await sonarrHarness();

    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await guess(harness)).status).toBe(401);
    }
    const throttled = await guess(harness, token);
    expectJsonRefusal(throttled, 429, "Too Many Requests");
    expect(throttled.headers["retry-after"]).toBe("60");
    expect(throttled.headers.connection).toBe("close");
    expect(throttled.headers["www-authenticate"]).toBeUndefined();

    harness.clock.advance(30_000);
    expect((await guess(harness, token)).headers["retry-after"]).toBe("30");
    harness.clock.advance(29_500);
    expect((await guess(harness, token)).headers["retry-after"]).toBe("1");
    expect(sonarr.requests).toEqual([]);

    // The window ends, and with it the throttle and the count.
    harness.clock.advance(500);
    expect((await guess(harness, token)).status).toBe(200);
    for (let attempt = 0; attempt < 9; attempt += 1) {
      expect((await guess(harness)).status).toBe(401);
    }
    expect((await guess(harness, token)).status).toBe(200);
  });

  it("counts malformed credentials but not requests that carry none", async () => {
    const { harness } = await sonarrHarness();
    const { Authorization: _omitted, ...withoutCredential } = mcpHeaders();

    for (let attempt = 0; attempt < 15; attempt += 1) {
      const refused = await harness.send({ headers: withoutCredential, body: initializeBody(1) });
      expect(refused.status).toBe(401);
    }
    expect((await guess(harness, token)).status).toBe(200);

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const refused = await harness.send({
        headers: mcpHeaders({ Authorization: "Basic credential" }),
        body: initializeBody(1),
      });
      expect(refused.status).toBe(400);
    }
    expect((await guess(harness, token)).status).toBe(429);
  });

  it("neither counts nor resets on an authenticated request, and does not count throttled ones", async () => {
    const { harness } = await sonarrHarness();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await guess(harness)).status).toBe(401);
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await guess(harness, token)).status).toBe(200);
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await guess(harness)).status).toBe(401);
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await guess(harness)).status).toBe(429);
    }
    harness.clock.advance(60_000);
    expect((await guess(harness, token)).status).toBe(200);
  });

  it("keeps a separate window per address, and evicts the oldest past its capacity", () => {
    const clock = createManualClock(0);
    const throttle = createFailedAuthenticationThrottle(() => clock.now());

    for (let attempt = 0; attempt < 10; attempt += 1) {
      throttle.recordFailure("192.0.2.1");
    }
    expect(throttle.retryAfter("192.0.2.1")).toBe(60);
    expect(throttle.retryAfter("192.0.2.2")).toBeUndefined();

    clock.advance(1);
    for (let index = 0; index < 9_999; index += 1) {
      throttle.recordFailure(`198.51.100.${String(index)}`);
    }
    // At capacity, the oldest window is still held.
    expect(throttle.retryAfter("192.0.2.1")).toBe(60);
    throttle.recordFailure("203.0.113.1");
    // One more address evicts it rather than growing past the cap.
    expect(throttle.retryAfter("192.0.2.1")).toBeUndefined();

    // Expired windows are pruned, and an address that fails again after its
    // window starts a new one rather than continuing the old count.
    clock.advance(60_000);
    throttle.recordFailure("198.51.100.0");
    expect(throttle.retryAfter("198.51.100.0")).toBeUndefined();
  });
});

describe("HTTP transport body bound", () => {
  it("refuses a declared length over 1 MiB without reading it", async () => {
    const { harness, sonarr } = await sonarrHarness();

    const refused = await harness.send({
      headers: mcpHeaders({ "Content-Length": String(mib + 1) }),
    });
    expectJsonRefusal(refused, 413, "Content Too Large");
    expect(refused.headers.connection).toBe("close");
    expect(sonarr.requests).toEqual([]);
  });

  it("refuses an undeclared length once it passes 1 MiB", async () => {
    const { harness, sonarr } = await sonarrHarness();

    const refused = await harness.send({
      headers: mcpHeaders(),
      chunks: [Buffer.alloc(mib, 0x20), Buffer.from("{}")],
    });
    expectJsonRefusal(refused, 413, "Content Too Large");
    expect(refused.headers.connection).toBe("close");
    expect(sonarr.requests).toEqual([]);
  });

  it("accepts a body of exactly 1 MiB, declared or chunked", async () => {
    const { harness } = await sonarrHarness();
    const message = initializeBody(1);
    const padded = Buffer.from(message + " ".repeat(mib - Buffer.byteLength(message)));
    expect(padded.length).toBe(mib);

    expect((await harness.send({ headers: mcpHeaders(), body: padded })).status).toBe(200);
    expect(
      (
        await harness.send({
          headers: mcpHeaders(),
          chunks: [padded.subarray(0, mib / 2), padded.subarray(mib / 2)],
        })
      ).status,
    ).toBe(200);
  });

  it("answers a body that is not JSON with a parse error", async () => {
    const { harness, sonarr } = await sonarrHarness();

    const refused = await harness.send({ headers: mcpHeaders(), body: "{not json" });
    expect(refused.status).toBe(400);
    expect(JSON.parse(refused.body)).toEqual({
      jsonrpc: "2.0",
      error: { code: -32700, message: "Parse error" },
      id: null,
    });
    expect(refused.body).not.toContain("not json");
    expect(sonarr.requests).toEqual([]);
  });
});

describe("HTTP transport refusal order", () => {
  it("answers each request by the first check it fails", async () => {
    const { harness, sonarr } = await sonarrHarness();
    const { Authorization: _omitted, ...withoutCredential } = mcpHeaders();

    // Path and method before origin, origin before the throttle.
    expect(
      (await harness.send({ method: "GET", headers: { Origin: "https://attacker.example" } }))
        .status,
    ).toBe(405);
    expect((await harness.send({ method: "GET", headers: withoutCredential })).status).toBe(405);
    expect(
      (
        await harness.send({
          path: "/elsewhere",
          headers: { ...withoutCredential, Origin: "https://attacker.example" },
        })
      ).status,
    ).toBe(404);

    // The credential before the body: an unauthenticated client cannot make
    // the server read, or even weigh, a large body.
    const oversized = { "Content-Length": String(mib + 1) };
    expect((await harness.send({ headers: { ...withoutCredential, ...oversized } })).status).toBe(
      401,
    );
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const refused = await harness.send({
        headers: mcpHeaders({ Authorization: `Bearer ${wrongToken}`, ...oversized }),
      });
      expect(refused.status).toBe(401);
    }

    // The throttle before the credential and the body.
    expect((await harness.send({ headers: mcpHeaders(oversized) })).status).toBe(429);
    // Origin still before the throttle.
    expect(
      (await harness.send({ headers: mcpHeaders({ Origin: "https://attacker.example" }) })).status,
    ).toBe(403);
    // And the health path is outside every check.
    expect((await harness.send({ method: "GET", path: "/healthz" })).status).toBe(200);
    expect(sonarr.requests).toEqual([]);
  });

  it("leaves the SDK's own content negotiation in place", async () => {
    const { harness } = await sonarrHarness();

    const notAcceptable = await harness.send({
      headers: mcpHeaders({ Accept: "application/json" }),
      body: initializeBody(1),
    });
    expect(notAcceptable.status).toBe(406);
    const unsupported = await harness.send({
      headers: mcpHeaders({ "Content-Type": "text/plain" }),
      body: initializeBody(1),
    });
    expect(unsupported.status).toBe(415);
  });
});

interface ToolCallMessage {
  result?: {
    isError?: boolean;
    content?: Array<{ type: string; text?: string }>;
    structuredContent?: Record<string, unknown>;
  };
}

describe("HTTP transport MCP endpoint", () => {
  it("initializes, lists, and calls on separate connections without any session", async () => {
    const { harness, sonarr } = await sonarrHarness();

    const initialized = await harness.send({ headers: mcpHeaders(), body: initializeBody(1) });
    expect(initialized.status).toBe(200);
    expect(initialized.headers["content-type"]).toBe("application/json");
    expect(initialized.headers["mcp-session-id"]).toBeUndefined();
    expect(JSON.parse(initialized.body)).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        serverInfo: { name: "mcp-arr" },
      },
    });

    const notified = await harness.send({
      headers: mcpHeaders(),
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(notified.status).toBe(202);
    expect(notified.headers["mcp-session-id"]).toBeUndefined();

    const listed = await harness.call(2, "tools/list");
    expect(listed.exchange.status).toBe(200);
    expect(listed.exchange.headers["content-type"]).toBe("application/json");
    expect(listed.exchange.headers["mcp-session-id"]).toBeUndefined();
    const tools = (listed.message.result as { tools: { name: string }[] }).tools;
    expect(tools.map((tool) => tool.name)).toContain("arr_capabilities");
    expect(tools).toHaveLength(14);

    const called = await harness.call(3, "tools/call", {
      name: "arr_capabilities",
      arguments: {},
    });
    expect(called.exchange.status).toBe(200);
    expect(called.exchange.headers["content-type"]).toBe("application/json");
    expect(called.exchange.headers["mcp-session-id"]).toBeUndefined();
    const result = (called.message as ToolCallMessage).result;
    expect(result?.isError).toBe(false);
    expect(result?.content?.[0]?.text).toMatch(/^arr_capabilities: /u);
    expect(sonarr.requests).toContain("system/status");
  });

  it("serves concurrent requests", async () => {
    const { harness } = await sonarrHarness();

    const answers = await Promise.all(
      Array.from({ length: 8 }, (_, index) => harness.call(index + 1, "tools/list")),
    );
    expect(answers.map(({ exchange }) => exchange.status)).toEqual(Array(8).fill(200));
    expect(answers.map(({ message }) => message.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  async function retiredSeriesReference(harness: Harness): Promise<string> {
    const { message } = await harness.call(10, "tools/call", {
      name: "arr_library_query",
      arguments: { view: "series", detail: "full", applications: ["sonarr"] },
    });
    const envelope = (message as ToolCallMessage).result?.structuredContent as {
      applications: Array<{ data?: { items: Array<{ title: string; reference: string }> } }>;
    };
    const record = envelope.applications
      .flatMap((entry) => entry.data?.items ?? [])
      .find((item) => item.title === "Example Retired Series");
    if (record === undefined) {
      throw new Error("No recorded series named Example Retired Series");
    }
    return record.reference;
  }

  async function plan(harness: Harness, reference: string): Promise<string> {
    const { message } = await harness.call(11, "tools/call", {
      name: "arr_library_change",
      arguments: { intent: "set_monitoring", mode: "plan", items: [reference], monitored: true },
    });
    const mutation = (message as ToolCallMessage).result?.structuredContent?.mutation as
      | { plan?: string }
      | undefined;
    if (mutation?.plan === undefined) {
      throw new Error("The plan returned no plan reference");
    }
    return mutation.plan;
  }

  function applyArguments(planReference: string) {
    return { name: "arr_library_change", arguments: { mode: "apply", plan: planReference } };
  }

  it("applies, in a later request on a new connection, a plan made in an earlier one", async () => {
    const { harness, sonarr } = await sonarrHarness();
    const planReference = await plan(harness, await retiredSeriesReference(harness));
    expect(planReference).toMatch(/^pln_/u);
    expect(sonarr.writes).toEqual([]);

    const { message } = await harness.call(12, "tools/call", applyArguments(planReference));
    const result = (message as ToolCallMessage).result;
    expect(result?.isError).toBe(false);
    expect(result?.structuredContent?.mutation).toMatchObject({
      receipt: { state: "succeeded" },
    });
    expect(sonarr.writes).toEqual([expect.objectContaining({ method: "PUT", route: "series" })]);
    expect(sonarr.writes[0]?.body).toMatchObject({ id: 14, monitored: true });
  });

  it("sends one upstream write for two concurrent applies of one plan", async () => {
    const { harness, sonarr } = await sonarrHarness();
    const planReference = await plan(harness, await retiredSeriesReference(harness));

    const answers = await Promise.all([
      harness.call(12, "tools/call", applyArguments(planReference)),
      harness.call(13, "tools/call", applyArguments(planReference)),
    ]);
    expect(answers.map(({ exchange }) => exchange.status)).toEqual([200, 200]);
    expect(sonarr.writes).toHaveLength(1);
  });
});

describe("HTTP transport credential leakage", () => {
  it("never echoes the bearer token or any instance API key in a response or diagnostic", async () => {
    const sonarr = await fixture("sonarr");
    const radarr = await fixture("radarr");
    // Radarr is configured with a key it rejects, so the run includes an
    // upstream authentication failure.
    const rejectedRadarrKey = "radarr-rejected-key-0123456789abcdef";
    const harness = await startHarness({
      ...instanceEnvironment([sonarr]),
      RADARR_URL: radarr.url,
      RADARR_API_KEY: rejectedRadarrKey,
    });
    const { Authorization: _omitted, ...withoutCredential } = mcpHeaders();

    await harness.send({ method: "GET", path: "/healthz" });
    await harness.send({ method: "GET", path: "/.well-known/oauth-protected-resource" });
    await harness.send({ method: "GET", headers: mcpHeaders() });
    await harness.send({
      headers: mcpHeaders({ Origin: "https://attacker.example" }),
      body: initializeBody(1),
    });
    await harness.send({ headers: withoutCredential, body: initializeBody(1) });
    await harness.send({ path: `/mcp?access_token=${token}`, headers: withoutCredential });
    await harness.send({ headers: mcpHeaders({ "Content-Length": String(mib + 1) }) });
    await harness.send({ headers: mcpHeaders(), body: `{"token":"${token}"` });
    const called = await harness.call(2, "tools/call", { name: "arr_capabilities", arguments: {} });
    expect(called.exchange.status).toBe(200);
    const applications = (called.message as ToolCallMessage).result?.structuredContent
      ?.applications as Array<{ application: string; data?: { state?: string } }>;
    expect(applications.map((entry) => [entry.application, entry.data?.state])).toEqual([
      ["sonarr", "available"],
      ["radarr", "unavailable"],
      ["prowlarr", "unconfigured"],
    ]);
    expect(radarr.requests).toContain("system/status");
    await harness.send({
      headers: mcpHeaders({ Authorization: `Bearer ${token},` }),
      body: initializeBody(1),
    });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await harness.send({
        headers: mcpHeaders({ Authorization: `Bearer ${wrongToken}` }),
        body: initializeBody(1),
      });
    }
    const throttled = await harness.send({ headers: mcpHeaders(), body: initializeBody(1) });
    expect(throttled.status).toBe(429);
    await harness.runtime.close();

    const observed = JSON.stringify({ exchanges: harness.exchanges, stderr: harness.stderr });
    expect(new Set(harness.exchanges.map((exchange) => exchange.status))).toEqual(
      new Set([200, 400, 401, 403, 404, 405, 413, 429]),
    );
    for (const secret of [token, wrongToken, sonarr.apiKey, radarr.apiKey, rejectedRadarrKey]) {
      expect(observed).not.toContain(secret);
    }
    expect(harness.stderr).toEqual([
      `mcp-arr: listening on http://127.0.0.1:${String(harness.port)}/mcp with the arr toolset\n`,
    ]);
  });
});
