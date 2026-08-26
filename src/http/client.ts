import type { ApplicationId } from "../applications.js";
import { joinUpstreamUrl } from "../config/base-url.js";
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

export interface UpstreamClient {
  readonly application: ApplicationId;
  /** The resolved versioned API base, exposed for diagnostics and tests. */
  readonly apiBaseUrl: string;
  get(path: string): Promise<unknown>;
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
  const apiBaseUrl = joinUpstreamUrl(options.baseUrl, options.apiBasePath);
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));

  return {
    application,
    apiBaseUrl,

    async get(path: string): Promise<unknown> {
      const url = joinUpstreamUrl(apiBaseUrl, path);
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
