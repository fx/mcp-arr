import { describe, expect, it } from "vitest";
import {
  grabConcurrency,
  type ReleaseGrabRequest,
  releaseGrabRoutes,
  runReleaseGrab,
  upstreamSearchCacheMs,
} from "../src/adapters/acquisition/grab.js";
import type { ReleaseCacheIdentity } from "../src/adapters/acquisition/model.js";
import { cacheIdentity, releaseSchema } from "../src/adapters/acquisition/parse.js";
import type { ApplicationId } from "../src/applications.js";
import { referenceLifetimes } from "../src/state/references.js";
import { jsonResponse, searchHarness, type UpstreamCall } from "./support/acquisition.js";
import { fixtureBody } from "./support/library.js";

/**
 * The identities this suite grabs, read from the recorded search fixtures.
 *
 * Taking them from the fixture rather than inventing them is what keeps the
 * test honest about what a grab actually carries: the GUID and indexer a real
 * (sanitized) search result was filed under, and nothing else from a payload
 * that also contained a protected download URL.
 */
async function fixtureIdentities(
  application: ApplicationId,
  route: string,
): Promise<readonly ReleaseCacheIdentity[]> {
  const body = await fixtureBody<readonly unknown[]>(
    application as "sonarr" | "radarr" | "prowlarr",
    route,
  );
  return body.map((record) => cacheIdentity(application, releaseSchema.parse(record)));
}

function requestsFor(identities: readonly ReleaseCacheIdentity[]): ReleaseGrabRequest[] {
  return identities.map((identity, index) => ({
    reference: `rel_0000000${index}`,
    identity,
  }));
}

function bodyOf(call: UpstreamCall): unknown {
  return JSON.parse(String(call.init.body));
}

describe("release grab requests", () => {
  it("posts only the cache identity, to each application's own grab route", async () => {
    const routes: Readonly<Record<ApplicationId, string>> = {
      sonarr: "release",
      radarr: "release",
      prowlarr: "search",
    };
    expect(releaseGrabRoutes).toEqual(routes);

    for (const [application, route] of Object.entries(routes) as [ApplicationId, string][]) {
      const searchRoute = application === "prowlarr" ? "search" : "release";
      const identities = await fixtureIdentities(application, searchRoute);
      const first = identities[0];
      if (first === undefined) {
        throw new Error(`The ${application} search fixture holds no release`);
      }

      const harness = searchHarness(application, () => jsonResponse({ accepted: true }));
      const result = await runReleaseGrab(application, harness.client, requestsFor([first]));

      expect(result.accepted).toBe(1);
      expect(harness.calls).toHaveLength(1);
      const call = harness.calls[0] as UpstreamCall;
      expect(call.init.method).toBe("POST");
      expect(call.url.pathname.endsWith(`/${route}`)).toBe(true);
      // The exact body, by equality: a field this server never meant to send
      // would fail here rather than travel unnoticed.
      expect(bodyOf(call)).toEqual({ guid: first.guid, indexerId: first.indexerId });
    }
  });

  it("omits an indexer the search never reported rather than inventing one", async () => {
    const harness = searchHarness("prowlarr", () => jsonResponse({}));
    await runReleaseGrab("prowlarr", harness.client, [
      { reference: "rel_00000001", identity: { application: "prowlarr", guid: "example-guid" } },
    ]);

    expect(bodyOf(harness.calls[0] as UpstreamCall)).toEqual({ guid: "example-guid" });
  });

  it("discards the echoed release rather than mapping anything out of it", async () => {
    const harness = searchHarness("radarr", () =>
      jsonResponse({
        guid: "example-indexer-a-1001",
        downloadUrl: "https://tracker.example.invalid/download?apikey=canary-download-key",
        magnetUrl: "magnet:?xt=urn:btih:canary",
      }),
    );

    const result = await runReleaseGrab("radarr", harness.client, [
      { reference: "rel_00000001", identity: { application: "radarr", guid: "g", indexerId: 1 } },
    ]);

    expect(result.outcomes).toEqual([{ reference: "rel_00000001", state: "accepted" }]);
    expect(JSON.stringify(result)).not.toContain("canary");
  });
});

