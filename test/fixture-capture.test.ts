import { spawn } from "node:child_process";
import { access, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { observeChildProcess } from "../scripts/child-process.mjs";
import { fixturePathFor } from "./support/fixtures.js";

/**
 * The capture procedure's refusals.
 *
 * The procedure itself is an operator tool that reads a real instance, and
 * nothing here does: these exercise the refusals against a loopback stub, which
 * is the same thing every adapter test does. What is under test is that a
 * capture cannot produce a fixture for a route the named application does not
 * answer — the defect that let a recorded body stand for a route that 404s —
 * and that no refusal writes a file.
 */

const scriptPath = fileURLToPath(new URL("../scripts/capture-fixture.mjs", import.meta.url));
const servers: Server[] = [];
const temporaryRoots: string[] = [];

/** A throwaway fixture root, so a real write never touches a recorded body. */
async function temporaryFixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "mcp-arr-capture-"));
  temporaryRoots.push(root);
  return root;
}

interface StubAnswer {
  readonly status?: number;
  readonly contentType?: string;
  readonly body?: string;
}

/** A loopback instance that answers `system/status` and one other route. */
async function startStub(answers: Readonly<Record<string, StubAnswer>>): Promise<string> {
  const server = createServer((request, response) => {
    const route = (request.url ?? "").split("?")[0] ?? "";
    const answer = answers[route] ?? { status: 404, body: JSON.stringify({ message: "NotFound" }) };
    response.writeHead(answer.status ?? 200, {
      "Content-Type": answer.contentType ?? "application/json",
    });
    response.end(answer.body ?? "{}");
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

const sonarrStatus = {
  body: JSON.stringify({ appName: "Sonarr", version: "4.0.19.2979" }),
} satisfies StubAnswer;

async function runCapture(
  url: string | undefined,
  args: readonly string[],
  application: "sonarr" | "radarr" | "prowlarr" = "sonarr",
): Promise<{ code: number | null; stderr: string }> {
  const environment: Record<string, string> = { PATH: process.env.PATH ?? "" };
  if (url !== undefined) {
    // Which application the variables configure is a parameter, because
    // "configured, but not the one asked for" is a different refusal from
    // "nothing configured at all" — and an environment holding neither pair
    // fails at startup before the one under test is ever reached.
    environment[`${application.toUpperCase()}_URL`] = url;
    environment[`${application.toUpperCase()}_API_KEY`] = "capture-test-key";
  }
  const child = spawn(process.execPath, [scriptPath, ...args], { env: environment });
  // Observed through the shared helper, which drains both streams and flushes
  // them after the close tick: every assertion here reads stderr, and a
  // hand-rolled listener loses the last chunk when the process exits first.
  const observed = observeChildProcess(child);
  const { code } = await observed.closed;
  return { code, stderr: observed.stderr };
}

afterEach(async () => {
  await Promise.all([
    ...servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error === undefined ? resolve() : reject(error)));
        }),
    ),
    ...temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  ]);
});

/**
 * Runs a capture that is expected to be refused, into a throwaway root.
 *
 * No refusal case passes `--dry-run`: what is under test is that the refusal
 * leaves no fixture behind, and a run that returns before the write path could
 * not show that.
 */
async function expectRefusal(
  url: string | undefined,
  args: readonly string[],
  route: string,
  application: "sonarr" | "radarr" = "sonarr",
): Promise<string> {
  const fixtureRoot = await temporaryFixtureRoot();
  const { code, stderr } = await runCapture(
    url,
    [...args, "--fixture-root", fixtureRoot],
    application,
  );

  expect(code).toBe(1);
  await expect(access(path.join(fixtureRoot, route))).rejects.toThrow();
  return stderr;
}

/**
 * Runs a capture that is expected to be refused, and asserts the throwaway
 * root holds nothing afterwards — under any version's directory, which is what
 * a refusal about which version to write under has to show.
 */
async function expectNothingWritten(url: string, args: readonly string[]): Promise<string> {
  const fixtureRoot = await temporaryFixtureRoot();
  const { code, stderr } = await runCapture(url, [...args, "--fixture-root", fixtureRoot]);

  expect(code).toBe(1);
  await expect(readdir(fixtureRoot)).resolves.toEqual([]);
  return stderr;
}

