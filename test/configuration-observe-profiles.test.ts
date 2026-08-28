import { describe, expect, it } from "vitest";
import {
  expectObservationError,
  expectObserved,
  firstRecord,
  observationRequest,
  observe,
  observedRecords,
} from "./support/configuration.js";
import { fixtureBody, jsonResponse } from "./support/library.js";

/**
 * Observation of the fixed-shape families: quality, custom-format, release,
 * delay, and app profiles, plus tags, root folders, path mappings, and list
 * exclusions.
 *
 * These carry no dynamic `fields` array, so they are mapped property by
 * property against a per-domain allowlist rather than through the provider
 * classifier. The provider families, and the four leakage classes, are covered
 * in `configuration-observe.test.ts`.
 *
 * Every domain is read on every application that models it. Several of them
 * are the same concept under different property names — a Sonarr exclusion
 * names a series, a Radarr one names a film — and one allowlist serves both,
 * so a domain read on only one application leaves half of its mapping
 * unexercised.
 */

function serving(body: unknown, status = 200) {
  return () => jsonResponse(body, status);
}

describe("observing profiles", () => {
  it("reads a recorded quality profile's scalar policy fields", async () => {
    const body = await fixtureBody("sonarr", "qualityprofile");
    const { outcome } = await observe(
      "sonarr",
      observationRequest("quality_profiles"),
      serving(body),
    );
    const records = observedRecords(outcome);
    const profile = firstRecord(records);

    expect(records.map((record) => record.ref.id)).toEqual(["1", "2", "4"]);
    expect(profile.family).toBe("profile");
    expect(profile.name).toBe("Example HD");
    expect(profile.fields).toEqual([
      { name: "upgradeAllowed", value: true },
      { name: "cutoff", value: 4 },
      { name: "minFormatScore", value: 0 },
      { name: "cutoffFormatScore", value: 0 },
    ]);
    expect(profile.withheld).toEqual({ count: 0 });
  });

  /**
   * Ordering is asserted against an inline payload rather than the recorded
   * profile: the recorded one carries empty item lists, because the library
   * fixtures it has to agree with only ever name profiles by id.
   */
  it("keeps a quality profile's entries in the order the instance sent them", async () => {
    const { outcome } = await observe(
      "sonarr",
      observationRequest("quality_profiles"),
      serving([
        {
          id: 1,
          name: "Example HD",
          upgradeAllowed: true,
          cutoff: 9,
          items: [
            { quality: { id: 9, name: "HDTV-1080p" }, items: [], allowed: true },
            { id: 1001, name: "WEB 1080p", items: [], allowed: true },
            { quality: { id: 1, name: "SDTV" }, items: [], allowed: false },
          ],
          formatItems: [{ format: 1, name: "Example Format", score: 100 }],
        },
      ]),
    );
    const profile = firstRecord(observedRecords(outcome));

    if (profile.family !== "profile") {
      throw new Error("Expected a profile record");
    }
    expect(profile.entries).toEqual([
      { name: "HDTV-1080p", allowed: true },
      { name: "WEB 1080p", allowed: true },
      { name: "SDTV", allowed: false },
      { name: "Example Format", score: 100 },
    ]);
  });

  it("reports a custom format's specifications by name", async () => {
    const body = await fixtureBody("radarr", "customformat");
    const { outcome } = await observe(
      "radarr",
      observationRequest("custom_formats"),
      serving(body),
    );
    const format = firstRecord(observedRecords(outcome));

    if (format.family !== "profile") {
      throw new Error("Expected a profile record");
    }
    expect(format.entries).toEqual([{ name: "Example Release Title Specification" }]);
    expect(format.fields).toEqual([{ name: "includeCustomFormatWhenRenaming", value: false }]);
  });

  it("reads a Prowlarr app profile as a flat profile document", async () => {
    const body = await fixtureBody("prowlarr", "appprofile");
    const { outcome } = await observe(
      "prowlarr",
      observationRequest("app_profiles"),
      serving(body),
    );
    const profile = firstRecord(observedRecords(outcome));

    expect(profile.name).toBe("Example App Profile");
    expect(profile.fields).toEqual([
      { name: "enableRss", value: true },
      { name: "enableAutomaticSearch", value: true },
      { name: "enableInteractiveSearch", value: true },
      { name: "minimumSeeders", value: 1 },
    ]);
    expect(profile.withheld).toEqual({ count: 0 });
  });

  /**
   * The remaining profile domains, whose per-domain allowlists nothing else
   * reads.
   *
   * These payloads are inline rather than recorded. A fixture is a sanitized
   * recording of an instance's answer, and this project has none for these
   * routes; writing one would put an invented body under `fixtures/` claiming
   * to be a recording. What is under test here is the mapping — which
   * properties the allowlist surfaces, in which order, and what it leaves to
   * the withheld count — and a constructed payload says exactly that without
   * claiming to be evidence about any instance.
   */
  it("reads a Sonarr release profile's terms, which only Sonarr models", async () => {
    const { outcome } = await observe(
      "sonarr",
      observationRequest("release_profiles"),
      serving([
        {
          id: 1,
          name: "Example Release Profile",
          enabled: true,
          indexerId: 0,
          required: ["example-term"],
          ignored: ["example-blocked-term"],
          tags: [],
        },
      ]),
    );
    const profile = firstRecord(observedRecords(outcome));

    expect(profile.name).toBe("Example Release Profile");
    expect(profile.fields).toEqual([
      { name: "enabled", value: true },
      { name: "indexerId", value: 0 },
      { name: "required", value: ["example-term"] },
      { name: "ignored", value: ["example-blocked-term"] },
    ]);
    expect(profile.withheld).toEqual({ count: 1 });
  });

  it("reads a delay profile's protocol policy from both applications that model one", async () => {
    for (const application of ["sonarr", "radarr"] as const) {
      const { outcome } = await observe(
        application,
        observationRequest("delay_profiles"),
        serving([
          {
            id: 1,
            enableUsenet: true,
            enableTorrent: false,
            preferredProtocol: "usenet",
            usenetDelay: 0,
            torrentDelay: 30,
            bypassIfHighestQuality: true,
            bypassIfAboveCustomFormatScore: false,
            minimumCustomFormatScore: 0,
            order: 1,
            tags: [],
          },
        ]),
      );
      const profile = firstRecord(observedRecords(outcome));

      expect(profile.ref.application).toBe(application);
      expect(profile.fields).toEqual([
        { name: "enableUsenet", value: true },
        { name: "enableTorrent", value: false },
        { name: "preferredProtocol", value: "usenet" },
        { name: "usenetDelay", value: 0 },
        { name: "torrentDelay", value: 30 },
        // Both bypass switches are ordinary settings. They read as credentials
        // to a matcher that looks for `pass` anywhere in a name rather than
        // where a word begins, which is what made them secrets until the
        // classifier learned word boundaries.
        { name: "bypassIfHighestQuality", value: true },
        { name: "bypassIfAboveCustomFormatScore", value: false },
        { name: "minimumCustomFormatScore", value: 0 },
        { name: "order", value: 1 },
      ]);
      expect(profile.secrets).toEqual([]);
      expect(profile.withheld).toEqual({ count: 1 });
    }
  });

  it("reads a Sonarr custom format's specifications in order", async () => {
    const { outcome } = await observe(
      "sonarr",
      observationRequest("custom_formats"),
      serving([
        {
          id: 3,
          name: "Example Format",
          includeCustomFormatWhenRenaming: false,
          specifications: [
            { name: "Example Release Title Specification" },
            { name: "Example Source Specification" },
          ],
        },
      ]),
    );
    const format = firstRecord(observedRecords(outcome));

    if (format.family !== "profile") {
      throw new Error("Expected a profile record");
    }
    expect(format.entries).toEqual([
      { name: "Example Release Title Specification" },
      { name: "Example Source Specification" },
    ]);
    expect(format.fields).toEqual([{ name: "includeCustomFormatWhenRenaming", value: false }]);
    expect(format.withheld).toEqual({ count: 0 });
  });
});

