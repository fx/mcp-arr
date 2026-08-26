import { describe, expect, it } from "vitest";
import {
  type BaseUrlProblem,
  describeBaseUrlProblem,
  joinUpstreamUrl,
  normalizeBaseUrl,
} from "../src/config/base-url.js";

function normalized(raw: string): string {
  const result = normalizeBaseUrl(raw);
  if (!result.ok) {
    throw new Error(`Expected ${raw} to normalize, got ${result.problem}`);
  }
  return result.baseUrl;
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
    expect(joinUpstreamUrl(base, "/api/v3")).toBe("https://sonarr.example.invalid/sonarr/api/v3");
    expect(joinUpstreamUrl(`${base}/api/v3`, "system/status")).toBe(
      "https://sonarr.example.invalid/sonarr/api/v3/system/status",
    );
    expect(joinUpstreamUrl(`${base}/`, "series")).toBe(
      "https://sonarr.example.invalid/sonarr/series",
    );
  });

  it("refuses paths that could escape or reshape the base", () => {
    const base = "https://sonarr.example.invalid/sonarr";
    expect(() => joinUpstreamUrl(base, "")).toThrow("Upstream path must not be empty");
    expect(() => joinUpstreamUrl(base, "///")).toThrow("Upstream path must not be empty");
    expect(() => joinUpstreamUrl(base, "system/status?apikey=secret")).toThrow(
      "must not contain a query string or fragment",
    );
    expect(() => joinUpstreamUrl(base, "system#fragment")).toThrow(
      "must not contain a query string or fragment",
    );
    expect(() => joinUpstreamUrl(base, "../api/v3")).toThrow(
      "must not contain empty or relative segments",
    );
    expect(() => joinUpstreamUrl(base, "system//status")).toThrow(
      "must not contain empty or relative segments",
    );
    expect(() => joinUpstreamUrl(base, "./status")).toThrow(
      "must not contain empty or relative segments",
    );
  });
});
