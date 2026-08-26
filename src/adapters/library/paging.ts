import { createHash } from "node:crypto";

/**
 * The ceiling on how many upstream records one adapter-side projection will
 * examine.
 *
 * Several library endpoints have no server-side paging, so the adapter receives
 * whatever the instance sends. What it must never do is materialize all of it:
 * projection stops at this many records, which keeps one query's cost bounded
 * regardless of library size. Reaching the bound is reported as a warning
 * rather than silently truncating.
 */
export const defaultScanLimit = 5_000;

export interface PageWindow {
  /** How many matching records to skip; always a multiple of `pageSize`. */
  readonly offset: number;
  readonly pageSize: number;
}

/** The 1-based page number a window maps onto for an upstream-paged endpoint. */
export function pageNumberFor(window: PageWindow): number {
  return Math.floor(window.offset / window.pageSize) + 1;
}

/**
 * One bounded page produced by an adapter.
 *
 * `hasMore` is the adapter's own answer, because only the adapter knows whether
 * it stopped at a page boundary or ran out of records; the service turns it
 * into the caller-visible continuation.
 */
export interface AdapterPage<TItem> {
  readonly items: readonly TItem[];
  readonly hasMore: boolean;
  readonly warnings?: readonly string[] | undefined;
}

/**
 * A digest of the query a cursor belongs to.
 *
 * The parts are supplied as an already-ordered tuple built by the caller in a
 * fixed, code-authored order, and any set-valued part is sorted before it gets
 * here. Nothing about the digest depends on the order a caller happened to
 * write its filters in, so the same query always digests to the same value and
 * two different queries cannot share a cursor.
 */
export function queryDigest(parts: readonly (string | number | boolean | undefined)[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    // Typed and terminated so neighbouring parts cannot run together: the
    // string "1" and the number 1 are different filters, and so are the pairs
    // ("ab", "c") and ("a", "bc"). The separator is written as an escape rather
    // than embedded, since a raw NUL is invisible in an editor and tooling can
    // strip it, which would silently let two different queries digest alike.
    hash.update(part === undefined ? "undefined" : `${typeof part}:${String(part)}`);
    hash.update("\u0000");
  }
  return hash.digest("hex").slice(0, 32);
}

interface CursorPayload {
  readonly v: 1;
  /** The digest of the query this cursor was minted for. */
  readonly q: string;
  readonly o: number;
}

/**
 * Mints a continuation cursor.
 *
 * The token is base64url, which is what the published cursor schema accepts,
 * and carries nothing but a version tag, the query digest, and an offset — no
 * upstream URL, credential, path, or identifier.
 */
export function encodePageCursor(digest: string, offset: number): string {
  const payload: CursorPayload = { v: 1, q: digest, o: offset };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export type CursorDecoding =
  | { readonly ok: true; readonly offset: number }
  | { readonly ok: false; readonly reason: "malformed" | "mismatched" };

/**
 * Reads a continuation cursor back, refusing one minted for a different query.
 *
 * Paging a cursor into a query whose filters changed would silently return a
 * window of the wrong result set, so the digest mismatch is reported rather
 * than tolerated.
 */
export function decodePageCursor(token: string, digest: string): CursorDecoding {
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }

  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { ok: false, reason: "malformed" };
  }
  const record = payload as Record<string, unknown>;
  const offset = record.o;
  if (
    record.v !== 1 ||
    typeof record.q !== "string" ||
    typeof offset !== "number" ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  ) {
    return { ok: false, reason: "malformed" };
  }
  if (record.q !== digest) {
    return { ok: false, reason: "mismatched" };
  }
  return { ok: true, offset };
}

export interface ProjectionInput<TSource, TItem> {
  readonly source: readonly TSource[];
  readonly window: PageWindow;
  /** Adapter-side filtering, for endpoints the instance cannot filter itself. */
  readonly include?: ((value: TSource) => boolean) | undefined;
  readonly map: (value: TSource) => TItem;
  readonly scanLimit?: number | undefined;
}

/**
 * Projects one bounded page out of an unpaged upstream collection.
 *
 * The projection stops as soon as it has filled the page and seen one further
 * match, so it neither maps nor retains records beyond the window.
 *
 * The scan limit is a hard cap, not a hint. Once it is reached the page ends
 * there and reports `hasMore: false`, because continuing would hand back a
 * cursor that re-scans from the start and stops at the same place — a page that
 * never advances. The truncation is stated as a warning instead, so a caller
 * learns that records beyond the cap exist and that narrowing the query, rather
 * than paging further, is what reaches them.
 *
 * A page that fills is always exactly `pageSize` long, which is what lets the
 * service advance a cursor by whole pages.
 */
export function projectPage<TSource, TItem>(
  input: ProjectionInput<TSource, TItem>,
): AdapterPage<TItem> {
  const scanLimit = input.scanLimit ?? defaultScanLimit;
  const { offset, pageSize } = input.window;
  const items: TItem[] = [];
  let matched = 0;
  let scanned = 0;
  let hasMore = false;
  let truncated = false;

  for (const value of input.source) {
    if (scanned >= scanLimit) {
      truncated = true;
      break;
    }
    scanned += 1;
    if (input.include !== undefined && !input.include(value)) {
      continue;
    }

    const position = matched;
    matched += 1;
    if (position < offset) {
      continue;
    }
    if (items.length < pageSize) {
      items.push(input.map(value));
      continue;
    }
    hasMore = true;
    break;
  }

  return {
    items,
    hasMore,
    ...(truncated
      ? {
          warnings: [
            `only the first ${scanLimit} records were examined; narrow the query to see the rest`,
          ],
        }
      : {}),
  };
}

/**
 * Wraps the records of an upstream-paged endpoint.
 *
 * The instance already applied the window, so nothing is sliced here; the total
 * it reported is what decides whether a further page exists. A missing total is
 * treated as "a full page means there may be more", which is the only honest
 * answer available without one.
 */
export function upstreamPage<TItem>(
  items: readonly TItem[],
  window: PageWindow,
  totalRecords: number | undefined,
): AdapterPage<TItem> {
  return {
    items,
    hasMore:
      totalRecords === undefined
        ? items.length === window.pageSize
        : window.offset + items.length < totalRecords,
  };
}
