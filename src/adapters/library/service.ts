import type { ApplicationId } from "../../applications.js";
import type { UpstreamClient } from "../../http/client.js";
import { createToolError, type ToolError, toolErrorForThrown } from "../../tools/errors.js";
import { type Continuation, maxPageSize } from "../../tools/schemas/common.js";
import {
  type CalendarEvent,
  isMediaApplication,
  type LookupResult,
  type MediaApplication,
  type MediaFile,
  type MediaItem,
  type WantedItem,
} from "./model.js";
import {
  type AdapterPage,
  decodePageCursor,
  encodePageCursor,
  type PageWindow,
  queryDigest,
} from "./paging.js";
import * as radarr from "./radarr.js";
import {
  digestPartsFor,
  type LibraryQueryRequest,
  type LibraryView,
  libraryViewApplications,
} from "./requests.js";
import * as sonarr from "./sonarr.js";

/**
 * The shared library service.
 *
 * It is the single entry point the tool layer will call: it decides whether the
 * selected application models the requested view at all, owns the continuation
 * cursor so no adapter has to, and normalizes every adapter failure into the
 * same {@link ToolError} vocabulary the rest of the surface uses. The adapters
 * below it only map upstream payloads.
 */

/**
 * What one view answers with.
 *
 * Each view is its own member, discriminated by the view name, so a consumer
 * that knows which view it asked for also knows what it is holding — a Sonarr
 * episode page and a Radarr movie-file page never have to be told apart by
 * inspecting an item.
 */
export type LibraryViewData =
  | { readonly view: "series"; readonly items: readonly MediaItem[] }
  | { readonly view: "seasons"; readonly items: readonly MediaItem[] }
  | { readonly view: "episodes"; readonly items: readonly MediaItem[] }
  | { readonly view: "movies"; readonly items: readonly MediaItem[] }
  | { readonly view: "collections"; readonly items: readonly MediaItem[] }
  | { readonly view: "episode_files"; readonly items: readonly MediaFile[] }
  | { readonly view: "movie_files"; readonly items: readonly MediaFile[] }
  | { readonly view: "missing_episodes"; readonly items: readonly WantedItem[] }
  | { readonly view: "cutoff_unmet_episodes"; readonly items: readonly WantedItem[] }
  | { readonly view: "missing_movies"; readonly items: readonly WantedItem[] }
  | { readonly view: "cutoff_unmet_movies"; readonly items: readonly WantedItem[] }
  | { readonly view: "calendar"; readonly items: readonly CalendarEvent[] }
  | { readonly view: "lookup"; readonly items: readonly LookupResult[] };

/**
 * The outcome shape the operation runtime already understands: an `ok` carrying
 * data plus continuation metadata, or a normalized error. Registering the view
 * as an operation handler is therefore a mapping from validated tool input to a
 * {@link LibraryQueryRequest}, and nothing more.
 */
export type LibraryQueryOutcome =
  | {
      readonly status: "ok";
      readonly data: LibraryViewData;
      readonly continuation: Continuation;
      readonly warnings: readonly string[];
    }
  | { readonly status: "error"; readonly error: ToolError };

interface ViewResult {
  readonly data: LibraryViewData;
  readonly hasMore: boolean;
  readonly warnings?: readonly string[] | undefined;
}

/** Pairs one view's mapped payload with the paging answer its adapter gave. */
function viewResult(data: LibraryViewData, page: AdapterPage<unknown>): ViewResult {
  return { data, hasMore: page.hasMore, warnings: page.warnings };
}

function unsupported(application: ApplicationId, view: LibraryView): ToolError {
  return createToolError({
    code: "unsupported_capability",
    message: `${application}: the ${view} library view is not available on this application`,
    application,
  });
}

function invalid(application: ApplicationId, message: string): ToolError {
  return createToolError({
    code: "invalid_input",
    message: `${application}: ${message}`,
    application,
  });
}

/**
 * Runs the view the request names.
 *
 * The switch is exhaustive over the closed view set, and support was already
 * checked by the caller, so each branch may assume the application in hand
 * models the view; only the two cross-application views still have to choose.
 */
