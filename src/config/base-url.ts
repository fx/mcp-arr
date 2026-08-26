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

/**
 * Appends a relative upstream path to an already normalized base, keeping the
 * base path prefix intact and refusing anything that could escape it.
 */
export function joinUpstreamUrl(base: string, path: string): string {
  const trimmed = path.replace(/^\/+|\/+$/gu, "");
  if (trimmed === "") {
    throw new Error("Upstream path must not be empty");
  }
  if (/[?#]/u.test(trimmed)) {
    throw new Error(`Upstream path must not contain a query string or fragment: ${path}`);
  }
  const segments = trimmed.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`Upstream path must not contain empty or relative segments: ${path}`);
  }

  return `${base.replace(/\/+$/u, "")}/${segments.join("/")}`;
}
