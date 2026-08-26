import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { type ApplicationId, describeApplication } from "../../src/applications.js";
import { fixturePathFor, loadFixture } from "./fixtures.js";
import { fixtureRoot } from "./tool-context.js";

/**
 * A loopback stand-in for one *arr instance, answering from recorded fixtures.
 *
 * The spawned server has no injectable fetch, so an end-to-end stdio test needs
 * something on the other end of a real socket. This is that: it serves the same
 * sanitized, version-labelled fixtures the adapter tests use, over the same
 * routes, and applies the identifier filters a real instance applies — so a
 * view that asks for one series' episodes gets one series' episodes rather than
 * whatever the file happens to hold. It is not, and must never become, a
 * reimplementation of an *arr API: it answers recorded routes and nothing else.
 */

/** The routes each application answers: its probe, plus its library reads. */
const routes: Readonly<Record<ApplicationId, readonly string[]>> = {
  sonarr: [
    "system/status",
    "series",
    "series/lookup",
    "episode",
    "episodefile",
    "wanted/missing",
    "wanted/cutoff",
    "calendar",
  ],
  radarr: [
    "system/status",
    "movie",
    "movie/lookup",
    "collection",
    "moviefile",
    "wanted/missing",
    "wanted/cutoff",
    "calendar",
  ],
  // Prowlarr has no media library, so it answers only the capability probe.
  prowlarr: ["system/status"],
};

/** Which query parameter narrows a route, where a real instance narrows one. */
const parentFilters: Readonly<Record<string, string | undefined>> = {
  episode: "seriesId",
  episodefile: "seriesId",
  moviefile: "movieId",
};

export interface FixtureInstanceOptions {
  /**
   * Drops every connection instead of answering it, which is what this server
   * sees when a configured instance is not running. Modelled by an accepting
   * socket that then closes, so the test never has to guess at a free port or
   * race one that was just released.
   */
  readonly unreachable?: boolean;
}

export interface FixtureInstance {
  readonly application: ApplicationId;
  readonly url: string;
  readonly apiKey: string;
  /** The relative routes this instance was asked for, in order. */
  readonly requests: readonly string[];
  close(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function filtered(body: unknown, route: string, query: URLSearchParams): unknown {
  const parameter = parentFilters[route];
  const wanted = parameter === undefined ? null : query.get(parameter);
  if (wanted === null || !Array.isArray(body)) {
    return body;
  }
  return body.filter(
    (record) => isRecord(record) && String(record[parameter as string]) === wanted,
  );
}

/** The single record `series/{id}` answers with, taken from the series fixture. */
function recordById(body: unknown, id: number): unknown {
  return Array.isArray(body)
    ? body.find((record) => isRecord(record) && record.id === id)
    : undefined;
}

export async function startFixtureInstance(
  application: ApplicationId,
  options: FixtureInstanceOptions = {},
): Promise<FixtureInstance> {
  const descriptor = describeApplication(application);
  const apiKey = `${application}-fixture-key`;
  const requests: string[] = [];
  const bodies = new Map<string, unknown>(
    await Promise.all(
      routes[application].map(
        async (route) =>
          [
            route,
            (await loadFixture(fixtureRoot, fixturePathFor(application, route))).body,
          ] as const,
      ),
    ),
  );

  const send = (response: ServerResponse, status: number, body: unknown): void => {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  };

  const server: Server = createServer((request, response) => {
    if (options.unreachable === true) {
      request.socket.destroy();
      return;
    }

    const url = new URL(request.url ?? "/", "http://instance.invalid");
    const prefix = `${descriptor.apiBasePath}/`;
    if (!url.pathname.startsWith(prefix)) {
      send(response, 404, { message: "unknown path" });
      return;
    }
    const route = url.pathname.slice(prefix.length);
    requests.push(route);

    if (request.headers["x-api-key"] !== apiKey) {
      send(response, 401, { message: "unauthorized" });
      return;
    }

    const single = /^series\/(\d+)$/u.exec(route);
    if (application === "sonarr" && single !== null) {
      const record = recordById(bodies.get("series"), Number(single[1]));
      send(response, record === undefined ? 404 : 200, record ?? { message: "not found" });
      return;
    }

    const body = bodies.get(route);
    if (body === undefined) {
      send(response, 404, { message: "not found" });
      return;
    }
    send(response, 200, filtered(body, route, url.searchParams));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;

  return {
    application,
    url: `http://127.0.0.1:${address.port}`,
    apiKey,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}

/** The environment a host would pass for the given fixture instances. */
export function instanceEnvironment(instances: readonly FixtureInstance[]): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const instance of instances) {
    const descriptor = describeApplication(instance.application);
    environment[descriptor.urlVariable] = instance.url;
    environment[descriptor.apiKeyVariable] = instance.apiKey;
  }
  return environment;
}