async function runView(
  application: MediaApplication,
  client: UpstreamClient,
  window: PageWindow,
  request: LibraryQueryRequest,
): Promise<ViewResult> {
  switch (request.view) {
    case "series": {
      const page = await sonarr.listSeries(client, window, request);
      return viewResult({ view: request.view, items: page.items }, page);
    }
    case "seasons": {
      const page = await sonarr.listSeasons(client, window, request);
      return viewResult({ view: request.view, items: page.items }, page);
    }
    case "episodes": {
      const page = await sonarr.listEpisodes(client, window, request);
      return viewResult({ view: request.view, items: page.items }, page);
    }
    case "episode_files": {
      const page = await sonarr.listEpisodeFiles(client, window, request);
      return viewResult({ view: request.view, items: page.items }, page);
    }
    case "missing_episodes":
    case "cutoff_unmet_episodes": {
      const page = await sonarr.listWantedEpisodes(client, window, request);
      return viewResult({ view: request.view, items: page.items }, page);
    }
    case "movies": {
      const page = await radarr.listMovies(client, window, request);
      return viewResult({ view: request.view, items: page.items }, page);
    }
    case "collections": {
      const page = await radarr.listCollections(client, window, request);
      return viewResult({ view: request.view, items: page.items }, page);
    }
    case "movie_files": {
      const page = await radarr.listMovieFiles(client, window, request);
      return viewResult({ view: request.view, items: page.items }, page);
    }
    case "missing_movies":
    case "cutoff_unmet_movies": {
      const page = await radarr.listWantedMovies(client, window, request);
      return viewResult({ view: request.view, items: page.items }, page);
    }
    case "calendar": {
      const page =
        application === "sonarr"
          ? await sonarr.listCalendar(client, window, request)
          : await radarr.listCalendar(client, window, request);
      return viewResult({ view: request.view, items: page.items }, page);
    }
    case "lookup": {
      const page =
        application === "sonarr"
          ? await sonarr.lookupSeries(client, window, request)
          : await radarr.lookupMovies(client, window, request);
      return viewResult({ view: request.view, items: page.items }, page);
    }
  }
}

/**
 * Answers one bounded library query.
 *
 * A view the selected application does not model — a Sonarr view asked of
 * Radarr, or any view asked of Prowlarr, which has no library at all — is
 * refused as an unsupported capability before a request is sent, rather than
 * being emulated or answered with an empty page.
 */
export async function runLibraryQuery(
  application: ApplicationId,
  client: UpstreamClient,
  request: LibraryQueryRequest,
): Promise<LibraryQueryOutcome> {
  if (!isMediaApplication(application)) {
    return { status: "error", error: unsupported(application, request.view) };
  }
  if (!libraryViewApplications[request.view].includes(application)) {
    return { status: "error", error: unsupported(application, request.view) };
  }

  const pageSize = request.paging.pageSize;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > maxPageSize) {
    return {
      status: "error",
      error: invalid(application, `page size must be between 1 and ${maxPageSize}`),
    };
  }

  const digest = queryDigest(digestPartsFor(application, request));
  let offset = 0;
  if (request.paging.cursor !== undefined) {
    const decoded = decodePageCursor(request.paging.cursor, digest);
    if (!decoded.ok) {
      return {
        status: "error",
        error: invalid(
          application,
          decoded.reason === "mismatched"
            ? "that continuation belongs to a different query; repeat the first page with these filters"
            : "that continuation was not issued by this server",
        ),
      };
    }
    offset = decoded.offset;
  }

  const window: PageWindow = { offset, pageSize };
  let result: ViewResult;
  try {
    result = await runView(application, client, window, request);
  } catch (error) {
    return { status: "error", error: toolErrorForThrown(error, application) };
  }

  const returned = result.data.items.length;
  const continuation: Continuation = {
    pageSize,
    returned,
    hasMore: result.hasMore,
    ...(result.hasMore ? { cursor: encodePageCursor(digest, offset + returned) } : {}),
  };

  return {
    status: "ok",
    data: result.data,
    continuation,
    warnings: [...(result.warnings ?? [])],
  };
}
