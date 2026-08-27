import { z } from "zod";
import type { UpstreamClient } from "../../http/client.js";
import { isUpstreamError, type UpstreamErrorKind } from "../../http/errors.js";
import type { Clock } from "../../state/clock.js";
import { type AdapterPage, type PageWindow, projectPage } from "../library/paging.js";
import {
  count,
  flag,
  parseUpstream,
  text,
  textList,
  upstreamFlag,
  upstreamId,
  upstreamNumber,
  upstreamText,
} from "../library/parse.js";
import type {
  IndexerOutcome,
  ReleaseCandidate,
  ReleaseIndexer,
  ReleaseSearchItem,
  SearchCompleteness,
} from "./model.js";
import { cacheIdentity, mapReleaseBase, releaseSchema, safeReason } from "./parse.js";
import type { ReleaseDetailLevel, ReleaseRequestFor } from "./requests.js";

/**
 * The Prowlarr aggregate release-search adapter.
 *
 * Prowlarr's search endpoint will happily query every configured indexer in one
 * request, but it answers with a flat release list and says nothing about the
 * indexers that failed — so a caller could not tell an exhaustive empty result
 * from one where the indexer holding the release never replied. This adapter
 * therefore asks each indexer separately. That is what makes the four outcome
 * states real rather than inferred: an indexer the instance had already
 * disabled is never asked, one whose own request runs out of time is
 * `timed_out`, and one that answers with a failure is `failed`, while the
 * indexers that did answer still return their releases.
 */

const application = "prowlarr" as const;

export const prowlarrRoutes = {
  search: "search",
  indexer: "indexer",
  indexerStatus: "indexerstatus",
} as const;

/**
 * How many indexers one search will query, and how many of those requests are
 * in flight at once.
 *
 * Both are hard bounds rather than hints: fanning out is what buys the
 * per-indexer outcome, and an unbounded fan-out would let one tool call issue
 * as many upstream requests as the instance has indexers. Reaching the ceiling
 * is reported as incompleteness and a warning, never as a silently narrower
 * search.
 */
export const maxSearchIndexers = 20;

export const searchConcurrency = 6;

const indexerSchema = z.object({ id: upstreamId, name: upstreamText, enable: upstreamFlag });

const indexerStatusSchema = z.object({ indexerId: upstreamId, disabledTill: upstreamText });

const prowlarrReleaseSchema = releaseSchema.extend({
  grabs: upstreamNumber,
  files: upstreamNumber,
  categories: z.array(z.object({ name: upstreamText })).nullish(),
});

type ProwlarrRelease = z.infer<typeof prowlarrReleaseSchema>;

type ProwlarrIndexer = z.infer<typeof indexerSchema>;

/**
 * A failure that is about the instance rather than about one indexer.
 *
 * A rejected API key or an unusable request path would fail identically for
 * every indexer, and reporting it twenty times as twenty indexer failures would
 * bury the one thing an operator has to fix. Those are rethrown so the search
 * fails as a whole; everything else stays the outcome of the indexer it
 * happened to.
 */
function isInstanceFailure(kind: UpstreamErrorKind): boolean {
  return kind === "authentication" || kind === "invalid-request";
}

function mapRelease(record: ProwlarrRelease, detail: ReleaseDetailLevel): ReleaseCandidate {
  return {
    ...mapReleaseBase(record, {
      detail,
      // Prowlarr holds no library, profile, or custom formats, so it reaches no
      // acceptance decision. Publishing an empty rejection list would read as
      // an approval nothing actually granted.
      decided: false,
      categories: textList((record.categories ?? []).map((category) => category.name)),
    }),
    application,
    prowlarr: { grabs: count(record.grabs), files: count(record.files) },
  };
}

function indexerOf(indexer: ProwlarrIndexer): ReleaseIndexer {
  return { id: indexer.id, name: text(indexer.name) };
}

