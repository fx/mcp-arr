import { describe, expect, it, vi } from "vitest";
import { applicationDescriptors } from "../src/applications.js";
import {
  ConfigurationError,
  type EnvironmentRecord,
  findInstance,
  loadEnvironment,
  parseEnvironment,
} from "../src/config/environment.js";
import { defaultUpstreamTimeoutMs } from "../src/http/client.js";

const sonarrKey = "sonarr-secret-key";
const radarrKey = "radarr-secret-key";
const prowlarrKey = "prowlarr-secret-key";
const sonarrEnvironment: EnvironmentRecord = {
  SONARR_URL: "https://sonarr.example.invalid",
  SONARR_API_KEY: sonarrKey,
};
const timeoutProblem =
  "ARR_UPSTREAM_TIMEOUT_MS must be a whole number of milliseconds between 1 and 600000";
/** A configured timeout the parser refuses, used to prove it is never echoed. */
const rejectedTimeout = "999999999";

function expectProblems(env: EnvironmentRecord): readonly string[] {
  try {
    parseEnvironment(env);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigurationError);
    return (error as ConfigurationError).problems;
  }
  throw new Error("Expected the environment to be rejected");
}

describe("parseEnvironment", () => {
  it("accepts a single application and leaves the others unconfigured", () => {
    const configuration = parseEnvironment({
      SONARR_URL: "https://sonarr.example.invalid/sonarr/",
      SONARR_API_KEY: `  ${sonarrKey}  `,
    });

    expect(configuration.instances).toEqual([
      {
        application: "sonarr",
        baseUrl: "https://sonarr.example.invalid/sonarr",
        apiKey: sonarrKey,
      },
    ]);
    expect(findInstance(configuration, "sonarr")?.baseUrl).toBe(
      "https://sonarr.example.invalid/sonarr",
    );
    expect(findInstance(configuration, "radarr")).toBeUndefined();
    expect(findInstance(configuration, "prowlarr")).toBeUndefined();
  });

  it("accepts all three applications in descriptor order and ignores unrelated variables", () => {
    const configuration = parseEnvironment({
      PROWLARR_URL: "http://prowlarr.example.invalid:9696",
      PROWLARR_API_KEY: prowlarrKey,
      RADARR_URL: "https://radarr.example.invalid/radarr",
      RADARR_API_KEY: radarrKey,
      SONARR_URL: "https://sonarr.example.invalid",
      SONARR_API_KEY: sonarrKey,
      SONARR_EXTRA: "ignored",
      PATH: "/usr/bin",
    });

    expect(configuration.instances.map((instance) => instance.application)).toEqual([
      "sonarr",
      "radarr",
      "prowlarr",
    ]);
    expect(configuration.instances.map((instance) => instance.baseUrl)).toEqual([
      "https://sonarr.example.invalid",
      "https://radarr.example.invalid/radarr",
      "http://prowlarr.example.invalid:9696",
    ]);
  });

  it("rejects an incomplete pair by naming the missing variable", () => {
    expect(
      expectProblems({
        SONARR_URL: "https://sonarr.example.invalid",
        SONARR_API_KEY: sonarrKey,
        RADARR_URL: "https://radarr.example.invalid",
      }),
    ).toEqual(["RADARR_API_KEY is required when RADARR_URL is set"]);

    expect(
      expectProblems({
        SONARR_URL: "https://sonarr.example.invalid",
        SONARR_API_KEY: sonarrKey,
        PROWLARR_API_KEY: prowlarrKey,
      }),
    ).toEqual(["PROWLARR_URL is required when PROWLARR_API_KEY is set"]);
  });

  it("rejects present-but-empty variables", () => {
    expect(
      expectProblems({
        SONARR_URL: "   ",
        SONARR_API_KEY: sonarrKey,
      }),
    ).toEqual(["SONARR_URL is set but empty"]);

    expect(
      expectProblems({
        SONARR_URL: "https://sonarr.example.invalid",
        SONARR_API_KEY: "",
      }),
    ).toEqual(["SONARR_API_KEY is set but empty"]);

    expect(expectProblems({ RADARR_URL: "", RADARR_API_KEY: "\t\n" })).toEqual([
      "RADARR_URL is set but empty",
      "RADARR_API_KEY is set but empty",
    ]);
  });

  it("rejects an environment with no configured application", () => {
    const problems = expectProblems({ PATH: "/usr/bin" });
    expect(problems).toHaveLength(1);
    for (const descriptor of applicationDescriptors) {
      expect(problems[0]).toContain(descriptor.urlVariable);
      expect(problems[0]).toContain(descriptor.apiKeyVariable);
    }
  });

  it("rejects base URLs that are not absolute http or https", () => {
    expect(
      expectProblems({ SONARR_URL: "sonarr.example.invalid", SONARR_API_KEY: sonarrKey }),
    ).toEqual(["SONARR_URL must be an absolute URL"]);
    expect(
      expectProblems({ SONARR_URL: "ftp://sonarr.example.invalid", SONARR_API_KEY: sonarrKey }),
    ).toEqual(["SONARR_URL must use the http or https scheme"]);
    expect(
      expectProblems({
        SONARR_URL: `https://user:${sonarrKey}@sonarr.example.invalid`,
        SONARR_API_KEY: sonarrKey,
      }),
    ).toEqual(["SONARR_URL must not embed credentials"]);
  });

  it("reports every problem at once", () => {
    expect(
      expectProblems({
        SONARR_URL: "not-a-url",
        SONARR_API_KEY: sonarrKey,
        RADARR_URL: "https://radarr.example.invalid",
        PROWLARR_API_KEY: prowlarrKey,
      }),
    ).toEqual([
      "SONARR_URL must be an absolute URL",
      "RADARR_API_KEY is required when RADARR_URL is set",
      "PROWLARR_URL is required when PROWLARR_API_KEY is set",
    ]);
  });

  it("never exposes a configured value in the error, message, or serialized form", () => {
    const env = {
      SONARR_URL: `https://sonarr.example.invalid/secret-prefix?apikey=${sonarrKey}`,
      SONARR_API_KEY: sonarrKey,
      RADARR_URL: "https://radarr.example.invalid",
      ARR_UPSTREAM_TIMEOUT_MS: rejectedTimeout,
    };

    let thrown: ConfigurationError | undefined;
    try {
      parseEnvironment(env);
    } catch (error) {
      thrown = error as ConfigurationError;
    }

    expect(thrown).toBeInstanceOf(ConfigurationError);
    const serialized = `${thrown?.message ?? ""}\n${thrown?.stack ?? ""}\n${JSON.stringify({
      ...thrown,
      problems: thrown?.problems,
    })}`;
    for (const value of [sonarrKey, "secret-prefix", "sonarr.example.invalid", rejectedTimeout]) {
      expect(serialized).not.toContain(value);
    }
    expect(thrown?.message).toContain("SONARR_URL must not include a query string or fragment");
    expect(thrown?.message).toContain("RADARR_API_KEY is required when RADARR_URL is set");
    expect(thrown?.message).toContain(timeoutProblem);
  });

  it("defaults the upstream timeout to the client's own constant", () => {
    const configuration = parseEnvironment(sonarrEnvironment);

    expect(configuration.upstreamTimeoutMs).toBe(defaultUpstreamTimeoutMs);
    expect(configuration.upstreamTimeoutMs).toBe(30_000);
  });

  it("accepts a surrounding-whitespace timeout as a whole number of milliseconds", () => {
    expect(
      parseEnvironment({ ...sonarrEnvironment, ARR_UPSTREAM_TIMEOUT_MS: "  45000  " })
        .upstreamTimeoutMs,
    ).toBe(45_000);
  });

  it("accepts both ends of the supported range", () => {
    expect(
      parseEnvironment({ ...sonarrEnvironment, ARR_UPSTREAM_TIMEOUT_MS: "1" }).upstreamTimeoutMs,
    ).toBe(1);
    expect(
      parseEnvironment({ ...sonarrEnvironment, ARR_UPSTREAM_TIMEOUT_MS: "600000" })
        .upstreamTimeoutMs,
    ).toBe(600_000);
  });

  it("rejects every timeout spelling that is not a whole number in range", () => {
    // `Number` would accept most of these: `"1e4"` as 10000, `"+30000"` as
    // 30000, and `"30.5"` as a fraction. Each is a value nobody wrote.
    for (const value of [
      "0",
      "-1",
      "abc",
      "30.5",
      "1e4",
      "30s",
      "Infinity",
      "30_000",
      "+30000",
      "600001",
      "0x7530",
      "9007199254740993",
    ]) {
      expect(expectProblems({ ...sonarrEnvironment, ARR_UPSTREAM_TIMEOUT_MS: value })).toEqual([
        timeoutProblem,
      ]);
    }
  });

  it("rejects a present-but-empty timeout", () => {
    expect(expectProblems({ ...sonarrEnvironment, ARR_UPSTREAM_TIMEOUT_MS: "   " })).toEqual([
      "ARR_UPSTREAM_TIMEOUT_MS is set but empty",
    ]);
  });

  it("reports an unusable timeout after every instance problem", () => {
    expect(
      expectProblems({
        SONARR_URL: "https://sonarr.example.invalid",
        SONARR_API_KEY: sonarrKey,
        RADARR_URL: "https://radarr.example.invalid",
        ARR_UPSTREAM_TIMEOUT_MS: "abc",
      }),
    ).toEqual(["RADARR_API_KEY is required when RADARR_URL is set", timeoutProblem]);
  });

  it("still reports the missing application when the timeout is unusable too", () => {
    const problems = expectProblems({ PATH: "/usr/bin", ARR_UPSTREAM_TIMEOUT_MS: "abc" });

    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain("no application is configured");
    expect(problems[1]).toBe(timeoutProblem);
  });
});

