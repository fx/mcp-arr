import { createHash, timingSafeEqual } from "node:crypto";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { type AdapterRegistry, createAdapterRegistry } from "./adapters/registry.js";
import type { EnvironmentConfiguration, HttpTransportConfiguration } from "./config/environment.js";
import type { Runtime } from "./process.js";
import { createServer } from "./server.js";
import { systemClock } from "./state/clock.js";
import { createWorkflowState, type WorkflowState } from "./state/workflow.js";
import { unrefStdin } from "./stdin.js";
import type { ConnectableServer } from "./stdio.js";
import type { ToolContext } from "./tools/dispatch.js";
import { createOperationRegistry } from "./tools/operations.js";

/** A configuration that selected the HTTP transport. */
export type HttpEnvironmentConfiguration = EnvironmentConfiguration & {
  readonly transport: HttpTransportConfiguration;
};

/** The one MCP endpoint path, compared exactly and never decoded. */
const mcpPath = "/mcp";
/** The unauthenticated liveness path. */
const healthPath = "/healthz";
/** The largest request body read; one byte more is refused. */
const maximumBodyBytes = 1_048_576;

/** Refused authentication attempts one peer address may make inside a window. */
const throttleLimit = 10;
const throttleWindowMs = 60_000;
/**
 * The most peer addresses tracked at once. A flood of distinct addresses
 * evicts the oldest window rather than growing memory without bound; an
 * evicted address only loses its count, which errs toward letting it guess
 * again rather than toward refusing a legitimate client.
 */
const maximumTrackedAddresses = 10_000;

const realm = 'Bearer realm="mcp-arr"';
/** RFC 6750 `credentials`: the scheme, one or more spaces, and a `b64token`. */
const bearerCredential = /^Bearer +([A-Za-z0-9\-._~+/]+=*)$/iu;

/**
 * Reason phrases fixed here rather than taken from `node:http`, whose table
 * has renamed some of them between releases. Each one is also the message of
 * the refusal's JSON-RPC error, so no refusal says anything a request sent.
 */
const reasonPhrases = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  413: "Content Too Large",
  429: "Too Many Requests",
  500: "Internal Server Error",
} as const;

type RefusalStatus = keyof typeof reasonPhrases;

/** The SDK transport's request entry point, which a connected server answers through. */
export interface RequestTransport extends Transport {
  handleRequest(request: IncomingMessage, response: ServerResponse, body: unknown): Promise<void>;
}

export interface HttpRuntime extends Runtime {
  /** Where the listener is bound once started, so a test can bind port 0 and find it. */
  address(): AddressInfo | undefined;
}

export interface HttpRuntimeDependencies {
  createServer: (context: ToolContext) => ConnectableServer;
  createTransport: () => RequestTransport;
  createRegistry: (configuration: EnvironmentConfiguration) => AdapterRegistry;
  createOperations: () => ToolContext["operations"];
  /**
   * Built once per runtime and shared by every request, which is what lets a
   * reference minted in one request resolve in the next.
   */
  createState: () => WorkflowState;
  writeStderr: (message: string) => void;
  unrefStdin: () => void;
  /** The throttle's clock, in milliseconds. */
  now: () => number;
}

export const defaultHttpRuntimeDependencies: HttpRuntimeDependencies = {
  createServer,
  // Stateless — no session id generator — and JSON rather than an event stream
  // for every answer. `onerror` is deliberately never set: the SDK reports
  // what a client sent through it, and nothing a client sends is logged.
  //
  // The assertion is about the SDK's declarations, not its behavior: it types
  // its callbacks as accessors returning `T | undefined`, which
  // `exactOptionalPropertyTypes` will not read as its own `Transport`
  // interface's optional members.
  createTransport: () =>
    new StreamableHTTPServerTransport({ enableJsonResponse: true }) as RequestTransport,
  createRegistry: (configuration) => createAdapterRegistry(configuration),
  createOperations: () => createOperationRegistry(),
  createState: () => createWorkflowState(),
  writeStderr: (message) => {
    process.stderr.write(message);
  },
  unrefStdin,
  now: () => systemClock.now(),
};

interface ThrottleWindow {
  failures: number;
  readonly windowStart: number;
}

/**
 * Counts refused authentication attempts per peer address in fixed windows.
 *
 * The map's insertion order is its window order: an entry is only ever
 * inserted with the current time as its start, and an expired one is deleted
 * before being inserted again. Pruning therefore stops at the first live
 * entry, and the oldest entry is always the first.
 */
