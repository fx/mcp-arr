import type { ApplicationId } from "../../applications.js";
import type { UpstreamClient } from "../../http/client.js";
import { type Clock, systemClock } from "../../state/clock.js";
import { createToolError, type ToolError, toolErrorForThrown } from "../../tools/errors.js";
import { type Continuation, maxPageSize } from "../../tools/schemas/common.js";
import {
  type AdapterPage,
  decodePageCursor,
  encodePageCursor,
  type PageWindow,
  queryDigest,
} from "../library/paging.js";
import type { ReleaseSearchItem, SearchCompleteness } from "./model.js";
import * as prowlarr from "./prowlarr.js";
import * as radarr from "./radarr.js";
import {
  digestPartsFor,
  type ReleaseSearchRequest,
  type ReleaseSearchTarget,
  releaseSearchApplications,
} from "./requests.js";
import * as sonarr from "./sonarr.js";

/**
 * The shared release-search service.
 *
 * It is the single entry point the tool layer will call once change 0005's
 * later tasks register the tool: it decides whether the selected application
 * models the requested target at all, owns the continuation cursor so no
 * adapter has to, and normalizes every adapter failure into the same
 * {@link ToolError} vocabulary the rest of the surface uses. The adapters below
 * it only map upstream payloads.
 */

export interface ReleaseSearchData {
  readonly target: ReleaseSearchTarget;
  readonly items: readonly ReleaseSearchItem[];
  /**
   * Present only for a target whose application can report which of its
   * indexers answered. Sonarr and Radarr run their own indexer fan-out inside a
   * single interactive search and report nothing about the ones that failed, so
   * claiming completeness for them would be an assertion this server cannot
   * make.
   */
  readonly completeness?: SearchCompleteness | undefined;
}

export type ReleaseSearchOutcome =
  | {
      readonly status: "ok";
      readonly data: ReleaseSearchData;
      readonly continuation: Continuation;
      readonly warnings: readonly string[];
    }
  | { readonly status: "error"; readonly error: ToolError };

interface TargetResult {
  readonly page: AdapterPage<ReleaseSearchItem>;
  readonly completeness?: SearchCompleteness | undefined;
}

function unsupported(application: ApplicationId, target: ReleaseSearchTarget): ToolError {
  return createToolError({
    code: "unsupported_capability",
    message: `${application}: the ${target} release search is not available on this application`,
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
 * Runs the search the request names.
 *
 * The switch is exhaustive over the closed target set, and support was already
 * checked by the caller, so each branch may assume the application in hand
 * models the target.
 */
async function runTarget(
  client: UpstreamClient,
  window: PageWindow,
  request: ReleaseSearchRequest,
  clock: Clock,
): Promise<TargetResult> {
  switch (request.target) {
    case "sonarr_episode":
      return { page: await sonarr.searchEpisode(client, window, request) };
    case "sonarr_season":
      return { page: await sonarr.searchSeason(client, window, request) };
    case "radarr_movie":
      return { page: await radarr.searchMovie(client, window, request) };
    case "prowlarr_aggregate": {
      const page = await prowlarr.searchAggregate(client, window, request, clock);
      return { page, completeness: page.completeness };
    }
  }
}

export interface ReleaseSearchOptions {
  /** Injected so a test can decide whether an indexer is still disabled. */
  readonly clock?: Clock | undefined;
}

/**
 * Answers one bounded release search.
 *
 * A target the selected application does not model — a Sonarr target asked of
 * Radarr, or a Prowlarr aggregate asked of either — is refused as an
 * unsupported capability before a request is sent, rather than being emulated
 * or answered with an empty page.
 */
export async function runReleaseSearch(
  application: ApplicationId,
  client: UpstreamClient,
  request: ReleaseSearchRequest,
  options: ReleaseSearchOptions = {},
): Promise<ReleaseSearchOutcome> {
  if (!releaseSearchApplications[request.target].includes(application)) {
    return { status: "error", error: unsupported(application, request.target) };
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
            ? "that continuation belongs to a different search; repeat the first page with this target"
            : "that continuation was not issued by this server",
        ),
      };
    }
    offset = decoded.offset;
  }

  const window: PageWindow = { offset, pageSize };
  let result: TargetResult;
  try {
    result = await runTarget(client, window, request, options.clock ?? systemClock);
  } catch (error) {
    return { status: "error", error: toolErrorForThrown(error, application) };
  }

  // The next window advances by a whole page rather than by however many
  // records came back, for the same reason the library service does: an
  // adapter-side projection only reports more when it filled the page exactly.
  const continuation: Continuation = {
    pageSize,
    returned: result.page.items.length,
    hasMore: result.page.hasMore,
    ...(result.page.hasMore ? { cursor: encodePageCursor(digest, offset + pageSize) } : {}),
  };

  return {
    status: "ok",
    data: {
      target: request.target,
      items: result.page.items,
      completeness: result.completeness,
    },
    continuation,
    warnings: [...(result.page.warnings ?? [])],
  };
}
