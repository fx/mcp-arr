import { afterEach, describe, expect, it } from "vitest";
import { type ApplicationId, describeApplication } from "../src/applications.js";
import { type FixtureInstance, startFixtureInstance } from "./support/instance-server.js";

/**
 * The guards the fixture instance keeps on its own writes.
 *
 * A test double that stops checking is worse than no double: a client
 * regression that dropped the cache identity from a grab would be answered
 * with the same `404` an expired cache produces, so the suite would stay green
 * while the grab path was broken and the failure it eventually surfaced would
 * name the wrong cause. These tests hold the double to the check.
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

      // A refused grab is not a grab the instance saw, so a test asserting on
      // what reached the wire cannot mistake one for the other.
      expect(running.grabs).toEqual([]);
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