export function createFailedAuthenticationThrottle(now: () => number) {
  const windows = new Map<string, ThrottleWindow>();

  const prune = (at: number): void => {
    for (const [address, window] of windows) {
      if (at - window.windowStart < throttleWindowMs) {
        return;
      }
      windows.delete(address);
    }
  };

  return {
    /** Seconds until the address may try again, or `undefined` when it may now. */
    retryAfter(address: string): number | undefined {
      const at = now();
      prune(at);
      const window = windows.get(address);
      if (window === undefined || window.failures < throttleLimit) {
        return undefined;
      }
      const remainingMs = window.windowStart + throttleWindowMs - at;
      return Math.max(1, Math.ceil(remainingMs / 1000));
    },

    recordFailure(address: string): void {
      const at = now();
      prune(at);
      const window = windows.get(address);
      if (window !== undefined) {
        window.failures += 1;
        return;
      }
      windows.set(address, { failures: 1, windowStart: at });
      for (const oldest of windows.keys()) {
        if (windows.size <= maximumTrackedAddresses) {
          break;
        }
        windows.delete(oldest);
      }
    },
  };
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function formatAuthority(host: string, port: number): string {
  return host.includes(":") ? `[${host}]:${String(port)}` : `${host}:${String(port)}`;
}

/**
 * Answers a request this listener will not serve, with a body that depends on
 * nothing but the status. A refused `POST /mcp` also closes its connection:
 * its body may be unread, and the connection is not worth reusing for a
 * client that sent one this listener refused.
 */
function refuse(
  response: ServerResponse,
  status: RefusalStatus,
  headers: OutgoingHttpHeaders = {},
  closeConnection = false,
): void {
  const reason = reasonPhrases[status];
  const body = JSON.stringify({
    jsonrpc: "2.0",
    error: { code: status === 500 ? -32603 : -32000, message: reason },
    id: null,
  });
  response.writeHead(status, reason, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    ...headers,
    ...(closeConnection ? { Connection: "close" } : {}),
  });
  response.end(body);
}

/**
 * Reads a request body up to the bound. Resolves `undefined` as soon as the
 * bound is passed, and discards the rest of the body rather than holding it.
 */
function readBoundedBody(request: IncomingMessage): Promise<Buffer | undefined> {
  return new Promise<Buffer | undefined>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const detach = (): void => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      request.off("close", onClose);
    };
    function onData(chunk: Buffer): void {
      size += chunk.length;
      if (size > maximumBodyBytes) {
        detach();
        request.resume();
        resolve(undefined);
        return;
      }
      chunks.push(chunk);
    }
    function onEnd(): void {
      detach();
      resolve(Buffer.concat(chunks));
    }
    function onError(error: Error): void {
      detach();
      reject(error);
    }
    function onClose(): void {
      detach();
      reject(new Error("the request closed before its body ended"));
    }
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    request.once("close", onClose);
  });
}

/**
 * Builds the Streamable HTTP runtime: one listener that serves MCP on `/mcp`
 * behind a bearer token, and liveness on `/healthz`.
 *
 * The adapter registry, operation inventory, and workflow state are built
 * once, here, and every request is answered by a server built for it alone
 * over that one context — the pinned SDK cannot reuse a stateless transport,
 * and nothing but the context needs to outlive a request.
 */
