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

/**
 * One answer to a validating write: the status the instance chose, and whatever
 * body came with it.
 *
 * `accepted` is the status class rather than an interpretation of the body,
 * because what a body means is the domain adapter's business and what a status
 * means is HTTP's.
 */
export interface UpstreamValidation {
  readonly accepted: boolean;
  readonly status: number;
  /** Parsed where the instance sent JSON, `undefined` where it sent nothing. */
  readonly body: unknown;
}

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
  /**
   * Sends a write whose refusal is itself the answer.
   *
   * These APIs report a failed provider validation as a `400` whose body is the
   * list of what failed, so a caller that only learned the status would have to
   * report "the instance refused it" and could never say why, whether the
   * refusal was a warning or an error, or which field it was about. That is the
   * one case where the body of a rejection is the payload rather than a
   * diagnostic, so this hands it back as data instead of discarding it.
   *
   * It is deliberately not the general write path. Only a transport failure
   * throws here; a status the instance chose is returned, which means the
   * caller takes on the job of deciding what the answer means — and the job of
   * keeping the returned body out of anything published, since it is upstream
   * content like any other.
   */
  validate(path: string, body: UpstreamBody, query?: UpstreamQuery): Promise<UpstreamValidation>;
  /**
   * Removes an upstream resource. Only a mutation adapter may call this.
   *
   * It carries no body, because none of these APIs reads one on a delete: what
   * is removed is named by the route, and the flags that change what a delete
   * means — the queue's removal precedence, most consequentially — are query
   * parameters an adapter authors explicitly.
   */
  delete(path: string, query?: UpstreamQuery): Promise<unknown>;
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

/** Parses a body that may not be JSON at all, which a rejection often is not. */
function readJson(text: string): unknown {
  if (text.trim() === "") {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
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
  /**
   * The answer `send` gives instead of a bare body, and only when asked.
   *
   * It exists so `validate` can report the status the instance chose — and read
   * a rejection it chose — without a second copy of the request path: the
   * joining, the serialization, the timeout, and the redaction all have to be
   * the same, or a validating write would be a different request than every
   * other write. Nothing else passes the flag that produces one, so no other
   * method can receive it.
   */
  interface RetainedAnswer {
    readonly retainedStatus: number;
    readonly retainedBody: unknown;
  }

  const isRetainedAnswer = (value: unknown): value is RetainedAnswer =>
    typeof value === "object" && value !== null && "retainedStatus" in value;

  const send = async (
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    query: UpstreamQuery | undefined,
    body: UpstreamBody | undefined,
    retainStatus = false,
  ): Promise<unknown> => {
    const joined = joinUpstreamUrl(apiBaseUrl, path);
    if (!joined.ok) {
      throw new UpstreamError("invalid-request", { application, pathProblem: joined.problem });
    }

    // Serialized here, before anything is dispatched and before the fetch's
    // own catch is in scope. A value JSON cannot represent is a fault in this
    // project's own payload, not a failure to reach the instance, and folding
    // it into the catch below would report a working instance as unreachable —
    // sending the caller to look at the wrong system entirely. The thrown
    // value's message is deliberately dropped: a serializer quotes what it
    // choked on, and that is the payload.
    let payload: string | undefined;
    if (body !== undefined) {
      try {
        payload = JSON.stringify(body);
      } catch {
        throw new UpstreamError("invalid-request", {
          application,
          operation: path,
          bodyProblem: "unserializable",
        });
      }
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
            ...(payload === undefined ? {} : { "Content-Type": "application/json" }),
          },
          ...(payload === undefined ? {} : { body: payload }),
          signal: controller.signal,
        });
      } catch {
        throw fail(timedOut ? "timeout" : "unavailable");
      }

      if (!response.ok) {
        // A status below 500 is a decision the instance made about this request,
        // and for a validating write that decision's body is the answer. Above
        // it, the instance is reporting that it failed rather than that the
        // request did, which is not something to hand back as a result.
        if (retainStatus && response.status < 500) {
          let rejected: string;
          try {
            rejected = await response.text();
          } catch {
            // The body this answer consists of never arrived, which is a
            // transport failure and not a validation the instance performed.
            // Reading it as an empty rejection would report a test the caller
            // could act on where nothing was learned at all.
            throw fail(timedOut ? "timeout" : "unavailable");
          }
          return {
            retainedStatus: response.status,
            retainedBody: readJson(rejected),
          } satisfies RetainedAnswer;
        }
        discardBody(response);
        throw new UpstreamError(upstreamErrorKindForStatus(response.status), {
          application,
          operation: path,
          status: response.status,
          timeoutMs,
        });
      }

      let answered: string;
      try {
        answered = await response.text();
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
      if (method !== "GET" && answered.trim() === "" && !retainStatus) {
        return undefined;
      }

      if (retainStatus) {
        // The status the instance chose, for a caller that promised to report
        // it. A body that is not JSON is not a failure here either: the caller
        // reads what came back rather than assuming a shape.
        return {
          retainedStatus: response.status,
          retainedBody: readJson(answered),
        } satisfies RetainedAnswer;
      }

      try {
        return JSON.parse(answered) as unknown;
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

    async validate(
      path: string,
      body: UpstreamBody,
      query?: UpstreamQuery,
    ): Promise<UpstreamValidation> {
      // The same request `post` sends, answered rather than thrown where the
      // instance chose the status. A transport failure still throws, because a
      // validation this server never received is not a validation that
      // answered — and telling those apart is the whole point of the method.
      const answered = await send("POST", path, query, body, true);
      if (!isRetainedAnswer(answered)) {
        // Unreachable: the flag above is what produces the envelope, and this
        // is the only site that passes it. Refused rather than assumed, because
        // inventing a status here would be inventing the very thing this method
        // exists to report.
        throw new UpstreamError("unexpected-response", { application, operation: path });
      }
      return {
        // The 2xx range rather than "not a rejection": a redirect is neither a
        // success nor a validation the instance performed, and reading one as
        // accepted would let it stand in for a test that passed.
        accepted: answered.retainedStatus >= 200 && answered.retainedStatus < 300,
        status: answered.retainedStatus,
        body: answered.retainedBody,
      };
    },

    delete(path: string, query?: UpstreamQuery): Promise<unknown> {
      return send("DELETE", path, query, undefined);
    },
  };
}
