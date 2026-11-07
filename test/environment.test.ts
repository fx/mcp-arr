import { describe, expect, it, vi } from "vitest";
import { applicationDescriptors } from "../src/applications.js";
import {
  authTokenVariable,
  ConfigurationError,
  defaultHttpHost,
  defaultHttpPort,
  type EnvironmentRecord,
  findInstance,
  httpHostVariable,
  httpPortVariable,
  loadEnvironment,
  parseEnvironment,
  transportVariable,
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

/** A usable bearer token: 64 hexadecimal characters, as `openssl rand -hex 32` prints. */
const token = "0123456789abcdef".repeat(4);
const httpEnvironment: EnvironmentRecord = {
  ...sonarrEnvironment,
  ARR_MCP_TRANSPORT: "http",
  ARR_MCP_AUTH_TOKEN: token,
};
const tokenProblem =
  "ARR_MCP_AUTH_TOKEN must be 32 to 4096 characters from the RFC 6750 b64token alphabet";
const portProblem = "ARR_MCP_HTTP_PORT must be a whole number from 1 to 65535";
const hostProblem = "ARR_MCP_HTTP_HOST must be an IPv4 or IPv6 address";

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

describe("parseEnvironment transport selection", () => {
  it("names the variables it reads", () => {
    expect([transportVariable, httpHostVariable, httpPortVariable, authTokenVariable]).toEqual([
      "ARR_MCP_TRANSPORT",
      "ARR_MCP_HTTP_HOST",
      "ARR_MCP_HTTP_PORT",
      "ARR_MCP_AUTH_TOKEN",
    ]);
  });

  it("selects stdio when no transport is named, or when stdio is", () => {
    expect(parseEnvironment(sonarrEnvironment).transport).toEqual({ kind: "stdio" });
    expect(
      parseEnvironment({ ...sonarrEnvironment, ARR_MCP_TRANSPORT: " stdio " }).transport,
    ).toEqual({ kind: "stdio" });
  });

  it("selects http with the loopback default address and the default port", () => {
    expect(parseEnvironment(httpEnvironment).transport).toEqual({
      kind: "http",
      host: "127.0.0.1",
      port: 9797,
      token,
    });
    expect(defaultHttpHost).toBe("127.0.0.1");
    expect(defaultHttpPort).toBe(9797);
  });

  it("accepts IPv4 and IPv6 listener addresses", () => {
    for (const host of ["0.0.0.0", "192.0.2.10", "::", "::1", "2001:db8::1"]) {
      expect(parseEnvironment({ ...httpEnvironment, ARR_MCP_HTTP_HOST: host }).transport).toEqual({
        kind: "http",
        host,
        port: defaultHttpPort,
        token,
      });
    }
  });

  it("rejects a listener address that is not an IP address", () => {
    for (const host of [
      "localhost",
      "mcp.example.invalid",
      "[::1]",
      "127.0.0.1:9797",
      "256.0.0.1",
    ]) {
      expect(expectProblems({ ...httpEnvironment, ARR_MCP_HTTP_HOST: host })).toEqual([
        hostProblem,
      ]);
    }
  });

  it("accepts both ends of the port range and surrounding whitespace", () => {
    for (const [value, port] of [
      ["1", 1],
      ["65535", 65_535],
      [" 8443 ", 8_443],
    ] as const) {
      expect(parseEnvironment({ ...httpEnvironment, ARR_MCP_HTTP_PORT: value }).transport).toEqual({
        kind: "http",
        host: defaultHttpHost,
        port,
        token,
      });
    }
  });

  it("rejects every port spelling that is not a whole number from 1 to 65535", () => {
    for (const value of ["0", "65536", "-1", "+80", "80.0", "1e3", "0x50", "eighty", "80 80"]) {
      expect(expectProblems({ ...httpEnvironment, ARR_MCP_HTTP_PORT: value })).toEqual([
        portProblem,
      ]);
    }
  });

  it("accepts tokens of the bounding lengths drawn from the whole b64token alphabet", () => {
    for (const value of [
      "a".repeat(32),
      "a".repeat(4096),
      "AZaz09-._~+/AZaz09-._~+/AZaz09==",
      `${"x".repeat(30)}==`,
    ]) {
      expect(parseEnvironment({ ...httpEnvironment, ARR_MCP_AUTH_TOKEN: value }).transport).toEqual(
        { kind: "http", host: defaultHttpHost, port: defaultHttpPort, token: value },
      );
    }
  });

  it("rejects a token that is too short, too long, or outside the alphabet, without echoing it", () => {
    const rejected = [
      "s".repeat(20),
      "s".repeat(31),
      "s".repeat(4097),
      `${"s".repeat(31)} s`,
      `${"s".repeat(31)}"`,
      `${"s".repeat(31)},`,
      `${"s".repeat(31)}é`,
      // Each folds to an ASCII letter under Unicode case-insensitive matching.
      `${"s".repeat(31)}\u212A`,
      `${"s".repeat(31)}\u017F`,
      `=${"s".repeat(31)}`,
      `${"s".repeat(16)}=${"s".repeat(16)}`,
    ];
    for (const value of rejected) {
      const problems = expectProblems({ ...httpEnvironment, ARR_MCP_AUTH_TOKEN: value });
      expect(problems).toEqual([tokenProblem]);
      expect(problems.join("\n")).not.toContain(value.slice(0, 20));
    }
  });

  it("requires a token under http and names the variable", () => {
    const { ARR_MCP_AUTH_TOKEN: _omitted, ...withoutToken } = httpEnvironment;

    expect(expectProblems(withoutToken)).toEqual([
      "ARR_MCP_AUTH_TOKEN is required when ARR_MCP_TRANSPORT is http",
    ]);
  });

  it("rejects present-but-empty transport settings", () => {
    expect(expectProblems({ ...sonarrEnvironment, ARR_MCP_TRANSPORT: " " })).toEqual([
      "ARR_MCP_TRANSPORT is set but empty",
    ]);
    expect(
      expectProblems({
        ...httpEnvironment,
        ARR_MCP_HTTP_HOST: "",
        ARR_MCP_HTTP_PORT: "\t",
        ARR_MCP_AUTH_TOKEN: "",
      }),
    ).toEqual([
      "ARR_MCP_HTTP_HOST is set but empty",
      "ARR_MCP_HTTP_PORT is set but empty",
      "ARR_MCP_AUTH_TOKEN is set but empty",
    ]);
  });

  it("rejects an unknown transport by name and reports nothing about the HTTP settings", () => {
    for (const value of ["websocket", "HTTP", "sse", "http,stdio"]) {
      const problems = expectProblems({
        ...sonarrEnvironment,
        ARR_MCP_TRANSPORT: value,
        ARR_MCP_HTTP_PORT: "not-a-port",
      });
      expect(problems).toEqual(["ARR_MCP_TRANSPORT must be stdio or http"]);
      expect(problems.join("\n")).not.toContain(value);
    }
  });

  it("rejects each HTTP setting under stdio, empty ones included, without echoing it", () => {
    for (const transport of [undefined, "stdio"]) {
      const env: EnvironmentRecord = {
        ...sonarrEnvironment,
        ...(transport === undefined ? {} : { ARR_MCP_TRANSPORT: transport }),
        ARR_MCP_HTTP_HOST: "",
        ARR_MCP_HTTP_PORT: "9797",
        ARR_MCP_AUTH_TOKEN: token,
      };
      const problems = expectProblems(env);
      expect(problems).toEqual([
        "ARR_MCP_HTTP_HOST requires ARR_MCP_TRANSPORT=http",
        "ARR_MCP_HTTP_PORT requires ARR_MCP_TRANSPORT=http",
        "ARR_MCP_AUTH_TOKEN requires ARR_MCP_TRANSPORT=http",
      ]);
      expect(problems.join("\n")).not.toContain(token);
    }
    expect(expectProblems({ ...sonarrEnvironment, ARR_MCP_AUTH_TOKEN: token })).toEqual([
      "ARR_MCP_AUTH_TOKEN requires ARR_MCP_TRANSPORT=http",
    ]);
  });

  it("reports transport problems after the instance, missing-application, and timeout ones", () => {
    expect(
      expectProblems({
        RADARR_URL: "https://radarr.example.invalid",
        ARR_UPSTREAM_TIMEOUT_MS: "abc",
        ARR_MCP_TRANSPORT: "http",
        ARR_MCP_HTTP_HOST: "localhost",
        ARR_MCP_HTTP_PORT: "0",
      }),
    ).toEqual([
      "RADARR_API_KEY is required when RADARR_URL is set",
      timeoutProblem,
      hostProblem,
      portProblem,
      "ARR_MCP_AUTH_TOKEN is required when ARR_MCP_TRANSPORT is http",
    ]);

    const problems = expectProblems({ PATH: "/usr/bin", ARR_MCP_TRANSPORT: "websocket" });
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain("no application is configured");
    expect(problems[1]).toBe("ARR_MCP_TRANSPORT must be stdio or http");
  });

  it("never exposes a transport setting's value in the error, message, or serialized form", () => {
    const rejectedToken = "short-secret-token";
    let thrown: ConfigurationError | undefined;
    try {
      parseEnvironment({
        ...sonarrEnvironment,
        ARR_MCP_TRANSPORT: "http",
        ARR_MCP_HTTP_HOST: "listener.example.invalid",
        ARR_MCP_HTTP_PORT: "70000",
        ARR_MCP_AUTH_TOKEN: rejectedToken,
      });
    } catch (error) {
      thrown = error as ConfigurationError;
    }

    expect(thrown).toBeInstanceOf(ConfigurationError);
    const serialized = `${thrown?.message ?? ""}\n${thrown?.stack ?? ""}\n${JSON.stringify({
      ...thrown,
      problems: thrown?.problems,
    })}`;
    for (const value of [rejectedToken, "listener.example.invalid", "70000", sonarrKey]) {
      expect(serialized).not.toContain(value);
    }
    expect(thrown?.problems).toEqual([hostProblem, portProblem, tokenProblem]);
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
    // The transport settings for the same reason: one left exported would
    // reject the stdio configuration this case expects.
    for (const name of [transportVariable, httpHostVariable, httpPortVariable, authTokenVariable]) {
      vi.stubEnv(name, undefined);
    }

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
