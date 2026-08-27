import type { ApplicationId } from "../../applications.js";
import type { UpstreamClient } from "../../http/client.js";
import { createToolError, type ToolError, toolErrorForThrown } from "../../tools/errors.js";
import { type Continuation, maxPageSize } from "../../tools/schemas/common.js";
import { isMediaApplication } from "../library/model.js";
import {
  type AdapterPage,
  decodePageCursor,
  encodePageCursor,
  type PageWindow,
  queryDigest,
} from "../library/paging.js";
import * as media from "./media.js";
import type {
  BlocklistRecord,
  CommandActivity,
  DiskCondition,
  HealthCheck,
  HistoryRecord,
  QueueItem,
  QueueSummary,
} from "./model.js";
import * as prowlarr from "./prowlarr.js";
import {
  type ActivityQueryRequest,
  type ActivityView,
  activityViewApplications,
  digestPartsFor,
} from "./requests.js";
import { readCommands, readHealth } from "./shared.js";

/**
 * The shared activity service.
 *
 * It is the single entry point the tool layer will call, and it plays the same
 * role the library service does: it decides whether the selected application
 * models the requested view at all, owns the continuation cursor so no adapter
 * has to, and normalizes every adapter failure into the same {@link ToolError}
 * vocabulary the rest of the surface uses. The adapters below it only map
 * upstream payloads.
 *
 * Every operation reachable from here is a read. Nothing in this module or
 * beneath it sends anything but a GET, so a diagnostic query cannot change
 * upstream state.
 */

/**
 * What one view answers with.
 *
 * Most views answer with a bounded page, but two do not, and saying so in the
 * type is what keeps a caller from having to guess: the queue's counters are a
 * single summary object, and a focused queue read is exactly one row.
 */
export type ActivityViewData =
  | { readonly view: "queue_status"; readonly summary: QueueSummary }
  | { readonly view: "queue"; readonly items: readonly QueueItem[] }
  | { readonly view: "queue_details"; readonly item: QueueItem }
  | { readonly view: "history"; readonly items: readonly HistoryRecord[] }
  | { readonly view: "blocklist"; readonly items: readonly BlocklistRecord[] }
  | { readonly view: "health"; readonly items: readonly HealthCheck[] }
  | { readonly view: "commands"; readonly items: readonly CommandActivity[] }
  | { readonly view: "disk_space"; readonly items: readonly DiskCondition[] };

export type ActivityQueryOutcome =
  | {
      readonly status: "ok";
      readonly data: ActivityViewData;
      readonly continuation: Continuation;
      readonly warnings: readonly string[];
    }
  | { readonly status: "error"; readonly error: ToolError };

interface ViewResult {
  readonly data: ActivityViewData;
  readonly returned: number;
  readonly hasMore: boolean;
  readonly warnings?: readonly string[] | undefined;
}

/** Pairs one view's mapped payload with the paging answer its adapter gave. */
function pageResult(data: ActivityViewData, page: AdapterPage<unknown>): ViewResult {
  return {
    data,
    returned: page.items.length,
    hasMore: page.hasMore,
    warnings: page.warnings,
  };
}

/**
 * The answer for a view that is a single object rather than a page.
 *
 * It still carries a continuation, because the published result shape has one
 * for every query; it simply says that one record came back and no more follow.
 */
function singleResult(data: ActivityViewData): ViewResult {
  return { data, returned: 1, hasMore: false };
}

