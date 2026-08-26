import { beforeAll, describe, expect, it } from "vitest";
import type { ApplicationId } from "../src/applications.js";
import { capabilitySummary, reportCapabilities } from "../src/tools/capabilities.js";
import { findToolDefinition } from "../src/tools/definitions.js";
import { capabilitiesToolName, projectedToolNames, toolNames } from "../src/tools/names.js";
import type { OperationDefinition } from "../src/tools/operations.js";
import { isImplementedOperation, operationDefinitions } from "../src/tools/operations.js";
import { summarizeToolResult, type ToolResult } from "../src/tools/results.js";
import {
  type CapabilityReport,
  capabilitiesOutputSchema,
  capabilityOperationSchema,
  capabilityUnsupportedOperationSchema,
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

function operationKey(operation: { tool: string; variant?: string | undefined }): string {
  return `${operation.tool}/${operation.variant ?? "-"}`;
}

/** Every operation a report projects onto its application, however it is grouped. */
function projectedKeys(report: CapabilityReport): string[] {
  return [
    ...report.supportedOperations,
    ...report.unsupportedOperations,
    ...report.unimplementedOperations,
  ].map(operationKey);
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
      unimplementedOperations: [],
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
    expect(reportFor(result, "sonarr").unimplementedOperations.length).toBeGreaterThan(0);
    expect(reportFor(result, "radarr")).toMatchObject({
      state: "unavailable",
      supportedOperations: [],
      unsupportedOperations: [],
      unimplementedOperations: [],
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

    const sonarrKeys = projectedKeys(sonarr);
    expect(sonarrKeys).toContain("arr_library_query/series");
    expect(sonarrKeys).not.toContain("arr_library_query/movies");
    expect(sonarrKeys).not.toContain("arr_activity_query/indexer_status");

    const prowlarrKeys = projectedKeys(prowlarr);
    expect(prowlarrKeys).toContain("arr_activity_query/indexer_status");
    expect(prowlarrKeys).not.toContain("arr_library_query/series");

    const expectedSonarr = operationDefinitions.filter(
      (operation) =>
        operation.applications.includes("sonarr") && !isImplementedOperation(operation),
    ).length;
    expect(sonarr.unimplementedOperations).toHaveLength(expectedSonarr);
    expect(sonarr.unimplementedOperations.every((entry) => entry.sideEffect.length > 0)).toBe(true);
  });

  it("advertises exactly the operations that already have adapter behavior", async () => {
    const context = createTestToolContext({
      environment: allApplicationsEnvironment,
      fetch: async (url) => jsonResponse(fixtureBody(applicationForUrl(url))),
    });

    const result = await reportCapabilities(context, undefined);

    // Job projection is process-local, so it is usable on every configured
    // application. The library views are advertised exactly where the adapters
    // model them, and Prowlarr has no media library so it advertises none.
    expect(reportFor(result, "sonarr").supportedOperations.map(operationKey)).toEqual([
      "arr_library_query/series",
      "arr_library_query/seasons",
      "arr_library_query/episodes",
      "arr_library_query/episode_files",
      "arr_library_query/missing_episodes",
      "arr_library_query/cutoff_unmet_episodes",
      "arr_library_query/calendar",
      "arr_library_query/lookup",
      "arr_job_get/-",
      "arr_job_cancel/-",
    ]);
    expect(reportFor(result, "radarr").supportedOperations.map(operationKey)).toEqual([
      "arr_library_query/movies",
      "arr_library_query/collections",
      "arr_library_query/movie_files",
      "arr_library_query/missing_movies",
      "arr_library_query/cutoff_unmet_movies",
      "arr_library_query/calendar",
      "arr_library_query/lookup",
      "arr_job_get/-",
      "arr_job_cancel/-",
    ]);
    expect(reportFor(result, "prowlarr").supportedOperations.map(operationKey)).toEqual([
      "arr_job_get/-",
      "arr_job_cancel/-",
    ]);

    // An implemented view is never also reported as declared-but-unimplemented.
    for (const application of ["sonarr", "radarr", "prowlarr"] as const) {
      const report = reportFor(result, application);
      expect(
        report.unimplementedOperations
          .map(operationKey)
          .filter((key) => key.startsWith("arr_library_query/")),
        application,
      ).toEqual([]);
    }
  });

  it("advertises an operation as supported once it has a real handler", async () => {
    const base = operationDefinitions.find(
      (operation) => operation.tool === "arr_library_query" && operation.variant === "series",
    );
    if (base === undefined) {
      throw new Error("Missing the series library operation");
    }
    const implemented: OperationDefinition = {
      ...base,
      handler: async () => ({ status: "ok", data: {} }),
    };
    const context = createTestToolContext({
      environment: {
        SONARR_URL: "https://sonarr.example.invalid/sonarr",
        SONARR_API_KEY: testApiKeys.sonarr,
      },
      operations: [implemented],
      fetch: async () => jsonResponse(fixtureBody("sonarr")),
    });

    const report = reportFor(await reportCapabilities(context, undefined), "sonarr");

    expect(report.supportedOperations).toEqual([
      { tool: "arr_library_query", variant: "series", sideEffect: "read" },
    ]);
    expect(report.unimplementedOperations).toEqual([]);
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

  it("keeps the projected tool set in step with the published tool set", () => {
    expect([...projectedToolNames].sort()).toEqual(
      toolNames.filter((name) => name !== capabilitiesToolName).sort(),
    );
    expect(projectedToolNames).toHaveLength(toolNames.length - 1);
    expect(projectedToolNames).not.toContain(capabilitiesToolName);
    // The registry is the only producer of these entries, so it must agree.
    for (const operation of operationDefinitions) {
      expect(projectedToolNames, operation.id).toContain(operation.tool);
    }
  });

  it("rejects the meta tool as an operation entry", () => {
    const entry = { tool: capabilitiesToolName, sideEffect: "read" };

    expect(capabilityOperationSchema.safeParse(entry).success).toBe(false);
    expect(
      capabilityUnsupportedOperationSchema.safeParse({ ...entry, requiredVersion: "1.0.0" })
        .success,
    ).toBe(false);
    expect(
      capabilityOperationSchema.safeParse({ tool: "arr_library_query", sideEffect: "read" })
        .success,
    ).toBe(true);
  });

  it("summarizes the capability state rather than the envelope status", async () => {
    // Every application here is an `ok` outcome by design, so a summary built
    // from the envelope status would read "sonarr ok, radarr ok, prowlarr ok"
    // at the exact moment nothing is reachable. This is the first call an
    // operator makes; its one line has to be true of the instances.
    const context = createTestToolContext({
      environment: {
        SONARR_URL: "https://sonarr.example.invalid/sonarr",
        SONARR_API_KEY: testApiKeys.sonarr,
        RADARR_URL: "https://radarr.example.invalid",
        RADARR_API_KEY: testApiKeys.radarr,
      },
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });

    const result = await reportCapabilities(context, undefined);

    expect(result.applications.every((outcome) => outcome.status === "ok")).toBe(true);
    expect(summarizeToolResult(capabilitiesToolName, result, capabilitySummary)).toBe(
      "arr_capabilities: no application available; sonarr unavailable, radarr unavailable, prowlarr unconfigured",
    );
  });

  it("names the available applications and their versions in the summary", async () => {
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

    // The version is what lets an operator check the instance that answered is
    // the one they meant to configure, and an unsupported release is named as
    // unsupported rather than folded into "not available".
    expect(summarizeToolResult(capabilitiesToolName, result, capabilitySummary)).toBe(
      "arr_capabilities: 1 of 3 application(s) available; sonarr available 4.0.19.2979, radarr unavailable, prowlarr unsupported",
    );
  });

  it("summarizes a wholly unconfigured report without claiming success", async () => {
    const context = createTestToolContext({
      environment: {
        SONARR_URL: "https://sonarr.example.invalid/sonarr",
        SONARR_API_KEY: testApiKeys.sonarr,
      },
      fetch: async () => jsonResponse(fixtureBody("sonarr")),
    });

    const result = await reportCapabilities(context, ["radarr", "prowlarr"]);

    expect(summarizeToolResult(capabilitiesToolName, result, capabilitySummary)).toBe(
      "arr_capabilities: no application available; radarr unconfigured, prowlarr unconfigured",
    );
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
