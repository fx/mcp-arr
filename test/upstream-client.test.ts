import { describe, expect, it } from "vitest";
import {
  createUpstreamClient,
  defaultUpstreamTimeoutMs,
  type FetchLike,
  type UpstreamClient,
} from "../src/http/client.js";
import {
  isUpstreamError,
  UpstreamError,
  type UpstreamErrorKind,
  upstreamErrorKindForStatus,
  upstreamErrorKinds,
} from "../src/http/errors.js";

const apiKey = "sonarr-secret-key";

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

function harness(
  respond: (call: Call) => Promise<Response> | Response,
  options: { timeoutMs?: number; baseUrl?: string } = {},
): { client: UpstreamClient; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const call = { url, init };
    calls.push(call);
    return respond(call);
  };

  return {
    calls,
    client: createUpstreamClient({
      application: "sonarr",
      baseUrl: options.baseUrl ?? "https://sonarr.example.invalid/sonarr",
      apiBasePath: "/api/v3",
      apiKey,
      timeoutMs: options.timeoutMs,
      fetch: fetchImpl,
    }),
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function captureError(promise: Promise<unknown>): Promise<UpstreamError> {
  try {
    await promise;
  } catch (error) {
    expect(isUpstreamError(error)).toBe(true);
    return error as UpstreamError;
  }
  throw new Error("Expected the request to fail");
}

describe("createUpstreamClient", () => {
  it("injects the API key, keeps the base prefix, and returns the parsed body", async () => {
    const { client, calls } = harness(() => json({ version: "4.0.19.2979" }));

    expect(client.application).toBe("sonarr");
    expect(client.apiBaseUrl).toBe("https://sonarr.example.invalid/sonarr/api/v3");
    await expect(client.get("system/status")).resolves.toEqual({ version: "4.0.19.2979" });

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.url).toBe("https://sonarr.example.invalid/sonarr/api/v3/system/status");
    const headers = new Headers(call?.init.headers);
    expect(headers.get("X-Api-Key")).toBe(apiKey);
    expect(headers.get("Accept")).toBe("application/json");
    expect(call?.init.method).toBe("GET");
    expect(call?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("preserves a bare-origin base and an api/v1 base path", async () => {
    const calls: Call[] = [];
    const client = createUpstreamClient({
      application: "prowlarr",
      baseUrl: "http://prowlarr.example.invalid:9696",
      apiBasePath: "/api/v1",
      apiKey,
      fetch: async (url, init) => {
        calls.push({ url, init });
        return json({ version: "2.5.2.5491" });
      },
    });

    await client.get("/system/status/");
    expect(calls[0]?.url).toBe("http://prowlarr.example.invalid:9696/api/v1/system/status");
  });

  it("normalizes each upstream status into its own error kind", async () => {
    const expectations: ReadonlyArray<readonly [number, UpstreamErrorKind]> = [
      [400, "validation"],
      [422, "validation"],
      [401, "authentication"],
      [403, "authentication"],
      [404, "not-found"],
      [429, "rate-limit"],
      [500, "unexpected-response"],
      [502, "unexpected-response"],
    ];

    for (const [status, kind] of expectations) {
      const { client } = harness(() => json({ message: `raw upstream body ${apiKey}` }, status));
      const error = await captureError(client.get("system/status"));
      expect(error.kind).toBe(kind);
      expect(error.status).toBe(status);
      expect(upstreamErrorKindForStatus(status)).toBe(kind);
    }
  });

  it("reports a network failure as unavailable and never leaks the thrown cause", async () => {
    const { client } = harness(() => {
      throw new TypeError(`fetch failed for https://user:${apiKey}@sonarr.example.invalid`);
    });

    const error = await captureError(client.get("system/status"));
    expect(error.kind).toBe("unavailable");
    expect(error.status).toBeUndefined();
    expect(error.cause).toBeUndefined();
    expect(error.message).not.toContain(apiKey);
  });

  it("aborts and reports a timeout when the instance never responds", async () => {
    const { client, calls } = harness(
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          call.init.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
      { timeoutMs: 5 },
    );

    const error = await captureError(client.get("system/status"));
    expect(error.kind).toBe("timeout");
    expect(error.message).toContain("timed out after 5ms");
    expect(calls[0]?.init.signal?.aborted).toBe(true);
  });

  it("reports an unreadable or non-JSON success body as an unexpected response", async () => {
    const { client: textClient } = harness(() => new Response("<html>not json</html>"));
    const parseError = await captureError(textClient.get("system/status"));
    expect(parseError.kind).toBe("unexpected-response");
    expect(parseError.status).toBe(200);

    const { client: streamClient } = harness(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error(`stream failed with ${apiKey}`));
            },
          }),
        ),
    );
    const readError = await captureError(streamClient.get("system/status"));
    expect(readError.kind).toBe("unavailable");
    expect(readError.message).not.toContain(apiKey);
  });

  it("rejects a non-finite or non-positive timeout at construction", () => {
    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        createUpstreamClient({
          application: "sonarr",
          baseUrl: "https://sonarr.example.invalid",
          apiBasePath: "/api/v3",
          apiKey,
          timeoutMs,
          fetch: async () => json({}),
        }),
      ).toThrow("Upstream timeout must be a finite positive number of milliseconds");
    }

    expect(defaultUpstreamTimeoutMs).toBeGreaterThan(0);
    expect(Number.isFinite(defaultUpstreamTimeoutMs)).toBe(true);
  });

  it("never exposes the API key through any normalized error", async () => {
    const scenarios: ReadonlyArray<() => Response | Promise<Response>> = [
      () => json({ apiKey, body: `secret ${apiKey}` }, 401),
      () => json({ apiKey }, 429),
      () => json({ apiKey }, 500),
      () => new Response(`plain ${apiKey}`, { status: 200 }),
      () => {
        throw new Error(`network failure carrying ${apiKey}`);
      },
    ];

    for (const respond of scenarios) {
      const { client } = harness(respond);
      const error = await captureError(client.get("system/status"));
      const exposed = [
        error.message,
        error.stack ?? "",
        String(error),
        JSON.stringify(error),
        JSON.stringify(error.toJSON()),
        JSON.stringify(Object.entries(error)),
        Object.getOwnPropertyNames(error)
          .map((name) => String(Reflect.get(error, name)))
          .join("\n"),
      ].join("\n");
      expect(exposed).not.toContain(apiKey);
      expect(upstreamErrorKinds).toContain(error.kind);
    }
  });
});

describe("UpstreamError", () => {
  it("serializes only redacted identifying fields", () => {
    const error = new UpstreamError("validation", {
      application: "radarr",
      operation: "system/status",
      status: 400,
    });

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("UpstreamError");
    expect(error.toJSON()).toEqual({
      name: "UpstreamError",
      kind: "validation",
      application: "radarr",
      operation: "system/status",
      status: 400,
      message: error.message,
    });
    expect(isUpstreamError(error)).toBe(true);
    expect(isUpstreamError(new Error("other"))).toBe(false);
    expect(isUpstreamError(undefined)).toBe(false);
  });

  it("formats a distinct message for every kind", () => {
    const messages = upstreamErrorKinds.map(
      (kind) =>
        new UpstreamError(kind, {
          application: "prowlarr",
          operation: "system/status",
          status: 500,
          timeoutMs: 10_000,
        }).message,
    );

    expect(new Set(messages).size).toBe(upstreamErrorKinds.length);
    for (const message of messages) {
      expect(message).toContain("prowlarr");
      expect(message).toContain("system/status");
    }
  });
});
