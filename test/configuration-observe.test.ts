import { describe, expect, it } from "vitest";
import {
  applicationsForDomain,
  configurationDomains,
  familyOf,
  routeFor,
} from "../src/adapters/configuration/domains.js";
import { applicationIds } from "../src/applications.js";
import {
  expectObservationError,
  expectObserved,
  firstRecord,
  observationRequest,
  observe,
  observedRecords,
  providerRecords,
} from "./support/configuration.js";
import { fixtureBody, jsonResponse } from "./support/library.js";

/**
 * The observation service, read end to end from recorded upstream payloads.
 *
 * Every assertion is about what a calling agent is handed. What the internal
 * side kept is asserted in `configuration-resources.test.ts`, and what neither
 * may carry is asserted in `configuration-leakage.test.ts`.
 */

function serving(body: unknown, status = 200) {
  return () => jsonResponse(body, status);
}

describe("the configuration domain table", () => {
  it("gives every domain at least one application and every pair a route", () => {
    for (const domain of configurationDomains) {
      const applications = applicationsForDomain(domain);
      expect(applications.length).toBeGreaterThan(0);
      for (const application of applications) {
        expect(routeFor(domain, application)).toBeTruthy();
      }
      for (const application of applicationIds) {
        expect(applications.includes(application)).toBe(
          routeFor(domain, application) !== undefined,
        );
      }
    }
  });

  it("places every domain in exactly one family", () => {
    const families = configurationDomains.map((domain) => familyOf(domain));
    expect(new Set(families)).toEqual(new Set(["provider", "profile", "resource"]));
  });
});

describe("observing providers", () => {
  it("maps a Sonarr indexer without carrying either secret value out", async () => {
    const body = await fixtureBody("sonarr", "indexer");
    const { outcome, calls } = await observe(
      "sonarr",
      observationRequest("indexers"),
      serving(body),
    );
    const records = providerRecords(outcome);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.pathname).toBe("/api/v3/indexer");
    expect(records).toHaveLength(2);

    const indexer = firstRecord(records);
    expect(indexer.ref).toEqual({ application: "sonarr", domain: "indexers", id: "1" });
    expect(indexer.name).toBe("Example Usenet Indexer");
    expect(indexer.implementation).toBe("Newznab");
    expect(indexer.configContract).toBe("NewznabSettings");
    expect(indexer.protocol).toBe("usenet");
    expect(indexer.priority).toBe(25);
    expect(indexer.enabled).toBe(true);
    expect(indexer.tags).toEqual([{ application: "sonarr", domain: "tags", id: "1" }]);
    expect(indexer.fields).toEqual([{ name: "categories", value: [5030, 5040] }]);
    expect(indexer.secrets).toEqual([{ name: "apiKey", state: "configured", masked: false }]);
    expect(indexer.withheld).toEqual({ count: 5 });

    const torrent = records[1];
    expect(torrent?.enabled).toBe(false);
    expect(torrent?.secrets).toEqual([{ name: "apiKey", state: "unconfigured", masked: false }]);
    expect(torrent?.fields).toEqual([
      { name: "minimumSeeders", value: 2 },
      { name: "seedRatio", value: 1.5 },
    ]);
    expect(torrent?.withheld).toEqual({ count: 1 });
  });

  it("reads a Radarr download client's single enable switch and both credentials", async () => {
    const body = await fixtureBody("radarr", "downloadclient");
    const { outcome } = await observe(
      "radarr",
      observationRequest("download_clients"),
      serving(body),
    );
    const client = firstRecord(providerRecords(outcome));

    expect(client.enabled).toBe(true);
    expect(client.protocol).toBe("torrent");
    expect(client.secrets).toEqual([
      { name: "username", state: "configured", masked: false },
      { name: "password", state: "configured", masked: false },
    ]);
    expect(client.fields).toEqual([
      { name: "useSsl", value: false },
      { name: "movieCategory", value: "radarr" },
      { name: "initialState", value: 0 },
    ]);
    expect(client.withheld).toEqual({ count: 4 });
  });

  it("reports a Prowlarr application's sync level and its masked credential", async () => {
    const body = await fixtureBody("prowlarr", "applications");
    const { outcome } = await observe(
      "prowlarr",
      observationRequest("applications"),
      serving(body),
    );
    const records = providerRecords(outcome);

    expect(records.map((record) => record.syncLevel)).toEqual(["fullSync", "addOnly"]);
    expect(firstRecord(records).secrets).toEqual([
      { name: "apiKey", state: "configured", masked: false },
    ]);
    // The instance answered with its sentinel rather than the stored key: the
    // secret is set, and a later write can send the sentinel back to keep it.
    expect(records[1]?.secrets).toEqual([{ name: "apiKey", state: "configured", masked: true }]);
  });

  it("classifies a Cardigann definition's fields instead of passing them through", async () => {
    const body = await fixtureBody("prowlarr", "indexer");
    const { outcome } = await observe("prowlarr", observationRequest("indexers"), serving(body));
    const indexer = firstRecord(providerRecords(outcome));

    expect(indexer.implementation).toBe("Cardigann");
    // A definition-driven provider reports no field values at all. Its field
    // names were chosen by the tracker definition, so none of them is evidence
    // about what the value holds; only the credentials are acknowledged.
    expect(indexer.fields).toEqual([]);
    expect(indexer.secrets).toEqual([
      { name: "username", state: "configured", masked: false },
      { name: "password", state: "configured", masked: false },
      { name: "passkey", state: "configured", masked: false },
      { name: "cardigannCaptcha", state: "unconfigured", masked: false },
    ]);
    expect(indexer.withheld).toEqual({ count: 10 });
  });

  it("reads a provider whose payload carries no dynamic fields at all", async () => {
    const body = await fixtureBody("prowlarr", "indexer");
    const { outcome } = await observe("prowlarr", observationRequest("indexers"), serving(body));
    const records = providerRecords(outcome);

    expect(records.map((record) => record.ref.id)).toEqual(["1", "2", "3", "4"]);
    // The last two have no `fields` array; that is an empty field list, not a
    // reason to refuse the record or to invent one.
    const bare = records[2];
    expect(bare?.name).toBe("Example Indexer C");
    expect(bare?.fields).toEqual([]);
    expect(bare?.secrets).toEqual([]);
    expect(bare?.enabled).toBe(true);
    expect(records[3]?.enabled).toBe(false);
  });

  it("omits field values at summary detail while still reporting secret state", async () => {
    const body = await fixtureBody("sonarr", "indexer");
    const { outcome } = await observe(
      "sonarr",
      observationRequest("indexers", { detail: "summary" }),
      serving(body),
    );
    const indexer = firstRecord(providerRecords(outcome));

    expect(indexer.fields).toBeUndefined();
    expect(indexer.name).toBe("Example Usenet Indexer");
    expect(indexer.secrets).toEqual([{ name: "apiKey", state: "configured", masked: false }]);
  });
});