describe("fixture capture procedure", () => {
  it("refuses a route the named application answers with 404", async () => {
    const url = await startStub({ "/api/v3/system/status": sonarrStatus });

    const stderr = await expectRefusal(
      url,
      ["--application", "sonarr", "--route", "config/downloadclient"],
      "sonarr/v3/4.0.19.2979/config-downloadclient.json",
    );

    expect(stderr).toContain("answers config/downloadclient with 404");
    expect(stderr).toContain("does not serve this route");
  });

  it("refuses a route answered with the web interface rather than JSON", async () => {
    // Both applications serve their single-page interface, with a 200, for any
    // path their API does not recognize. A capture that trusted the status code
    // would record that page as the route's response.
    const url = await startStub({
      "/api/v3/system/status": sonarrStatus,
      "/api/v3/config/downloadclient": {
        contentType: "text/html",
        body: '<!doctype html><html lang="en"><body></body></html>',
      },
    });

    const stderr = await expectRefusal(
      url,
      ["--application", "sonarr", "--route", "config/downloadclient"],
      "sonarr/v3/4.0.19.2979/config-downloadclient.json",
    );

    expect(stderr).toContain("a body that is not JSON");
    expect(stderr).toContain("does not resolve on this application");
  });

  it("refuses an instance that is not the application the fixture names", async () => {
    // A proxy or a mistyped variable can put another application behind the
    // ones this fixture's application is configured by, and its answer would
    // then be recorded under this application's name.
    const url = await startStub({
      "/api/v3/system/status": {
        body: JSON.stringify({ appName: "Radarr", version: "4.0.19.2979" }),
      },
      "/api/v3/tag": { body: "[]" },
    });

    const stderr = await expectRefusal(
      url,
      ["--application", "sonarr", "--route", "tag"],
      "sonarr/v3/4.0.19.2979/tag.json",
    );

    expect(stderr).toContain("calls itself Radarr, not Sonarr");
  });

  it("refuses an instance at a version no fixture is recorded at", async () => {
    const url = await startStub({
      "/api/v3/system/status": { body: JSON.stringify({ appName: "Sonarr", version: "4.1.0.1" }) },
      "/api/v3/tag": { body: "[]" },
    });

    const stderr = await expectNothingWritten(url, ["--application", "sonarr", "--route", "tag"]);

    expect(stderr).toContain("reports 4.1.0.1");
    expect(stderr).toContain("recorded only at 4.0.19.2979, 4.0.20.3014");
  });

  it("refuses an instance that reports no version at all", async () => {
    const url = await startStub({
      "/api/v3/system/status": { body: JSON.stringify({ appName: "Sonarr" }) },
      "/api/v3/tag": { body: "[]" },
    });

    const stderr = await expectNothingWritten(url, ["--application", "sonarr", "--route", "tag"]);

    expect(stderr).toContain("reports an unreported version");
  });

  it("refuses a newer recorded version for a route approved only at another", async () => {
    // The instance is at a version fixtures may be recorded at, but this route
    // is approved only at the minimum. Its body is evidence for the version it
    // came from alone, so it is neither written there unapproved nor filed
    // under the minimum's name.
    const url = await startStub({
      "/api/v3/system/status": {
        body: JSON.stringify({ appName: "Sonarr", version: "4.0.20.3014" }),
      },
      "/api/v3/tag": { body: "[]" },
    });

    const stderr = await expectNothingWritten(url, ["--application", "sonarr", "--route", "tag"]);

    expect(stderr).toContain("reports 4.0.20.3014, a recorded version");
    expect(stderr).toContain("tag is approved only at 4.0.19.2979");
  });

  it("refuses a route the inventory does not approve, before reading anything", async () => {
    const url = await startStub({ "/api/v3/system/status": sonarrStatus });

    const stderr = await expectRefusal(
      url,
      ["--application", "sonarr", "--route", "exclusions/paged"],
      "sonarr/v3/4.0.19.2979/tag.json",
    );

    expect(stderr).toContain("records no fixture for route exclusions/paged");
    expect(stderr).toContain("importlistexclusion/paged");
  });

  it("writes a body whose identifying values and keys have been replaced", async () => {
    const fixtureRoot = await temporaryFixtureRoot();
    const url = await startStub({
      "/api/v3/system/status": sonarrStatus,
      // Written as raw JSON rather than through an object literal: a
      // `__proto__` key in a literal sets the prototype instead of becoming a
      // property, and would never reach the wire.
      "/api/v3/tag": {
        body: [
          "[{",
          '"id": 7,',
          '"label": "Example Tag",',
          '"apiKey": "CANARY-CAPTURE-SECRET",',
          '"note": "detail=/srv/private/data",',
          // Upstream keys a path where a payload is a dictionary of them, and
          // a key screened only by name would carry that path through.
          '"https://tracker.invalid/announce": 1,',
          '"__proto__": { "retained": true }',
          "}]",
        ].join(""),
      },
    });

    const { code, stderr } = await runCapture(url, [
      "--application",
      "sonarr",
      "--route",
      "tag",
      "--fixture-root",
      fixtureRoot,
    ]);

    expect(code).toBe(0);
    expect(stderr).toContain("1 record");
    const written = await readFile(
      path.join(fixtureRoot, "sonarr/v3/4.0.19.2979/tag.json"),
      "utf8",
    );
    const record = (JSON.parse(written) as { body: Record<string, unknown>[] }).body[0] ?? {};

    // What identifies is gone: the credential with its key, the embedded path,
    // and the key that was a URL. What describes the shape survives.
    expect(written).not.toContain("CANARY-CAPTURE-SECRET");
    expect(written).not.toContain("apiKey");
    expect(written).not.toContain("/srv/private");
    expect(written).not.toContain("tracker.invalid");
    // A label beside other fields is no tag's, and text no rule recognizes is
    // replaced; the record's shape survives.
    expect(record).toMatchObject({ id: 7, label: expect.stringMatching(/^Example text \d+$/u) });
    // The subtree under a prototype-named key is kept rather than silently lost.
    expect(Object.values(record)).toContainEqual({ retained: true });
  });

  it("replaces what identifies a library with stand-ins that still agree with each other", async () => {
    const fixtureRoot = await temporaryFixtureRoot();
    const series = {
      id: 113,
      title: "Love Begins in Another World",
      sortTitle: "love begins in another world",
      cleanTitle: "lovebeginsinanotherworld",
      titleSlug: "love-begins-in-another-world",
      overview: "Two strangers meet in a world that is not theirs.",
      network: "A Real Broadcaster",
      genres: ["Animation", "Isekai Romance"],
      certification: "TV-14",
      ratings: { votes: 41, value: 8.2 },
      images: [{ coverType: "poster", url: "poster.jpg", remoteUrl: "" }],
      tvdbId: 469_794,
      tvMazeId: 65_001,
      tvRageId: 0,
      imdbId: "tt1234567",
      tags: [3],
      year: 2025,
      firstAired: "2025-11-21T00:00:00Z",
      airTime: "01:30",
      runtime: 24,
      originalLanguage: { id: 8, name: "Japanese" },
    };
    const row = (id: number, episodeId: number, episodeTitle: string, airDay: number) => ({
      id,
      seriesId: 113,
      episodeId,
      series,
      episode: {
        id: episodeId,
        title: episodeTitle,
        tvdbId: 9_000_000 + episodeId,
        airDate: `2025-11-${airDay}`,
        airDateUtc: `2025-11-${airDay - 1}T16:30:00Z`,
        runtime: 24,
      },
      languages: [{ id: 8, name: "Japanese" }],
      size: 4_000_000_000,
      sizeleft: 1_000_000_000,
      added: "2026-11-06T06:47:10.123Z",
      title: "Love Begins S01 1080p",
      downloadId: "SABnzbd_nzo_8f2k1q",
      downloadClient: "My Downloader",
      indexer: "Treasure Maps (Prowlarr)",
      status: "completed",
    });
    const url = await startStub({
      "/api/v3/system/status": sonarrStatus,
      "/api/v3/queue/details": {
        body: JSON.stringify([
          row(1, 11_807, "A First Meeting", 21),
          row(2, 11_808, "A Second Look", 28),
        ]),
      },
    });

    const { code } = await runCapture(url, [
      "--application",
      "sonarr",
      "--route",
      "queue/details",
      "--query",
      "seriesId=113",
      "--fixture-root",
      fixtureRoot,
    ]);

    expect(code).toBe(0);
    const written = await readFile(
      // A capture from an instance at the minimum writes the minimum's file.
      path.join(fixtureRoot, fixturePathFor("sonarr", "queue/details")),
      "utf8",
    );
    for (const original of [
      "Love Begins",
      "love",
      "Two strangers",
      "Real Broadcaster",
      "Isekai",
      "469794",
      "65001",
      "tt1234567",
      "9011807",
      "A First Meeting",
      "SABnzbd",
      "My Downloader",
      "Treasure Maps",
      "Japanese",
      "01:30",
    ]) {
      expect(written, original).not.toContain(original);
    }
    type Row = Record<string, unknown> & {
      series: Record<string, unknown>;
      episode: Record<string, string>;
      size: number;
      sizeleft: number;
    };
    const [first, second] = (JSON.parse(written) as { body: Row[] }).body;
    const { year, firstAired, airTime, runtime, originalLanguage, ...text } = first?.series ?? {};
    // The facts that place a title: one offset for every date, a year moved
    // with them, a runtime and an air time anyone could have, an example language.
    const shiftedDays =
      (Date.parse(firstAired as string) - Date.parse("2025-11-21T00:00:00Z")) / 86_400_000;
    expect(Number.isInteger(shiftedDays)).toBe(true);
    expect(new Date(firstAired as string).getUTCFullYear()).toBeGreaterThanOrEqual(2100);
    expect(
      Math.abs((year as number) - new Date(firstAired as string).getUTCFullYear()),
    ).toBeLessThanOrEqual(1);
    expect([airTime, runtime, first?.episode.runtime]).toEqual(["20:00", 30, 30]);
    expect(originalLanguage).toEqual({ id: 0, name: "Example Language 1" });
    expect(first?.languages).toEqual([{ id: 0, name: "Example Language 1" }]);
    const shifted = (instant: string, original: string) =>
      (Date.parse(instant) - Date.parse(original)) / 86_400_000;
    expect(shifted(first?.episode.airDateUtc ?? "", "2025-11-20T16:30:00Z")).toBe(shiftedDays);
    expect(shifted(first?.episode.airDate ?? "", "2025-11-21")).toBe(shiftedDays);
    expect(shifted(second?.episode.airDateUtc ?? "", "2025-11-27T16:30:00Z")).toBe(shiftedDays);
    // The time and the zone are kept as written.
    expect(first?.added).toMatch(/^\d{4}-\d{2}-\d{2}T06:47:10\.123Z$/u);
    expect(shifted(first?.added as string, "2026-11-06T06:47:10.123Z")).toBe(shiftedDays);
    // Every byte count is scaled by one factor, so progress reads the same.
    expect(first?.size).not.toBe(4_000_000_000);
    expect(first?.sizeleft ?? 0).toBeGreaterThan(0);
    expect((first?.sizeleft ?? 0) / (first?.size ?? 1)).toBeCloseTo(0.25, 6);
    expect(text).toEqual({
      id: 113,
      title: "Example Title 1",
      sortTitle: "example title 1",
      cleanTitle: "exampletitle1",
      titleSlug: "example-title-1",
      overview: "A sanitized overview recorded only to fix the payload shape",
      network: "Example Network 1",
      genres: ["Example Genre 1", "Example Genre 2"],
      certification: "Example Certification 1",
      ratings: { votes: 0, value: 0 },
      images: [{ coverType: "poster", url: "/media/example/artwork-1", remoteUrl: "" }],
      tvdbId: 100_001,
      tvMazeId: 400_001,
      tvRageId: 0,
      imdbId: "tt0000001",
      tags: [3],
    });
    // Each distinct value has its own stand-in, the same wherever it recurs,
    // so the two rows of one download, and of one series, still agree.
    expect(second?.series).toEqual(first?.series);
    expect(first).toMatchObject({
      id: 1,
      seriesId: 113,
      title: "Example Title 3",
      downloadId: "example-download-1",
      downloadClient: "Example Service 1",
      indexer: "Example Service 2",
      episode: { id: 11_807, title: "Example Title 2", tvdbId: 100_002 },
    });
    expect(second).toMatchObject({
      title: "Example Title 3",
      downloadId: "example-download-1",
      episode: { title: "Example Title 4", tvdbId: 100_003 },
    });
  });

  /**
   * One case per route shape whose identifying fields the queue rows above do
   * not carry: what each route's body says about a library or its services,
   * and the stand-in a capture writes for it.
   */
  const identifyingSites: Array<{
    readonly site: string;
    readonly application: "sonarr" | "radarr" | "prowlarr";
    readonly route: string;
    readonly body: unknown;
    readonly originals: readonly string[];
    readonly expected: unknown;
  }> = [
    {
      site: "an episode file's paths, release, and media information",
      application: "sonarr",
      route: "episodefile",
      body: [
        {
          id: 1,
          seriesId: 113,
          relativePath: "Season 01/Another World - S01E01 - A First Meeting.mkv",
          path: "/data/tv/Another World/Season 01/Another World - S01E01 - A First Meeting.mkv",
          sceneName: "Another.World.S01E01.1080p.WEB-DL-SubsPlease",
          releaseGroup: "SubsPlease",
          size: 1_000,
          mediaInfo: {
            runTime: "23:41",
            audioLanguages: "jpn",
            subtitles: "eng/spa",
            videoCodec: "x265",
          },
          customFormats: [{ id: 3, name: "DV Boost" }],
        },
      ],
      originals: [
        "Another World",
        "A First Meeting",
        "SubsPlease",
        "/data/tv",
        "23:41",
        "jpn",
        "DV Boost",
      ],
      expected: [
        {
          id: 1,
          seriesId: 113,
          // A path keeps its depth and its file's extension, and a folder the
          // two paths share stays shared.
          relativePath: "example-1/example-2.mkv",
          path: "/media/example/example-3/example-4/example-5/example-1/example-2.mkv",
          sceneName: "Example Title 1",
          releaseGroup: "EXAMPLEGRP1",
          size: expect.any(Number),
          mediaInfo: {
            runTime: "30:00",
            audioLanguages: "und",
            subtitles: "und",
            videoCodec: "x265",
          },
          customFormats: [{ id: 3, name: "Example Format 1" }],
        },
      ],
    },
    {
      site: "a provider's name, beside the product it is",
      application: "sonarr",
      route: "indexer",
      body: [
        { id: 2, name: "Treasure Maps (Prowlarr)", implementation: "Torznab", protocol: "torrent" },
      ],
      originals: ["Treasure Maps"],
      expected: [
        { id: 2, name: "Example Service 1", implementation: "Torznab", protocol: "torrent" },
      ],
    },
    {
      site: "a quality profile's and its formats' names",
      application: "radarr",
      route: "qualityprofile",
      body: [
        {
          id: 4,
          name: "Max Ultra HD",
          cutoff: 1,
          items: [
            { quality: { id: 1, name: "Bluray-2160p" }, allowed: true },
            { id: 1001, name: "My Private Collection", allowed: true, items: [] },
            { id: 1002, name: "WEB 1080p", allowed: true, items: [] },
          ],
          formatItems: [{ format: 3, name: "DV Boost", score: 100 }],
          language: { id: 8, name: "Japanese" },
        },
      ],
      originals: ["Max Ultra HD", "DV Boost", "My Private Collection", "Japanese"],
      expected: [
        {
          id: 4,
          name: "Example Profile 1",
          cutoff: 1,
          items: [
            { quality: { id: 1, name: "Bluray-2160p" }, allowed: true },
            { id: 1001, name: "Example Group 1", allowed: true, items: [] },
            // A group the application creates keeps its own name.
            { id: 1002, name: "WEB 1080p", allowed: true, items: [] },
          ],
          formatItems: [{ format: 3, name: "Example Format 1", score: 100 }],
          language: { id: 0, name: "Example Language 1" },
        },
      ],
    },
    {
      site: "an import candidate's file, folder, and rejections",
      application: "sonarr",
      route: "manualimport",
      body: [
        {
          id: 9,
          name: "Another World - S01E01",
          folderName: "Another World",
          path: "/data/downloads/Another World/Another World - S01E01.mkv",
          relativePath: "Another World - S01E01.mkv",
          rejections: [{ reason: "Not an upgrade for Another World S01E01", type: "permanent" }],
        },
      ],
      originals: ["Another World", "/data/downloads"],
      expected: [
        {
          id: 9,
          name: "example-1",
          folderName: "example-2",
          path: "/media/example/example-3/example-4/example-2/example-1.mkv",
          relativePath: "example-1.mkv",
          rejections: [{ reason: "Example message 1", type: "permanent" }],
        },
      ],
    },
    {
      site: "a disk's label, path, and space",
      application: "sonarr",
      route: "diskspace",
      body: [{ path: "/mnt/vault", label: "Vault", freeSpace: 2_000, totalSpace: 8_000 }],
      originals: ["vault", "Vault"],
      expected: [
        {
          path: "/media/example/example-1/example-2",
          label: "Example Disk 1",
          freeSpace: expect.any(Number),
          totalSpace: expect.any(Number),
        },
      ],
    },
    {
      site: "a history event's release, services, and download",
      application: "sonarr",
      route: "history",
      body: {
        page: 1,
        records: [
          {
            id: 5,
            eventType: "grabbed",
            sourceTitle: "Another.World.S01E01.1080p",
            downloadId: "ABCDEF0123456789ABCDEF0123456789ABCDEF01",
            data: {
              indexer: "Treasure Maps",
              downloadClientName: "My Downloader",
              releaseGroup: "SubsPlease",
              torrentInfoHash: "abcdef0123456789abcdef0123456789abcdef01",
              guid: "tm-123456",
              message: "Grabbed from Treasure Maps",
              reason: "The download of Another World failed",
            },
          },
        ],
      },
      originals: [
        "Another",
        "Treasure Maps",
        "My Downloader",
        "SubsPlease",
        "abcdef0123",
        "ABCDEF0123",
        "tm-123456",
      ],
      expected: {
        page: 1,
        records: [
          {
            id: 5,
            eventType: "grabbed",
            sourceTitle: "Example Title 1",
            // The info hash is the download's id, whatever its case.
            downloadId: "example-download-1",
            data: {
              indexer: "Example Service 1",
              downloadClientName: "Example Service 2",
              releaseGroup: "EXAMPLEGRP1",
              torrentInfoHash: "example-download-1",
              guid: "example-guid-1",
              message: "Example message 1",
              reason: "Example text 1",
            },
          },
        ],
      },
    },
    {
      site: "a Prowlarr indexer's definition, address, and name",
      application: "prowlarr",
      route: "indexer",
      body: [
        {
          id: 1,
          name: "Treasure Maps",
          definitionName: "treasuremaps",
          indexerUrls: ["treasure-maps-mirror"],
          implementation: "Cardigann",
          appProfileId: 1,
        },
      ],
      originals: ["Treasure", "treasure"],
      expected: [
        {
          id: 1,
          name: "Example Service 1",
          definitionName: "example-definition-1",
          indexerUrls: ["example-indexer-url-1"],
          implementation: "Cardigann",
          appProfileId: 1,
        },
      ],
    },
    {
      site: "a movie's trailer, artwork, popularity, and alternate titles",
      application: "radarr",
      route: "movie",
      body: [
        {
          id: 8,
          title: "Another World",
          youTubeTrailerId: "dQw4w9WgXcQ",
          remotePoster: "poster.jpg",
          popularity: 41.2,
          alternateTitles: [{ title: "Isekai Love" }],
          movieTitles: ["Another World"],
        },
      ],
      originals: ["Another World", "dQw4w9WgXcQ", "poster", "41.2", "Isekai"],
      expected: [
        {
          id: 8,
          title: "Example Title 1",
          youTubeTrailerId: "example-trailer-1",
          remotePoster: "/media/example/artwork-1",
          popularity: 0,
          alternateTitles: [{ title: "Example Title 2" }],
          movieTitles: ["Example Title 1"],
        },
      ],
    },
  ];

  identifyingSites.push({
    site: "a field no rule recognizes, and free text under an enumeration's key",
    application: "sonarr",
    route: "series",
    body: [
      {
        id: 12,
        status: "continuing",
        seriesType: "Another World's own type",
        someFieldNoOneHasSeen: "Another World",
        someNewList: ["Another World", "Love Begins"],
        someNewPath: "/srv/library/Another World",
      },
    ],
    originals: ["Another World", "Love Begins", "/srv/library"],
    expected: [
      {
        id: 12,
        status: "continuing",
        seriesType: "Example text 1",
        someFieldNoOneHasSeen: "Example text 2",
        someNewList: ["Example text 2", "Example text 3"],
        // Text that is a path keeps its shape.
        someNewPath: "/media/example/example-1/example-2/example-3",
      },
    ],
  });

  identifyingSites.push(
    {
      site: "text in lists of lists, text that only starts with a date, and unknown values",
      application: "sonarr",
      route: "series",
      body: [
        {
          id: 12,
          newList: [["My Private Movie"], [{ note: "My Private Note" }]],
          added: "2101-01-01T12:00 My Private Movie",
          airDateUtc: "2025-11-20T16:30:00Z",
          status: "treasuremaps",
          languages: [{ id: 1, name: "English" }],
          language: { id: 2, name: "My Private Language", nameLower: "my private language" },
          mediaInfo: { videoCodec: "My Private Film", audioCodec: "EAC3 Atmos" },
        },
      ],
      originals: ["My Private", "treasuremaps", "2025-11-20"],
      expected: [
        {
          id: 12,
          newList: [["Example text 1"], [{ note: "Example text 2" }]],
          added: "Example text 3",
          airDateUtc: expect.stringMatching(/^2\d{3}-\d{2}-\d{2}T16:30:00Z$/u),
          status: "Example text 4",
          languages: [{ id: 0, name: "Example Language 1" }],
          // Every leaf under a language is the language: its id zero, its text an example.
          language: { id: 0, name: "Example Language 2", nameLower: "Example Language 3" },
          mediaInfo: { videoCodec: "Example text 5", audioCodec: "EAC3 Atmos" },
        },
      ],
    },
    {
      site: "text at the root of a body",
      application: "sonarr",
      route: "tag",
      body: ["My Private Movie", ["My Private Note"]],
      originals: ["My Private"],
      expected: ["Example text 1", ["Example text 2"]],
    },
  );

  for (const { site, application, route, body, originals, expected } of identifyingSites) {
    it(`replaces ${site}`, async () => {
      const fixtureRoot = await temporaryFixtureRoot();
      const status = {
        sonarr: { appName: "Sonarr", version: "4.0.19.2979" },
        radarr: { appName: "Radarr", version: "6.3.0.10514" },
        prowlarr: { appName: "Prowlarr", version: "2.5.2.5491" },
      }[application];
      const api = application === "prowlarr" ? "/api/v1" : "/api/v3";
      const url = await startStub({
        [`${api}/system/status`]: { body: JSON.stringify(status) },
        [`${api}/${route}`]: { body: JSON.stringify(body) },
      });

      const { code, stderr } = await runCapture(
        url,
        ["--application", application, "--route", route, "--fixture-root", fixtureRoot],
        application,
      );

      expect(code, stderr).toBe(0);
      // Each stub reports its application's minimum, whose file is written.
      const file = path.join(fixtureRoot, fixturePathFor(application, route));
      const written = await readFile(file, "utf8");
      for (const original of originals) {
        expect(written, original).not.toContain(original);
      }
      expect((JSON.parse(written) as { body: unknown }).body).toEqual(expected);
    });
  }

  it("reports what a dry run would write without writing it", async () => {
    const fixtureRoot = await temporaryFixtureRoot();
    const url = await startStub({
      "/api/v3/system/status": sonarrStatus,
      "/api/v3/tag": { body: JSON.stringify([{ id: 7, label: "Example Tag" }]) },
    });

    const { code, stderr } = await runCapture(url, [
      "--application",
      "sonarr",
      "--route",
      "tag",
      "--fixture-root",
      fixtureRoot,
      "--dry-run",
    ]);

    expect(code).toBe(0);
    expect(stderr).toContain("Would write sonarr/v3/4.0.19.2979/tag.json: 1 record");
    await expect(
      access(path.join(fixtureRoot, "sonarr/v3/4.0.19.2979/tag.json")),
    ).rejects.toThrow();
  });

  it("redacts every provider field's value, not only the ones it can name", async () => {
    // These applications describe a provider's settings as a list of
    // `{ name, value }` pairs, so a credential arrives under the property name
    // `value` with its real name as a sibling. Screening the property name
    // alone sees `value`, objects to nothing, and writes the credential — and a
    // rule that redacted only the names a secret list spells would still write
    // `passkey`, `authkey`, `rssKey` and whatever a Cardigann definition calls
    // its own, which is every private tracker's credential.
    const fixtureRoot = await temporaryFixtureRoot();
    const url = await startStub({
      "/api/v3/system/status": sonarrStatus,
      "/api/v3/indexer": {
        body: JSON.stringify([
          {
            id: 3,
            name: "Example Indexer",
            fields: [
              { order: 0, name: "baseUrl", value: "example-indexer" },
              { order: 1, name: "apiKey", value: "CANARY-PROVIDER-FIELD-SECRET" },
              { order: 2, name: "password", value: ["CANARY-NESTED-SECRET"] },
              { order: 3, name: "passkey", value: "CANARY-PASSKEY-SECRET" },
              { order: 4, name: "rssKey", value: "CANARY-RSSKEY-SECRET" },
              { order: 5, name: "torrent_pass", value: "CANARY-TORRENTPASS-SECRET" },
              { order: 6, name: "categories", value: [5030, 5040] },
              { order: 7, name: "minimumSeeders", value: 1 },
              // The two texts these applications use as state rather than as
              // content: a credential they hold, and one they do not.
              { order: 8, name: "vipExpiration", value: "" },
              { order: 9, name: "maskedKey", value: "********" },
            ],
          },
        ]),
      },
    });

    const { code } = await runCapture(url, [
      "--application",
      "sonarr",
      "--route",
      "indexer",
      "--fixture-root",
      fixtureRoot,
    ]);

    expect(code).toBe(0);
    const written = await readFile(
      path.join(fixtureRoot, "sonarr/v3/4.0.19.2979/indexer.json"),
      "utf8",
    );
    expect(written).not.toContain("CANARY");
    // Every field survives with its type, because that is the shape a fixture
    // owes; only the text it held is gone. A setting keeps its name where the
    // applications' schemas define it, and one only a tracker's own
    // definition names — a passkey's, say — is text like any other. A value
    // that is not text cannot be a credential and is left alone, so a select
    // field and a numeric setting still record what they record.
    const fields = (
      JSON.parse(written) as { body: Array<{ fields: Array<Record<string, unknown>> }> }
    ).body[0]?.fields;
    expect(fields?.map((field) => field.name)).toEqual([
      "baseUrl",
      "apiKey",
      "password",
      expect.stringMatching(/^Example text \d+$/u),
      expect.stringMatching(/^Example text \d+$/u),
      expect.stringMatching(/^Example text \d+$/u),
      "categories",
      "minimumSeeders",
      "vipExpiration",
      expect.stringMatching(/^Example text \d+$/u),
    ]);
    expect(fields?.[0]?.value).not.toBe("example-indexer");
    expect(typeof fields?.[0]?.value).toBe("string");
    expect(fields?.[2]?.value).toBeInstanceOf(Array);
    expect(fields?.[6]?.value).toEqual([5030, 5040]);
    expect(fields?.[7]?.value).toBe(1);
    // A blank value says the credential is unset and a run of asterisks says
    // it is set; replacing either would record the opposite of what the
    // instance said, which is the falsehood this whole procedure exists against.
    expect(fields?.[8]?.value).toBe("");
    expect(fields?.[9]?.value).toBe("********");
  });

  it("writes nothing when the sanitized body still fails a fixture screen", async () => {
    const fixtureRoot = await temporaryFixtureRoot();
    const url = await startStub({
      "/api/v3/system/status": sonarrStatus,
      // A body version that contradicts the metadata is a contract failure the
      // sanitizer cannot repair, because it is about the claim, not the text.
      "/api/v3/tag": { body: JSON.stringify({ version: "9.9.9.9" }) },
    });

    const { code, stderr } = await runCapture(url, [
      "--application",
      "sonarr",
      "--route",
      "tag",
      "--fixture-root",
      fixtureRoot,
    ]);

    expect(code).toBe(1);
    expect(stderr).toContain("does not pass the fixture contract");
    expect(stderr).toContain("Nothing was written");
    await expect(
      access(path.join(fixtureRoot, "sonarr/v3/4.0.19.2979/tag.json")),
    ).rejects.toThrow();
  });

  it("names the environment variables an unconfigured application needs", async () => {
    // Configured, but not with the application being asked for. An environment
    // holding no pair at all fails at startup instead, with a message that
    // happens to name the same variables — so this refusal has to be reached
    // with another application configured or it is never exercised at all.
    const url = await startStub({ "/api/v3/system/status": sonarrStatus });

    const stderr = await expectRefusal(
      url,
      ["--application", "sonarr", "--route", "tag"],
      "sonarr/v3/4.0.19.2979/tag.json",
      "radarr",
    );

    expect(stderr).toContain("Set SONARR_URL and SONARR_API_KEY");
  });

  it("reports an instance failing as its own failure, not a missing route", async () => {
    // Every status the client does not name individually arrives as
    // `unexpected-response`, the same kind a non-JSON body raises. An operator
    // refreshing a fixture through a reverse proxy that answers 502 must not be
    // told to correct an approved route that is perfectly valid.
    const url = await startStub({
      "/api/v3/system/status": sonarrStatus,
      "/api/v3/tag": { status: 502, contentType: "text/html", body: "<html></html>" },
    });

    const stderr = await expectRefusal(
      url,
      ["--application", "sonarr", "--route", "tag"],
      "sonarr/v3/4.0.19.2979/tag.json",
    );

    expect(stderr).toContain("answered tag with status 502");
    expect(stderr).toContain("do not change the approved route");
    expect(stderr).not.toContain("does not resolve on this application");
  });
});