describe("loadEnvironment", () => {
  it("accepts an injected record", () => {
    expect(
      loadEnvironment({
        PROWLARR_URL: "https://prowlarr.example.invalid",
        PROWLARR_API_KEY: prowlarrKey,
      }).instances,
    ).toEqual([
      {
        application: "prowlarr",
        baseUrl: "https://prowlarr.example.invalid",
        apiKey: prowlarrKey,
      },
    ]);
  });

  it("defaults to the process environment", () => {
    for (const descriptor of applicationDescriptors) {
      vi.stubEnv(descriptor.urlVariable, undefined);
      vi.stubEnv(descriptor.apiKeyVariable, undefined);
    }
    // Stubbed alongside them because this is the one case that reads the real
    // process environment: a developer who exports the timeout for their own
    // instances would otherwise decide what this test observes.
    vi.stubEnv("ARR_UPSTREAM_TIMEOUT_MS", undefined);

    try {
      expect(() => loadEnvironment()).toThrow(ConfigurationError);

      vi.stubEnv("RADARR_URL", "https://radarr.example.invalid/radarr");
      vi.stubEnv("RADARR_API_KEY", radarrKey);
      expect(loadEnvironment().instances).toEqual([
        {
          application: "radarr",
          baseUrl: "https://radarr.example.invalid/radarr",
          apiKey: radarrKey,
        },
      ]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