describe("observing provider schemas", () => {
  it("reads the instance's templates and describes fields without valuing them", async () => {
    const [indexers, schema] = await Promise.all([
      fixtureBody("sonarr", "indexer"),
      fixtureBody("sonarr", "indexer/schema"),
    ]);
    const { outcome, calls } = await observe(
      "sonarr",
      observationRequest("indexers", { includeSchema: true }),
      (call) => jsonResponse(call.url.pathname.endsWith("/schema") ? schema : indexers),
    );
    const view = expectObserved(outcome).data;

    expect(calls.map((call) => call.url.pathname)).toEqual([
      "/api/v3/indexer",
      "/api/v3/indexer/schema",
    ]);
    if (view.family !== "provider") {
      throw new Error("Expected a provider view");
    }
    expect(view.schema?.templates.map((template) => template.implementation)).toEqual([
      "Newznab",
      "Torznab",
    ]);

    const newznab = view.schema?.templates[0];
    expect(newznab?.name).toBe("Newznab");
    expect(newznab?.configContract).toBe("NewznabSettings");
    expect(newznab?.fields).toEqual([
      { name: "baseUrl", label: "URL", type: "textbox", advanced: false, secret: false },
      { name: "apiPath", label: "API Path", type: "textbox", advanced: true, secret: false },
      { name: "apiKey", label: "API Key", type: "textbox", advanced: false, secret: true },
      { name: "categories", label: "Categories", type: "select", advanced: false, secret: false },
    ]);
  });

  it("does not read a schema route the caller did not ask for", async () => {
    const body = await fixtureBody("sonarr", "indexer");
    const { calls } = await observe("sonarr", observationRequest("indexers"), serving(body));

    expect(calls.map((call) => call.url.pathname)).toEqual(["/api/v3/indexer"]);
  });
});

