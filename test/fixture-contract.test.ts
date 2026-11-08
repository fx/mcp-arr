import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  approvedFixtureInventory,
  approvedFixtures,
  approvedFixtureTuples,
  captureTargetFor,
  createFixtureInventory,
  type FixtureTuple,
  type FixtureVersion,
  fixturePathFor,
  loadFixture,
  minimumFixtureTuples,
  type RecordedApplication,
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
      "sonarr/v3/4.0.20.3014/qualityprofile.json",
      "sonarr/v3/4.0.20.3014/queue.json",
      "sonarr/v3/4.0.20.3014/queue-details.json",
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
      "radarr/v3/6.4.4.10685/qualityprofile.json",
      "radarr/v3/6.4.4.10685/queue.json",
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
      "4.0.20.3014": { application: "sonarr", apiVersion: "v3", version: "4.0.20.3014" },
      "6.3.0.10514": { application: "radarr", apiVersion: "v3", version: "6.3.0.10514" },
      "6.4.4.10685": { application: "radarr", apiVersion: "v3", version: "6.4.4.10685" },
      "2.5.2.5491": { application: "prowlarr", apiVersion: "v1", version: "2.5.2.5491" },
      "2.7.0.5723": { application: "prowlarr", apiVersion: "v1", version: "2.7.0.5723" },
    };

    expect(new Set(approvedFixtureTuples)).toEqual(new Set(Object.values(declared)));
    // The minimum is what every test that names no version is evidence for,
    // and it is the version the application descriptors record as supported.
    expect(minimumFixtureTuples).toEqual([
      declared["4.0.19.2979"],
      declared["6.3.0.10514"],
      declared["2.5.2.5491"],
    ]);
  });

  it("rejects a fixture whose endpoint is not the one its file records", () => {
    const fixture = validFixture();
    (fixture.metadata as Record<string, unknown>).endpoint = "/api/v3/series";

    expect(() => validate(fixture)).toThrow("Fixture endpoint does not match its file");
  });

  it("accepts object or array response bodies and keeps status checks object-specific", () => {
    const collectionFixture = validFixture();
    (collectionFixture.metadata as Record<string, unknown>).endpoint = "/api/v3/series";
    collectionFixture.body = [{ title: "Example Series" }];

    expect(validate(collectionFixture, "sonarr/v3/4.0.19.2979/series.json").body).toEqual([
      { title: "Example Series" },
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

  it("refuses what identifies a library or its services, and accepts the stand-ins", () => {
    // Real-looking values a capture must never write: a library's titles and
    // text, metadata ids outside the reserved blocks, an operator's names.
    const identifying: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ["title", { title: "Love Begins in Another World" }],
      ["title", { originalTitle: "Another World" }],
      ["title", { seriesTitle: "Another World" }],
      ["sortTitle", { sortTitle: "love begins in another world" }],
      ["cleanTitle", { cleanTitle: "lovebeginsinanotherworld" }],
      ["titleSlug", { titleSlug: "love-begins-in-another-world" }],
      ["overview", { overview: "Two strangers meet in a world that is not theirs." }],
      ["network", { network: "A Real Broadcaster" }],
      ["studio", { studio: "A Real Studio" }],
      ["indexer", { indexer: "Treasure Maps (Prowlarr)" }],
      ["indexer", { indexerName: "Treasure Maps" }],
      ["downloadClient", { downloadClient: "SABnzbd" }],
      ["downloadId", { downloadId: "SABnzbd_nzo_8f2k1q" }],
      ["downloadId", { downloadId: "0123456789abcdef0123456789abcdef01234567" }],
      ["externalId:tvdbId", { tvdbId: 469_794 }],
      ["externalId:tmdbId", { tmdbId: 11 }],
      ["externalId:tvMazeId", { tvMazeId: 65_001 }],
      ["externalId:tvRageId", { tvRageId: "12345" }],
      ["imdbId", { imdbId: "tt1234567" }],
      ["genres", { genres: ["Drama", "Isekai Romance"] }],
      ["certification", { certification: "Kids 7+" }],
      ["tagLabel", { label: "private-tracker" }],
      ["artwork", { coverType: "poster", url: "poster.jpg" }],
    ];
    for (const [field, nested] of identifying) {
      const fixture = validFixture();
      (fixture.body as Record<string, unknown>).nested = [{ inner: nested }];
      expect(() => validate(fixture), JSON.stringify(nested)).toThrow(
        `Identifying ${field} is not neutralized at fixture.body.nested[0].inner.`,
      );
    }

    // The stand-ins a capture writes, the forms the minimum's fixtures were
    // recorded with, and the values that say a field is unset all pass.
    const fixture = validFixture();
    (fixture.body as Record<string, unknown>).nested = [
      {
        title: "Example Title 1",
        sortTitle: "example title 1",
        cleanTitle: "exampletitle1",
        titleSlug: "example-title-1",
        overview: "A sanitized overview recorded only to fix the payload shape",
        network: "Example Network 1",
        studio: "Example Studio",
        indexer: "Example Indexer 1",
        downloadClient: "Example Download Client 1",
        downloadId: "example-download-1",
        tvdbId: 100_001,
        tmdbId: 200_001,
        tvMazeId: 0,
        tvRageId: null,
        imdbId: "tt0000001",
        genres: ["Example Genre 1", "Drama", "Science Fiction"],
        certification: "PG-13",
        ratings: { votes: 300, value: 7.5 },
        images: [{ coverType: "poster", url: "/media/example/artwork-1", remoteUrl: "" }],
      },
      { id: 7, label: "example-tag-1" },
      { downloadId: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0", imdbId: "" },
      // A quality definition is titled by its quality until an operator renames it.
      { quality: { id: 7, name: "Bluray-1080p" }, title: "Bluray-1080p" },
      // A provider field's label is the application's text, not a tag's.
      { name: "apiPath", label: "API Path", value: "" },
    ];
    expect(() => validate(fixture)).not.toThrow();

    // A renamed quality definition is the operator's text, and is held to a stand-in.
    const renamed = validFixture();
    (renamed.body as Record<string, unknown>).nested = [
      { quality: { id: 7, name: "Bluray-1080p" }, title: "My Favourite Quality" },
    ];
    expect(() => validate(renamed)).toThrow("Identifying title is not neutralized");
  });

  it("holds a newer version's fixture to shifted dates, years, and example languages", () => {
    // Any route approved at the newer version will do; the screen reads the body.
    const fixtureAt = (version: string, row: Record<string, unknown>) => ({
      metadata: {
        application: "sonarr",
        apiVersion: "v3",
        version,
        endpoint: "/api/v3/qualityprofile",
      },
      body: [row],
    });
    const shifted = {
      added: "2251-06-09T06:47:10Z",
      episode: { airDate: "2251-06-10" },
      series: { year: 2251, originalLanguage: { id: 1, name: "Example Language 1" } },
      languages: [{ id: 1, name: "Example Language 1" }],
    };
    expect(() =>
      validate(fixtureAt("4.0.20.3014", shifted), "sonarr/v3/4.0.20.3014/qualityprofile.json"),
    ).not.toThrow();

    const unshifted: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ["Date is not shifted", { ...shifted, added: "2026-11-06T06:47:10Z" }],
      ["Date is not shifted", { ...shifted, episode: { airDate: "2025-11-21" } }],
      ["Identifying year is not shifted", { ...shifted, series: { year: 2025 } }],
      [
        "Identifying language is not neutralized",
        { ...shifted, languages: [{ id: 8, name: "Japanese" }] },
      ],
      [
        "Identifying language is not neutralized",
        { ...shifted, series: { originalLanguage: { id: 8, name: "Japanese" } } },
      ],
    ];
    for (const [refusal, row] of unshifted) {
      expect(
        () => validate(fixtureAt("4.0.20.3014", row), "sonarr/v3/4.0.20.3014/qualityprofile.json"),
        JSON.stringify(row),
      ).toThrow(refusal);
      // The minimum's fixtures were recorded before dates were shifted, and
      // their tests are written against the dates they hold.
      expect(() =>
        validate(fixtureAt("4.0.19.2979", row), "sonarr/v3/4.0.19.2979/qualityprofile.json"),
      ).not.toThrow();
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

describe("fixtures recorded at more than one version", () => {
  const minimumRoutes = ["system/status", "tag"];
  const recorded: Record<string, RecordedApplication> = {
    sonarr: {
      apiVersion: "v3",
      minimum: "4.0.19.2979",
      routes: { "4.0.19.2979": minimumRoutes, "4.0.20.3014": ["tag", "series/lookup"] },
    },
    radarr: { apiVersion: "v3", minimum: "6.3.0.10514", routes: { "6.3.0.10514": ["tag"] } },
  };

  it("records a newer version's routes under that version, beside the minimum's", () => {
    const inventory = createFixtureInventory(recorded);

    expect(inventory.inventory).toEqual([
      "sonarr/v3/4.0.19.2979/system-status.json",
      "sonarr/v3/4.0.19.2979/tag.json",
      "sonarr/v3/4.0.20.3014/tag.json",
      "sonarr/v3/4.0.20.3014/series-lookup.json",
      "radarr/v3/6.3.0.10514/tag.json",
    ]);
    expect(inventory.fixtures.find(({ version }) => version === "4.0.20.3014")).toMatchObject({
      application: "sonarr",
      apiVersion: "v3",
      route: "tag",
      endpoint: "/api/v3/tag",
    });
    expect(inventory.minimumTuples).toEqual([
      { application: "sonarr", apiVersion: "v3", version: "4.0.19.2979" },
      { application: "radarr", apiVersion: "v3", version: "6.3.0.10514" },
    ]);
    expect(inventory.tuples).toHaveLength(3);
  });

  it("resolves the minimum's fixture unless a test names another version", () => {
    const inventory = createFixtureInventory(recorded);

    // A route recorded at both versions still resolves to the minimum's by
    // default, so recording a newer body never changes what an existing test
    // reads.
    expect(inventory.pathFor("sonarr", "tag")).toBe("sonarr/v3/4.0.19.2979/tag.json");
    expect(inventory.pathFor("sonarr", "tag", { version: "4.0.19.2979" })).toBe(
      "sonarr/v3/4.0.19.2979/tag.json",
    );
    expect(inventory.pathFor("sonarr", "tag", { version: "4.0.20.3014" })).toBe(
      "sonarr/v3/4.0.20.3014/tag.json",
    );
    // A route recorded only at a newer version is never handed to a test that
    // did not ask for that version: it is no evidence about the minimum.
    expect(() => inventory.pathFor("sonarr", "series/lookup")).toThrow(
      "No approved fixture for sonarr series/lookup",
    );
    expect(inventory.pathFor("sonarr", "series/lookup", { version: "4.0.20.3014" })).toBe(
      "sonarr/v3/4.0.20.3014/series-lookup.json",
    );
    expect(() => inventory.pathFor("sonarr", "system/status", { version: "4.0.20.3014" })).toThrow(
      "No approved fixture for sonarr system/status at 4.0.20.3014",
    );
    expect(() => inventory.pathFor("sonarr", "tag", { version: "4.0.21.1" })).toThrow(
      "No approved fixture for sonarr tag at 4.0.21.1",
    );
  });

  it("selects a capture's fixture from the version the instance reports", () => {
    const inventory = createFixtureInventory(recorded);

    expect(inventory.forReportedVersion("sonarr", "tag", "4.0.20.3014")).toEqual({
      kind: "approved",
      fixture: expect.objectContaining({ relativePath: "sonarr/v3/4.0.20.3014/tag.json" }),
    });
    expect(inventory.forReportedVersion("sonarr", "tag", "4.0.19.2979")).toEqual({
      kind: "approved",
      fixture: expect.objectContaining({ relativePath: "sonarr/v3/4.0.19.2979/tag.json" }),
    });
    expect(inventory.forReportedVersion("sonarr", "system/status", "4.0.20.3014")).toEqual({
      kind: "route-not-recorded-at-version",
      routeVersions: ["4.0.19.2979"],
    });
    for (const reported of ["4.0.21.1", undefined]) {
      expect(inventory.forReportedVersion("sonarr", "tag", reported)).toEqual({
        kind: "unrecorded-version",
        recordedVersions: ["4.0.19.2979", "4.0.20.3014"],
      });
    }
  });

  it("refuses a record that breaks one fixture per application, version and route", () => {
    expect(() =>
      createFixtureInventory({
        sonarr: {
          apiVersion: "v3",
          minimum: "4.0.19.2979",
          routes: { "4.0.19.2979": ["tag", "tag"] },
        },
      }),
    ).toThrow("Fixture is approved twice: sonarr/v3/4.0.19.2979/tag.json");
    expect(() =>
      createFixtureInventory({
        sonarr: { apiVersion: "v3", minimum: "4.0.19.2979", routes: { "4.0.20.3014": ["tag"] } },
      }),
    ).toThrow("sonarr records no routes at its minimum version 4.0.19.2979");
    expect(() =>
      createFixtureInventory({
        sonarr: { apiVersion: "v3", minimum: "4.0.19.2979", routes: { "4.0.19.2979": [] } },
      }),
    ).toThrow("sonarr records no routes at its minimum version 4.0.19.2979");
    // A malformed label is refused even where there is no other version to
    // order it against.
    expect(() =>
      createFixtureInventory({
        sonarr: { apiVersion: "v3", minimum: "invalid", routes: { invalid: ["tag"] } },
      }),
    ).toThrow("Recorded fixture version is not a dotted numeric version: invalid");
    // A version beside the minimum is a newer one by definition; an older one
    // would be a minimum nobody lowered deliberately.
    expect(() =>
      createFixtureInventory({
        sonarr: {
          apiVersion: "v3",
          minimum: "4.0.19.2979",
          routes: { "4.0.19.2979": ["tag"], "4.0.9.2000": [] },
        },
      }),
    ).toThrow("sonarr 4.0.9.2000 is recorded beside its minimum 4.0.19.2979 but is not newer");
    expect(() =>
      createFixtureInventory({
        sonarr: {
          apiVersion: "v3",
          minimum: "4.0.19.2979",
          routes: { "4.0.19.2979": ["tag"], "4.0.20-beta": [] },
        },
      }),
    ).toThrow("Recorded fixture version is not a dotted numeric version: 4.0.20-beta");
  });

  it("holds the real record's newer versions to the routes approved there", () => {
    expect(fixturePathFor("sonarr", "tag")).toBe(
      fixturePathFor("sonarr", "tag", { version: "4.0.19.2979" }),
    );
    expect(() => fixturePathFor("sonarr", "tag", { version: "4.0.20.3014" })).toThrow(
      "No approved fixture for sonarr tag at 4.0.20.3014",
    );
    // The version is typed by the application it is passed with, so a version
    // another application records at does not compile, let alone resolve.
    // @ts-expect-error 6.3.0.10514 is a Radarr version.
    expect(() => fixturePathFor("sonarr", "tag", { version: "6.3.0.10514" })).toThrow();
    expect(captureTargetFor("radarr", "tag", "6.4.4.10685")).toEqual({
      kind: "route-not-recorded-at-version",
      routeVersions: ["6.3.0.10514"],
    });
    expect(captureTargetFor("prowlarr", "tag", "2.6.0.1")).toEqual({
      kind: "unrecorded-version",
      recordedVersions: ["2.5.2.5491", "2.7.0.5723"],
    });

    // A newer version's tuple is approved, so a fixture labelled with it gets
    // as far as the route check — and is refused there until its route is.
    const newer = validFixture();
    Object.assign(newer.metadata as Record<string, unknown>, { version: "4.0.20.3014" });
    Object.assign(newer.body as Record<string, unknown>, { version: "4.0.20.3014" });
    expect(() => validate(newer, "sonarr/v3/4.0.20.3014/system-status.json")).toThrow(
      "Fixture is not in the approved inventory: sonarr/v3/4.0.20.3014/system-status.json",
    );
    // And a body recorded at the minimum cannot be filed under a newer version.
    expect(() => validate(validFixture(), "sonarr/v3/4.0.20.3014/system-status.json")).toThrow(
      "Fixture version label does not match metadata",
    );
  });
});
