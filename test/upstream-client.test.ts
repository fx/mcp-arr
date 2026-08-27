import { describe, expect, it } from "vitest";
import { describeUpstreamPathProblem, type UpstreamPathProblem } from "../src/config/base-url.js";
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

  it("appends a query in a stable order and drops the parameters left unset", async () => {
    const { client, calls } = harness(() => json([]));

    await client.get("wanted/missing", {
      pageSize: 25,
      page: 1,
      monitored: undefined,
      includeSeries: true,
    });

    // Sorted by parameter name, so the same request always produces the same
    // URL no matter how the adapter happened to build the object.
    expect(calls[0]?.url).toBe(
      "https://sonarr.example.invalid/sonarr/api/v3/wanted/missing?includeSeries=true&page=1&pageSize=25",
    );

    await client.get("series");
    expect(calls[1]?.url).toBe("https://sonarr.example.invalid/sonarr/api/v3/series");

    await client.get("series", {});
    expect(calls[2]?.url).toBe("https://sonarr.example.invalid/sonarr/api/v3/series");
  });

  it("encodes a query value rather than letting it alter the request", async () => {
    const { client, calls } = harness(() => json([]));

    await client.get("series/lookup", { term: "a&b=c?d#e /f" });

    const url = new URL(calls[0]?.url ?? "");
    expect(url.pathname).toBe("/sonarr/api/v3/series/lookup");
    expect([...url.searchParams.keys()]).toEqual(["term"]);
    expect(url.searchParams.get("term")).toBe("a&b=c?d#e /f");
  });

  it("keeps a query value out of the failure it reports", async () => {
    const term = "sensitive lookup term";
    const { client } = harness(() => json({ message: `rejected ${apiKey}` }, 401));

    const error = await captureError(client.get("series/lookup", { term }));
    expect(error.kind).toBe("authentication");
    expect(error.operation).toBe("series/lookup");
    expect(`${error.message}\n${JSON.stringify(error.toJSON())}`).not.toContain(term);
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

  it("sends a write as JSON without disturbing how a read is sent", async () => {
    const { client, calls } = harness(() => json({ id: 12 }));

    await expect(client.post("series", { title: "Example Series" })).resolves.toEqual({ id: 12 });
    await expect(
      client.put("series/12", { id: 12, monitored: false }, { moveFiles: false }),
    ).resolves.toEqual({
      id: 12,
    });

    const created = calls[0];
    expect(created?.url).toBe("https://sonarr.example.invalid/sonarr/api/v3/series");
    expect(created?.init.method).toBe("POST");
    expect(created?.init.body).toBe(JSON.stringify({ title: "Example Series" }));
    const createdHeaders = new Headers(created?.init.headers);
    // A write carries the same credential and the same base prefix a read
    // does; the only difference is the body and the type that describes it.
    expect(createdHeaders.get("X-Api-Key")).toBe(apiKey);
    expect(createdHeaders.get("Accept")).toBe("application/json");
    expect(createdHeaders.get("Content-Type")).toBe("application/json");
    expect(created?.init.signal).toBeInstanceOf(AbortSignal);

    const replaced = calls[1];
    expect(replaced?.url).toBe(
      "https://sonarr.example.invalid/sonarr/api/v3/series/12?moveFiles=false",
    );
    expect(replaced?.init.method).toBe("PUT");
    expect(replaced?.init.body).toBe(JSON.stringify({ id: 12, monitored: false }));
  });

  it("resolves a write the instance accepted without a body", async () => {
    const { client } = harness(() => new Response(null, { status: 204 }));

    // Several upstream writes answer with no content. That is an accepted
    // request, not a body this server failed to parse.
    await expect(client.post("series", { title: "Example" })).resolves.toBeUndefined();
    await expect(client.put("series/12", { id: 12 })).resolves.toBeUndefined();
  });

  it("accepts an empty body from a write and refuses one from a read", async () => {
    // The same status and the same empty body, answered differently by method.
    // A write that says nothing was still accepted; a read that says nothing
    // has not answered the question it was asked, and reporting it as an
    // unexpected response is what keeps the status with the failure.
    const { client: writer } = harness(() => new Response("", { status: 200 }));
    await expect(writer.post("series", { title: "Example" })).resolves.toBeUndefined();
    await expect(writer.put("series/12", { id: 12 })).resolves.toBeUndefined();

    const { client: reader } = harness(() => new Response("", { status: 200 }));
    const error = await captureError(reader.get("series"));
    expect(error.kind).toBe("unexpected-response");
    expect(error.status).toBe(200);
    expect(error.operation).toBe("series");
  });

  it("redacts a failed write exactly as it redacts a failed read", async () => {
    const secret = "sensitive-title-value";

    for (const status of [400, 401, 404, 429, 500]) {
      const { client } = harness(() => json({ message: `raw upstream body ${apiKey}` }, status));
      const error = await captureError(client.put("series/12", { title: secret }));
      expect(error.kind).toBe(upstreamErrorKindForStatus(status));
      expect(error.status).toBe(status);
      expect(error.operation).toBe("series/12");
      // Neither the response body nor the payload that was sent reaches the
      // failure, and neither does the configured credential.
      const disclosed = `${error.message}\n${JSON.stringify(error.toJSON())}`;
      expect(disclosed).not.toContain(apiKey);
      expect(disclosed).not.toContain(secret);
      expect(disclosed).not.toContain("raw upstream body");
    }
  });

  it("reports an unreachable instance and a silent one the same way for a write", async () => {
    const unreachable = harness(() => {
      throw new TypeError(`fetch failed for https://user:${apiKey}@sonarr.example.invalid`);
    });
    const failure = await captureError(unreachable.client.post("series", { title: "Example" }));
    expect(failure.kind).toBe("unavailable");
    expect(failure.message).not.toContain(apiKey);

    const silent = harness(
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          call.init.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
      { timeoutMs: 5 },
    );
    const timeout = await captureError(silent.client.put("series/12", { id: 12 }));
    expect(timeout.kind).toBe("timeout");
    expect(timeout.message).toContain("timed out after 5ms");
    expect(silent.calls[0]?.init.signal?.aborted).toBe(true);
  });

  it("refuses a body it cannot serialize and never reaches for the instance", async () => {
    const { client, calls } = harness(() => json({ id: 12 }));
    const secret = "sensitive-title-value";
    const circular: Record<string, unknown> = { title: secret };
    circular.self = circular;

    for (const unserializable of [{ title: secret, size: 1n }, circular]) {
      const rejection = client.post("series", unserializable);
      await expect(rejection).rejects.toBeInstanceOf(UpstreamError);
      const error = await captureError(rejection);
      // A payload this project cannot represent is its own fault, not an
      // unreachable instance: reporting `unavailable` would send the caller to
      // look at a system that is working fine.
      expect(error.kind).toBe("invalid-request");
      expect(error.bodyProblem).toBe("unserializable");
      expect(error.operation).toBe("series");
      expect(error.status).toBeUndefined();
      expect(error.message).toContain("body could not be serialized");
      // A serializer quotes the value it choked on, so its message is dropped.
      const disclosed = `${error.message}\n${JSON.stringify(error.toJSON())}`;
      expect(disclosed).not.toContain(secret);
      expect(disclosed).not.toContain(apiKey);
    }

    // Nothing was ever dispatched.
    expect(calls).toEqual([]);
  });

  it("refuses an unusable path on a write before anything is dispatched", async () => {
    const { client, calls } = harness(() => json({ id: 12 }));

    const rejection = client.post("../../admin", { title: "Example" });
    await expect(rejection).rejects.toBeInstanceOf(UpstreamError);
    expect((await captureError(rejection)).pathProblem).toBe("relative-segment");
    expect(calls).toEqual([]);
  });

  it("reports a non-JSON success body on a write as an unexpected response", async () => {
    const { client } = harness(() => new Response("<html>accepted</html>", { status: 201 }));

    const error = await captureError(client.post("series", { title: "Example" }));
    expect(error.kind).toBe("unexpected-response");
    expect(error.status).toBe(201);
  });

  it("answers a validating write's rejection instead of throwing it away", async () => {
    const findings = [{ isWarning: true, propertyName: "onGrab", errorMessage: "example" }];
    const { client, calls } = harness(() => json(findings, 400));

    const answered = await client.validate("notification/test", { id: 1 });

    // The refusal is the answer for this endpoint, so the body comes back as
    // data. Everything else about the request is what `post` would have sent.
    expect(answered).toEqual({
      accepted: false,
      status: 400,
      body: findings,
      unreadableBody: false,
    });
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.body).toBe(JSON.stringify({ id: 1 }));
    expect(new Headers(calls[0]?.init.headers).get("X-Api-Key")).toBe(apiKey);
  });

  it("keeps a validating write's other failures as failures", async () => {
    // Above 500 the instance is reporting that it failed rather than that the
    // request did, and a transport failure answered nothing at all. Neither is
    // a validation result, so both still throw.
    const { client: broken } = harness(() => json({ message: "boom" }, 503));
    const serverError = await captureError(broken.validate("notification/test", { id: 1 }));
    expect(serverError.kind).toBe("unexpected-response");

    const { client: unreachable } = harness(() => {
      throw new Error("connection reset");
    });
    const lost = await captureError(unreachable.validate("notification/test", { id: 1 }));
    expect(lost.kind).toBe("unavailable");
  });

  it("answers an accepted validating write and a body-less one alike", async () => {
    const { client: clean } = harness(() => json([], 200));
    await expect(clean.validate("notification/test", { id: 1 })).resolves.toEqual({
      accepted: true,
      status: 200,
      body: [],
      unreadableBody: false,
    });

    // Nothing arrived, which is not the same fact as something arriving that
    // could not be read — and the two are now told apart by a field rather
    // than by a comment explaining that they cannot be.
    const { client: silent } = harness(() => new Response(null, { status: 200 }));
    await expect(silent.validate("notification/test", { id: 1 })).resolves.toEqual({
      accepted: true,
      status: 200,
      body: undefined,
      unreadableBody: false,
    });

    // A rejection that is not JSON at all is common for these endpoints, and it
    // is still a rejection rather than a broken response — but the instance did
    // have something to say, and this says that it went unheard.
    const { client: prose } = harness(() => new Response("not json", { status: 400 }));
    await expect(prose.validate("notification/test", { id: 1 })).resolves.toEqual({
      accepted: false,
      status: 400,
      body: undefined,
      unreadableBody: true,
    });
  });

  it("surfaces a redirect as itself rather than following it with the credential", async () => {
    const { client, calls } = harness(() => new Response(null, { status: 302 }));

    // Asked for, not assumed: the request declares that a redirect is to be
    // reported rather than followed, because following one would send this
    // instance's API key to a location the instance named rather than the one
    // an operator configured.
    await captureError(client.get("system/status"));
    expect(calls[0]?.init.redirect).toBe("manual");

    // A redirect is neither a success nor a validation the instance performed,
    // so its status is reported and it is not acceptance. Without the mode
    // above the client would never see the 3xx at all: the runtime would follow
    // it and hand back whatever answered, and a redirect could stand in for a
    // test that passed.
    await expect(client.validate("notification/test", { id: 1 })).resolves.toMatchObject({
      accepted: false,
      status: 302,
    });

    // On the ordinary paths it is the error a misconfigured base URL deserves,
    // rather than something this client quietly works around.
    const read = await captureError(client.get("system/status"));
    expect(read.kind).toBe("unexpected-response");
    expect(read.status).toBe(302);
    const written = await captureError(client.post("notification", { id: 1 }));
    expect(written.kind).toBe("unexpected-response");
    expect(written.status).toBe(302);
  });

  it("fails a validating write whose rejection body never arrived", async () => {
    const { client } = harness(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("stream failed"));
            },
          }),
          { status: 400 },
        ),
    );

    // The body is what this answer consists of. Reading its loss as an empty
    // rejection would report a test the caller could act on where nothing was
    // learned at all.
    const error = await captureError(client.validate("notification/test", { id: 1 }));
    expect(error.kind).toBe("unavailable");
  });

  it("sends a delete with its query, its credential, and no body at all", async () => {
    const { client, calls } = harness(() => json({ id: 7001 }));

    await expect(client.delete("blocklist/7001")).resolves.toEqual({ id: 7001 });
    await expect(
      client.delete("queue/502", { removeFromClient: true, blocklist: false }),
    ).resolves.toEqual({ id: 7001 });

    const removed = calls[0];
    expect(removed?.url).toBe("https://sonarr.example.invalid/sonarr/api/v3/blocklist/7001");
    expect(removed?.init.method).toBe("DELETE");
    expect(removed?.init.body).toBeUndefined();
    const headers = new Headers(removed?.init.headers);
    expect(headers.get("X-Api-Key")).toBe(apiKey);
    expect(headers.get("Accept")).toBe("application/json");
    // No body means no type describing one, which is what keeps a delete from
    // looking like a write that simply forgot its payload.
    expect(headers.get("Content-Type")).toBeNull();
    expect(removed?.init.signal).toBeInstanceOf(AbortSignal);

    // The flags that change what a delete means travel as query parameters an
    // adapter authors, in the same sorted order every other request uses.
    expect(calls[1]?.url).toBe(
      "https://sonarr.example.invalid/sonarr/api/v3/queue/502?blocklist=false&removeFromClient=true",
    );
  });

  it("resolves a delete the instance accepted without a body", async () => {
    // Pinned rather than left as an inference from the method gate: both
    // applications answer a single-record removal with no content, and either
    // status has to resolve rather than fail to parse an empty body.
    for (const response of [
      () => new Response(null, { status: 204 }),
      () => new Response("", { status: 200 }),
    ]) {
      const { client } = harness(response);
      await expect(client.delete("blocklist/7001")).resolves.toBeUndefined();
    }
  });

  it("redacts a failed delete exactly as it redacts a failed read and write", async () => {
    for (const status of [400, 401, 404, 429, 500]) {
      const { client } = harness(() => json({ message: `raw upstream body ${apiKey}` }, status));
      const error = await captureError(client.delete("blocklist/7001"));
      expect(error.kind).toBe(upstreamErrorKindForStatus(status));
      expect(error.status).toBe(status);
      expect(error.operation).toBe("blocklist/7001");
      const disclosed = `${error.message}\n${JSON.stringify(error.toJSON())}`;
      expect(disclosed).not.toContain(apiKey);
      expect(disclosed).not.toContain("raw upstream body");
    }
  });

  it("reports an unreachable instance and a silent one the same way for a delete", async () => {
    const unreachable = harness(() => {
      throw new TypeError(`fetch failed for https://user:${apiKey}@sonarr.example.invalid`);
    });
    const failure = await captureError(unreachable.client.delete("blocklist/7001"));
    expect(failure.kind).toBe("unavailable");
    expect(failure.message).not.toContain(apiKey);

    const silent = harness(
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          call.init.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
      { timeoutMs: 5 },
    );
    const timeout = await captureError(silent.client.delete("blocklist/7001"));
    expect(timeout.kind).toBe("timeout");
    expect(timeout.message).toContain("timed out after 5ms");
    expect(silent.calls[0]?.init.signal?.aborted).toBe(true);
  });

  it("refuses an unusable path on a delete and reports a non-JSON success body", async () => {
    const { client, calls } = harness(() => json({ id: 7001 }));
    const rejection = client.delete("../../admin");
    await expect(rejection).rejects.toBeInstanceOf(UpstreamError);
    expect((await captureError(rejection)).pathProblem).toBe("relative-segment");
    expect(calls).toEqual([]);

    const html = harness(() => new Response("<html>gone</html>", { status: 200 }));
    const error = await captureError(html.client.delete("blocklist/7001"));
    expect(error.kind).toBe("unexpected-response");
    expect(error.status).toBe(200);
  });

  it("normalizes an unusable path into an UpstreamError instead of a raw Error", async () => {
    const { client, calls } = harness(() => json({ version: "4.0.19.2979" }));
    const unusable: ReadonlyArray<readonly [string, UpstreamPathProblem]> = [
      ["", "empty"],
      ["system/status?apikey=secret", "query-or-fragment"],
      ["../../admin", "relative-segment"],
      ["%2e%2e/%2e%2e/admin", "rewritten"],
    ];

    for (const [path, problem] of unusable) {
      const rejection = client.get(path);
      await expect(rejection).rejects.toBeInstanceOf(UpstreamError);
      const error = await captureError(rejection);
      expect(error.kind).toBe("invalid-request");
      expect(error.pathProblem).toBe(problem);
      expect(error.operation).toBeUndefined();
      expect(error.status).toBeUndefined();
      // The unusable path never reaches the message or the serialized form.
      expect(`${error.message}\n${JSON.stringify(error.toJSON())}`).not.toContain("secret");
      expect(error.message).toContain(describeUpstreamPathProblem(problem));
    }

    // Nothing was ever dispatched.
    expect(calls).toEqual([]);
  });

  it("rejects an unusable API base path at construction", () => {
    expect(() =>
      createUpstreamClient({
        application: "sonarr",
        baseUrl: "https://sonarr.example.invalid",
        apiBasePath: "/api/../admin",
        apiKey,
        fetch: async () => json({}),
      }),
    ).toThrow("Upstream API base path must not contain empty or relative segments");
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
      pathProblem: undefined,
      bodyProblem: undefined,
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
    }
    // Every kind but invalid-request names the route it was attempting.
    for (const [index, message] of messages.entries()) {
      if (upstreamErrorKinds[index] !== "invalid-request") {
        expect(message).toContain("system/status");
      }
    }
  });

  it("describes an unusable path without a route and without the path", () => {
    const withProblem = new UpstreamError("invalid-request", {
      application: "sonarr",
      pathProblem: "query-or-fragment",
    });
    expect(withProblem.message).toBe(
      "sonarr: the request was not sent because its path must not contain a query string or fragment",
    );
    expect(withProblem.operation).toBeUndefined();

    const withoutProblem = new UpstreamError("invalid-request", { application: "sonarr" });
    expect(withoutProblem.message).toBe(
      "sonarr: the request was not sent because its path is unusable",
    );
    expect(withoutProblem.pathProblem).toBeUndefined();
  });
});
