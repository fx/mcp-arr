import { describe, expect, it } from "vitest";
import {
  firstRecord,
  observationRequest,
  observe,
  observedRecords,
} from "./support/configuration.js";
import { fixtureBody, jsonResponse } from "./support/library.js";

/**
 * Observation of the fixed-shape families: quality and custom-format profiles,
 * app profiles, tags, root folders, path mappings, and list exclusions.
 *
 * These carry no dynamic `fields` array, so they are mapped property by
 * property against a per-domain allowlist rather than through the provider
 * classifier. The provider families, and the four leakage classes, are covered
 * in `configuration-observe.test.ts`.
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

  it("reads an import-list exclusion", async () => {
    const body = await fixtureBody("radarr", "importlistexclusion");
    const { outcome } = await observe(
      "radarr",
      observationRequest("import_list_exclusions"),
      serving(body),
    );
    const exclusion = firstRecord(observedRecords(outcome));

    expect(exclusion.fields).toEqual([
      { name: "tmdbId", value: 11 },
      { name: "movieTitle", value: "Example Movie" },
      { name: "movieYear", value: 2001 },
    ]);
  });

  it("withholds the machine a remote path mapping names", async () => {
    const { outcome } = await observe(
      "radarr",
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
  });
});
