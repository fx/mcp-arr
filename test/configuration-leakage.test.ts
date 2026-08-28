import { describe, expect, it } from "vitest";
import type { UpstreamValue } from "../src/adapters/configuration/resources.js";
import type { ApplicationId } from "../src/applications.js";
import {
  expectObservationError,
  expectObserved,
  firstRecord,
  observationRequest,
  observe,
  providerRecords,
} from "./support/configuration.js";
import { fixtureBody, jsonResponse } from "./support/library.js";
import { testApiKeys } from "./support/tool-context.js";

/**
 * The four leakage classes this change has to be safe against.
 *
 * Each one is a different way an unexamined upstream value can end up in
 * something a calling agent reads: a field nothing here knows about, a field
 * whose name a tracker definition invented, a secret an instance happily
 * returns in full, and a failure whose response body would otherwise be quoted
 * back. The tests plant a marker in the input and then look for it in the
 * output; a marker that appears anywhere a caller can see is the bug.
 */

/** Every fixture value carrying a planted marker, gathered by walking the body. */
function canaries(value: unknown): readonly string[] {
  if (typeof value === "string") {
    return value.includes("CANARY") ? [value] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => canaries(item));
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value).flatMap((child) => canaries(child));
  }
  return [];
}

const observations: ReadonlyArray<
  readonly [ApplicationId, string, Parameters<typeof observationRequest>[0]]
> = [
  ["sonarr", "indexer", "indexers"],
  ["sonarr", "importlist", "import_lists"],
  ["radarr", "downloadclient", "download_clients"],
  ["prowlarr", "indexer", "indexers"],
  ["prowlarr", "applications", "applications"],
  ["prowlarr", "notification", "notifications"],
];

describe("planted secrets never reach the model-facing output", () => {
  it("plants a marker in every provider fixture and finds none of them in a result", async () => {
    for (const [application, route, domain] of observations) {
      const body = await fixtureBody(application, route);
      const planted = canaries(body);
      expect(planted.length).toBeGreaterThan(0);

      const { outcome } = await observe(application, observationRequest(domain), () =>
        jsonResponse(body),
      );
      const observed = expectObserved(outcome);
      const serialized = JSON.stringify({
        data: observed.data,
        continuation: observed.continuation,
        warnings: observed.warnings,
      });

      for (const marker of planted) {
        expect(serialized).not.toContain(marker);
      }
      // The same read kept every one of them internally, which is what a later
      // full-resource write has to send back.
      const internal = JSON.stringify(observed.resources.list().map((item) => item.payload()));
      for (const marker of planted) {
        expect(internal).toContain(marker);
      }
    }
  });
});

describe("unknown fields survive internally and never surface", () => {
  it("preserves a field this server has no name for while omitting it from the result", async () => {
    const body: readonly UpstreamValue[] = [
      {
        id: 1,
        name: "Example Indexer",
        implementation: "Newznab",
        // Everything below was added by a newer provider definition. A
        // full-resource update rebuilt from the output model would erase it.
        futureTopLevelSetting: "CANARY-UNKNOWN-TOP-0201",
        futureNestedSetting: { depth: { marker: "CANARY-UNKNOWN-NESTED-0202" } },
        fields: [
          { name: "minimumSeeders", value: 3 },
          { name: "futureDynamicField", value: "CANARY-UNKNOWN-FIELD-0203" },
        ],
      },
    ];
    const { outcome } = await observe("sonarr", observationRequest("indexers"), () =>
      jsonResponse(body),
    );
    const observed = expectObserved(outcome);
    const record = firstRecord(providerRecords(outcome));

    expect(record.fields).toEqual([{ name: "minimumSeeders", value: 3 }]);
    // Two unknown top-level properties plus one unknown dynamic field.
    expect(record.withheld).toEqual({ count: 3 });
    expect(JSON.stringify(observed.data)).not.toContain("CANARY-UNKNOWN");

    expect(observed.resources.list()[0]?.payload()).toEqual(body[0]);
  });
});

