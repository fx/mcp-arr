import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
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
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error === undefined ? resolve() : reject(error)));
        }),
    ),
  );
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