function unsupported(application: ApplicationId, view: ActivityView): ToolError {
  return createToolError({
    code: "unsupported_capability",
    message: `${application}: the ${view} activity view is not available on this application`,
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
 * The media profile for a view only the two media applications declare.
 *
 * Reaching this with Prowlarr in hand would mean the support table and the view
 * union disagree, which is a defect in this file rather than anything a caller
 * did — so it throws, and the caller reports it as an unexpected response with
 * a static message. It is deliberately not folded into the `undefined` a
 * queue-detail read returns: that value means one specific thing, and giving it
 * a second meaning would report a broken invariant as a stale reference.
 */
function requireProfile(application: ApplicationId, view: ActivityView): media.MediaProfile {
  if (!isMediaApplication(application)) {
    throw new Error(`the ${view} activity view reached a non-media application`);
  }
  return media.profileFor(application);
}

/**
 * Runs the view the request names.
 *
 * The switch is exhaustive over the closed view set, and support was already
 * checked by the caller, so each branch may assume the application in hand
 * models the view. `undefined` means one thing only: the focused queue read
 * found no such row, which the caller turns into a stale reference rather than
 * an empty result.
 */
async function runView(
  application: ApplicationId,
  client: UpstreamClient,
  window: PageWindow,
  request: ActivityQueryRequest,
): Promise<ViewResult | undefined> {
  switch (request.view) {
    case "queue_status": {
      const profile = requireProfile(application, request.view);
      return singleResult({
        view: request.view,
        summary: await media.readQueueStatus(client, profile),
      });
    }
    case "queue": {
      const profile = requireProfile(application, request.view);
      const page = await media.readQueue(client, window, request, profile);
      return pageResult({ view: request.view, items: page.items }, page);
    }
    case "queue_details": {
      const profile = requireProfile(application, request.view);
      const item = await media.readQueueDetails(client, request, profile);
      return item === undefined ? undefined : singleResult({ view: request.view, item });
    }
    case "history": {
      const page = isMediaApplication(application)
        ? await media.readMediaHistory(client, window, request, media.profileFor(application))
        : await prowlarr.readProwlarrHistory(client, window, request);
      return pageResult({ view: request.view, items: page.items }, page);
    }
    case "blocklist": {
      const profile = requireProfile(application, request.view);
      const page = await media.readBlocklist(client, window, request, profile);
      return pageResult({ view: request.view, items: page.items }, page);
    }
    case "health": {
      const page = await readHealth(client, window, application);
      return pageResult({ view: request.view, items: page.items }, page);
    }
    case "commands": {
      const page = await readCommands(client, window, application);
      return pageResult({ view: request.view, items: page.items }, page);
    }
    case "disk_space": {
      const profile = requireProfile(application, request.view);
      const page = await media.readDiskSpace(client, window, profile);
      return pageResult({ view: request.view, items: page.items }, page);
    }
  }
}

/**
 * Answers one bounded activity query.
 *
 * A view the selected application does not model — a queue or a blocklist asked
 * of Prowlarr — is refused as an unsupported capability before a request is
 * sent, rather than being emulated or answered with an empty page.
 */
export async function runActivityQuery(
  application: ApplicationId,
  client: UpstreamClient,
  request: ActivityQueryRequest,
): Promise<ActivityQueryOutcome> {
  if (!activityViewApplications[request.view].includes(application)) {
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
  let result: ViewResult | undefined;
  try {
    result = await runView(application, client, window, request);
  } catch (error) {
    return { status: "error", error: toolErrorForThrown(error, application) };
  }

  if (result === undefined) {
    // Only the focused queue read produces this: the queue is volatile, and a
    // row that finished or was removed between the query that produced the
    // reference and this read is stale rather than missing.
    return {
      status: "error",
      error: createToolError({
        code: "stale_reference",
        message: `${application}: that queue item is no longer in the queue`,
        application,
      }),
    };
  }

  // The next window advances by a whole page, never by however many records
  // came back, for the same reason the library service does it: an
  // upstream-paged endpoint maps the offset back onto a 1-based page number, so
  // an unaligned offset would floor back onto the page just read and the caller
  // would page in circles. Activity pages are short more often than library
  // ones, because several of these endpoints cannot apply a filter themselves.
  const continuation: Continuation = {
    pageSize,
    returned: result.returned,
    hasMore: result.hasMore,
    ...(result.hasMore ? { cursor: encodePageCursor(digest, offset + pageSize) } : {}),
  };

  return {
    status: "ok",
    data: result.data,
    continuation,
    warnings: [...(result.warnings ?? [])],
  };
}