describe("dynamic Cardigann fields are classified, not passed through", () => {
  it("reports a definition's own fields as credentials or as a count, never as values", async () => {
    const body = await fixtureBody("prowlarr", "indexer");
    const { outcome } = await observe("prowlarr", observationRequest("indexers"), () =>
      jsonResponse(body),
    );
    const record = firstRecord(providerRecords(outcome));
    const serialized = JSON.stringify(record);

    // The definition file, the tracker it names, and the free-text info slot a
    // Cardigann definition uses are all absent from the output.
    expect(serialized).not.toContain("exampletracker");
    expect(serialized).not.toContain("example-tracker");
    expect(serialized).not.toContain("info_tpp");
    // Not even an allowlisted operational name survives on a Cardigann
    // provider: the definition chose that name, so it vouches for nothing.
    expect(record.fields).toEqual([]);
    expect(record.secrets.map((secret) => secret.name)).toEqual([
      "username",
      "password",
      "passkey",
      "cardigannCaptcha",
    ]);
    expect(record.withheld.count).toBeGreaterThan(0);
  });

  it("withholds a definition field even when the definition calls it public", async () => {
    const { outcome } = await observe("prowlarr", observationRequest("indexers"), () =>
      jsonResponse([
        {
          id: 1,
          name: "Example Tracker",
          implementation: "Cardigann",
          fields: [
            { name: "passkey", value: "CANARY-CARDIGANN-CLAIMED-PUBLIC-0301", privacy: "normal" },
            { name: "trackerNotice", value: "CANARY-CARDIGANN-NOTICE-0302", privacy: "normal" },
          ],
        },
      ]),
    );
    const record = firstRecord(providerRecords(outcome));

    expect(JSON.stringify(record)).not.toContain("CANARY-CARDIGANN");
    expect(record.secrets).toEqual([{ name: "passkey", state: "configured", masked: false }]);
    expect(record.fields).toEqual([]);
    expect(record.withheld).toEqual({ count: 1 });
  });
});

describe("upstream failures carry no upstream content", () => {
  const responseBody = {
    message: "CANARY-ERROR-BODY-0401",
    description: `${testApiKeys.sonarr} https://sonarr.example.invalid/sonarr/api/v3/indexer`,
  };

  it("surfaces a rejection without its body, URL, header, or configured key", async () => {
    for (const [status, code] of [
      [400, "upstream_rejection"],
      [401, "upstream_authentication"],
      [404, "stale_reference"],
      [429, "rate_limit"],
      [500, "unexpected_response"],
    ] as const) {
      const { outcome } = await observe("sonarr", observationRequest("indexers"), () =>
        jsonResponse(responseBody, status),
      );
      const error = expectObservationError(outcome);
      const serialized = JSON.stringify(error);

      expect(error.code).toBe(code);
      expect(serialized).not.toContain("CANARY-ERROR-BODY-0401");
      expect(serialized).not.toContain(testApiKeys.sonarr);
      expect(serialized).not.toContain("example.invalid");
      expect(serialized).not.toContain("X-Api-Key");
      expect(serialized).not.toContain("https");
      // The route is named, because that is what a caller has to act on.
      expect(error.message).toContain("indexer");
    }
  });

  it("says nothing about a body it could not parse at all", async () => {
    const { outcome } = await observe(
      "sonarr",
      observationRequest("indexers"),
      () => new Response("CANARY-ERROR-UNPARSED-0402", { status: 200 }),
    );
    const error = expectObservationError(outcome);

    expect(error.code).toBe("unexpected_response");
    expect(JSON.stringify(error)).not.toContain("CANARY-ERROR-UNPARSED-0402");
  });

  it("says nothing about a body whose shape it could not read", async () => {
    const { outcome } = await observe("sonarr", observationRequest("quality_profiles"), () =>
      jsonResponse([{ id: 1, name: "Example", items: "CANARY-ERROR-SHAPE-0403" }]),
    );
    const error = expectObservationError(outcome);

    expect(error.code).toBe("unexpected_response");
    expect(JSON.stringify(error)).not.toContain("CANARY-ERROR-SHAPE-0403");
  });
});
