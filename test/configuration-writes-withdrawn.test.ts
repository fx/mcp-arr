import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { beforeAll, describe, expect, it } from "vitest";
import type { ApplicationId } from "../src/applications.js";
import { reportCapabilities } from "../src/tools/capabilities.js";
import type { CapabilityReport } from "../src/tools/schemas/capabilities.js";
import type { VersionedFixture } from "./support/fixtures.js";
import { assertCleanProtocolStdout, spawnBuiltServer } from "./support/spawned-stdio.js";
import {
  allApplicationsEnvironment,
  applicationForUrl,
  createTestToolContext,
  jsonResponse,
  loadStatusFixtures,
} from "./support/tool-context.js";

/**
 * The tools this server publishes, in order, written out by hand.
 *
 * Deliberately not derived from `toolNames`: a list compared against the
 * constant it is built from asserts nothing about what a host receives, and the
 * claim here is precisely that the surface a host sees is these fourteen and no
 * fifteenth. Adding or withdrawing a tool is a public contract change, so
 * restating the names here is the point rather than duplication to be removed.
 */
const publishedToolNames = [
  "arr_capabilities",
  "arr_library_query",
  "arr_activity_query",
  "arr_release_search",
  "arr_import_inspect",
  "arr_config_observe",
  "arr_job_get",
  "arr_search_start",
  "arr_release_grab",
  "arr_queue_resolve",
  "arr_activity_change",
  "arr_import_execute",
  "arr_library_change",
  "arr_job_cancel",
] as const;

interface PublishedTool {
  name: string;
}

interface ToolListResult {
  result?: { tools?: PublishedTool[] };
}

const configuredInstance = {
  SONARR_URL: "https://sonarr.example.invalid/sonarr",
  SONARR_API_KEY: "sonarr-secret-key",
};

/** The published names exactly as a host reads them off the wire. */
async function readPublishedToolNames(): Promise<{
  readonly names: readonly string[];
  readonly stdout: string;
}> {
  const child = spawnBuiltServer(configuredInstance, 5_000);
  try {
    await child.initializeSession(1, LATEST_PROTOCOL_VERSION);
    const listed = (await child.request(2, "tools/list")) as ToolListResult;
    await child.terminateGracefully();
    return {
      names: (listed.result?.tools ?? []).map((tool) => tool.name),
      stdout: child.stdout,
    };
  } finally {
    await child.forceCleanup().catch(() => undefined);
  }
}

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

interface ProjectedOperation {
  readonly tool: string;
  readonly variant?: string | undefined;
  readonly sideEffect: string;
}

/** Every operation a report names, however the report groups it. */
function projectedOperations(report: CapabilityReport): readonly ProjectedOperation[] {
  return [
    ...report.supportedOperations,
    ...(report.unsupportedOperations ?? []),
    ...(report.unimplementedOperations ?? []),
  ];
}

describe("the withdrawn configuration write surface", () => {
  it("publishes exactly the fourteen remaining tools", async () => {
    const { names, stdout } = await readPublishedToolNames();

    expect(names).toEqual([...publishedToolNames]);
    expect(names).not.toContain("arr_config_reconcile");
    assertCleanProtocolStdout(stdout);
  });

  it("reports no configuration write operation for any application", async () => {
    const context = createTestToolContext({
      environment: allApplicationsEnvironment,
      fetch: async (url) => jsonResponse(fixtureBody(applicationForUrl(url))),
    });

    // Full detail, because that is the one place an operation this server has
    // declared but refuses is enumerated rather than counted. A summary report
    // would pass this assertion by disclosing less.
    const result = await reportCapabilities(context, undefined, "full");

    expect(result.applications.map((outcome) => outcome.application)).toEqual([
      "sonarr",
      "radarr",
      "prowlarr",
    ]);
    for (const outcome of result.applications) {
      const report = outcome.data;
      expect(report, outcome.application).toBeDefined();
      if (report === undefined) {
        continue;
      }
      // Nothing was counted and then left out of the enumeration, so the three
      // lists below really are everything this application reports.
      expect(report.unsupportedOperations, outcome.application).toHaveLength(
        report.unsupportedOperationCount,
      );
      expect(report.unimplementedOperations, outcome.application).toHaveLength(
        report.unimplementedOperationCount,
      );

      const operations = projectedOperations(report);
      expect(operations.length, outcome.application).toBeGreaterThan(0);
      for (const operation of operations) {
        expect(operation.tool, `${outcome.application} reports ${operation.tool}`).not.toBe(
          "arr_config_reconcile",
        );
        expect(
          publishedToolNames as readonly string[],
          `${outcome.application} reports an unpublished tool`,
        ).toContain(operation.tool);
        // The surviving configuration surface is observation, so every
        // configuration operation an application reports — supported,
        // unsupported, or unimplemented alike — declares a read and nothing
        // that changes upstream state.
        if (operation.tool.startsWith("arr_config")) {
          expect(
            operation.sideEffect,
            `${outcome.application} ${operation.tool}/${operation.variant ?? "-"}`,
          ).toBe("read");
        }
      }
    }
  });
});
