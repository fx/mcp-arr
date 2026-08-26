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

  return {
    application,
    apiBaseUrl,

    async get(path: string, query?: UpstreamQuery): Promise<unknown> {
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
            method: "GET",
            headers: { "X-Api-Key": options.apiKey, Accept: "application/json" },
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

        let body: string;
        try {
          body = await response.text();
        } catch {
          throw fail(timedOut ? "timeout" : "unavailable");
        }

        try {
          return JSON.parse(body) as unknown;
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
    },
  };
}
