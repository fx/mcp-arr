import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createAdapterRegistry } from "../../src/adapters/registry.js";
import type { ApplicationId } from "../../src/applications.js";
import {
  type EnvironmentRecord,
  type MediaDefaults,
  parseEnvironment,
} from "../../src/config/environment.js";
import type { FetchLike } from "../../src/http/client.js";
import { type Clock, systemClock } from "../../src/state/clock.js";
import { createDownloadClaims, type DownloadClaims } from "../../src/state/download-claims.js";
import { toolErrorCodes } from "../../src/tools/errors.js";
import type { MediaContext } from "../../src/tools/media/context.js";
import { mediaToolDefinitions } from "../../src/tools/media/definitions.js";
import type { MediaToolName } from "../../src/tools/names.js";
import { runMediaTool } from "../../src/tools/register.js";
import { fixtureBody } from "./library.js";
import { allApplicationsEnvironment, jsonResponse, loadStatusFixtures } from "./tool-context.js";

/**
 * A stand-in for the two media instances, answering the routes the `media`
 * tools read from the recorded fixtures and applying creates to its own copy.
 *
 * It behaves as the applications do where a test depends on it: a lookup by
 * `tvdb:` or `tmdb:` term answers only the candidate with that id, a lookup by
 * any other term answers the whole recorded list, a created title becomes a
 * library record the next lookup reports, and a second create of the same
 * title is refused with a validation failure.
 */

export type MediaApplication = "sonarr" | "radarr";

export interface RecordedMediaRequest {
  readonly application: ApplicationId;
  readonly method: string;
  readonly route: string;
  readonly query: Readonly<Record<string, string>>;
  readonly body?: Record<string, unknown> | undefined;
  /** Everything the request carried, for the redaction checks. */
  readonly url: string;
}

export interface MediaInstances {
  readonly fetch: FetchLike;
  readonly requests: readonly RecordedMediaRequest[];
  /** Replaces one route's answer. */
  serve(application: MediaApplication, route: string, body: unknown): void;
  /** Makes a route answer with a status; narrowed to a method when given. */
  failRoute(application: MediaApplication, route: string, status: number, method?: string): void;
  /** Makes every request to one instance fail as an unreachable host does. */
  stop(application: MediaApplication): void;
  /**
   * Adds a title to the library behind this server's back, as another call
   * would, with the quality profile that call chose when one is named.
   */
  addBehindOurBack(
    application: MediaApplication,
    metadataId: number,
    qualityProfileId?: number,
  ): void;
  /**
   * Runs once a create arrives, before the instance answers it. A test uses it
   * to make the title appear between this call's check and its create.
   */
  beforeCreate(hook: (() => void) | undefined): void;
  /** Accepts creates but answers with no body, so nothing confirms them. */
  silenceCreates(application: MediaApplication): void;
  /**
   * Decides every create as usual, then drops the connection instead of
   * answering, as a lost reply does: the caller cannot tell whether it acted.
   */
  loseCreateAnswers(application: MediaApplication): void;
  /** Answers every confirmed create with these fields over the record it made. */
  answerCreatesWith(application: MediaApplication, fields: Record<string, unknown>): void;
  /** The current lookup list of one instance. */
  catalog(application: MediaApplication): readonly Record<string, unknown>[];
  /** Writes sent upstream, of any method other than GET. */
  writes(): readonly RecordedMediaRequest[];
}

const lookupRoutes: Readonly<Record<MediaApplication, string>> = {
  sonarr: "series/lookup",
  radarr: "movie/lookup",
};

const recordRoutes: Readonly<Record<MediaApplication, string>> = {
  sonarr: "series",
  radarr: "movie",
};

const metadataFields: Readonly<Record<MediaApplication, string>> = {
  sonarr: "tvdbId",
  radarr: "tmdbId",
};

