import { beforeAll, describe, expect, it } from "vitest";
import type { ApplicationId } from "../src/applications.js";
import { reportCapabilities } from "../src/tools/capabilities.js";
import { findToolDefinition } from "../src/tools/definitions.js";
import type { OperationDefinition } from "../src/tools/operations.js";
import { operationDefinitions } from "../src/tools/operations.js";
import type { ToolResult } from "../src/tools/results.js";
import {
  type CapabilityReport,
  capabilitiesOutputSchema,
} from "../src/tools/schemas/capabilities.js";
import type { VersionedFixture } from "./support/fixtures.js";
import {
  allApplicationsEnvironment,
  applicationForUrl,
  createTestToolContext,
  jsonResponse,
  loadStatusFixtures,
  testApiKeys,
} from "./support/tool-context.js";

let statusFixtures: ReadonlyMap<ApplicationId, VersionedFixture<Record<string, unknown>>>;

beforeAll(async () => {
  statusFixtures = await loadStatusFixtures();
});

function fixtureBody(application: ApplicationId): Record<string, unknown> {
  const fixture = statusFixtures.get(application);
  if (fixture === undefined) {
    throw new Error(`Missing loaded fixture for ${application}`);
  }
  return fixture.body;
}

function reportFor(
  result: ToolResult<CapabilityReport>,
  application: ApplicationId,
): CapabilityReport {
  const outcome = result.applications.find((entry) => entry.application === application);
  if (outcome?.data === undefined) {
    throw new Error(`Missing capability report for ${application}`);
  }
  expect(outcome.status).toBe("ok");
  return outcome.data;
}

