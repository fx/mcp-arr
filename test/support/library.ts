import type {
  CalendarEvent,
  LookupResult,
  MediaFile,
  MediaItem,
  WantedItem,
} from "../../src/adapters/library/model.js";
import type { LibraryPaging } from "../../src/adapters/library/requests.js";
import type { LibraryViewData } from "../../src/adapters/library/service.js";
import { type ApplicationId, describeApplication } from "../../src/applications.js";
import { createUpstreamClient, type UpstreamClient } from "../../src/http/client.js";
import { type FixtureApplication, fixturePathFor, loadFixture } from "./fixtures.js";
import { fixtureRoot, testApiKeys } from "./tool-context.js";

export interface UpstreamCall {
  readonly url: URL;
  readonly init: RequestInit;
}

export interface LibraryHarness {
  readonly client: UpstreamClient;
  readonly calls: UpstreamCall[];
}

export interface HarnessOptions {
  /** Overrides the client's request timeout, for a test that has to trip it. */
  readonly timeoutMs?: number | undefined;
}

/**
 * Rejects once the client aborts the request it is watching.
 *
 * Real `fetch` rejects on abort, and the upstream client tells a timeout from
 * an unreachable instance by whether its own abort fired — so a stub that
 * ignored the signal could never produce a timeout at all. The promise stays
 * pending when nothing aborts, which is what lets it lose a race to a response.
 */
function abortRejection(signal: AbortSignal | null | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
}

/**
 * An adapter harness backed by the real upstream client, so a test exercises
 * the same path joining, query encoding, and error normalization the server
 * uses — only the network is replaced.
 */
export function libraryHarness(
  application: ApplicationId,
  respond: (call: UpstreamCall) => Response | Promise<Response>,
  options: HarnessOptions = {},
): LibraryHarness {
  const calls: UpstreamCall[] = [];
  const client = createUpstreamClient({
    application,
    baseUrl: `https://${application}.example.invalid`,
    apiBasePath: describeApplication(application).apiBasePath,
    apiKey: testApiKeys[application],
    timeoutMs: options.timeoutMs,
    fetch: async (url, init) => {
      const call = { url: new URL(url), init };
      calls.push(call);
      return await Promise.race([respond(call), abortRejection(init.signal)]);
    },
  });
  return { client, calls };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** The recorded response body for one application's route. */
export async function fixtureBody<TBody = unknown>(
  application: FixtureApplication,
  route: string,
): Promise<TBody> {
  const fixture = await loadFixture<TBody>(fixtureRoot, fixturePathFor(application, route));
  return fixture.body;
}

/**
 * A recorded payload with some properties removed, for the case an instance
 * simply does not report them.
 */
export function without(
  record: Record<string, unknown>,
  ...names: readonly string[]
): Record<string, unknown> {
  const copy = { ...record };
  for (const name of names) {
    delete copy[name];
  }
  return copy;
}

/**
 * The paging a request carries. The default matches the page size the
 * published tool schema applies when a caller omits one.
 */
export function paging(pageSize = 25, cursor?: string): LibraryPaging {
  return { pageSize, cursor };
}

/**
 * Narrows one view's payload to the item family it produces.
 *
 * The view union is discriminated, so each accessor is an exhaustive switch
 * rather than a cast: asking a wanted view for media items fails loudly instead
 * of silently typing the wrong thing.
 */
export function mediaItems(data: LibraryViewData): readonly MediaItem[] {
  switch (data.view) {
    case "series":
    case "seasons":
    case "episodes":
    case "movies":
    case "collections":
      return data.items;
    default:
      throw new Error(`Expected a media view, got ${data.view}`);
  }
}

export function mediaFiles(data: LibraryViewData): readonly MediaFile[] {
  switch (data.view) {
    case "episode_files":
    case "movie_files":
      return data.items;
    default:
      throw new Error(`Expected a media-file view, got ${data.view}`);
  }
}

export function wantedItems(data: LibraryViewData): readonly WantedItem[] {
  switch (data.view) {
    case "missing_episodes":
    case "cutoff_unmet_episodes":
    case "missing_movies":
    case "cutoff_unmet_movies":
      return data.items;
    default:
      throw new Error(`Expected a wanted view, got ${data.view}`);
  }
}

export function calendarEvents(data: LibraryViewData): readonly CalendarEvent[] {
  if (data.view !== "calendar") {
    throw new Error(`Expected the calendar view, got ${data.view}`);
  }
  return data.items;
}

export function lookupResults(data: LibraryViewData): readonly LookupResult[] {
  if (data.view !== "lookup") {
    throw new Error(`Expected the lookup view, got ${data.view}`);
  }
  return data.items;
}
