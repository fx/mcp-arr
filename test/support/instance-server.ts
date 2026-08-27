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
 *
 * What it refuses matters as much as what it answers, because a double that
 * accepts what a real instance would reject stops being evidence about the
 * client. A route this application does not expose is `404`, a method the route
 * does not expose is `405`, a write missing the one field it exists to carry is
 * `400`, and nothing is recorded as done until it has been accepted.
 */

/**
 * The routes each application answers: its probe, its library and activity
 * reads, the interactive release search a grab is resolved from, and the
 * command endpoint an automatic search is started on.
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
    "queue/status",
    "queue",
    "queue/details",
    "history",
    "history/series",
    "blocklist",
    "health",
    "command",
    "diskspace",
    "release",
    "config/downloadclient",
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
    "queue/status",
    "queue",
    "queue/details",
    "history",
    "history/movie",
    "blocklist",
    "health",
    "command",
    "diskspace",
    "release",
    "config/downloadclient",
  ],
  // Prowlarr has no media library, no queue, no blocklist, and no disk view, so
  // it answers the capability probe, the activity reads it does model, and the
  // routes an aggregate search and a grab need.
  prowlarr: [
    "system/status",
    "indexer",
    "indexerstatus",
    "indexerstats",
    "search",
    "history",
    "health",
    "command",
  ],
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
  "history/series": { query: "seriesId", field: "seriesId" },
  "history/movie": { query: "movieId", field: "movieId" },
};

/** `history/failed/{id}` and `blocklist/{id}`, the two single-record writes. */
const historyFailedRoute = /^history\/failed\/(\d+)$/u;
const blocklistRecordRoute = /^blocklist\/(\d+)$/u;

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

/** One grab this instance resolved, as it arrived. */
export interface UpstreamGrab {
  readonly route: string;
  readonly guid: string;
  readonly indexerId: number | undefined;
}

/** One command this instance started, as it arrived. */
export interface UpstreamCommand {
  readonly name: string;
  readonly body: Readonly<Record<string, unknown>>;
}

export interface FixtureInstance {
  readonly application: ApplicationId;
  readonly url: string;
  readonly apiKey: string;
  /**
   * The relative routes this instance was asked for, in order — every request
   * that named one, answered or refused, because what reached the wire is the
   * question this records.
   */
  readonly requests: readonly string[];
  /** The same requests with their query parameters, for asserting what was sent. */
  readonly searches: readonly UpstreamSearch[];
  /**
   * The grabs this instance resolved, in order. A write this server refused is
   * absent, so these two records say what the instance did rather than what it
   * was asked to do, and a test asserting on them cannot mistake a rejected
   * write for a performed one.
   */
  readonly grabs: readonly UpstreamGrab[];
  /** The commands this instance started, in order, on the same terms. */
  readonly commands: readonly UpstreamCommand[];
  /**
   * The history records this instance marked failed, and the blocklist records
   * it removed, in order. Like the grabs above, a write this server refused is
   * absent — so a test asserting on these cannot mistake a rejected write for a
   * performed one.
   */
  readonly failedHistory: readonly number[];
  readonly removedBlocklist: readonly number[];
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

/** Reads the JSON object a write carried. Nothing here interprets it. */
async function readPostedBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!isRecord(parsed)) {
    throw new Error("A write must carry a JSON object");
  }
  return parsed;
}

