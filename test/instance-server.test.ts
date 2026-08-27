import { afterEach, describe, expect, it } from "vitest";
import { type ApplicationId, describeApplication } from "../src/applications.js";
import { type FixtureInstance, startFixtureInstance } from "./support/instance-server.js";

/**
 * The guards the fixture instance keeps on its own writes.
 *
 * A test double that stops checking is worse than no double. A grab that lost
 * its cache identity would be answered with the same `404` an expired cache
 * produces, and a command the instance refused would still appear in the record
 * of what it started — so the suite would stay green while the write path was
 * broken, and the failure it eventually surfaced would name the wrong cause.
 * These tests hold the double to both: refuse a write that carries no identity,
 * and record only the writes it actually performed.
 */

const started: FixtureInstance[] = [];

async function instance(application: ApplicationId): Promise<FixtureInstance> {
  const running = await startFixtureInstance(application);
  started.push(running);
  return running;
}

afterEach(async () => {
  await Promise.all(started.splice(0).map((running) => running.close()));
});

/** Posts a body to one of the instance's write routes, as a client would. */
async function post(
  running: FixtureInstance,
  route: string,
  body: unknown,
): Promise<{ status: number }> {
  const { apiBasePath } = describeApplication(running.application);
  const response = await fetch(`${running.url}${apiBasePath}/${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": running.apiKey },
    body: JSON.stringify(body),
  });
  await response.text();
  return { status: response.status };
}

/** The route each application resolves a grab on. */
const grabRoutes: Readonly<Record<ApplicationId, string>> = {
  sonarr: "release",
  radarr: "release",
  prowlarr: "search",
};

describe("the fixture instance's grab route", () => {
  for (const application of ["sonarr", "radarr", "prowlarr"] as const) {
    const route = grabRoutes[application];

    it(`refuses a ${application} grab that carries no release GUID`, async () => {
      const running = await instance(application);

      expect((await post(running, route, { indexerId: 1 })).status).toBe(400);
      expect((await post(running, route, { guid: 42 })).status).toBe(400);
      expect((await post(running, route, { guid: "" })).status).toBe(400);

      // A refused grab is not a grab the instance resolved, so a test asserting
      // on what it did cannot mistake one for the other. That the request
      // reached the wire at all is a separate question, and `requests` still
      // answers it.
      expect(running.grabs).toEqual([]);
      expect(running.requests).toEqual([route, route, route]);
    });

    it(`still answers a ${application} grab for an uncached release with 404`, async () => {
      const running = await instance(application);

      // The cache miss a genuinely stale reference produces stays distinct
      // from the malformed-body refusal above.
      expect((await post(running, route, { guid: "never-recorded" })).status).toBe(404);
      expect(running.grabs.map((entry) => entry.guid)).toEqual(["never-recorded"]);
    });
  }
});

describe("the fixture instance's command route", () => {
  for (const application of ["sonarr", "radarr"] as const) {
    it(`records no ${application} command it refused to start`, async () => {
      const running = await instance(application);

      expect((await post(running, "command", { seriesId: 12 })).status).toBe(400);
      expect((await post(running, "command", { name: 42 })).status).toBe(400);

      // The whole point of the record: a test that asserts on what was started
      // must fail when nothing was.
      expect(running.commands).toEqual([]);
      expect(running.requests).toEqual(["command", "command"]);
    });

    it(`records a started ${application} command with the body it arrived in`, async () => {
      const running = await instance(application);
      const body = { name: "RefreshMonitoredDownloads" };

      expect((await post(running, "command", body)).status).toBe(201);
      expect(running.commands).toEqual([{ name: body.name, body }]);
    });
  }
});
