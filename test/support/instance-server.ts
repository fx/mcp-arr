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
    "rename",
    "rootfolder",
    "qualityprofile",
    "qualitydefinition",
    "language",
    "tag",
    "wanted/missing",
    "wanted/cutoff",
    "calendar",
    "queue/status",
    "queue",
    "queue/details",
    "manualimport",
    "history",
    "history/series",
    "blocklist",
    "health",
    "command",
    "diskspace",
    "release",
    "config/downloadclient",
    "indexer",
  ],
  radarr: [
    "system/status",
    "movie",
    "movie/lookup",
    "collection",
    "moviefile",
    "rename",
    "rootfolder",
    "qualityprofile",
    "qualitydefinition",
    "language",
    "tag",
    "wanted/missing",
    "wanted/cutoff",
    "calendar",
    "queue/status",
    "queue",
    "queue/details",
    "manualimport",
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
    "applications",
    "tag",
  ],
};

/**
 * Which query parameters narrow a route, where a real instance narrows one, and
 * which record field each is matched against. The two halves are named
 * separately because they differ: an aggregate search takes a plural
 * `indexerIds` filter and each release reports the singular `indexerId` it came
 * from. A route may carry several, because a rename preview is asked about one
 * series and optionally one season of it, and a filter whose parameter the
 * request omitted narrows nothing.
 */
const parentFilters: Readonly<
  Record<string, readonly { query: string; field: string }[] | undefined>
> = {
  episode: [{ query: "seriesId", field: "seriesId" }],
  episodefile: [{ query: "seriesId", field: "seriesId" }],
  moviefile: [{ query: "movieId", field: "movieId" }],
  search: [{ query: "indexerIds", field: "indexerId" }],
  "history/series": [{ query: "seriesId", field: "seriesId" }],
  "history/movie": [{ query: "movieId", field: "movieId" }],
  rename: [
    { query: "seriesId", field: "seriesId" },
    { query: "movieId", field: "movieId" },
    { query: "seasonNumber", field: "seasonNumber" },
  ],
};

/** `history/failed/{id}` and `blocklist/{id}`, the two activity single-record writes. */
const historyFailedRoute = /^history\/failed\/(\d+)$/u;
const blocklistRecordRoute = /^blocklist\/(\d+)$/u;
const queueItemRoute = /^queue\/(\d+)$/u;
const queueGrabRoute = /^queue\/grab\/(\d+)$/u;

/**
 * The collections whose individual records this surface reads and writes.
 *
 * A library mutation is a read-modify-write over one record, so the double has
 * to hold the record rather than only the collection it came from: a write is
 * kept, and the read that follows it sees what was written. That is what makes a
 * repeated apply, a stale reference, and a lost answer distinguishable from one
 * another over a real socket instead of only in a unit test's memory.
 */
const recordRoutes: Readonly<Record<ApplicationId, readonly string[]>> = {
  sonarr: ["series", "episodefile"],
  radarr: ["movie", "moviefile", "collection"],
  prowlarr: [],
};

/** The collections a create may append to, and the metadata identifier one carries. */
const createRoutes: Readonly<
  Record<ApplicationId, { route: string; metadataId: string } | undefined>