describe("arr_capabilities", () => {
  it("distinguishes available, unconfigured, unavailable, and unsupported", async () => {
    const context = createTestToolContext({
      environment: allApplicationsEnvironment,
      fetch: async (url) => {
        const application = applicationForUrl(url);
        if (application === "radarr") {
          throw new TypeError("fetch failed");
        }
        if (application === "prowlarr") {
          return jsonResponse({ ...fixtureBody("prowlarr"), version: "2.0.0.1" });
        }
        return jsonResponse(fixtureBody("sonarr"));
      },
    });

    const result = await reportCapabilities(context, undefined);

    expect(result.status).toBe("ok");
    expect(result.errors).toEqual([]);
    expect(
      result.applications.map((outcome) => [outcome.application, outcome.data?.state]),
    ).toEqual([
      ["sonarr", "available"],
      ["radarr", "unavailable"],
      ["prowlarr", "unsupported"],
    ]);
    expect(capabilitiesOutputSchema.safeParse(result).success).toBe(true);
  });

  it("reports an unconfigured application without contacting anything", async () => {
    const requested: string[] = [];
    const context = createTestToolContext({
      environment: {
        SONARR_URL: "https://sonarr.example.invalid/sonarr",
        SONARR_API_KEY: testApiKeys.sonarr,
      },
      fetch: async (url) => {
        requested.push(url);
        return jsonResponse(fixtureBody("sonarr"));
      },
    });

    const result = await reportCapabilities(context, undefined);

    expect(requested).toEqual(["https://sonarr.example.invalid/sonarr/api/v3/system/status"]);
    expect(reportFor(result, "radarr")).toMatchObject({
      state: "unconfigured",
      apiVersion: "v3",
      minimumVersion: "6.3.0.10514",
      supportedOperations: [],
      unsupportedOperations: [],
    });
    expect("version" in reportFor(result, "radarr")).toBe(false);
    expect(result.applications[1]?.warnings).toEqual([
      "radarr is not configured; set RADARR_URL and RADARR_API_KEY",
    ]);
  });

  it("keeps one unreachable application from failing the whole result", async () => {
    const context = createTestToolContext({
      environment: {
        SONARR_URL: "https://sonarr.example.invalid/sonarr",
        SONARR_API_KEY: testApiKeys.sonarr,
        RADARR_URL: "https://radarr.example.invalid",
        RADARR_API_KEY: testApiKeys.radarr,
      },
      fetch: async (url) => {
        const application = applicationForUrl(url);
        if (application === "radarr") {
          return jsonResponse({ message: `rejected ${testApiKeys.radarr}` }, 500);
        }
        return jsonResponse(fixtureBody("sonarr"));
      },
    });

    const result = await reportCapabilities(context, undefined);

    expect(result.status).toBe("ok");
    expect(reportFor(result, "sonarr").state).toBe("available");
    expect(reportFor(result, "sonarr").supportedOperations.length).toBeGreaterThan(0);
    expect(reportFor(result, "radarr")).toMatchObject({
      state: "unavailable",
      supportedOperations: [],
      unsupportedOperations: [],
    });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(testApiKeys.radarr);
    expect(serialized).not.toContain("radarr.example.invalid");
    expect(serialized).not.toContain("rejected");
  });

  it("projects only the operations the reported application declares", async () => {
    const context = createTestToolContext({
      environment: allApplicationsEnvironment,
      fetch: async (url) => jsonResponse(fixtureBody(applicationForUrl(url))),
    });

    const result = await reportCapabilities(context, undefined);
    const sonarr = reportFor(result, "sonarr");
    const prowlarr = reportFor(result, "prowlarr");

    const sonarrKeys = sonarr.supportedOperations.map(
      (operation) => `${operation.tool}/${operation.variant ?? "-"}`,
    );
    expect(sonarrKeys).toContain("arr_library_query/series");
    expect(sonarrKeys).not.toContain("arr_library_query/movies");
    expect(sonarrKeys).not.toContain("arr_activity_query/indexer_status");

    const prowlarrKeys = prowlarr.supportedOperations.map(
      (operation) => `${operation.tool}/${operation.variant ?? "-"}`,
    );
    expect(prowlarrKeys).toContain("arr_activity_query/indexer_status");
    expect(prowlarrKeys).not.toContain("arr_library_query/series");

    const expectedSonarr = operationDefinitions.filter((operation) =>
      operation.applications.includes("sonarr"),
    ).length;
    expect(sonarr.supportedOperations).toHaveLength(expectedSonarr);
    expect(sonarr.supportedOperations.every((operation) => operation.sideEffect.length > 0)).toBe(
      true,
    );
  });

  it("reports an operation that needs a newer release as unsupported", async () => {
    const base = operationDefinitions.find(
      (operation) => operation.tool === "arr_library_query" && operation.variant === "series",
    );
    if (base === undefined) {
      throw new Error("Missing the series library operation");
    }
    const gated: OperationDefinition = { ...base, minimumVersions: { sonarr: "9.9.9.9" } };
    const context = createTestToolContext({
      environment: {
        SONARR_URL: "https://sonarr.example.invalid/sonarr",
        SONARR_API_KEY: testApiKeys.sonarr,
      },
      operations: [gated],
      fetch: async () => jsonResponse(fixtureBody("sonarr")),
    });

    const report = reportFor(await reportCapabilities(context, undefined), "sonarr");

    expect(report.state).toBe("available");
    expect(report.supportedOperations).toEqual([]);
    expect(report.unsupportedOperations).toEqual([
      {
        tool: "arr_library_query",
        variant: "series",
        sideEffect: "read",
        requiredVersion: "9.9.9.9",
      },
    ]);
  });

  it("restricts the report to the requested applications", async () => {
    const requested: string[] = [];
    const context = createTestToolContext({
      environment: allApplicationsEnvironment,
      fetch: async (url) => {
        requested.push(url);
        return jsonResponse(fixtureBody(applicationForUrl(url)));
      },
    });

    const result = await reportCapabilities(context, ["prowlarr"]);

    expect(result.applications.map((outcome) => outcome.application)).toEqual(["prowlarr"]);
    expect(requested).toEqual(["http://prowlarr.example.invalid:9696/api/v1/system/status"]);
  });

  it("is handled by the registered arr_capabilities definition", async () => {
    const definition = findToolDefinition("arr_capabilities");
    if (definition === undefined) {
      throw new Error("arr_capabilities must be registered");
    }
    const context = createTestToolContext({
      environment: allApplicationsEnvironment,
      fetch: async (url) => jsonResponse(fixtureBody(applicationForUrl(url))),
    });

    const parsed = definition.inputSchema.safeParse({ applications: ["sonarr"] });
    expect(parsed.success).toBe(true);
    const result = await definition.handle(context, parsed.success ? parsed.data : undefined);

    expect(result.applications.map((outcome) => outcome.application)).toEqual(["sonarr"]);
    expect(definition.outputSchema.safeParse(result).success).toBe(true);
  });
});