/** Whether a recorded paged collection holds a record with this identifier. */
function pagedHasId(body: unknown, id: number): boolean {
  const records = isRecord(body) && Array.isArray(body.records) ? body.records : [];
  return records.some((record) => isRecord(record) && record.id === id);
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
  const started: UpstreamCommand[] = [];
  const failedHistory: number[] = [];
  // Removals are remembered as well as recorded, so a subsequent read of the
  // blocklist no longer reports a record this instance has removed. That is
  // what a real instance does, and it is what lets a test that reconciles a
  // lost answer against upstream state mean anything.
  const removedBlocklist: number[] = [];
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

  /**
   * The blocklist as it now stands, with anything this instance removed gone
   * from it. Every other route answers its recorded body unchanged.
   */
  const withoutRemoved = (body: unknown, route: string): unknown => {
    if (route !== "blocklist" || removedBlocklist.length === 0 || !isRecord(body)) {
      return body;
    }
    const records = Array.isArray(body.records) ? body.records : [];
    const kept = records.filter(
      (record) => !(isRecord(record) && removedBlocklist.includes(Number(record.id))),
    );
    return { ...body, records: kept, totalRecords: kept.length };
  };

  const send = (response: ServerResponse, status: number, body: unknown): void => {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  };

  /**
   * Whether this application exposes the route at all. The table is per
   * application because the applications differ, and a double that answered one
   * application's route on another would let a request no instance could have
   * served pass for a working one.
   */
  const answers = (candidate: string): boolean => routes[application].includes(candidate);

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

    /**
     * Answers a command as an instance does: with a command record the caller
     * can follow. The record is the recorded fixture with the requested name
     * written over it, so the identity and the state come from the fixture and
     * only the echo is synthesized.
     *
     * Which names are legitimate is instance policy this double does not hold.
     * The allowlist is enforced where a target is compiled into a command, in
     * `src/adapters/acquisition/commands.ts`, and a test asserts on the name
     * recorded here; all this route requires is that a command carry one. A
     * body without a name is refused and recorded nowhere, so `commands` is
     * what the instance started rather than what it was asked for.
     */
    const acceptCommand = (body: Record<string, unknown>): void => {
      const recorded = Array.isArray(bodies.get("command"))
        ? (bodies.get("command") as unknown[])[0]
        : undefined;
      const name = typeof body.name === "string" ? body.name : "";
      if (name === "" || !isRecord(recorded)) {
        send(response, 400, { message: "unknown command" });
        return;
      }
      started.push({ name, body });
      send(response, 201, { ...recorded, name });
    };

    // The two things this server is asked to do rather than to report. A grab
    // resolves out of the recorded search body, exactly the way an instance
    // resolves one out of its own short-lived cache, and answers `404` for a
    // release the cache no longer holds. A command is accepted and echoed back
    // as a command record, which is what makes the started job projectable.
    if (request.method === "POST") {
      // Only where the application actually exposes the endpoint, which is what
      // the route list already says: an application that answers no command
      // route gives the `404` a real instance gives for a route that does not
      // exist, rather than a refusal, which would read as an instance that has
      // the endpoint and declined this particular command.
      // A mark-failed names its record in the path and carries nothing in its
      // body, so it is settled here rather than in the body handler below: the
      // instance either holds that history record or it does not.
      const failing = historyFailedRoute.exec(route);
      if (failing !== null) {
        if (!answers("history")) {
          send(response, 404, { message: "not found" });
          return;
        }
        const id = Number(failing[1]);
        if (!pagedHasId(bodies.get("history"), id)) {
          send(response, 404, { message: "unknown history record" });
          return;
        }
        failedHistory.push(id);
        response.writeHead(200);
        response.end();
        return;
      }

      const writable = route === grabRoutes[application] || (route === "command" && answers(route));
      if (!writable) {
        send(response, 404, { message: "not found" });
        return;
      }
      readPostedBody(request).then(
        (body) => {
          if (route === "command") {
            acceptCommand(body);
            return;
          }
          // A grab without a cache identity is a client defect, not an expired
          // reference. Answering it with the cache-miss `404` below would dress
          // that defect up as `stale_reference` and leave the suite green, so
          // this route refuses it here and records nothing.
          const guid = body.guid;
          if (typeof guid !== "string" || guid === "") {
            send(response, 400, { message: "A grab must carry a release GUID" });
            return;
          }
          grabs.push({
            route,
            guid,
            indexerId: typeof body.indexerId === "number" ? body.indexerId : undefined,
          });
          const cached = Array.isArray(bodies.get(route))
            ? (bodies.get(route) as unknown[]).find(
                (record) => isRecord(record) && record.guid === guid,
              )
            : undefined;
          if (cached === undefined || stale.has(guid)) {
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

    // The one delete this surface exposes. A record the instance does not hold —
    // including one it has already removed — is the `404` a real instance gives,
    // which is what makes a second removal distinguishable from a first.
    const removing = request.method === "DELETE" ? blocklistRecordRoute.exec(route) : null;
    if (removing !== null && answers("blocklist")) {
      const id = Number(removing[1]);
      if (!pagedHasId(bodies.get("blocklist"), id) || removedBlocklist.includes(id)) {
        send(response, 404, { message: "unknown blocklist record" });
        return;
      }
      removedBlocklist.push(id);
      response.writeHead(200);
      response.end();
      return;
    }

    const single = application === "sonarr" ? /^series\/(\d+)$/u.exec(route) : null;

    // Everything left is a read, so every other method is one this instance
    // does not expose here. Answering it with the body a `GET` would have
    // returned is the whole defect class: a client that reached for the wrong
    // verb would be indistinguishable from one that got it right.
    if (request.method !== "GET") {
      const known = answers(route) || single !== null;
      send(response, known ? 405 : 404, {
        message: known ? "method not allowed" : "not found",
      });
      return;
    }

    if (single !== null) {
      const record = recordById(bodies.get("series"), Number(single[1]));
      send(response, record === undefined ? 404 : 200, record ?? { message: "not found" });
      return;
    }

    const body = bodies.get(route);
    if (body === undefined) {
      send(response, 404, { message: "not found" });
      return;
    }
    send(response, 200, filtered(withoutRemoved(body, route), route, url.searchParams));
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
    commands: started,
    failedHistory,
    removedBlocklist,
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
