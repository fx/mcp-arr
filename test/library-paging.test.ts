import { describe, expect, it } from "vitest";
import {
  decodePageCursor,
  defaultScanLimit,
  encodePageCursor,
  pageNumberFor,
  projectPage,
  queryDigest,
  upstreamPage,
} from "../src/adapters/library/paging.js";
import { digestPartsFor, type LibraryQueryRequest } from "../src/adapters/library/requests.js";
import { paging } from "./support/library.js";

const identity = (value: number): number => value;

function series(count: number): readonly number[] {
  return Array.from({ length: count }, (_unused, index) => index);
}

describe("projectPage", () => {
  it("returns only the requested window and reports whether more follows", () => {
    const source = series(10);

    expect(projectPage({ source, window: { offset: 0, pageSize: 4 }, map: identity })).toEqual({
      items: [0, 1, 2, 3],
      hasMore: true,
    });
    expect(projectPage({ source, window: { offset: 8, pageSize: 4 }, map: identity })).toEqual({
      items: [8, 9],
      hasMore: false,
    });
    expect(projectPage({ source, window: { offset: 20, pageSize: 4 }, map: identity })).toEqual({
      items: [],
      hasMore: false,
    });
  });

  it("applies the window to matches rather than to raw records", () => {
    const page = projectPage({
      source: series(10),
      window: { offset: 2, pageSize: 2 },
      include: (value) => value % 2 === 0,
      map: identity,
    });

    expect(page).toEqual({ items: [4, 6], hasMore: true });
  });

  it("never maps a record outside the window", () => {
    const mapped: number[] = [];
    const page = projectPage({
      source: series(100),
      window: { offset: 0, pageSize: 3 },
      map: (value) => {
        mapped.push(value);
        return value;
      },
    });

    expect(page.items).toEqual([0, 1, 2]);
    expect(mapped).toEqual([0, 1, 2]);
  });

  it("stops at the scan bound and says so instead of claiming the list ended", () => {
    const bounded = projectPage({
      source: series(100),
      window: { offset: 0, pageSize: 5 },
      include: (value) => value >= 50,
      map: identity,
      scanLimit: 10,
    });

    expect(bounded).toEqual({
      items: [],
      hasMore: false,
      warnings: ["only the first 10 records were examined; narrow the query to see the rest"],
    });

    // The same bound applies by default, without a caller asking for one.
    const defaulted = projectPage({
      source: series(defaultScanLimit + 1),
      window: { offset: 0, pageSize: 5 },
      include: (value) => value > defaultScanLimit,
      map: identity,
    });
    expect(defaulted.items).toEqual([]);
    expect(defaulted.warnings?.[0]).toContain(String(defaultScanLimit));
  });
});

describe("upstreamPage", () => {
  it("uses the reported total to decide whether a further page exists", () => {
    expect(upstreamPage([1, 2], { offset: 0, pageSize: 2 }, 3)).toEqual({
      items: [1, 2],
      hasMore: true,
    });
    expect(upstreamPage([1, 2], { offset: 2, pageSize: 2 }, 4)).toEqual({
      items: [1, 2],
      hasMore: false,
    });
  });

  it("falls back to a full page meaning more when no total is reported", () => {
    expect(upstreamPage([1, 2], { offset: 0, pageSize: 2 }, undefined).hasMore).toBe(true);
    expect(upstreamPage([1], { offset: 0, pageSize: 2 }, undefined).hasMore).toBe(false);
  });

  it("maps an offset onto the 1-based page number the endpoint expects", () => {
    expect(pageNumberFor({ offset: 0, pageSize: 25 })).toBe(1);
    expect(pageNumberFor({ offset: 25, pageSize: 25 })).toBe(2);
    expect(pageNumberFor({ offset: 100, pageSize: 25 })).toBe(5);
  });
});

describe("page cursors", () => {
  const digest = queryDigest(["sonarr", "series", "summary", 25]);

  it("round-trips an offset for the query it was minted for", () => {
    const cursor = encodePageCursor(digest, 50);

    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(decodePageCursor(cursor, digest)).toEqual({ ok: true, offset: 50 });
  });

  it("refuses a cursor minted for a different query", () => {
    const other = queryDigest(["sonarr", "series", "full", 25]);

    expect(decodePageCursor(encodePageCursor(digest, 25), other)).toEqual({
      ok: false,
      reason: "mismatched",
    });
  });

  it("refuses a value this server never minted", () => {
    const malformed = [
      "not-base64url",
      Buffer.from("[]", "utf8").toString("base64url"),
      Buffer.from(JSON.stringify({ v: 2, q: digest, o: 0 }), "utf8").toString("base64url"),
      Buffer.from(JSON.stringify({ v: 1, q: digest, o: -1 }), "utf8").toString("base64url"),
      Buffer.from(JSON.stringify({ v: 1, q: digest, o: 1.5 }), "utf8").toString("base64url"),
      Buffer.from(JSON.stringify({ v: 1, o: 0 }), "utf8").toString("base64url"),
    ];

    for (const token of malformed) {
      expect(decodePageCursor(token, digest)).toEqual({ ok: false, reason: "malformed" });
    }
  });

  it("carries nothing but a version, a digest, and an offset", () => {
    const decoded = JSON.parse(
      Buffer.from(encodePageCursor(digest, 25), "base64url").toString("utf8"),
    );

    expect(Object.keys(decoded).sort()).toEqual(["o", "q", "v"]);
  });
});

describe("queryDigest", () => {
  it("distinguishes values that only look alike", () => {
    const digests = [
      queryDigest(["1"]),
      queryDigest([1]),
      queryDigest([true]),
      queryDigest(["true"]),
      queryDigest([undefined]),
      queryDigest(["undefined"]),
      queryDigest(["ab", "c"]),
      queryDigest(["a", "bc"]),
    ];

    expect(new Set(digests).size).toBe(digests.length);
  });

  it("is stable for the same query", () => {
    expect(queryDigest(["sonarr", "series", undefined, 25])).toBe(
      queryDigest(["sonarr", "series", undefined, 25]),
    );
  });

  it("does not depend on the order a caller named its identifier filter", () => {
    const ascending: LibraryQueryRequest = {
      view: "series",
      detail: "summary",
      ids: [12, 13, 14],
      paging: paging(25),
    };
    const descending: LibraryQueryRequest = {
      view: "series",
      detail: "summary",
      ids: [14, 12, 13],
      paging: paging(25),
    };

    expect(queryDigest(digestPartsFor("sonarr", ascending))).toBe(
      queryDigest(digestPartsFor("sonarr", descending)),
    );
    // A different filter still produces a different cursor identity.
    expect(queryDigest(digestPartsFor("sonarr", ascending))).not.toBe(
      queryDigest(
        digestPartsFor("sonarr", {
          view: "series",
          detail: "summary",
          ids: [12, 13],
          paging: paging(25),
        }),
      ),
    );
  });

  it("separates the same view asked of a different application", () => {
    const request: LibraryQueryRequest = {
      view: "calendar",
      detail: "summary",
      start: "2026-01-01",
      end: "2026-01-31",
      paging: paging(25),
    };

    expect(queryDigest(digestPartsFor("sonarr", request))).not.toBe(
      queryDigest(digestPartsFor("radarr", request)),
    );
  });
});