const termPrefixes: Readonly<Record<MediaApplication, string>> = {
  sonarr: "tvdb:",
  radarr: "tmdb:",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function applicationForUrl(url: URL): ApplicationId {
  for (const application of ["sonarr", "radarr", "prowlarr"] as const) {
    if (url.hostname.startsWith(`${application}.`)) {
      return application;
    }
  }
  throw new Error(`Unexpected upstream host in ${url.pathname}`);
}

function routeOf(url: URL): string {
  return url.pathname.replace(/^.*?\/api\/v\d\//u, "");
}

export async function createMediaInstances(): Promise<MediaInstances> {
  const statuses = await loadStatusFixtures();
  const routes = new Map<string, unknown>();
  const key = (application: ApplicationId, route: string): string => `${application} ${route}`;
  for (const application of ["sonarr", "radarr"] as const) {
    routes.set(key(application, "rootfolder"), await fixtureBody(application, "rootfolder"));
    routes.set(
      key(application, "qualityprofile"),
      await fixtureBody(application, "qualityprofile"),
    );
    const lookup = await fixtureBody<readonly Record<string, unknown>[]>(
      application,
      lookupRoutes[application],
    );
    routes.set(
      key(application, lookupRoutes[application]),
      lookup.map((record) => ({ ...record })),
    );
  }

  const requests: RecordedMediaRequest[] = [];
  const failures = new Map<string, number>();
  const stopped = new Set<ApplicationId>();
  const silenced = new Set<ApplicationId>();
  const lostAnswers = new Set<ApplicationId>();
  const createAnswers = new Map<ApplicationId, Record<string, unknown>>();
  let createHook: (() => void) | undefined;
  let nextId = 500;

  const catalog = (application: MediaApplication): Record<string, unknown>[] =>
    routes.get(key(application, lookupRoutes[application])) as Record<string, unknown>[];

  const addToLibrary = (
    application: MediaApplication,
    metadataId: number,
    qualityProfileId: unknown,
  ): Record<string, unknown> => {
    const entry = catalog(application).find(
      (record) => record[metadataFields[application]] === metadataId,
    );
    if (entry === undefined) {
      throw new Error(`No catalog entry has ${metadataFields[application]} ${metadataId}`);
    }
    nextId += 1;
    entry.id = nextId;
    // A library record carries the profile it was added with, and the lookup
    // reports it for a title in the library.
    if (typeof qualityProfileId === "number") {
      entry.qualityProfileId = qualityProfileId;
    }
    return entry;
  };

  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    const application = applicationForUrl(url);
    const route = routeOf(url);
    const method = init.method ?? "GET";
    const rawBody = typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    requests.push({
      application,
      method,
      route,
      query: Object.fromEntries(url.searchParams),
      body: isRecord(rawBody) ? rawBody : undefined,
      url: url.href,
    });

    if (stopped.has(application)) {
      throw new TypeError("fetch failed");
    }
    const failure =
      failures.get(`${method} ${key(application, route)}`) ?? failures.get(key(application, route));
    if (failure !== undefined) {
      return jsonResponse({ message: "an instance-side failure" }, failure);
    }
    if (route === "system/status") {
      return jsonResponse(routes.get(key(application, route)) ?? statuses.get(application)?.body);
    }
    if (application === "prowlarr") {
      return jsonResponse({ message: "not found" }, 404);
    }

    if (route === lookupRoutes[application] && method === "GET") {
      const term = url.searchParams.get("term") ?? "";
      const prefix = termPrefixes[application];
      const list = catalog(application);
      if (term.startsWith(prefix)) {
        const id = Number(term.slice(prefix.length));
        return jsonResponse(list.filter((record) => record[metadataFields[application]] === id));
      }
      return jsonResponse(list);
    }

    if (route === recordRoutes[application] && method === "POST") {
      createHook?.();
      const metadataId = isRecord(rawBody) ? rawBody[metadataFields[application]] : undefined;
      const entry = catalog(application).find(
        (record) => record[metadataFields[application]] === metadataId,
      );
      if (typeof entry?.id === "number" && entry.id > 0) {
        if (lostAnswers.has(application)) {
          throw new TypeError("fetch failed");
        }
        return jsonResponse(
          [
            {
              propertyName: metadataFields[application],
              errorMessage: "This title has already been added",
            },
          ],
          400,
        );
      }
      const created = addToLibrary(
        application,
        metadataId as number,
        isRecord(rawBody) ? rawBody.qualityProfileId : undefined,
      );
      if (lostAnswers.has(application)) {
        throw new TypeError("fetch failed");
      }
      if (silenced.has(application)) {
        return new Response(null, { status: 201 });
      }
      const answered = createAnswers.get(application) ?? {};
      Object.assign(created, answered);
      return jsonResponse({ ...(rawBody as object), ...answered, id: created.id }, 201);
    }

    const recordMatch = new RegExp(`^${recordRoutes[application]}/(\\d+)$`, "u").exec(route);
    if (recordMatch !== null && method === "GET" && !routes.has(key(application, route))) {
      const id = Number(recordMatch[1]);
      const record = catalog(application).find((entry) => entry.id === id);
      return record === undefined
        ? jsonResponse({ message: "not found" }, 404)
        : jsonResponse(record);
    }

    const served = routes.get(key(application, route));
    if (served !== undefined && method === "GET") {
      return jsonResponse(served);
    }
    return jsonResponse({ message: "not found" }, 404);
  };

  return {
    fetch,
    requests,
    serve(application, route, body) {
      routes.set(key(application, route), body);
    },
    failRoute(application, route, status, method) {
      failures.set(
        method === undefined ? key(application, route) : `${method} ${key(application, route)}`,
        status,
      );
    },
    stop(application) {
      stopped.add(application);
    },
    addBehindOurBack(application, metadataId, qualityProfileId) {
      addToLibrary(application, metadataId, qualityProfileId);
    },
    beforeCreate(hook) {
      createHook = hook;
    },
    silenceCreates(application) {
      silenced.add(application);
    },
    loseCreateAnswers(application) {
      lostAnswers.add(application);
    },
    answerCreatesWith(application, fields) {
      createAnswers.set(application, fields);
    },
    catalog,
    writes: () => requests.filter((request) => request.method !== "GET"),
  };
}

export const noMediaDefaults: MediaDefaults = { movie: {}, series: {} };

/** The process state a `media` context shares with every other call. */
export interface MediaProcessState {
  readonly claims: DownloadClaims;
  readonly clock: Clock;
}

export function createMediaContext(
  instances: { readonly fetch: FetchLike },
  defaults: MediaDefaults = noMediaDefaults,
  environment: EnvironmentRecord = allApplicationsEnvironment,
  state: MediaProcessState = { claims: createDownloadClaims(), clock: systemClock },
): MediaContext {
  return {
    registry: createAdapterRegistry(parseEnvironment(environment), { fetch: instances.fetch }),
    defaults,
    claims: state.claims,
    clock: state.clock,
  };
}

export interface MediaCall<TContent> {
  readonly result: CallToolResult;
  readonly content: TContent;
  readonly summary: string;
}

/** Calls one `media` tool exactly as the registered handler does. */
export async function callMediaTool<TContent = Record<string, unknown>>(
  name: MediaToolName,
  context: MediaContext,
  input: unknown,
): Promise<MediaCall<TContent>> {
  const definition = mediaToolDefinitions.find((candidate) => candidate.name === name);
  if (definition === undefined) {
    throw new Error(`No media tool is named ${name}`);
  }
  const result = await runMediaTool(definition, context, input);
  const text = result.content[0];
  return {
    result,
    content: result.structuredContent as TContent,
    summary: text?.type === "text" ? text.text : "",
  };
}

/**
 * The terms a `media` result or listing must not name, written out here
 * rather than derived from code: a list taken from the vocabulary it polices
 * would agree with it by construction.
 */
export const forbiddenWords: readonly string[] = [
  "sonarr",
  "radarr",
  "prowlarr",
  "application",
  "applications",
  "indexer",
  "indexers",
  "tag",
  "tags",
  "command",
  "commands",
  "plan",
  "plans",
  "opaque",
  "reference",
  "references",
  "qualityprofile",
  "rootfolder",
  "downloadclient",
];

export const forbiddenPhrases: readonly string[] = [
  "quality profile",
  "quality profiles",
  "root folder",
  "root folders",
  "download client",
  "download clients",
];

/**
 * Splits text into lowercase words, breaking on camelCase as well as on
 * anything that is not a letter or digit, so `rootFolderPath`,
 * `root_folder`, and `Root Folder` all yield `root` then `folder`.
 */
export function words(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .split(/[^A-Za-z0-9]+/u)
    .filter((word) => word !== "")
    .map((word) => word.toLowerCase());
}

/**
 * Every forbidden word or phrase the text names, case-insensitively.
 *
 * The stable error codes are removed first. They are the shared vocabulary
 * both toolsets branch on, which a `media` result carries by design, and the
 * one of them that spells an application concept is the code the Media
 * Toolset specification itself requires.
 */
export function forbiddenTermsIn(text: string): string[] {
  const withoutCodes = toolErrorCodes.reduce(
    (remaining, code) => remaining.replaceAll(code, " "),
    text,
  );
  return forbiddenTermsInText(withoutCodes);
}

/** The same scan, over text that carries no error code. */
export function forbiddenTermsInText(text: string): string[] {
  const found = words(text);
  const joined = ` ${found.join(" ")} `;
  return [
    ...forbiddenWords.filter((word) => found.includes(word)),
    ...forbiddenPhrases.filter((phrase) => joined.includes(` ${phrase} `)),
  ];
}

/** The quality identifier these bodies give each resolution's one quality. */
const qualityIds: Readonly<Record<number, number>> = { 480: 1, 576: 2, 720: 4, 1080: 3, 2160: 19 };

/**
 * A quality profile in the documented upstream shape, cut off at one
 * resolution and allowing the qualities named. The fixtures recorded at each
 * application's minimum carry their profiles with emptied `items`, so a test
 * that needs a profile to have a resolution, and a shape of its own choosing,
 * serves one of these instead.
 */
export function qualityProfileBody(
  id: number,
  name: string,
  cutoff: number,
  allowed: readonly number[] = [cutoff],
): Record<string, unknown> {
  return {
    id,
    name,
    upgradeAllowed: true,
    cutoff: qualityIds[cutoff] ?? cutoff,
    items: allowed.map((resolution) => ({
      quality: {
        id: qualityIds[resolution] ?? resolution,
        name: `Example ${resolution}`,
        source: "web",
        resolution,
      },
      items: [],
      allowed: true,
    })),
    minFormatScore: 0,
    cutoffFormatScore: 0,
    formatItems: [],
  };
}