/** Reads the configured indexers this search may query, newest identifier last. */
async function readIndexers(client: UpstreamClient): Promise<readonly ProwlarrIndexer[]> {
  const route = prowlarrRoutes.indexer;
  const body = await client.get(route);
  return parseUpstream(z.array(indexerSchema), body, application, route)
    .filter((indexer) => flag(indexer.enable) !== false)
    .sort((left, right) => left.id - right.id);
}

interface BlockedIndexers {
  /** When the instance stops holding an indexer down, keyed by indexer id. */
  readonly until: ReadonlyMap<number, string>;
  readonly warnings: readonly string[];
}

/**
 * Reads which indexers the instance itself has disabled after repeated
 * failures.
 *
 * A missing or failing status endpoint degrades the search rather than ending
 * it: without it the adapter simply asks a blocked indexer and reports whatever
 * that request does, which is a worse answer than "blocked" but a far better
 * one than no search at all.
 */
async function readBlockedIndexers(client: UpstreamClient, clock: Clock): Promise<BlockedIndexers> {
  const route = prowlarrRoutes.indexerStatus;
  let statuses: readonly z.infer<typeof indexerStatusSchema>[];
  try {
    statuses = parseUpstream(
      z.array(indexerStatusSchema),
      await client.get(route),
      application,
      route,
    );
  } catch {
    return {
      until: new Map(),
      warnings: [
        "the instance did not report indexer status, so a disabled indexer is reported by whatever its own request does",
      ],
    };
  }

  const now = clock.now();
  const until = new Map<number, string>();
  for (const status of statuses) {
    const till = Date.parse(text(status.disabledTill) ?? "");
    if (!Number.isNaN(till) && till > now) {
      // Re-rendered from the parsed instant rather than passed through, so the
      // reason cannot carry upstream text of any kind.
      until.set(status.indexerId, new Date(till).toISOString());
    }
  }
  return { until, warnings: [] };
}

interface IndexerSearch {
  readonly outcome: IndexerOutcome;
  readonly items: readonly ReleaseSearchItem[];
}

/** Asks one indexer, turning its own failure into that indexer's outcome. */
async function searchIndexer(
  client: UpstreamClient,
  indexer: ProwlarrIndexer,
  request: ReleaseRequestFor<"prowlarr_aggregate">,
  blockedUntil: string | undefined,
): Promise<IndexerSearch> {
  const identity = indexerOf(indexer);
  if (blockedUntil !== undefined) {
    return {
      outcome: {
        indexer: identity,
        state: "blocked",
        releases: 0,
        reason: `the instance has disabled this indexer until ${blockedUntil}`,
      },
      items: [],
    };
  }

  const route = prowlarrRoutes.search;
  let releases: readonly ProwlarrRelease[];
  try {
    const body = await client.get(route, {
      query: request.term,
      indexerIds: indexer.id,
      type: "search",
    });
    releases = parseUpstream(z.array(prowlarrReleaseSchema), body, application, route);
  } catch (error) {
    if (!isUpstreamError(error)) {
      throw error;
    }
    if (isInstanceFailure(error.kind)) {
      throw error;
    }
    return {
      outcome: {
        indexer: identity,
        state: error.kind === "timeout" ? "timed_out" : "failed",
        releases: 0,
        // The upstream boundary already built this message from typed
        // discriminants, so reusing it keeps one redaction boundary rather than
        // adding a second.
        reason: safeReason(error.message),
      },
      items: [],
    };
  }

  return {
    outcome: { indexer: identity, state: "succeeded", releases: releases.length },
    items: releases.map((record) => ({
      release: mapRelease(record, request.detail),
      identity: cacheIdentity(application, record),
    })),
  };
}

/**
 * Runs the fan-out in bounded batches so one search cannot flood an instance.
 *
 * A batch is settled in full before its first rejection is rethrown. An
 * instance-wide failure rejects every request in the batch at once, and
 * `Promise.all` would abandon the rest of them the moment it took the first —
 * leaving rejected promises nobody ever handled, which Node reports as an
 * unhandled rejection and can be configured to exit on.
 */
