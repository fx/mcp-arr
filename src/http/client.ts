import type { ApplicationId } from "../applications.js";
import { describeUpstreamPathProblem, joinUpstreamUrl } from "../config/base-url.js";
import { UpstreamError, type UpstreamErrorKind, upstreamErrorKindForStatus } from "./errors.js";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export const defaultUpstreamTimeoutMs = 10_000;

export interface UpstreamClientOptions {
  readonly application: ApplicationId;
  /** Normalized instance base URL, including any path prefix. */
  readonly baseUrl: string;
  /** Versioned API base path, such as `/api/v3`. */
  readonly apiBasePath: string;
  readonly apiKey: string;
  readonly timeoutMs?: number | undefined;
  readonly fetch?: FetchLike | undefined;
}

export type UpstreamQueryValue = string | number | boolean;

/**
 * The query parameters one upstream read may carry.
 *
 * Names are authored here in adapter code, never taken from a caller, and an
 * `undefined` value drops its parameter rather than sending an empty one.
 * Values may be caller-derived — a lookup term is — so they are percent-encoded
 * and, deliberately, never reach an error message.
 */
export type UpstreamQuery = Readonly<Record<string, UpstreamQueryValue | undefined>>;

/**
 * A request body an adapter sends upstream.
 *
 * It is always a value this project built — a resource read from the instance
 * with the fields a validated mutation changes written over it, or a payload
 * assembled from validated arguments — never a caller-supplied blob passed
 * through, because no published input accepts one.
 */
export type UpstreamBody = Readonly<Record<string, unknown>>;

export interface UpstreamClient {
  readonly application: ApplicationId;
  /**
   * The resolved versioned API base, exposed so adapters and tests can assert
   * which instance a request targets. It carries no credential — the API key
   * stays captured in the closure and is only ever sent as a header — but it is
   * still a configured value, so keep it out of tool results and diagnostics.
   */
  readonly apiBaseUrl: string;
  get(path: string, query?: UpstreamQuery): Promise<unknown>;
  /** Creates an upstream resource. Only a mutation adapter may call this. */
  post(path: string, body: UpstreamBody, query?: UpstreamQuery): Promise<unknown>;
  /** Replaces an upstream resource. Only a mutation adapter may call this. */
  put(path: string, body: UpstreamBody, query?: UpstreamQuery): Promise<unknown>;
}

/**
 * Serializes a query into a percent-encoded search string.
 *
 * Parameters are emitted in sorted name order so the same request always
 * produces the same URL regardless of how an adapter happened to build the
 * object, and every value goes through `URLSearchParams`, so a term containing
 * `&`, `#`, or `?` cannot alter the request it belongs to.
 */
function buildQueryString(query: UpstreamQuery): string {
  const params = new URLSearchParams();
  for (const name of Object.keys(query).sort()) {
    const value = query[name];
    if (value !== undefined) {
      params.append(name, String(value));
    }
  }
  const encoded = params.toString();
  return encoded === "" ? "" : `?${encoded}`;
}

function discardBody(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

/**
 * The single upstream boundary every adapter calls through. It injects the
 * configured API key, keeps the base path prefix intact, enforces a finite
 * timeout, and converts every failure into a redacted {@link UpstreamError}.
 */
export function createUpstreamClient(options: UpstreamClientOptions): UpstreamClient {
  const timeoutMs = options.timeoutMs ?? defaultUpstreamTimeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("Upstream timeout must be a finite positive number of milliseconds");
  }

  const application = options.application;
  const apiBase = joinUpstreamUrl(options.baseUrl, options.apiBasePath);
  if (!apiBase.ok) {
    throw new RangeError(`Upstream API base path ${describeUpstreamPathProblem(apiBase.problem)}`);
  }
  const apiBaseUrl = apiBase.url;
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));

  /**
   * Sends one request and returns its parsed body.
   *
   * Every method shares this path, so a write is redacted, timed out, and
   * normalized exactly like a read. A write differs only in carrying a body:
   * the payload is serialized here rather than by the caller, so no adapter can
   * send something that is not JSON, and a successful response with no body —
   * which several upstream writes answer with — resolves as `undefined` rather
   * than as a parse failure.
   */
  const send = async (
    method: "GET" | "POST" | "PUT",
    path: string,
    query: UpstreamQuery | undefined,
    body: UpstreamBody | undefined,
  ): Promise<unknown> => {
    const joined = joinUpstreamUrl(apiBaseUrl, path);
    if (!joined.ok) {
      throw new UpstreamError("invalid-request", { application, pathProblem: joined.problem });
    }

    // Appended after the path is validated and joined, and deliberately kept
    // out of `operation` below: the route names the failure, while a query
    // value can be caller-derived and must never reach a diagnostic.
    const url = `${joined.url}${query === undefined ? "" : buildQueryString(query)}`;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    timer.unref();

    const fail = (kind: UpstreamErrorKind): UpstreamError =>
      new UpstreamError(kind, { application, operation: path, timeoutMs });

    try {
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method,
          headers: {
            "X-Api-Key": options.apiKey,
            Accept: "application/json",
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: controller.signal,
        });
      } catch {
        throw fail(timedOut ? "timeout" : "unavailable");
      }

      if (!response.ok) {
        discardBody(response);
        throw new UpstreamError(upstreamErrorKindForStatus(response.status), {
          application,
          operation: path,
          status: response.status,
          timeoutMs,
        });
      }

      let payload: string;
      try {
        payload = await response.text();
      } catch {
        throw fail(timedOut ? "timeout" : "unavailable");
      }

      // Only a write may answer with no content. Several upstream writes do,
      // and treating that as a broken response would fail a request the
      // instance accepted. A read is held to its payload exactly as it always
      // was: an empty body falls through to the parse below and is reported as
      // an unexpected response carrying the status, because a read that
      // returned nothing has not answered the question it was asked, and
      // losing that status would leave the caller with less than it had.
      if (method !== "GET" && payload.trim() === "") {
        return undefined;
      }

      try {
        return JSON.parse(payload) as unknown;
      } catch {
        throw new UpstreamError("unexpected-response", {
          application,
          operation: path,
          status: response.status,
          timeoutMs,
        });
      }
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    application,
    apiBaseUrl,

    get(path: string, query?: UpstreamQuery): Promise<unknown> {
      return send("GET", path, query, undefined);
    },

    post(path: string, body: UpstreamBody, query?: UpstreamQuery): Promise<unknown> {
      return send("POST", path, query, body);
    },

    put(path: string, body: UpstreamBody, query?: UpstreamQuery): Promise<unknown> {
      return send("PUT", path, query, body);
    },
  };
}
