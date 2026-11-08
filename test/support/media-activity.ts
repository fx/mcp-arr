import type { ApplicationId } from "../../src/applications.js";
import type { FetchLike } from "../../src/http/client.js";
import { activityFixture } from "./activity.js";
import { reprocessAnswer } from "./manual-import.js";
import { jsonResponse, loadStatusFixtures } from "./tool-context.js";

/**
 * A stand-in for the two media instances behind `media_status`, `media_fix`,
 * `media_search_again`, and `media_remove`.
 *
 * Each instance starts as the recorded fixtures describe it — its library, its
 * episodes and files, its queue, its history, its calendar, and its import
 * scan — and holds that state as a copy a test can change, so a removal
 * removes, a resolved queue row leaves the queue, and a command can be moved
 * to an end. `command/{id}` answers with a command it accepted. It filters
 * and pages what a real instance filters and pages, and every request is
 * recorded as it arrived.
 */

export type ActivityApplication = "sonarr" | "radarr";

export interface ActivityRequest {
  readonly application: ApplicationId;
  readonly method: string;
  readonly route: string;
  readonly query: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

type UpstreamRecord = Record<string, unknown>;

/** One instance's state, which a test reads and changes directly. */
export interface InstanceState {
  /** Series on the series instance, movies on the movie instance. */
  titles: UpstreamRecord[];
  episodes: UpstreamRecord[];
  files: UpstreamRecord[];
  queue: UpstreamRecord[];
  history: UpstreamRecord[];
  calendar: UpstreamRecord[];
  manualimport: UpstreamRecord[];
  diskspace: UpstreamRecord[];
  profiles: UpstreamRecord[];
  /** Commands this instance accepted, by id, as it would answer them. */
  readonly commands: Map<number, UpstreamRecord>;
}

/** Answers one request in place of the double, or `undefined` to let the double answer. */
export type Interceptor = (
  request: ActivityRequest,
) => Response | undefined | Promise<Response | undefined>;

export interface ActivityInstances {
  readonly fetch: FetchLike;
  readonly requests: readonly ActivityRequest[];
  state(application: ActivityApplication): InstanceState;
  /** Runs before the double answers every request; the first answer wins. */
  intercept(interceptor: Interceptor): void;
  /** Requests that could change something: every one but a GET and an import re-decision. */
  mutations(): readonly ActivityRequest[];
}

const titleRoutes: Readonly<Record<ActivityApplication, { route: string }>> = {
  sonarr: { route: "series" },
  radarr: { route: "movie" },
};

function isRecord(value: unknown): value is UpstreamRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function applicationOf(url: URL): ApplicationId {
  for (const application of ["sonarr", "radarr", "prowlarr"] as const) {
    if (url.hostname.startsWith(`${application}.`)) {
      return application;
    }
  }
  throw new Error(`Unexpected upstream host in ${url.pathname}`);
}

function records(body: unknown): UpstreamRecord[] {
  const list = Array.isArray(body)
    ? body
    : isRecord(body) && Array.isArray(body.records)
      ? body.records
      : [];
  return list.filter(isRecord).map((record) => structuredClone(record));
}

async function seed(application: ActivityApplication): Promise<InstanceState> {
  const titleRoute = titleRoutes[application].route;
  const fileRoute = application === "sonarr" ? "episodefile" : "moviefile";
  const read = (route: string) => activityFixture(application, route);
  return {
    titles: records(await read(titleRoute)),
    episodes: application === "sonarr" ? records(await read("episode")) : [],
    files: records(await read(fileRoute)),
    queue: records(await read("queue/details")),
    history: records(await read("history")),
    calendar: records(await read("calendar")),
    manualimport: records(await read("manualimport")),
    diskspace: records(await read("diskspace")),
    profiles: records(await read("qualityprofile")),
    commands: new Map(),
  };
}

function matches(record: UpstreamRecord, field: string, wanted: string | undefined): boolean {
  return wanted === undefined || String(record[field]) === wanted;
}

export async function createActivityInstances(): Promise<ActivityInstances> {
  const statuses = await loadStatusFixtures();
  const states: Record<ActivityApplication, InstanceState> = {
    sonarr: await seed("sonarr"),
    radarr: await seed("radarr"),
  };
  const queueStatus = {
    sonarr: (await activityFixture("sonarr", "queue/status")) as UpstreamRecord,
    radarr: (await activityFixture("radarr", "queue/status")) as UpstreamRecord,
  };
  const requests: ActivityRequest[] = [];
  const interceptors: Interceptor[] = [];
  let nextCommandId = 7001;

  const answer = (application: ActivityApplication, request: ActivityRequest): Response => {
    const state = states[application];
    const { method, route, query } = request;
    const title = titleRoutes[application];
    const parent = application === "sonarr" ? "seriesId" : "movieId";

    if (method === "GET" && route === title.route) {
      return jsonResponse(state.titles);
    }
    const single = new RegExp(`^${title.route}/(\\d+)$`, "u").exec(route);
    if (single !== null) {
      const id = Number(single[1]);
      const index = state.titles.findIndex((record) => record.id === id);
      if (index < 0) {
        return jsonResponse({ message: "not found" }, 404);
      }
      if (method === "GET") {
        return jsonResponse(state.titles[index]);
      }
      if (method === "DELETE") {
        state.titles.splice(index, 1);
        return new Response(null, { status: 200 });
      }
    }
    if (method === "GET" && route === "episode") {
      return jsonResponse(
        state.episodes.filter((record) => matches(record, "seriesId", query.seriesId)),
      );
    }
    if (method === "GET" && (route === "episodefile" || route === "moviefile")) {
      return jsonResponse(state.files.filter((record) => matches(record, parent, query[parent])));
    }
    if (method === "GET" && route === "qualityprofile") {
      return jsonResponse(state.profiles);
    }
    if (method === "GET" && route === "queue") {
      const page = Number(query.page ?? "1");
      const pageSize = Number(query.pageSize ?? String(state.queue.length));
      return jsonResponse({
        page,
        pageSize,
        totalRecords: state.queue.length,
        records: state.queue.slice((page - 1) * pageSize, page * pageSize),
      });
    }
    if (method === "GET" && route === "queue/status") {
      return jsonResponse({
        ...queueStatus[application],
        totalCount: state.queue.length,
        count: state.queue.length,
      });
    }
    if (method === "GET" && route === "queue/details") {
      return jsonResponse(state.queue.filter((record) => matches(record, parent, query[parent])));
    }
    const queueRow = /^queue\/(\d+)$/u.exec(route);
    if (method === "DELETE" && queueRow !== null) {
      const row = state.queue.find((record) => record.id === Number(queueRow[1]));
      if (row === undefined) {
        return jsonResponse({ message: "not found" }, 404);
      }
      // Removing a download removes every row it is listed as.
      state.queue = state.queue.filter((record) =>
        row.downloadId === undefined || row.downloadId === null
          ? record !== row
          : record.downloadId !== row.downloadId,
      );
      return new Response(null, { status: 200 });
    }
    if (method === "GET" && route === "history") {
      // Server-paged, newest first, as the instance answers the paged route.
      const page = Number(query.page ?? "1");
      const pageSize = Number(query.pageSize ?? String(state.history.length));
      const sorted = [...state.history].sort(
        (left, right) => Date.parse(String(right.date)) - Date.parse(String(left.date)),
      );
      return jsonResponse({
        page,
        pageSize,
        totalRecords: sorted.length,
        records: sorted.slice((page - 1) * pageSize, page * pageSize),
      });
    }
    if (method === "GET" && route === "calendar") {
      return jsonResponse(state.calendar);
    }
    if (method === "GET" && route === "manualimport") {
      return jsonResponse(state.manualimport);
    }
    if (method === "POST" && route === "manualimport") {
      const sent = Array.isArray(request.body) ? request.body.filter(isRecord) : [];
      return jsonResponse(
        sent.map((element) => {
          const scanned = state.manualimport.find((record) => record.path === element.path);
          return reprocessAnswer(
            element,
            Array.isArray(scanned?.rejections) ? scanned.rejections : [],
          );
        }),
      );
    }
    if (method === "GET" && route === "diskspace") {
      return jsonResponse(state.diskspace);
    }
    if (method === "POST" && route === "command" && isRecord(request.body)) {
      const id = nextCommandId;
      nextCommandId += 1;
      const accepted = { id, name: request.body.name, status: "queued", body: request.body };
      state.commands.set(id, accepted);
      return jsonResponse(accepted, 201);
    }
    if (method === "GET" && route === "command") {
      return jsonResponse([...state.commands.values()]);
    }
    const command = /^command\/(\d+)$/u.exec(route);
    if (method === "GET" && command !== null) {
      const accepted = state.commands.get(Number(command[1]));
      return accepted === undefined
        ? jsonResponse({ message: "not found" }, 404)
        : jsonResponse(accepted);
    }
    return jsonResponse({ message: "not found" }, 404);
  };

  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    const application = applicationOf(url);
    const method = init.method ?? "GET";
    const request: ActivityRequest = {
      application,
      method,
      route: url.pathname.replace(/^.*?\/api\/v\d\//u, ""),
      query: Object.fromEntries(url.searchParams),
      body: typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
    };
    requests.push(request);
    for (const interceptor of interceptors) {
      const intercepted = await interceptor(request);
      if (intercepted !== undefined) {
        return intercepted;
      }
    }
    if (request.route === "system/status") {
      return jsonResponse(statuses.get(application)?.body);
    }
    if (application === "prowlarr") {
      return jsonResponse({ message: "not found" }, 404);
    }
    return answer(application, request);
  };

  return {
    fetch,
    requests,
    state: (application) => states[application],
    intercept(interceptor) {
      interceptors.push(interceptor);
    },
    mutations: () =>
      requests.filter(
        (request) =>
          request.method !== "GET" &&
          !(request.method === "POST" && request.route === "manualimport"),
      ),
  };
}
