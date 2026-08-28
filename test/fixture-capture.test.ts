import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
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
): Promise<{ code: number | null; stderr: string }> {
  const environment: Record<string, string> = { PATH: process.env.PATH ?? "" };
  if (url !== undefined) {
    environment.SONARR_URL = url;
    environment.SONARR_API_KEY = "capture-test-key";
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

describe("fixture capture procedure", () => {
  it("refuses a route the named application answers with 404", async () => {
    const url = await startStub({ "/api/v3/system/status": sonarrStatus });

    const { code, stderr } = await runCapture(url, [
      "--application",
      "sonarr",
      "--route",
      "config/downloadclient",
      "--dry-run",
    ]);

    expect(code).toBe(1);
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

    const { code, stderr } = await runCapture(url, [
      "--application",
      "sonarr",
      "--route",
      "config/downloadclient",
      "--dry-run",
    ]);

    expect(code).toBe(1);
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

    const { code, stderr } = await runCapture(url, [
      "--application",
      "sonarr",
      "--route",
      "tag",
      "--dry-run",
    ]);

    expect(code).toBe(1);
    expect(stderr).toContain("calls itself Radarr, not Sonarr");
  });

  it("refuses an instance that is not the version the fixtures name", async () => {
    const url = await startStub({
      "/api/v3/system/status": { body: JSON.stringify({ appName: "Sonarr", version: "4.1.0.1" }) },
      "/api/v3/tag": { body: "[]" },
    });

    const { code, stderr } = await runCapture(url, [
      "--application",
      "sonarr",
      "--route",
      "tag",
      "--dry-run",
    ]);

    expect(code).toBe(1);
    expect(stderr).toContain("reports 4.1.0.1");
    expect(stderr).toContain("4.0.19.2979");
  });

  it("refuses a route the inventory does not approve, before reading anything", async () => {
    const url = await startStub({ "/api/v3/system/status": sonarrStatus });

    const { code, stderr } = await runCapture(url, [
      "--application",
      "sonarr",
      "--route",
      "exclusions/paged",
      "--dry-run",
    ]);

    expect(code).toBe(1);
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

  it("redacts a credential a provider field names beside it", async () => {
    // These applications describe a provider's settings as a list of
    // `{ name, value }` pairs, so a credential arrives under the property name
    // `value` with `apiKey` as a sibling. Screening the property name alone
    // sees `value`, objects to nothing, and writes the real credential.
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
    expect(written).not.toContain("CANARY-PROVIDER-FIELD-SECRET");
    expect(written).not.toContain("CANARY-NESTED-SECRET");
    // The field itself survives, so the recorded shape still has it.
    expect(written).toContain('"name": "apiKey"');
    expect(written).toContain("example-indexer");
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
    const { code, stderr } = await runCapture(undefined, [
      "--application",
      "sonarr",
      "--route",
      "tag",
      "--dry-run",
    ]);

    expect(code).toBe(1);
    expect(stderr).toContain("SONARR_URL");
    expect(stderr).toContain("SONARR_API_KEY");
  });
});
