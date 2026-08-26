import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type ApplicationCapability,
  createAdapterRegistry,
  createApplicationAdapter,
  systemStatusPath,
} from "../src/adapters/registry.js";
import {
  type ApplicationId,
  applicationDescriptors,
  describeApplication,
} from "../src/applications.js";
import { parseEnvironment } from "../src/config/environment.js";
import type { FetchLike } from "../src/http/client.js";
import { loadFixture, type VersionedFixture } from "./support/fixtures.js";

const fixtureRoot = fileURLToPath(new URL("./fixtures", import.meta.url));
const apiKeys: Readonly<Record<ApplicationId, string>> = {
  sonarr: "sonarr-secret-key",
  radarr: "radarr-secret-key",
  prowlarr: "prowlarr-secret-key",
};
const allApplicationsEnvironment = {
  SONARR_URL: "https://sonarr.example.invalid/sonarr",
  SONARR_API_KEY: apiKeys.sonarr,
  RADARR_URL: "https://radarr.example.invalid",
  RADARR_API_KEY: apiKeys.radarr,
  PROWLARR_URL: "http://prowlarr.example.invalid:9696",
  PROWLARR_API_KEY: apiKeys.prowlarr,
};

const statusFixtures = new Map<ApplicationId, VersionedFixture<Record<string, unknown>>>();

beforeAll(async () => {
  await Promise.all(
    applicationDescriptors.map(async (descriptor) => {
      const fixture = await loadFixture<Record<string, unknown>>(
        fixtureRoot,
        `${descriptor.id}/${descriptor.apiVersion}/${descriptor.minimumVersion}/system-status.json`,
      );
      statusFixtures.set(descriptor.id, fixture);
    }),
  );
});

function fixtureFor(application: ApplicationId): VersionedFixture<Record<string, unknown>> {
  const fixture = statusFixtures.get(application);
  if (fixture === undefined) {
    throw new Error(`Missing loaded fixture for ${application}`);
  }
  return fixture;
}

