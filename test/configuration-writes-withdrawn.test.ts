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

interface CallResult {
  error?: { message?: string };
  result?: {
    isError?: boolean;
    content?: Array<{ type: string; text?: string }>;
  };
}

const configuredInstance = {
  SONARR_URL: "https://sonarr.example.invalid/sonarr",
  SONARR_API_KEY: "sonarr-secret-key",
};

interface WireSession {
  readonly names: readonly string[];
  /** The refusal text for each call in {@link refusedCalls}, in order. */
  readonly refusals: readonly string[];
  readonly stdout: string;
}

/**
 * The calls a caller reaching for the withdrawn surface would make.
 *
 * Every one of them must be refused, and refused before anything is sent: the
 * server this file drives is configured against the reserved `.invalid` host,
 * so a call that was not refused could not have succeeded either way.
 */
const refusedCalls: readonly { readonly name: string; readonly arguments: unknown }[] = [
  // The tool itself, by the name a host that cached an older listing would use.
  {
    name: "arr_config_reconcile",
    arguments: { intent: "reconcile_profile", mode: "plan", application: "sonarr" },
  },
  // The transient-secret channel, on the retained mutation tool whose intent is
  // otherwise valid. No tool declares `secrets`, so the closed input schema is
  // what refuses it.
  {
    name: "arr_library_change",
    arguments: {
      intent: "set_monitoring",
      mode: "plan",
      items: ["med_00000001"],
      monitored: true,
      secrets: [{ name: "apiKey", value: "supplied" }],
    },
  },
  // And the same channel on the plan-apply form, which is where a secret used
  // to be resupplied.
  {
    name: "arr_library_change",
    arguments: {
      mode: "apply",
      plan: "pln_00000001",
      secrets: [{ name: "apiKey", value: "resupplied" }],
    },
  },
];

/** One spawned server, asked everything this file needs to know. */
async function readWireSession(): Promise<WireSession> {
  const child = spawnBuiltServer(configuredInstance, 10_000);
  try {
    await child.initializeSession(1, LATEST_PROTOCOL_VERSION);
    const listed = (await child.request(2, "tools/list")) as ToolListResult;
    const refusals: string[] = [];
    for (const [index, call] of refusedCalls.entries()) {
      const called = (await child.request(3 + index, "tools/call", {
        name: call.name,
        arguments: call.arguments,
      })) as CallResult;
      if (called.error !== undefined) {
        refusals.push(called.error.message ?? "");
        continue;
      }
      if (called.result?.isError !== true) {
        throw new Error(`${call.name} answered a call this server must refuse`);
      }
      refusals.push(called.result.content?.map((part) => part.text ?? "").join(" ") ?? "");
    }
    await child.terminateGracefully();
    return {
      names: (listed.result?.tools ?? []).map((tool) => tool.name),
      refusals,
      stdout: child.stdout,
    };
  } finally {
    await child.forceCleanup().catch(() => undefined);
  }
}

let session: Promise<WireSession> | undefined;

/**
 * Read once and shared: every assertion below asks the same server the same
 * questions, and spawning it per assertion would only spend seconds proving the
 * answers are stable.
 */
function wireSession(): Promise<WireSession> {
  session ??= readWireSession();
  return session;
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
    const { names, stdout } = await wireSession();

    expect(names).toEqual([...publishedToolNames]);
    expect(names).not.toContain("arr_config_reconcile");
    assertCleanProtocolStdout(stdout);
  });

  it("refuses the withdrawn tool and the transient-secret channel over the wire", async () => {
    const { refusals } = await wireSession();

    expect(refusals).toHaveLength(refusedCalls.length);
    for (const [index, refusal] of refusals.entries()) {
      const name = refusedCalls[index]?.name ?? "";
      // Named rather than merely non-empty: a refusal that did not name the
      // tool could be any rejection at all, including one this file did not ask
      // for.
      expect(refusal, name).toContain(name);
      // And a refusal that quoted the value back would defeat the point of
      // withdrawing the channel that carried it.
      expect(refusal, name).not.toContain("supplied");
    }
    // The withdrawn tool is gone rather than present and rejecting arguments,
    // which the two remaining refusals cannot show.
    expect(refusals[0]).toContain("not found");
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