async function inBatches<TValue, TResult>(
  values: readonly TValue[],
  size: number,
  run: (value: TValue) => Promise<TResult>,
): Promise<TResult[]> {
  const results: TResult[] = [];
  for (let index = 0; index < values.length; index += size) {
    const settled = await Promise.allSettled(values.slice(index, index + size).map(run));
    for (const outcome of settled) {
      if (outcome.status === "rejected") {
        throw outcome.reason;
      }
      results.push(outcome.value);
    }
  }
  return results;
}

function compareText(left: string | undefined, right: string | undefined): number {
  const a = left ?? "";
  const b = right ?? "";
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

function publishedAtMs(item: ReleaseSearchItem): number {
  const published = item.release.publishedAt;
  if (published === undefined) {
    return Number.NEGATIVE_INFINITY;
  }
  const parsed = Date.parse(published);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

/**
 * Orders the merged result.
 *
 * Releases arrive per indexer, so the merged list needs an order of this
 * server's own choosing — otherwise a page boundary would depend on which
 * indexer happened to answer first, and paging would return overlapping or
 * skipped releases. Newest first is the useful order; the remaining keys exist
 * only to make it total, so the same upstream data always pages identically.
 */
function compareReleases(left: ReleaseSearchItem, right: ReleaseSearchItem): number {
  const leftPublished = publishedAtMs(left);
  const rightPublished = publishedAtMs(right);
  if (leftPublished !== rightPublished) {
    return rightPublished - leftPublished;
  }
  return (
    compareText(left.release.title, right.release.title) ||
    (left.identity.indexerId ?? 0) - (right.identity.indexerId ?? 0) ||
    compareText(left.identity.guid, right.identity.guid)
  );
}

export interface ProwlarrSearchPage extends AdapterPage<ReleaseSearchItem> {
  readonly completeness: SearchCompleteness;
}

/**
 * One aggregate search across the instance's enabled indexers.
 *
 * A partial result is the normal outcome, not an error: Prowlarr tolerates
 * individual indexer failures by design, so an indexer that failed is reported
 * beside the releases the others returned, and completeness says the result is
 * not exhaustive.
 */
export async function searchAggregate(
  client: UpstreamClient,
  window: PageWindow,
  request: ReleaseRequestFor<"prowlarr_aggregate">,
  clock: Clock,
): Promise<ProwlarrSearchPage> {
  const configured = await readIndexers(client);
  const queried = configured.slice(0, maxSearchIndexers);
  const warnings: string[] = [];
  if (configured.length > queried.length) {
    warnings.push(
      `only ${queried.length} of ${configured.length} enabled indexers were queried; the result is not exhaustive`,
    );
  }

  if (queried.length === 0) {
    warnings.push("the instance has no enabled indexer, so this search reached none");
  }

  const blocked =
    queried.length === 0
      ? { until: new Map<number, string>(), warnings: [] }
      : await readBlockedIndexers(client, clock);
  warnings.push(...blocked.warnings);

  const searches = await inBatches(queried, searchConcurrency, (indexer) =>
    searchIndexer(client, indexer, request, blocked.until.get(indexer.id)),
  );

  const outcomes = searches.map((search) => search.outcome);
  const succeeded = outcomes.filter((outcome) => outcome.state === "succeeded").length;
  if (succeeded < outcomes.length) {
    warnings.push(
      `${outcomes.length - succeeded} of ${outcomes.length} indexers did not answer; the result is not exhaustive`,
    );
  }

  const merged = searches.flatMap((search) => [...search.items]).sort(compareReleases);
  const page = projectPage({ source: merged, window, map: (item) => item });

  return {
    items: page.items,
    hasMore: page.hasMore,
    warnings: [...warnings, ...(page.warnings ?? [])],
    completeness: {
      complete: succeeded === outcomes.length && configured.length === queried.length,
      queried: outcomes.length,
      succeeded,
      indexers: outcomes,
    },
  };
}