function applicationForUrl(url: string): ApplicationId {
  const descriptor = applicationDescriptors.find((candidate) =>
    url.includes(`${candidate.id}.example.invalid`),
  );
  if (descriptor === undefined) {
    throw new Error(`Unexpected upstream URL: ${url}`);
  }
  return descriptor.id;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function byApplication(
  capabilities: readonly ApplicationCapability[],
  application: ApplicationId,
): ApplicationCapability {
  const capability = capabilities.find((candidate) => candidate.application === application);
  if (capability === undefined) {
    throw new Error(`Missing capability for ${application}`);
  }
  return capability;
}

describe("createAdapterRegistry", () => {
  it("builds one adapter per configured application and none for the rest", () => {
    const registry = createAdapterRegistry(
      parseEnvironment({
        SONARR_URL: "https://sonarr.example.invalid/sonarr",
        SONARR_API_KEY: apiKeys.sonarr,
      }),
    );

    expect(registry.adapters.map((adapter) => adapter.application)).toEqual(["sonarr"]);
    const sonarr = registry.adapter("sonarr");
    expect(sonarr?.apiVersion).toBe("v3");
    expect(sonarr?.minimumVersion).toBe("4.0.19.2979");
    expect(sonarr?.client.apiBaseUrl).toBe("https://sonarr.example.invalid/sonarr/api/v3");
    expect(registry.adapter("radarr")).toBeUndefined();
    expect(registry.adapter("prowlarr")).toBeUndefined();
  });

  it("probes each configured application against its own API base and records availability", async () => {
    const requested: string[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      requested.push(url);
      const application = applicationForUrl(url);
      expect(new Headers(init.headers).get("X-Api-Key")).toBe(apiKeys[application]);
      return jsonResponse(fixtureFor(application).body);
    };

    const registry = createAdapterRegistry(parseEnvironment(allApplicationsEnvironment), {
      fetch: fetchImpl,
    });

    await expect(registry.probe()).resolves.toEqual([
      {
        application: "sonarr",
        status: "available",
        apiVersion: "v3",
        minimumVersion: "4.0.19.2979",
        version: "4.0.19.2979",
      },
      {
        application: "radarr",
        status: "available",
        apiVersion: "v3",
        minimumVersion: "6.3.0.10514",
        version: "6.3.0.10514",
      },
      {
        application: "prowlarr",
        status: "available",
        apiVersion: "v1",
        minimumVersion: "2.5.2.5491",
        version: "2.5.2.5491",
      },
    ]);
    expect(requested.sort()).toEqual([
      "http://prowlarr.example.invalid:9696/api/v1/system/status",
      "https://radarr.example.invalid/api/v3/system/status",
      "https://sonarr.example.invalid/sonarr/api/v3/system/status",
    ]);
  });

  it("reports unconfigured applications without probing them", async () => {
    const requested: string[] = [];
    const registry = createAdapterRegistry(
      parseEnvironment({
        RADARR_URL: "https://radarr.example.invalid",
        RADARR_API_KEY: apiKeys.radarr,
      }),
      {
        fetch: async (url) => {
          requested.push(url);
          return jsonResponse(fixtureFor("radarr").body);
        },
      },
    );

    const capabilities = await registry.probe();
    expect(capabilities.map((capability) => capability.status)).toEqual([
      "unconfigured",
      "available",
      "unconfigured",
    ]);
    expect(byApplication(capabilities, "sonarr")).toEqual({
      application: "sonarr",
      status: "unconfigured",
    });
    expect(requested).toEqual(["https://radarr.example.invalid/api/v3/system/status"]);
  });

  it("accepts a newer patch release and marks an older one unsupported", async () => {
    const versions: Readonly<Record<ApplicationId, string>> = {
      sonarr: "4.0.20.3000",
      radarr: "6.3.0.10514",
      prowlarr: "2.5.1.5000",
    };
    const registry = createAdapterRegistry(parseEnvironment(allApplicationsEnvironment), {
      fetch: async (url) => {
        const application = applicationForUrl(url);
        return jsonResponse({ ...fixtureFor(application).body, version: versions[application] });
      },
    });

    const capabilities = await registry.probe();
    expect(capabilities.map((capability) => [capability.application, capability.status])).toEqual([
      ["sonarr", "available"],
      ["radarr", "available"],
      ["prowlarr", "unsupported"],
    ]);
    expect(byApplication(capabilities, "prowlarr")).toMatchObject({
      status: "unsupported",
      version: "2.5.1.5000",
      minimumVersion: "2.5.2.5491",
    });
  });

  it("isolates a failing probe from the other applications", async () => {
    const registry = createAdapterRegistry(parseEnvironment(allApplicationsEnvironment), {
      fetch: async (url) => {
        const application = applicationForUrl(url);
        if (application === "sonarr") {
          return jsonResponse({ message: `rejected ${apiKeys.sonarr}` }, 401);
        }
        if (application === "radarr") {
          throw new TypeError("fetch failed");
        }
        return jsonResponse(fixtureFor("prowlarr").body);
      },
    });

    const capabilities = await registry.probe();
    expect(byApplication(capabilities, "sonarr")).toMatchObject({
      status: "unavailable",
      failure: { kind: "authentication" },
    });
    expect(byApplication(capabilities, "radarr")).toMatchObject({
      status: "unavailable",
      failure: { kind: "unavailable" },
    });
    expect(byApplication(capabilities, "prowlarr")).toMatchObject({ status: "available" });
    expect(JSON.stringify(capabilities)).not.toContain(apiKeys.sonarr);
  });

  it("treats an unusable status body as unavailable rather than crashing", async () => {
    const bodies: readonly unknown[] = [{}, { version: "" }, { version: 419 }, [], null, "status"];

    for (const body of bodies) {
      const registry = createAdapterRegistry(
        parseEnvironment({
          SONARR_URL: "https://sonarr.example.invalid/sonarr",
          SONARR_API_KEY: apiKeys.sonarr,
        }),
        { fetch: async () => jsonResponse(body) },
      );

      const capability = byApplication(await registry.probe(), "sonarr");
      expect(capability).toEqual({
        application: "sonarr",
        status: "unavailable",
        apiVersion: "v3",
        minimumVersion: "4.0.19.2979",
        failure: {
          kind: "unexpected-response",
          message: `sonarr: ${systemStatusPath} did not report a usable version`,
        },
      });
    }
  });
});

describe("createApplicationAdapter", () => {
  const descriptor = describeApplication("sonarr");

  it("probes system/status through the injected client", async () => {
    const requested: string[] = [];
    const adapter = createApplicationAdapter(descriptor, {
      application: "sonarr",
      apiBaseUrl: "https://sonarr.example.invalid/sonarr/api/v3",
      get: async (path) => {
        requested.push(path);
        return fixtureFor("sonarr").body;
      },
    });

    await expect(adapter.probe()).resolves.toEqual({
      application: "sonarr",
      status: "available",
      apiVersion: "v3",
      minimumVersion: "4.0.19.2979",
      version: "4.0.19.2979",
    });
    expect(requested).toEqual([systemStatusPath]);
  });

  it("normalizes a non-upstream failure without leaking its message", async () => {
    const adapter = createApplicationAdapter(descriptor, {
      application: "sonarr",
      apiBaseUrl: "https://sonarr.example.invalid/sonarr/api/v3",
      get: () => Promise.reject(new Error(`internal detail ${apiKeys.sonarr}`)),
    });

    const capability = await adapter.probe();
    expect(capability).toEqual({
      application: "sonarr",
      status: "unavailable",
      apiVersion: "v3",
      minimumVersion: "4.0.19.2979",
      failure: {
        kind: "unexpected-response",
        message: `sonarr: probing ${systemStatusPath} failed unexpectedly`,
      },
    });
    expect(JSON.stringify(capability)).not.toContain(apiKeys.sonarr);
  });
});