describe("bounding and continuing an observation", () => {
  it("bounds the page and continues it with a cursor of its own", async () => {
    const body = await fixtureBody("sonarr", "indexer");
    const first = await observe(
      "sonarr",
      observationRequest("indexers", { paging: { pageSize: 1 } }),
      serving(body),
    );
    const firstPage = expectObserved(first.outcome);

    expect(firstPage.continuation.returned).toBe(1);
    expect(firstPage.continuation.hasMore).toBe(true);
    expect(firstPage.resources.size).toBe(1);

    const cursor = firstPage.continuation.cursor;
    expect(cursor).toBeDefined();
    const second = await observe(
      "sonarr",
      observationRequest("indexers", { paging: { pageSize: 1, cursor } }),
      serving(body),
    );
    const secondPage = expectObserved(second.outcome);

    expect(secondPage.continuation).toEqual({ pageSize: 1, returned: 1, hasMore: false });
    expect(providerRecords(second.outcome).map((record) => record.ref.id)).toEqual(["2"]);
  });

  it("refuses a continuation minted for a different observation", async () => {
    const body = await fixtureBody("sonarr", "indexer");
    const first = await observe(
      "sonarr",
      observationRequest("indexers", { paging: { pageSize: 1 } }),
      serving(body),
    );
    const cursor = expectObserved(first.outcome).continuation.cursor ?? "";

    const mismatched = await observe(
      "sonarr",
      observationRequest("import_lists", { paging: { pageSize: 1, cursor } }),
      serving(await fixtureBody("sonarr", "importlist")),
    );
    expect(expectObservationError(mismatched.outcome).message).toContain(
      "belongs to a different observation",
    );

    const malformed = await observe(
      "sonarr",
      observationRequest("indexers", { paging: { pageSize: 1, cursor: "not-a-cursor" } }),
      serving(body),
    );
    expect(expectObservationError(malformed.outcome).message).toContain("was not issued");
  });

  /**
   * The cursor digest must key on what actually varies. `includeSchema` only
   * reaches a schema route on a provider domain; everywhere else it is ignored,
   * so digesting it there would make two identical observations mint cursors
   * that reject each other.
   */
  it("mints interchangeable cursors for a non-provider observation either way", async () => {
    const tags = [
      { id: 1, label: "example-one" },
      { id: 2, label: "example-two" },
    ];
    const withSchema = await observe(
      "sonarr",
      observationRequest("tags", { paging: { pageSize: 1 }, includeSchema: true }),
      serving(tags),
    );
    const cursor = expectObserved(withSchema.outcome).continuation.cursor;
    expect(cursor).toBeDefined();

    // The same observation, asked without the flag, continues that page.
    const continued = await observe(
      "sonarr",
      observationRequest("tags", { paging: { pageSize: 1, cursor } }),
      serving(tags),
    );
    expect(observedRecords(continued.outcome).map((record) => record.ref.id)).toEqual(["2"]);
    // And no schema route was read for a domain that has none.
    expect(withSchema.calls.map((call) => call.url.pathname)).toEqual(["/api/v3/tag"]);
  });

  it("still separates provider observations that differ only by includeSchema", async () => {
    const body = await fixtureBody("sonarr", "indexer");
    const plain = await observe(
      "sonarr",
      observationRequest("indexers", { paging: { pageSize: 1 } }),
      serving(body),
    );
    const cursor = expectObserved(plain.outcome).continuation.cursor;

    const schemaBody = await fixtureBody("sonarr", "indexer/schema");
    const mismatched = await observe(
      "sonarr",
      observationRequest("indexers", { paging: { pageSize: 1, cursor }, includeSchema: true }),
      (call) => jsonResponse(call.url.pathname.endsWith("/schema") ? schemaBody : body),
    );

    expect(expectObservationError(mismatched.outcome).message).toContain(
      "belongs to a different observation",
    );
  });

  it("refuses a page size outside the published bounds before sending anything", async () => {
    const { outcome, calls } = await observe(
      "sonarr",
      observationRequest("indexers", { paging: { pageSize: 0 } }),
      serving([]),
    );

    expect(expectObservationError(outcome).code).toBe("invalid_input");
    expect(calls).toHaveLength(0);
  });
});

describe("refusing what an instance cannot answer", () => {
  it("refuses a domain the application does not model, without sending a request", async () => {
    for (const [application, domain] of [
      ["prowlarr", "root_folders"],
      ["prowlarr", "quality_profiles"],
      ["sonarr", "applications"],
      ["radarr", "release_profiles"],
      ["sonarr", "proxies"],
    ] as const) {
      const { outcome, calls } = await observe(
        application,
        observationRequest(domain),
        serving([]),
      );

      expect(expectObservationError(outcome).code).toBe("unsupported_capability");
      expect(calls).toHaveLength(0);
    }
  });

  it("reports an unreachable instance as unavailable rather than as an empty page", async () => {
    const { outcome } = await observe("sonarr", observationRequest("indexers"), () => {
      throw new Error("connection refused");
    });
    const error = expectObservationError(outcome);

    expect(error.code).toBe("unavailable_application");
    expect(error.application).toBe("sonarr");
    expect(error.recoverable).toBe(true);
  });

  it("refuses a body it cannot read without quoting it", async () => {
    const collection = await observe(
      "sonarr",
      observationRequest("indexers"),
      serving({ message: "not a collection" }),
    );
    expect(expectObservationError(collection.outcome).code).toBe("unexpected_response");

    const element = await observe("sonarr", observationRequest("tags"), serving(["not-a-record"]));
    expect(expectObservationError(element.outcome).code).toBe("unexpected_response");

    const identifier = await observe(
      "sonarr",
      observationRequest("tags"),
      serving([{ label: "example" }]),
    );
    expect(expectObservationError(identifier.outcome).code).toBe("unexpected_response");
  });

  /**
   * The counterpart to "reports no identifier for a payload that carries none"
   * in `configuration-resources.test.ts`: these are exactly the values the
   * internal capture declines to treat as an identifier. Publishing a reference
   * for one would hand a caller a row the resource set cannot find, so every
   * family refuses the record instead.
   */
  it("refuses an id the internal capture would not recognize", async () => {
    for (const id of [1.5, Number.MAX_SAFE_INTEGER + 2, 1e21, "1"]) {
      for (const domain of ["indexers", "quality_profiles", "tags"] as const) {
        const { outcome } = await observe(
          "sonarr",
          observationRequest(domain),
          serving([{ id, name: "example" }]),
        );

        expect(expectObservationError(outcome).code).toBe("unexpected_response");
      }
    }
  });
});