describe("observing resources", () => {
  it("reads tags by their label", async () => {
    const body = await fixtureBody("sonarr", "tag");
    const { outcome } = await observe("sonarr", observationRequest("tags"), serving(body));
    const records = observedRecords(outcome);

    expect(records.map((record) => record.name)).toEqual([
      "example-tag",
      "example-archive",
      "example-review",
    ]);
    expect(firstRecord(records).ref).toEqual({
      application: "sonarr",
      domain: "tags",
      id: "3",
    });
    expect(firstRecord(records).withheld).toEqual({ count: 0 });
  });

  it("reads a root folder's path and reports its nested list as withheld", async () => {
    const body = await fixtureBody("sonarr", "rootfolder");
    const { outcome } = await observe("sonarr", observationRequest("root_folders"), serving(body));
    const records = observedRecords(outcome);
    const folder = firstRecord(records);

    expect(records.map((record) => record.ref.id)).toEqual(["1", "2"]);
    expect(folder.family).toBe("resource");
    expect(folder.fields).toEqual([
      { name: "path", value: "/media/example/series" },
      { name: "accessible", value: true },
      { name: "freeSpace", value: 549755813888 },
    ]);
    expect(folder.withheld).toEqual({ count: 1 });
  });

  it("reads the same three resource domains from Radarr", async () => {
    for (const [domain, route, expected] of [
      ["root_folders", "rootfolder", ["1"]],
      ["quality_profiles", "qualityprofile", ["1", "2"]],
      ["tags", "tag", ["7", "8"]],
    ] as const) {
      const body = await fixtureBody("radarr", route);
      const { outcome } = await observe("radarr", observationRequest(domain), serving(body));

      expect(observedRecords(outcome).map((record) => record.ref.id)).toEqual(expected);
    }
  });

  /**
   * The same domain under two names: Radarr serves its exclusions from
   * `exclusions` and answers `importlistexclusion` with a 404, while Sonarr does
   * the reverse. Reading only one application is what let a route map that was
   * half wrong pass, so both are read here, from the fixture recorded against
   * each one's own route.
   */
  it("reads an import-list exclusion from the route Radarr serves", async () => {
    const body = await fixtureBody("radarr", "exclusions/paged");
    const { outcome, calls } = await observe(
      "radarr",
      observationRequest("import_list_exclusions"),
      serving(body),
    );
    const exclusion = firstRecord(observedRecords(outcome));

    expect(calls[0]?.url.pathname).toBe("/api/v3/exclusions/paged");
    expect(exclusion.fields).toEqual([
      { name: "tmdbId", value: 11 },
      { name: "movieTitle", value: "Example Movie" },
      { name: "movieYear", value: 2001 },
    ]);
  });

  /**
   * The same domain, and a different set of properties: Sonarr excludes a
   * series by `tvdbId` and `title` where Radarr excludes a film by `tmdbId`,
   * `movieTitle`, and `movieYear`. One allowlist names all of them, so reading
   * only one application would leave the other half of it unexercised — and a
   * property dropped from it would still look correct.
   */
  it("reads a Sonarr import-list exclusion, whose route and properties are its own", async () => {
    const body = await fixtureBody("sonarr", "importlistexclusion/paged");
    const { outcome, calls } = await observe(
      "sonarr",
      observationRequest("import_list_exclusions"),
      serving(body),
    );
    const records = observedRecords(outcome);
    const exclusion = firstRecord(records);

    expect(calls[0]?.url.pathname).toBe("/api/v3/importlistexclusion/paged");
    expect(records.map((record) => record.ref.id)).toEqual(["2", "1"]);
    expect(exclusion.family).toBe("resource");
    expect(exclusion.fields).toEqual([
      { name: "tvdbId", value: 100002 },
      { name: "title", value: "Example Other Series" },
    ]);
    // An exclusion carries neither `name` nor `label`, on either application:
    // what it is named by is the allowlisted title property itself.
    expect(exclusion.name).toBeUndefined();
    expect(exclusion.withheld).toEqual({ count: 0 });
  });

  /**
   * The instance applies the window for this domain, so the request has to carry
   * it: without an explicit page size both applications answer with their own
   * default of ten, which would make the query's page bound advisory.
   */
  it("asks the instance for the window rather than paging its whole collection", async () => {
    for (const application of ["sonarr", "radarr"] as const) {
      const { outcome, calls } = await observe(
        application,
        observationRequest("import_list_exclusions", { paging: { pageSize: 2 } }),
        serving({ page: 1, pageSize: 2, totalRecords: 5, records: [{ id: 1 }, { id: 2 }] }),
      );
      const query = calls[0]?.url.searchParams;

      expect(query?.get("page")).toBe("1");
      expect(query?.get("pageSize")).toBe("2");
      // The instance reported five, so the continuation says more remain even
      // though nothing here counted the records it withheld.
      expect(expectObserved(outcome).continuation).toMatchObject({ returned: 2, hasMore: true });
    }
  });

  it("advances an exclusion page against the instance's own page number", async () => {
    const first = await observe(
      "radarr",
      observationRequest("import_list_exclusions", { paging: { pageSize: 1 } }),
      serving({ page: 1, pageSize: 1, totalRecords: 3, records: [{ id: 1 }] }),
    );
    const cursor = expectObserved(first.outcome).continuation.cursor;
    expect(cursor).toBeDefined();

    const second = await observe(
      "radarr",
      observationRequest("import_list_exclusions", { paging: { pageSize: 1, cursor } }),
      serving({ page: 2, pageSize: 1, totalRecords: 3, records: [{ id: 2 }] }),
    );

    expect(second.calls[0]?.url.searchParams.get("page")).toBe("2");
    expect(observedRecords(second.outcome).map((record) => record.ref.id)).toEqual(["2"]);
  });

  it("refuses an exclusion page the instance answered with something else", async () => {
    for (const body of [
      // The bare collection the unpaged route answers with, which the paged
      // route does not.
      [{ id: 1, tmdbId: 11 }],
      // An envelope whose records are not records.
      { page: 1, pageSize: 25, totalRecords: 1, records: ["not a record"] },
    ]) {
      const { outcome } = await observe(
        "radarr",
        observationRequest("import_list_exclusions"),
        serving(body),
      );

      expect(expectObservationError(outcome).code).toBe("unexpected_response");
    }
  });

  /**
   * The defect this domain's wrong route produced: a 404 reported as a stale
   * reference told the caller to repeat a query that had produced no reference,
   * which described a recovery that did not exist and hid a permanent
   * misconfiguration behind a code meaning "try again".
   */
  it("reports a route the instance does not serve without advising a refresh", async () => {
    const { outcome } = await observe(
      "radarr",
      observationRequest("import_list_exclusions"),
      serving({ message: "NotFound" }, 404),
    );
    const error = expectObservationError(outcome);

    expect(error.code).toBe("unexpected_response");
    expect(error.recoverable).toBe(false);
    expect(error.remediation).not.toContain("reference");
  });

  it("withholds the machine a remote path mapping names, on either application", async () => {
    for (const application of ["sonarr", "radarr"] as const) {
      const { outcome } = await observe(
        application,
        observationRequest("remote_path_mappings"),
        serving([
          {
            id: 1,
            host: "example-download-client",
            remotePath: "/media/example/downloads",
            localPath: "/media/example/downloads",
          },
        ]),
      );
      const mapping = firstRecord(observedRecords(outcome));

      expect(mapping.fields).toEqual([
        { name: "remotePath", value: "/media/example/downloads" },
        { name: "localPath", value: "/media/example/downloads" },
      ]);
      expect(mapping.withheld).toEqual({ count: 1 });
    }
  });

  it("reads tags from Prowlarr as well as from the two library applications", async () => {
    const { outcome } = await observe(
      "prowlarr",
      observationRequest("tags"),
      serving([{ id: 2, label: "example-tag" }]),
    );
    const tag = firstRecord(observedRecords(outcome));

    expect(tag.ref).toEqual({ application: "prowlarr", domain: "tags", id: "2" });
    expect(tag.name).toBe("example-tag");
    expect(tag.withheld).toEqual({ count: 0 });
  });
});
