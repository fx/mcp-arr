import { spawn } from "node:child_process";
import { access, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { observeChildProcess } from "../scripts/child-process.mjs";

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
  application: "sonarr" | "radarr" = "sonarr",
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
    expect(record).toMatchObject({ id: 7, label: "Example Tag" });
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
      path.join(fixtureRoot, "sonarr/v3/4.0.19.2979/queue-details.json"),
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
    expect(originalLanguage).toEqual({ id: 1, name: "Example Language 1" });
    expect(first?.languages).toEqual([{ id: 1, name: "Example Language 1" }]);
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
      downloadClient: "Example Download Client 1",
      indexer: "Example Indexer 1",
      episode: { id: 11_807, title: "Example Title 2", tvdbId: 100_002 },
    });
    expect(second).toMatchObject({
      title: "Example Title 3",
      downloadId: "example-download-1",
      episode: { title: "Example Title 4", tvdbId: 100_003 },
    });
  });

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
    // Every field survives with its name and its type, because that is the
    // shape a fixture owes; only the text it held is gone. A value that is not
    // text cannot be a credential and is left alone, so a select field and a
    // numeric setting still record what they record.
    const fields = (
      JSON.parse(written) as { body: Array<{ fields: Array<Record<string, unknown>> }> }
    ).body[0]?.fields;
    expect(fields?.map((field) => field.name)).toEqual([
      "baseUrl",
      "apiKey",
      "password",
      "passkey",
      "rssKey",
      "torrent_pass",
      "categories",
      "minimumSeeders",
      "vipExpiration",
      "maskedKey",
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
