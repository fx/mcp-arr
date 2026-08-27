import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
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

/**
 * The routes each application answers: its probe, its library reads, and the
 * interactive release search a grab is resolved from.
 */
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
    "release",
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
    "release",
  ],
  // Prowlarr has no media library, so it answers the capability probe and the
  // routes an aggregate search and a grab need.
  prowlarr: ["system/status", "indexer", "indexerstatus", "search"],
};

/**
 * Which query parameter narrows a route, where a real instance narrows one, and
 * which record field it is matched against. The two are named separately
 * because they differ: an aggregate search takes a plural `indexerIds` filter
 * and each release reports the singular `indexerId` it came from.
 */
const parentFilters: Readonly<Record<string, { query: string; field: string } | undefined>> = {
  episode: { query: "seriesId", field: "seriesId" },
  episodefile: { query: "seriesId", field: "seriesId" },
  moviefile: { query: "movieId", field: "movieId" },
  search: { query: "indexerIds", field: "indexerId" },
};

/** The route each application resolves a grab on, keyed by application. */
const grabRoutes: Readonly<Record<ApplicationId, string>> = {
  sonarr: "release",
  radarr: "release",
  prowlarr: "search",
};

export interface FixtureInstanceOptions {
  /**
   * Drops every connection instead of answering it, which is what this server
   * sees when a configured instance is not running. Modelled by an accepting
   * socket that then closes, so the test never has to guess at a free port or
   * race one that was just released.
   */
  readonly unreachable?: boolean;
  /**
   * Refuses a grab for the named release GUIDs the way an instance whose search
   * cache no longer holds them does, so a test can produce a mixed per-release
   * outcome without inventing a second server.
   */
  readonly staleGrabs?: readonly string[];
}

export interface UpstreamSearch {
  readonly route: string;
  readonly query: URLSearchParams;
}

/** One grab this instance was asked for, as it arrived. */
export interface UpstreamGrab {
  readonly route: string;
  readonly guid: string;
  readonly indexerId: number | undefined;
}

export interface FixtureInstance {
  readonly application: ApplicationId;
  readonly url: string;
  readonly apiKey: string;
  /** The relative routes this instance was asked for, in order. */
  readonly requests: readonly string[];
  /** The same requests with their query parameters, for asserting what was sent. */
  readonly searches: readonly UpstreamSearch[];
  /** The grabs this instance was asked to resolve, in order. */
  readonly grabs: readonly UpstreamGrab[];
  close(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function filtered(body: unknown, route: string, query: URLSearchParams): unknown {
  const filter = parentFilters[route];
  const wanted = filter === undefined ? null : query.get(filter.query);
  if (filter === undefined || wanted === null || !Array.isArray(body)) {
    return body;
  }
  return body.filter((record) => isRecord(record) && String(record[filter.field]) === wanted);
}

interface GrabBody {
  readonly guid: string;
  readonly indexerId: number | undefined;
}

/** Reads the body one grab carried, which is only ever a cache identity. */
async function readGrabBody(request: IncomingMessage): Promise<GrabBody> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!isRecord(parsed) || typeof parsed.guid !== "string") {
    throw new Error("A grab must carry a release GUID");
  }
  return {
    guid: parsed.guid,
    indexerId: typeof parsed.indexerId === "number" ? parsed.indexerId : undefined,
  };
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
  const searches: UpstreamSearch[] = [];
  const grabs: UpstreamGrab[] = [];
  const stale = new Set(options.staleGrabs ?? []);
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
    searches.push({ route, query: url.searchParams });

    if (request.headers["x-api-key"] !== apiKey) {
      send(response, 401, { message: "unauthorized" });
      return;
    }

    // A grab is the one thing this server is asked to do rather than to
    // report. It resolves out of the recorded search body, exactly the way an
    // instance resolves one out of its own short-lived cache, and answers `404`
    // for a release the cache no longer holds.
    if (request.method === "POST") {
      if (route !== grabRoutes[application]) {
        send(response, 404, { message: "not found" });
        return;
      }
      readGrabBody(request).then(
        (body) => {
          grabs.push({ route, guid: body.guid, indexerId: body.indexerId });
          const cached = Array.isArray(bodies.get(route))
            ? (bodies.get(route) as unknown[]).find(
                (record) => isRecord(record) && record.guid === body.guid,
              )
            : undefined;
          if (cached === undefined || stale.has(body.guid)) {
            send(response, 404, {
              message: "Couldn't find requested release in cache, try searching again",
            });
            return;
          }
          send(response, 200, cached);
        },
        () => send(response, 400, { message: "unreadable body" }),
      );
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
    searches,
    grabs,
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
