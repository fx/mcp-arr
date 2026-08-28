import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  approvedFixtureInventory,
  approvedFixtures,
  approvedFixtureTuples,
  type FixtureTuple,
  type FixtureVersion,
  fixturePathFor,
  loadFixture,
  validateFixture,
} from "./support/fixtures.js";

const fixtureRoot = fileURLToPath(new URL("./fixtures", import.meta.url));
const temporaryDirectories: string[] = [];

async function listFiles(root: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(path.join(root, prefix), { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const relativePath = path.join(prefix, entry.name);
      return entry.isDirectory() ? listFiles(root, relativePath) : [relativePath];
    }),
  );
  return files
    .flat()
    .map((file) => file.split(path.sep).join("/"))
    .sort();
}

function validFixture(): Record<string, unknown> {
  return {
    metadata: {
      application: "sonarr",
      apiVersion: "v3",
      version: "4.0.19.2979",
      endpoint: "/api/v3/system/status",
    },
    body: {
      appName: "Sonarr",
      version: "4.0.19.2979",
    },
  };
}

function validate(value: unknown, relativePath = approvedFixtureInventory[0] ?? "") {
  return validateFixture(value, {
    fixtureRoot,
    filePath: path.join(fixtureRoot, relativePath),
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("versioned fixture contract", () => {
  it("contains exactly the approved fixtures and validates every file", async () => {
    expect(approvedFixtureInventory).toEqual([
      "sonarr/v3/4.0.19.2979/system-status.json",
      "sonarr/v3/4.0.19.2979/series.json",
      "sonarr/v3/4.0.19.2979/series-lookup.json",
      "sonarr/v3/4.0.19.2979/episode.json",
      "sonarr/v3/4.0.19.2979/episodefile.json",
      "sonarr/v3/4.0.19.2979/rename.json",
      "sonarr/v3/4.0.19.2979/wanted-missing.json",
      "sonarr/v3/4.0.19.2979/wanted-cutoff.json",
      "sonarr/v3/4.0.19.2979/calendar.json",
      "sonarr/v3/4.0.19.2979/release.json",
      "sonarr/v3/4.0.19.2979/queue-status.json",
      "sonarr/v3/4.0.19.2979/queue.json",
      "sonarr/v3/4.0.19.2979/queue-details.json",
      "sonarr/v3/4.0.19.2979/manualimport.json",
      "sonarr/v3/4.0.19.2979/history.json",
      "sonarr/v3/4.0.19.2979/history-series.json",
      "sonarr/v3/4.0.19.2979/blocklist.json",
      "sonarr/v3/4.0.19.2979/health.json",
      "sonarr/v3/4.0.19.2979/command.json",
      "sonarr/v3/4.0.19.2979/diskspace.json",
      "sonarr/v3/4.0.19.2979/rootfolder.json",
      "sonarr/v3/4.0.19.2979/qualityprofile.json",
      "sonarr/v3/4.0.19.2979/qualitydefinition.json",
      "sonarr/v3/4.0.19.2979/language.json",
      "sonarr/v3/4.0.19.2979/tag.json",
      "sonarr/v3/4.0.19.2979/indexer.json",
      "sonarr/v3/4.0.19.2979/importlist.json",
      "sonarr/v3/4.0.19.2979/config-downloadclient.json",
      "sonarr/v3/4.0.19.2979/importlistexclusion-paged.json",
      "radarr/v3/6.3.0.10514/system-status.json",
      "radarr/v3/6.3.0.10514/movie.json",
      "radarr/v3/6.3.0.10514/movie-lookup.json",
      "radarr/v3/6.3.0.10514/collection.json",
      "radarr/v3/6.3.0.10514/moviefile.json",
      "radarr/v3/6.3.0.10514/rename.json",
      "radarr/v3/6.3.0.10514/wanted-missing.json",
      "radarr/v3/6.3.0.10514/wanted-cutoff.json",
      "radarr/v3/6.3.0.10514/calendar.json",
      "radarr/v3/6.3.0.10514/release.json",
      "radarr/v3/6.3.0.10514/queue-status.json",
      "radarr/v3/6.3.0.10514/queue.json",
      "radarr/v3/6.3.0.10514/queue-details.json",
      "radarr/v3/6.3.0.10514/manualimport.json",
      "radarr/v3/6.3.0.10514/history.json",
      "radarr/v3/6.3.0.10514/history-movie.json",
      "radarr/v3/6.3.0.10514/blocklist.json",
      "radarr/v3/6.3.0.10514/health.json",
      "radarr/v3/6.3.0.10514/command.json",
      "radarr/v3/6.3.0.10514/diskspace.json",
      "radarr/v3/6.3.0.10514/rootfolder.json",
      "radarr/v3/6.3.0.10514/qualityprofile.json",
      "radarr/v3/6.3.0.10514/qualitydefinition.json",
      "radarr/v3/6.3.0.10514/language.json",
      "radarr/v3/6.3.0.10514/tag.json",
      "radarr/v3/6.3.0.10514/downloadclient.json",
      "radarr/v3/6.3.0.10514/config-downloadclient.json",
      "radarr/v3/6.3.0.10514/customformat.json",
      "radarr/v3/6.3.0.10514/exclusions-paged.json",
      "prowlarr/v1/2.5.2.5491/system-status.json",
      "prowlarr/v1/2.5.2.5491/indexer.json",
      "prowlarr/v1/2.5.2.5491/indexerstatus.json",
      "prowlarr/v1/2.5.2.5491/search.json",
      "prowlarr/v1/2.5.2.5491/history.json",
      "prowlarr/v1/2.5.2.5491/health.json",
      "prowlarr/v1/2.5.2.5491/command.json",
      "prowlarr/v1/2.5.2.5491/indexerstats.json",
      "prowlarr/v1/2.5.2.5491/applications.json",
      "prowlarr/v1/2.5.2.5491/notification.json",
      "prowlarr/v1/2.5.2.5491/appprofile.json",
      "prowlarr/v1/2.5.2.5491/tag.json",
    ]);
    await expect(listFiles(fixtureRoot)).resolves.toEqual([...approvedFixtureInventory].sort());

    const fixtures = await Promise.all(
      approvedFixtureInventory.map((relativePath) => loadFixture(fixtureRoot, relativePath)),
    );
    // Every file's declared metadata has to be the tuple and endpoint its own
    // path stands for; the loader refuses anything else.
    expect(fixtures.map(({ metadata }) => metadata)).toEqual(
      approvedFixtures.map(({ application, apiVersion, version, endpoint }) => ({
        application,
        apiVersion,
        version,
        endpoint,
      })),
    );
    expect(fixturePathFor("sonarr", "wanted/missing")).toBe(
      "sonarr/v3/4.0.19.2979/wanted-missing.json",
    );
    expect(() => fixturePathFor("prowlarr", "series")).toThrow("No approved fixture");
  });

  it("declares exactly the tuples the approved inventory holds", () => {
    // The contract's rules run as JavaScript and are declared for TypeScript in
    // a file beside them, so the two could disagree: a tuple added to the
    // declaration alone would type-check while the runtime contract refused it.
    // Keying by version makes the map exhaustive in both directions —
    // TypeScript refuses a missing key and an excess one, and a version is what
    // distinguishes one declared tuple from another — while each value has to
    // satisfy the declared tuple union, so an application or API label that
    // drifted there fails to compile. Comparing the map against the runtime
    // list is what catches drift the other way.
    const declared: Record<FixtureVersion, FixtureTuple> = {
      "4.0.19.2979": { application: "sonarr", apiVersion: "v3", version: "4.0.19.2979" },
      "6.3.0.10514": { application: "radarr", apiVersion: "v3", version: "6.3.0.10514" },
      "2.5.2.5491": { application: "prowlarr", apiVersion: "v1", version: "2.5.2.5491" },
    };

    expect(new Set(approvedFixtureTuples)).toEqual(new Set(Object.values(declared)));
  });

  it("rejects a fixture whose endpoint is not the one its file records", () => {
    const fixture = validFixture();
    (fixture.metadata as Record<string, unknown>).endpoint = "/api/v3/series";

    expect(() => validate(fixture)).toThrow("Fixture endpoint does not match its file");
  });

  it("accepts object or array response bodies and keeps status checks object-specific", () => {
    const collectionFixture = validFixture();
    (collectionFixture.metadata as Record<string, unknown>).endpoint = "/api/v3/series";
    collectionFixture.body = [{ title: "Sanitized fixture" }];

    expect(validate(collectionFixture, "sonarr/v3/4.0.19.2979/series.json").body).toEqual([
      { title: "Sanitized fixture" },
    ]);

    const statusFixture = validFixture();
    statusFixture.body = [];
    expect(() => validate(statusFixture)).toThrow("Fixture system-status body must be an object");
  });

  it("rejects malformed JSON and malformed or missing metadata", async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), "mcp-arr-fixtures-"));
    temporaryDirectories.push(temporaryRoot);
    const relativePath = approvedFixtureInventory[0] ?? "";
    const fixturePath = path.join(temporaryRoot, relativePath);
    await mkdir(path.dirname(fixturePath), { recursive: true });
    await writeFile(fixturePath, "{", "utf8");
    await expect(loadFixture(temporaryRoot, relativePath)).rejects.toThrow(
      "Fixture is not valid JSON",
    );

    const duplicateVersion = JSON.stringify(validFixture()).replace(
      '"version":"4.0.19.2979"',
      '"version":"4.0.19.2979","\\u0076ersion":"4.0.19.2979"',
    );
    await writeFile(fixturePath, duplicateVersion, "utf8");
    await expect(loadFixture(temporaryRoot, relativePath)).rejects.toThrow(
      'Fixture contains duplicate JSON object key "version"',
    );

    expect(() => validate(null)).toThrow("Fixture must be a JSON object");
    expect(() => validate({ body: {} })).toThrow("Fixture metadata must be an object");
    for (const field of ["application", "apiVersion", "version", "endpoint"] as const) {
      const fixture = validFixture();
      const metadata = fixture.metadata as Record<string, unknown>;
      delete metadata[field];
      expect(() => validate(fixture)).toThrow(`metadata.${field} must be a non-empty string`);
    }
  });

  it("rejects unapproved tuples and path, API, endpoint, and body-version mismatches", () => {
    const unapproved = validFixture();
    (unapproved.metadata as Record<string, unknown>).version = "0.0.0";
    expect(() => validate(unapproved)).toThrow("Unapproved fixture tuple");

    expect(() => validate(validFixture(), "radarr/v3/4.0.19.2979/system-status.json")).toThrow(
      "Fixture application label does not match metadata",
    );
    expect(() => validate(validFixture(), "sonarr/v1/4.0.19.2979/system-status.json")).toThrow(
      "Fixture API label does not match metadata",
    );
    expect(() => validate(validFixture(), "sonarr/v3/4.0.19.1/system-status.json")).toThrow(
      "Fixture version label does not match metadata",
    );

    const endpointMismatch = validFixture();
    (endpointMismatch.metadata as Record<string, unknown>).endpoint = "/api/v1/system/status";
    expect(() => validate(endpointMismatch)).toThrow("Fixture endpoint must use");

    const unsafeEndpoint = validFixture();
    (unsafeEndpoint.metadata as Record<string, unknown>).endpoint = [
      "https:",
      "",
      "fixture.invalid",
      "api/v3/system/status",
    ].join("/");
    expect(() => validate(unsafeEndpoint)).toThrow("Fixture endpoint must use");

    const bodyMismatch = validFixture();
    (bodyMismatch.body as Record<string, unknown>).version = "4.0.19.1";
    expect(() => validate(bodyMismatch)).toThrow("Fixture body version does not match metadata");
  });

  it("rejects recursive secret-bearing keys", () => {
    for (const key of ["apiKey", "authorization", "password", "client_secret", "sessionToken"]) {
      const fixture = validFixture();
      (fixture.body as Record<string, unknown>).nested = [{ safe: { [key]: "placeholder" } }];
      expect(() => validate(fixture)).toThrow("Secret-bearing key is not allowed");
    }
  });

  it("rejects recursive identifying fields", () => {
    for (const key of [
      "host",
      "hostAddress",
      "hostname",
      "instance",
      "instanceName",
      "instanceType",
      "internalHost",
      "ip",
      "ipAddress",
      "user",
      "userAgent",
      "userId",
      "username",
    ]) {
      const fixture = validFixture();
      (fixture.body as Record<string, unknown>).nested = [{ safe: { [key]: "placeholder" } }];
      expect(() => validate(fixture)).toThrow("Identifying key is not allowed");
    }

    const metadataFixture = validFixture();
    (metadataFixture.metadata as Record<string, unknown>).hostname = "placeholder";
    expect(() => validate(metadataFixture)).toThrow("Identifying key is not allowed");
  });

  it("allows a media file name but still rejects a hostname wearing one", () => {
    const fixture = validFixture();
    (fixture.body as Record<string, unknown>).nested = [
      "Season 01/Example Series - S01E01 - Example Pilot Bluray-1080p.mkv",
      "/media/example/movies/Example Movie (2021) Bluray-1080p.mkv",
      "Example Subtitle Track.srt",
    ];
    expect(() => validate(fixture)).not.toThrow();

    for (const disguised of [
      ["fixture", "example", "invalid", "mkv"].join("."),
      ["fixture", "example", "invalid"].join(".").concat(".mkv.bak"),
    ]) {
      const unsafe = validFixture();
      (unsafe.body as Record<string, unknown>).nested = [disguised];
      expect(() => validate(unsafe)).toThrow("Sensitive hostname is not allowed");
    }
  });

  it("allows schema path fields when their values are neutral", () => {
    const fixture = validFixture();
    (fixture.body as Record<string, unknown>).path = "/media/example";
    (fixture.body as Record<string, unknown>).rootFolderPath = "/media/example/library";

    expect(() => validate(fixture)).not.toThrow();
  });

  it("rejects identifying and sensitive value patterns", () => {
    const unsafeValues = [
      ["email address", ["fixture", "example.invalid"].join("@")],
      ["URL", ["https:", "", "fixture.invalid", "path"].join("/")],
      ["IP address", ["192", "0", "2", "1"].join(".")],
      ["IP address", ["2001", "db8", "", "1"].join(":")],
      ["hostname", ["fixture", "example", "invalid"].join(".")],
      ["internal hostname", ["local", "host"].join("")],
      ["home path", ["", "home", "fixture", "data"].join("/")],
      ["home path", ["", "Users", "fixture", "data"].join("/")],
      ["home path", ["", "root", "fixture"].join("/")],
      ["home path", ["~", "fixture", "data"].join("/")],
      ["workspace path", ["", "workspace", "fixture", "data"].join("/")],
      ["sensitive path", ["", "srv", "fixture", "data"].join("/")],
      ["sensitive path", ["", "media", "private", "data"].join("/")],
      ["Windows path", ["prefix=C:", "fixture", "data"].join("\\")],
      ["UNC path", `${"\\".repeat(2)}fixture\\share`],
      // A path arrives embedded in upstream free text as readily as it arrives
      // alone, and one behind a delimiter would otherwise read as ordinary text.
      ["workspace path", `detail=${["", "workspace", "fixture"].join("/")}`],
      ["sensitive path", `detail:${["", "srv", "fixture"].join("/")}`],
      ["sensitive path", `first,${["", "srv", "fixture"].join("/")}`],
      ["sensitive path", `first;${["", "srv", "fixture"].join("/")}`],
      ["sensitive path", `first|${["", "srv", "fixture"].join("/")}`],
    ] as const;

    for (const [description, unsafeValue] of unsafeValues) {
      const fixture = validFixture();
      (fixture.body as Record<string, unknown>).nested = [unsafeValue];
      expect(() => validate(fixture)).toThrow(`Sensitive ${description} is not allowed`);
      // A key is text the instance chose too, and is held to the same screens.
      // Which refusal fires is not the point — a key whose name is on the
      // identifying list is refused for that first — only that none passes.
      const keyed = validFixture();
      (keyed.body as Record<string, unknown>).nested = [{ [unsafeValue]: 1 }];
      expect(() => validate(keyed)).toThrow("is not allowed");
    }
  });

  it("keeps a relative path a name rather than a path", () => {
    // The boundary the path screens anchor on never includes a character a path
    // segment can end in, so an ordinary relative file name still passes.
    const fixture = validFixture();
    (fixture.body as Record<string, unknown>).nested = [
      "Season 01/Example Series - S01E01 - Example Pilot Bluray-1080p.mkv",
      "Example Movie (2021)/Example Movie (2021) Bluray-1080p.mkv",
    ];

    expect(() => validate(fixture)).not.toThrow();
  });
});