> = {
  sonarr: { route: "series", metadataId: "tvdbId" },
  radarr: { route: "movie", metadataId: "tmdbId" },
  prowlarr: undefined,
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
  /**
   * Records a library write, performs it, and then drops the connection instead
   * of answering — which is what a caller sees when an instance took a request
   * and the reply was lost on the way back. The write really happens, because
   * that is the whole difficulty the outcome-unknown settlement exists for: the
   * caller cannot tell this from a request that never arrived, and must not
   * record it as one that certainly did not.
   */
  readonly loseWriteAnswers?: boolean;
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

/**
 * One queue item this instance resolved, as the request arrived.
 *
 * The flags are kept exactly as they were sent rather than interpreted, because
 * what a test needs to assert about a queue transition is the combination that
 * reached the wire — that is the whole of what distinguishes the intents from
 * one another.
 */
export interface UpstreamQueueResolution {
  readonly queueItemId: number;
  readonly method: "DELETE" | "POST";
  readonly flags: Readonly<Record<string, string>>;
}

/** One command this instance started, as it arrived. */
export interface UpstreamCommand {
  readonly name: string;
  readonly body: Readonly<Record<string, unknown>>;
}

/** One library write this instance performed, as it arrived. */
export interface UpstreamWrite {
  readonly method: "POST" | "PUT" | "DELETE";
  readonly route: string;
  /** The query a deletion carries its explicit choices in. */
  readonly query: Readonly<Record<string, string>>;
  readonly body?: Readonly<Record<string, unknown>> | undefined;
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
  /** The candidate rows a manual-import reprocess was asked to re-decide. */
  readonly reprocessed: readonly Record<string, unknown>[];
  readonly failedHistory: readonly number[];
  readonly removedBlocklist: readonly number[];
  /**
   * The queue items this instance resolved, in order and on the same terms as
   * the grabs above: a request it refused is absent, so a test cannot mistake a
   * rejected transition for a performed one.
   */
  readonly queueResolutions: readonly UpstreamQueueResolution[];
  /**
   * The library records and media files this instance created, replaced, and
   * removed, in order and on the same terms as the grabs above: a write this
   * server refused is absent, so a test cannot mistake a rejected write for a
   * performed one.
   */
  readonly writes: readonly UpstreamWrite[];
  close(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function filtered(body: unknown, route: string, query: URLSearchParams): unknown {
  const filters = parentFilters[route];
  if (filters === undefined || !Array.isArray(body)) {
    return body;
  }
  return filters.reduce<unknown[]>((records, filter) => {
    const wanted = query.get(filter.query);
    return wanted === null
      ? records
      : records.filter((record) => isRecord(record) && String(record[filter.field]) === wanted);
  }, body);
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
  // Resolved queue items are remembered as well as recorded, so a later read of
  // the queue no longer reports a row this instance removed — which is what
  // makes a second resolution of the same row the `404` a real instance gives,
  // and what a stale reference has to be distinguishable from a first attempt.
  const resolvedQueue: number[] = [];
  const queueResolutions: UpstreamQueueResolution[] = [];
  const writes: UpstreamWrite[] = [];
  const reprocessed: Record<string, unknown>[] = [];
  // Well clear of every identifier the recorded fixtures use, so a created
  // record is always distinguishable from one that was already there.
  let nextRecordId = 90_001;
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
    // `queue/details` answers a bare array where the paged routes answer an
    // envelope, so both shapes are filtered rather than only the one the
    // blocklist happens to use.
    if (route === "queue/details" && resolvedQueue.length > 0 && Array.isArray(body)) {
      return body.filter(
        (record) => !(isRecord(record) && resolvedQueue.includes(Number(record.id))),
      );
    }

    const removed =
      route === "blocklist" ? removedBlocklist : route === "queue" ? resolvedQueue : [];
    if (removed.length === 0 || !isRecord(body)) {
      return body;
    }
    const records = Array.isArray(body.records) ? body.records : [];
    const kept = records.filter(
      (record) => !(isRecord(record) && removed.includes(Number(record.id))),
    );
    return { ...body, records: kept, totalRecords: kept.length };
  };

  const send = (response: ServerResponse, status: number, body: unknown): void => {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  };

  /**
   * Answers a performed write, or loses the answer to it.
   *
   * The write has already happened by the time this is reached, and the record
   * of it has already been kept, so a lost answer is exactly what it says: the
   * instance did the thing and the caller never found out.
   */
  const settle = (response: ServerResponse, status: number, body: unknown): void => {
    if (options.loseWriteAnswers === true) {
      response.socket?.destroy();
      return;
    }
    send(response, status, body);
  };

  /** The records of one collection, as this instance now holds them. */
  const collectionOf = (route: string): Record<string, unknown>[] => {
    const body = bodies.get(route);
    return Array.isArray(body) ? (body as Record<string, unknown>[]) : [];
  };

  /**
   * Replaces one record. A body that does not name the record it replaces is
   * the `400` a real instance gives: these APIs replace a whole resource, and a
   * payload with no identity is not one.
   */
  const replaceRecord = (
    response: ServerResponse,
    route: string,
    id: number,
    body: Record<string, unknown>,
  ): void => {
    if (body.id !== id) {
      send(response, 400, { message: "A replacement must carry the identifier it replaces" });
      return;
    }
    const records = collectionOf(route);
    const index = records.findIndex((record) => record.id === id);
    if (index < 0) {
      send(response, 404, { message: "not found" });
      return;
    }
    records[index] = body;
    writes.push({ method: "PUT", route, query: {}, body });
    settle(response, 200, body);
  };

  /** Removes one record, keeping whatever choices the caller sent with it. */
  const removeRecord = (
    response: ServerResponse,
    route: string,
    id: number,
    query: URLSearchParams,
  ): void => {
    const records = collectionOf(route);
    const index = records.findIndex((record) => record.id === id);
    if (index < 0) {
      send(response, 404, { message: "not found" });
      return;
    }
    records.splice(index, 1);
    writes.push({ method: "DELETE", route, query: Object.fromEntries(query) });
    // A real deletion answers with no content at all, which is the answer a
    // write has to accept without calling it broken.
    if (options.loseWriteAnswers === true) {
      response.socket?.destroy();
      return;
    }
    response.writeHead(200);
    response.end();
  };

  /**
   * Creates one record. A create that names no metadata identifier is refused,
   * because that identifier is the one field this route exists to carry: it is
   * what the instance would match against its own metadata source.
   */
  const createRecord = (
    response: ServerResponse,
    route: string,
    metadataId: string,
    body: Record<string, unknown>,
  ): void => {
    if (typeof body[metadataId] !== "number") {
      send(response, 400, { message: `A create must carry its ${metadataId}` });
      return;
    }
    const records = collectionOf(route);
    const created = { ...body, id: nextRecordId };
    nextRecordId += 1;
    records.push(created);
    writes.push({ method: "POST", route, query: {}, body });
    settle(response, 201, created);
  };

  /**
   * Whether this application exposes the route at all. The table is per
   * application because the applications differ, and a double that answered one
   * application's route on another would let a request no instance could have
   * served pass for a working one.
   */
  const answers = (candidate: string): boolean => routes[application].includes(candidate);

  /**
   * Matches any `<collection>/<id>` path. Whether *this* application models that
   * collection is decided at the call site, so a path naming another
   * application's collection is the `404` a real instance gives rather than a
   * path this server does not recognize at all.
   */
  const singleRecordRoute = /^([a-z]+)\/(\d+)$/u;

  /**
   * Whether this instance exposes the path at all, under any method.
   *
   * Every place a method is refused asks this one question, so the two answers
   * cannot drift: a client that reached for the wrong verb is told so, and a
   * client that reached for a path this application does not have is told that
   * instead. Deciding it separately per branch is how a wrong verb on one route
   * came to look like an absent route while the same mistake on another route
   * was named correctly.
   */
  const exposes = (candidate: string): boolean => {
    if (answers(candidate)) {
      return true;
    }
    // Asked before the generic `<collection>/<id>` shape, which `queue/502`
    // also matches: deciding it there would answer "no such path" for a route
    // this instance does expose, and a wrong verb on it would be reported as a
    // missing route.
    if (queueGrabRoute.test(candidate) || queueItemRoute.test(candidate)) {
      return answers("queue");
    }
    const record = singleRecordRoute.exec(candidate);
    if (record !== null) {
      const collection = record[1] ?? "";
      return (
        recordRoutes[application].includes(collection) ||
        (collection === "blocklist" && answers("blocklist"))
      );
    }
    return historyFailedRoute.test(candidate) && answers("history");
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

    /**
     * The two queue transitions. Both name their row in the path and read no
     * body: a delete carries the resolution's flags as query parameters, and a
     * pending grab carries nothing at all.
     *
     * A row this instance no longer holds — including one it has already
     * resolved — is the `404` a real instance gives, which is what makes a
     * stale reference distinguishable from a first attempt.
     */
    const queueItem = request.method === "DELETE" ? queueItemRoute.exec(route) : null;
    const queueGrab = request.method === "POST" ? queueGrabRoute.exec(route) : null;
    if ((queueItem !== null || queueGrab !== null) && answers("queue")) {
      const id = Number((queueItem ?? queueGrab)?.[1]);
      if (!pagedHasId(bodies.get("queue"), id) || resolvedQueue.includes(id)) {
        send(response, 404, { message: "unknown queue item" });
        return;
      }
      resolvedQueue.push(id);
      queueResolutions.push({
        queueItemId: id,
        method: queueItem !== null ? "DELETE" : "POST",
        flags: Object.fromEntries(url.searchParams),
      });
      // Both answer with no content, which is what the upstream client has to
      // resolve rather than fail to parse.
      response.writeHead(204);
      response.end();
      return;
    }

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

      // Manual-import reprocessing: a POST that decides rather than stores. It
      // answers with the rows it was given, which is what an instance that
      // re-ran its decision engine and changed nothing does, so a test that
      // needs a different decision replaces the scan body instead.
      if (route === "manualimport" && answers(route)) {
        readPostedBody(request).then(
          (body) => {
            const sent = isRecord(body) && Array.isArray(body.files) ? body.files : [];
            reprocessed.push(...(sent as Record<string, unknown>[]));
            send(response, 200, sent);
          },
          () => send(response, 400, { message: "unreadable body" }),
        );
        return;
      }

      const creating = createRoutes[application];
      const writable =
        route === grabRoutes[application] ||
        (route === "command" && answers(route)) ||
        (creating !== undefined && route === creating.route);
      if (!writable) {
        // An application that exposes no command route at all still gives the
        // `404` a real instance gives for a route it does not have; one that
        // exposes the path for another method gives the refusal that names the
        // verb, rather than denying the path exists.
        const exposed = exposes(route);
        send(response, exposed ? 405 : 404, {
          message: exposed ? "method not allowed" : "not found",
        });
        return;
      }
      readPostedBody(request).then(
        (body) => {
          if (route === "command") {
            acceptCommand(body);
            return;
          }
          if (creating !== undefined && route === creating.route) {
            createRecord(response, creating.route, creating.metadataId, body);
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

    const single = singleRecordRoute.exec(route);
    const collection = single === null ? undefined : single[1];
    const recordId = single === null ? undefined : Number(single[2]);
    const known = collection !== undefined && recordRoutes[application].includes(collection);

    // A single record of a collection this application does model, replaced or
    // removed in place. The write is kept, so the read after it sees what was
    // written and a second removal is the `404` a real instance gives.
    if (known && recordId !== undefined && collection !== undefined) {
      if (request.method === "PUT") {
        readPostedBody(request).then(
          (body) => replaceRecord(response, collection, recordId, body),
          () => send(response, 400, { message: "unreadable body" }),
        );
        return;
      }
      if (request.method === "DELETE") {
        removeRecord(response, collection, recordId, url.searchParams);
        return;
      }
    }

    // Everything left is a read, so every other method is one this instance
    // does not expose here. Answering it with the body a `GET` would have
    // returned is the whole defect class: a client that reached for the wrong
    // verb would be indistinguishable from one that got it right.
    if (request.method !== "GET") {
      const exposed = exposes(route);
      send(response, exposed ? 405 : 404, {
        message: exposed ? "method not allowed" : "not found",
      });
      return;
    }

    // The queue transition paths exist, but not for reading: `queue/{id}` is
    // resolved with a delete and `queue/grab/{id}` with a post, and neither
    // answers a `GET`. Deciding that here keeps the promise `exposes` makes —
    // a path this instance has, reached with the wrong verb, is told so.
    if (queueItemRoute.test(route) || queueGrabRoute.test(route)) {
      send(response, answers("queue") ? 405 : 404, {
        message: answers("queue") ? "method not allowed" : "not found",
      });
      return;
    }

    if (single !== null) {
      if (!known || collection === undefined || recordId === undefined) {
        send(response, 404, { message: "not found" });
        return;
      }
      const record = recordById(bodies.get(collection), recordId);
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
    reprocessed,
    queueResolutions,
    writes,
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
