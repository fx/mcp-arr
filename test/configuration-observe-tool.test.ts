import { beforeAll, describe, expect, it } from "vitest";
import { applicationsForDomain, providerDomains } from "../src/adapters/configuration/domains.js";
import type { ApplicationId } from "../src/applications.js";
import { findToolDefinition, type ToolDefinition } from "../src/tools/definitions.js";
import type { ToolResult } from "../src/tools/results.js";
import type { VersionedFixture } from "./support/fixtures.js";
import {
  applicationForUrl,
  createTestToolContext,
  jsonResponse,
  loadStatusFixtures,
} from "./support/tool-context.js";

/**
 * What `arr_config_observe` publishes, asserted at the tool rather than at the
 * adapter beneath it.
 *
 * The catalogue this pins the absence of was never something a caller asked
 * for: the tool decided to read it, from the detail level alone, and the
 * adapter only obeyed. So the claim "no observation carries the instance's
 * provider template catalogue" is only true if it is true here, where the
 * decision was made — an adapter test can show what the adapter does when it is
 * not asked, and this shows that nothing asks.
 *
 * It is asserted across every provider domain and both detail levels because
 * the catalogue was reachable from all of them, and one domain would leave the
 * others free to reintroduce it.
 */

const definition = findToolDefinition("arr_config_observe") as ToolDefinition;

let statusFixtures: ReadonlyMap<ApplicationId, VersionedFixture<Record<string, unknown>>>;

beforeAll(async () => {
  statusFixtures = await loadStatusFixtures();
});

function statusBody(application: ApplicationId): Record<string, unknown> {
  const fixture = statusFixtures.get(application);
  if (fixture === undefined) {
    throw new Error(`Missing loaded status fixture for ${application}`);
  }
  return fixture.body;
}

/** One configured provider, in the shape every provider domain reports. */
const providerRecords: readonly unknown[] = [
  {
    id: 1,
    name: "Example Provider",
    implementation: "Newznab",
    implementationName: "Newznab",
    configContract: "NewznabSettings",
    fields: [{ name: "minimumSeeders", value: 2 }],
  },
];

/**
 * What a schema route would answer if anything still read one. It is served
 * rather than refused so that a reintroduced catalogue would be populated and
 * visible, instead of failing for the unrelated reason that nothing answered.
 */
const providerTemplates: readonly unknown[] = [
  {
    implementation: "Newznab",
    implementationName: "Newznab",
    configContract: "NewznabSettings",
    fields: [{ name: "baseUrl", label: "URL", type: "textbox", advanced: false }],
  },
];

interface ObservationRun {
  readonly result: ToolResult<unknown>;
  /** Every upstream path the call read, excluding the capability probe. */
  readonly routes: readonly string[];
}

async function observe(args: Record<string, unknown>): Promise<ObservationRun> {
  const routes: string[] = [];
  const context = createTestToolContext({
    fetch: async (input) => {
      const { pathname } = new URL(input);
      if (pathname.endsWith("/system/status")) {
        return jsonResponse(statusBody(applicationForUrl(input)));
      }
      routes.push(pathname);
      return jsonResponse(pathname.endsWith("/schema") ? providerTemplates : providerRecords);
    },
  });

  const parsed = definition.inputSchema.safeParse(args);
  if (!parsed.success) {
    throw new Error(`Arguments rejected by the published schema: ${parsed.error.message}`);
  }
  const result = await definition.handle(context, parsed.data);
  expect(definition.outputSchema.safeParse(result).success).toBe(true);
  return { result, routes };
}

function onlyData(result: ToolResult<unknown>, label: string): Record<string, unknown> {
  const [outcome, ...rest] = result.applications;
  if (outcome === undefined || rest.length > 0) {
    throw new Error(`Expected exactly one application outcome for ${label}`);
  }
  if (outcome.status !== "ok" || outcome.data === undefined) {
    throw new Error(`${label} did not succeed: ${outcome.error?.code ?? "unknown"}`);
  }
  return outcome.data as Record<string, unknown>;
}

describe("arr_config_observe publishes no provider template catalogue", () => {
  it("carries none for any provider domain at any detail level", async () => {
    for (const domain of providerDomains) {
      for (const application of applicationsForDomain(domain)) {
        for (const detail of ["summary", "full"] as const) {
          const label = `${application} ${domain} ${detail}`;
          const { result } = await observe({ domain, detail, applications: [application] });
          const data = onlyData(result, label);

          expect(data, label).not.toHaveProperty("schema");
          expect(Object.keys(data).sort(), label).toEqual(["domain", "family", "records"]);
          // The member is gone by name; this is the same claim made of the
          // payload, so a catalogue republished under another name is caught.
          expect(JSON.stringify(data), label).not.toContain("templates");
          expect(JSON.stringify(data), label).not.toContain("baseUrl");
        }
      }
    }
  });

  it("reads one upstream route for a full-detail provider observation", async () => {
    const { routes } = await observe({
      domain: "indexers",
      detail: "full",
      applications: ["sonarr"],
    });

    // The records route, once, under this instance's configured path prefix.
    // The second request the catalogue cost is what full detail no longer
    // implies.
    expect(routes).toEqual(["/sonarr/api/v3/indexer"]);
  });
});