export function createHttpRuntime(
  configuration: HttpEnvironmentConfiguration,
  dependencies: HttpRuntimeDependencies = defaultHttpRuntimeDependencies,
): HttpRuntime {
  const { host, port } = configuration.transport;
  const registry = dependencies.createRegistry(configuration);
  const context: ToolContext = {
    registry,
    operations: dependencies.createOperations(),
    state: dependencies.createState(),
  };
  // Hashed once, so each comparison is between two equal-length digests and
  // takes the same time wherever a presented token first differs.
  const tokenDigest = sha256(configuration.transport.token);
  const throttle = createFailedAuthenticationThrottle(dependencies.now);
  let closing = false;
  let listening = false;
  let startPromise: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;

  const authenticate = (
    request: IncomingMessage,
    response: ServerResponse,
    address: string,
  ): boolean => {
    const values = request.headersDistinct.authorization;
    if (values === undefined) {
      // No credential is not an attempt at one, so it is not counted.
      refuse(response, 401, { "WWW-Authenticate": realm }, true);
      return false;
    }
    const match = values.length === 1 ? bearerCredential.exec(values[0] ?? "") : null;
    if (match === null) {
      throttle.recordFailure(address);
      refuse(response, 400, { "WWW-Authenticate": `${realm}, error="invalid_request"` }, true);
      return false;
    }
    if (!timingSafeEqual(sha256(match[1] ?? ""), tokenDigest)) {
      throttle.recordFailure(address);
      refuse(response, 401, { "WWW-Authenticate": `${realm}, error="invalid_token"` }, true);
      return false;
    }
    return true;
  };

  const serveMcp = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const declaredLength = request.headers["content-length"];
    if (declaredLength !== undefined && Number(declaredLength) > maximumBodyBytes) {
      refuse(response, 413, {}, true);
      return;
    }
    const body = await readBoundedBody(request);
    if (body === undefined) {
      refuse(response, 413, {}, true);
      return;
    }

    let message: unknown;
    try {
      message = JSON.parse(body.toString("utf8"));
    } catch {
      response.writeHead(400, reasonPhrases[400], { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32700, message: "Parse error" },
          id: null,
        }),
      );
      return;
    }

    const transport = dependencies.createTransport();
    const server = dependencies.createServer(context);
    response.once("close", () => {
      void transport.close().catch(() => undefined);
      void server.close().catch(() => undefined);
    });
    await server.connect(transport);
    await transport.handleRequest(request, response, message);
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (closing) {
      response.setHeader("Connection", "close");
    }
    // The raw target up to any query, compared exactly: no decoding, no
    // normalization, so `/mcp/`, `/%6Dcp`, and `/MCP` are all somewhere else.
    const target = request.url ?? "";
    const queryStart = target.indexOf("?");
    const path = queryStart < 0 ? target : target.slice(0, queryStart);

    if (path === healthPath) {
      if (request.method === "GET" || request.method === "HEAD") {
        const body = JSON.stringify({ status: "ok" });
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(body);
        return;
      }
      refuse(response, 405, { Allow: "GET, HEAD" });
      return;
    }
    if (path !== mcpPath) {
      refuse(response, 404);
      return;
    }
    if (request.method !== "POST") {
      refuse(response, 405, { Allow: "POST" });
      return;
    }

    // Any origin at all, `null` and empty included: only a browser sends one,
    // and no browser client is served. Not an authentication attempt.
    if (request.headers.origin !== undefined) {
      refuse(response, 403, {}, true);
      return;
    }
    // The connection's peer and nothing a request says about itself.
    const address = request.socket.remoteAddress ?? "";
    const retryAfter = throttle.retryAfter(address);
    if (retryAfter !== undefined) {
      refuse(response, 429, { "Retry-After": String(retryAfter) }, true);
      return;
    }
    if (!authenticate(request, response, address)) {
      return;
    }
    await serveMcp(request, response);
  };

  const listener = (request: IncomingMessage, response: ServerResponse): void => {
    handle(request, response).catch(() => {
      // Nothing about the failure is reported: what failed may be carrying
      // what the client sent.
      if (response.headersSent) {
        response.destroy();
        return;
      }
      refuse(response, 500, {}, true);
    });
  };

  const httpServer: Server = createHttpServer(listener);

  return {
    registry,

    address(): AddressInfo | undefined {
      const bound = httpServer.address();
      return typeof bound === "object" && bound !== null ? bound : undefined;
    },

    start(): Promise<void> {
      if (closePromise !== undefined) {
        return Promise.reject(new Error("Cannot start a closed HTTP runtime"));
      }

      startPromise ??= new Promise<void>((resolve, reject) => {
        const onError = (error: NodeJS.ErrnoException): void => {
          reject(
            new Error(
              `cannot listen on ${formatAuthority(host, port)} (${error.code ?? "unknown error"})`,
            ),
          );
        };
        httpServer.once("error", onError);
        httpServer.listen(port, host, () => {
          httpServer.off("error", onError);
          listening = true;
          const bound = httpServer.address() as AddressInfo;
          dependencies.writeStderr(
            `mcp-arr: listening on http://${formatAuthority(host, bound.port)}${mcpPath} ` +
              "with the arr toolset\n",
          );
          // The listener is what keeps this process alive now. A closed or
          // absent stdin must neither hold it open nor end it.
          dependencies.unrefStdin();
          resolve();
        });
      });

      return startPromise;
    },

    close(): Promise<void> {
      closePromise ??= (async () => {
        closing = true;
        await startPromise?.catch(() => undefined);
        if (!listening) {
          return;
        }
        const drained = new Promise<void>((resolve) => {
          httpServer.close(() => resolve());
        });
        httpServer.closeIdleConnections();
        // Requests already in progress get as long as the upstream call they
        // may be waiting on, and no longer.
        let timer: NodeJS.Timeout | undefined;
        const deadline = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, configuration.upstreamTimeoutMs);
          timer.unref();
        });
        await Promise.race([drained, deadline]);
        clearTimeout(timer);
        httpServer.closeAllConnections();
        await drained;
      })();

      return closePromise;
    },
  };
}
