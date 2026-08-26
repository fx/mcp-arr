export type BaseUrlProblem =
  | "not-absolute"
  | "unsupported-scheme"
  | "embedded-credentials"
  | "query-or-fragment";

export type BaseUrlResult =
  | { readonly ok: true; readonly baseUrl: string }
  | { readonly ok: false; readonly problem: BaseUrlProblem };

const problemDescriptions: Readonly<Record<BaseUrlProblem, string>> = {
  "not-absolute": "must be an absolute URL",
  "unsupported-scheme": "must use the http or https scheme",
  "embedded-credentials": "must not embed credentials",
  "query-or-fragment": "must not include a query string or fragment",
};

export function describeBaseUrlProblem(problem: BaseUrlProblem): string {
  return problemDescriptions[problem];
}

/**
 * Normalizes a configured base URL without changing its path prefix, so an
 * instance served from `https://host/sonarr` keeps the `/sonarr` prefix.
 */
export function normalizeBaseUrl(raw: string): BaseUrlResult {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, problem: "not-absolute" };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, problem: "unsupported-scheme" };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, problem: "embedded-credentials" };
  }
  if (url.search !== "" || url.hash !== "") {
    return { ok: false, problem: "query-or-fragment" };
  }

  const pathPrefix = url.pathname.replace(/\/+$/u, "");
  return { ok: true, baseUrl: `${url.protocol}//${url.host}${pathPrefix}` };
}

export type UpstreamPathProblem =
  | "empty"
  | "query-or-fragment"
  | "relative-segment"
  | "unparseable"
  | "rewritten";

export type UpstreamPathResult =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly problem: UpstreamPathProblem };

const pathProblemDescriptions: Readonly<Record<UpstreamPathProblem, string>> = {
  empty: "must not be empty",
  "query-or-fragment": "must not contain a query string or fragment",
  "relative-segment": "must not contain empty or relative segments",
  unparseable: "must produce a valid URL",
  rewritten: "must not change the resolved URL",
};

export function describeUpstreamPathProblem(problem: UpstreamPathProblem): string {
  return pathProblemDescriptions[problem];
}

/**
 * Appends a relative upstream path to an already normalized base, keeping the
 * base path prefix intact and refusing anything that could escape it.
 *
 * The literal segment checks alone are not enough: WHATWG URL parsing resolves
 * percent-encoded dot segments and treats a backslash as a separator, so
 * `%2e%2e/` and `..\` escape the prefix once the string reaches `fetch`. The
 * result is therefore re-parsed and required to survive unchanged, which
 * rejects every such representation while leaving an already-encoded segment
 * such as `lookup%20term` intact.
 *
 * A rejection reports a typed problem rather than throwing, so no caller
 * supplied path is ever embedded in a message that could reach a log.
 */
export function joinUpstreamUrl(base: string, path: string): UpstreamPathResult {
  const trimmed = path.replace(/^\/+|\/+$/gu, "");
  if (trimmed === "") {
    return { ok: false, problem: "empty" };
  }
  if (/[?#]/u.test(trimmed)) {
    return { ok: false, problem: "query-or-fragment" };
  }
  const segments = trimmed.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return { ok: false, problem: "relative-segment" };
  }

  const joined = `${base.replace(/\/+$/u, "")}/${segments.join("/")}`;
  let resolved: URL;
  try {
    resolved = new URL(joined);
  } catch {
    return { ok: false, problem: "unparseable" };
  }
  if (resolved.href !== joined) {
    return { ok: false, problem: "rewritten" };
  }

  return { ok: true, url: joined };
}