describe("release grab outcomes", () => {
  it("reports an outcome for every selected release and never abandons the rest", async () => {
    const identities = await fixtureIdentities("prowlarr", "search");
    const requests = requestsFor(identities);
    expect(requests.length).toBeGreaterThan(1);

    // The second release is refused; every other one still has to be asked for
    // and still has to report its own outcome.
    const refused = requests[1]?.identity.guid;
    const harness = searchHarness("prowlarr", (call) =>
      JSON.parse(String(call.init.body)).guid === refused
        ? jsonResponse({ message: "canary-upstream-detail" }, 400)
        : jsonResponse({}),
    );

    const result = await runReleaseGrab("prowlarr", harness.client, requests);

    expect(harness.calls).toHaveLength(requests.length);
    expect(result.outcomes.map((outcome) => outcome.reference)).toEqual(
      requests.map((request) => request.reference),
    );
    expect(result.outcomes.map((outcome) => outcome.state)).toEqual(
      requests.map((request) => (request.identity.guid === refused ? "failed" : "accepted")),
    );
    expect(result.accepted).toBe(requests.length - 1);

    const failure = result.outcomes[1]?.error;
    expect(failure?.code).toBe("upstream_rejection");
    expect(failure?.application).toBe("prowlarr");
    // The instance's own response body never reaches the caller-visible message.
    expect(failure?.message).not.toContain("canary");
  });

  it("reports a cache the instance no longer holds as a recoverable stale reference", async () => {
    const harness = searchHarness("sonarr", () =>
      jsonResponse(
        { message: "Couldn't find requested release in cache, try searching again" },
        404,
      ),
    );

    const result = await runReleaseGrab("sonarr", harness.client, [
      { reference: "rel_00000001", identity: { application: "sonarr", guid: "g", indexerId: 1 } },
    ]);

    const error = result.outcomes[0]?.error;
    expect(result.accepted).toBe(0);
    expect(error?.code).toBe("stale_reference");
    expect(error?.recoverable).toBe(true);
    expect(error?.remediation).toContain("Repeat the query");
    expect(error?.message).toContain("search cache");
    // The instance's own wording never reaches the caller.
    expect(error?.message).not.toContain("Couldn't find");
  });

  it("reports an unreachable instance per release without leaking the thrown reason", async () => {
    const harness = searchHarness("radarr", () => {
      throw new Error("connection refused to 203.0.113.7");
    });

    const result = await runReleaseGrab("radarr", harness.client, [
      { reference: "rel_00000001", identity: { application: "radarr", guid: "g", indexerId: 1 } },
    ]);

    const error = result.outcomes[0]?.error;
    expect(error?.code).toBe("unavailable_application");
    expect(error?.message).not.toContain("203.0.113.7");
  });

  it("keeps one call within the declared concurrency bound", async () => {
    const requests = requestsFor(
      Array.from({ length: grabConcurrency * 2 + 1 }, (_, index) => ({
        application: "sonarr" as const,
        guid: `example-${index}`,
        indexerId: 1,
      })),
    );

    let inFlight = 0;
    let peak = 0;
    const harness = searchHarness("sonarr", async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return jsonResponse({});
    });

    await runReleaseGrab("sonarr", harness.client, requests);
    expect(harness.calls).toHaveLength(requests.length);
    expect(peak).toBeLessThanOrEqual(grabConcurrency);
  });
});

describe("release reference lifetime", () => {
  it("expires no later than the upstream search cache it stands for", () => {
    expect(referenceLifetimes.release).toBeLessThanOrEqual(upstreamSearchCacheMs);
  });
});
