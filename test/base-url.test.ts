import { describe, expect, it } from "vitest";
import {
  type BaseUrlProblem,
  describeBaseUrlProblem,
  describeUpstreamPathProblem,
  joinUpstreamUrl,
  normalizeBaseUrl,
  type UpstreamPathProblem,
} from "../src/config/base-url.js";

function normalized(raw: string): string {
  const result = normalizeBaseUrl(raw);
  if (!result.ok) {
    throw new Error(`Expected ${raw} to normalize, got ${result.problem}`);
  }
  return result.baseUrl;
}

function joined(base: string, path: string): string {
  const result = joinUpstreamUrl(base, path);
  if (!result.ok) {
    throw new Error(`Expected ${path} to join, got ${result.problem}`);
  }
  return result.url;
}

function pathProblemOf(base: string, path: string): UpstreamPathProblem {
  const result = joinUpstreamUrl(base, path);
  if (result.ok) {
    throw new Error(`Expected ${path} to be rejected, got ${result.url}`);
  }
  return result.problem;
}

function problemOf(raw: string): BaseUrlProblem {
  const result = normalizeBaseUrl(raw);
  if (result.ok) {
    throw new Error(`Expected ${raw} to be rejected, got ${result.baseUrl}`);
  }
  return result.problem;
}

describe("normalizeBaseUrl", () => {
  it("preserves a configured path prefix and drops only trailing slashes", () => {
    expect(normalized("https://sonarr.example.invalid/sonarr")).toBe(
      "https://sonarr.example.invalid/sonarr",
    );
    expect(normalized("https://sonarr.example.invalid/sonarr/")).toBe(
      "https://sonarr.example.invalid/sonarr",
    );
    expect(normalized("https://sonarr.example.invalid/sonarr///")).toBe(
      "https://sonarr.example.invalid/sonarr",
    );
    expect(normalized("https://sonarr.example.invalid/deep/prefix")).toBe(
      "https://sonarr.example.invalid/deep/prefix",
    );
  });

  it("normalizes the origin without inventing a path", () => {
    expect(normalized("  http://sonarr.example.invalid:8989/  ")).toBe(
      "http://sonarr.example.invalid:8989",
    );
    expect(normalized("HTTP://Sonarr.Example.INVALID")).toBe("http://sonarr.example.invalid");
    expect(normalized("https://sonarr.example.invalid:443")).toBe("https://sonarr.example.invalid");
  });

  it("rejects non-absolute, non-http, credentialed, and query-bearing URLs", () => {
    expect(problemOf("sonarr.example.invalid")).toBe("not-absolute");
    expect(problemOf("/sonarr")).toBe("not-absolute");
    expect(problemOf("")).toBe("not-absolute");
    expect(problemOf("ftp://sonarr.example.invalid")).toBe("unsupported-scheme");
    expect(problemOf("file:///sonarr")).toBe("unsupported-scheme");
    expect(problemOf("https://user:secret@sonarr.example.invalid")).toBe("embedded-credentials");
    expect(problemOf("https://sonarr.example.invalid?apikey=secret")).toBe("query-or-fragment");
    expect(problemOf("https://sonarr.example.invalid#fragment")).toBe("query-or-fragment");
  });

  it("describes every problem without echoing a configured value", () => {
    const problems: readonly BaseUrlProblem[] = [
      "not-absolute",
      "unsupported-scheme",
      "embedded-credentials",
      "query-or-fragment",
    ];
    for (const problem of problems) {
      expect(describeBaseUrlProblem(problem)).toMatch(/^must /u);
    }
  });
});

describe("joinUpstreamUrl", () => {
  it("appends relative paths while keeping the base prefix", () => {
    const base = "https://sonarr.example.invalid/sonarr";
    expect(joined(base, "/api/v3")).toBe("https://sonarr.example.invalid/sonarr/api/v3");
    expect(joined(`${base}/api/v3`, "system/status")).toBe(
      "https://sonarr.example.invalid/sonarr/api/v3/system/status",
    );
    expect(joined(`${base}/`, "series")).toBe("https://sonarr.example.invalid/sonarr/series");
  });

  it("refuses paths that could escape or reshape the base", () => {
    const base = "https://sonarr.example.invalid/sonarr";
    expect(pathProblemOf(base, "")).toBe("empty");
    expect(pathProblemOf(base, "///")).toBe("empty");
    expect(pathProblemOf(base, "system/status?apikey=secret")).toBe("query-or-fragment");
    expect(pathProblemOf(base, "system#fragment")).toBe("query-or-fragment");
    expect(pathProblemOf(base, "../api/v3")).toBe("relative-segment");
    expect(pathProblemOf(base, "system//status")).toBe("relative-segment");
    expect(pathProblemOf(base, "./status")).toBe("relative-segment");
  });

  it("refuses every traversal representation URL parsing would resolve", () => {
    const base = "https://sonarr.example.invalid/prefix/api/v3";
    const traversals = [
      "%2e%2e/%2e%2e/status",
      "%2E%2E/admin",
      "%2e/status",
      "..\\..\\status",
      "system\\..\\..\\admin",
    ];

    for (const traversal of traversals) {
      expect(pathProblemOf(base, traversal)).toBe("rewritten");
      // Each one is rejected precisely because URL parsing rewrites it.
      expect(new URL(`${base}/${traversal}`).href).not.toBe(`${base}/${traversal}`);
    }

    // The dot-dot forms leave the configured prefix outright.
    for (const traversal of ["%2e%2e/%2e%2e/status", "%2E%2E/admin", "..\\..\\status"]) {
      expect(new URL(`${base}/${traversal}`).pathname.startsWith("/prefix/api/v3/")).toBe(false);
    }
  });

  it("reports an unparseable result rather than throwing", () => {
    expect(pathProblemOf("not-a-base", "system/status")).toBe("unparseable");
  });

  it("keeps an already-encoded segment that resolves unchanged", () => {
    const base = "https://sonarr.example.invalid/api/v3";
    expect(joined(base, `movie/lookup/${encodeURIComponent("a title")}`)).toBe(
      "https://sonarr.example.invalid/api/v3/movie/lookup/a%20title",
    );
  });

  it("never embeds the supplied path in a problem description", () => {
    const problems: readonly UpstreamPathProblem[] = [
      "empty",
      "query-or-fragment",
      "relative-segment",
      "unparseable",
      "rewritten",
    ];
    const descriptions = problems.map((problem) => describeUpstreamPathProblem(problem));

    expect(new Set(descriptions).size).toBe(problems.length);
    for (const description of descriptions) {
      expect(description).toMatch(/^must /u);
    }
    // A rejection returns a discriminant, so there is no message to leak into.
    const rejected = joinUpstreamUrl("https://host.invalid", "secret/../token?key=value");
    expect(rejected).toEqual({ ok: false, problem: "query-or-fragment" });
  });
});
