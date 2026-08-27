import { describe, expect, it } from "vitest";
import type { BlocklistRecord, HistoryRecord, QueueItem } from "../src/adapters/activity/model.js";
import { createManualClock } from "../src/state/clock.js";
import { createReferenceStore, type ReferenceStore } from "../src/state/references.js";
import {
  mintBlocklistReference,
  mintHistoryReference,
  mintQueueReference,
  resolveBlocklistReference,
  resolveHistoryReference,
  resolveQueueReference,
} from "../src/tools/activity-references.js";

/**
 * The values a reference must never carry back out. They are the two the
 * readers already refuse to map, planted here so a reference that reintroduced
 * either at the last step would be caught rather than assumed away.
 */
const canary = "CANARY-SECRET-42";

function storeAt(now = 1_000, lifetimeId?: string) {
  const clock = createManualClock(now);
  const store = createReferenceStore({
    clock,
    ...(lifetimeId === undefined ? {} : { lifetimeId }),
  });
  return { store, advance: (ms: number) => clock.advance(ms) };
}

/**
 * The exact shape every minted token has: a kind prefix, the store's lifetime
 * segment, and a fixed-length random tail.
 */
const tokenShape = /^([a-z]+)_([A-Za-z0-9_-]{8})([A-Za-z0-9_-]{22})$/u;

interface TokenParts {
  readonly prefix: string;
  readonly lifetime: string;
  readonly tail: string;
}

/**
 * Splits a token into the three parts the minting code builds it from.
 *
 * The opacity tests below are written in terms of these parts rather than as
 * substring searches, because a substring search shows nothing either way: a
 * short one appears in a random tail by coincidence often enough to fail a run
 * at random, and its absence would not have established that the token carries
 * nothing about its record. What the parts establish is where a record could
 * possibly appear — and that only the tail varies, that it varies when the
 * record does not, and that it is the same length whatever the record is.
 */
function tokenParts(store: ReferenceStore, token: string): TokenParts {
  const [, prefix, lifetime, tail] = tokenShape.exec(token) ?? [];
  if (prefix === undefined || lifetime === undefined || tail === undefined) {
    throw new Error(`Not a token this server mints: ${token}`);
  }
  // The lifetime segment belongs to the store, not to the record: the same
  // eight characters lead every token this store mints, whatever it names.
  expect(lifetime).toBe(store.lifetimeId);
  return { prefix, lifetime, tail };
}

function trackedItem(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    application: "sonarr",
    kind: "tracked_download",
    context: {
      application: "sonarr",
      kind: "tracked_download",
      queueItemId: 502,
      mediaId: 12,
    },
    title: "Example Series S01E01 Bluray-1080p",
    media: { application: "sonarr", kind: "series", id: "12" },
    evidence: {
      status: "completed",
      trackedStatus: "warning",
      trackedState: "import_blocked",
      statusMessages: [{ title: "Example", messages: ["import blocked"] }],
    },
    origin: {
      protocol: "torrent",
      downloadClient: "Example Client",
      // A salted digest, not the client's identifier — but planted with the
      // canary anyway, because the assertion is that nothing from `origin`
      // reaches a reference at all.
      downloadIdentity: `${canary}-digest`,
    },
    ...overrides,
  };
}

function pendingItem(): QueueItem {
  return trackedItem({
    kind: "pending_release",
    context: {
      application: "sonarr",
      kind: "pending_release",
      queueItemId: 503,
      mediaId: 13,
    },
    evidence: { status: "delay", statusMessages: [] },
    origin: undefined,
  });
}

function historyRecord(): HistoryRecord {
  return {
    application: "prowlarr",
    context: { application: "prowlarr", historyRecordId: 9001 },
    eventType: "grabbed",
    date: "2026-08-27T09:39:00Z",
  };
}

function blocklistRecord(): BlocklistRecord {
  return {
    application: "radarr",
    context: { application: "radarr", blocklistRecordId: 7101 },
    title: "Example Movie 2021 Bluray-1080p",
    date: "2026-08-20T12:00:05Z",
  };
}

function queueOf(store: ReferenceStore, item = trackedItem()) {
  const reference = mintQueueReference(store, item);
  const resolved = resolveQueueReference(store, reference, "sonarr");
  if (!resolved.ok) {
    throw new Error(`Expected the queue reference to resolve: ${resolved.error.message}`);
  }
  return { reference, context: resolved.value };
}

describe("activity references are opaque", () => {
  it("mints a token that is a kind, this process's lifetime, and randomness", () => {
    const { store } = storeAt();
    const { reference } = queueOf(store);
    const parts = tokenParts(store, reference);

    // The published cursor and reference schemas both accept only this
    // alphabet, and the prefix is the only part that means anything.
    expect(parts.prefix).toBe("que");
    // Nothing is left over. The token is exactly those three parts, so there is
    // nowhere in it for anything the record carries to be.
    expect(reference).toBe(`que_${store.lifetimeId}${parts.tail}`);
    // The one substring check worth keeping: a long planted value could only
    // appear by leaking, unlike a two-character one that a random tail produces
    // by coincidence.
    expect(reference).not.toContain(canary);
  });

  it("shapes a token the same however large the record it names", () => {
    const { store } = storeAt();
    const small = mintQueueReference(
      store,
      trackedItem({
        context: { application: "sonarr", kind: "tracked_download", queueItemId: 1 },
        title: "S",
        origin: undefined,
      }),
    );
    const large = mintQueueReference(
      store,
      trackedItem({
        context: {
          application: "sonarr",
          kind: "tracked_download",
          queueItemId: Number.MAX_SAFE_INTEGER,
          mediaId: 999_999,
        },
        title: `${canary} `.repeat(200),
      }),
    );

    // A token derived in any part from its record could not be the same length
    // for a one-character title and a two-thousand-character one.
    expect(large.length).toBe(small.length);
    const first = tokenParts(store, small);
    const second = tokenParts(store, large);
    expect(second.prefix).toBe(first.prefix);
    expect(second.tail).not.toBe(first.tail);
    expect(large).not.toContain(canary);
  });

  it("mints a different token for the same record every time", () => {
    const { store } = storeAt();
    const item = trackedItem();
    const tails = Array.from(
      { length: 128 },
      () => tokenParts(store, mintQueueReference(store, item)).tail,
    );

    // Nothing about the record determines the token: a hundred and twenty-eight
    // references to one row are a hundred and twenty-eight different tokens, so
    // the tail cannot be a function of what it names and two references to one
    // row cannot be recognized as the same row by comparing them.
    expect(new Set(tails).size).toBe(tails.length);
    // And another row's token is not distinguishable from any of them.
    const other = tokenParts(store, mintQueueReference(store, pendingItem()));
    expect(tails).not.toContain(other.tail);
    expect(new Set(tails.map((tail) => tail.length))).toEqual(new Set([other.tail.length]));
  });

  it("names its record only through the store that minted it", () => {
    const { store } = storeAt();
    const { reference } = queueOf(store);

    // A second store sharing this one's lifetime segment accepts the token as
    // well formed and current, and still cannot say what it names: everything
    // about the record is held by the store that minted it, and none of it
    // travels in the token. That is what makes the token opaque — not that some
    // substring happens to be missing from it.
    const sibling = storeAt(1_000, store.lifetimeId).store;
    expect(sibling.resolve(reference, "queue")).toEqual({
      ok: false,
      reason: "unknown",
      kind: "queue",
    });
    expect(resolveQueueReference(sibling, reference, "sonarr").ok).toBe(false);
  });

  it("keeps the download digest and every unmapped field out of what it retains", () => {
    const { store } = storeAt();
    const { reference, context } = queueOf(store);

    expect(JSON.stringify(context)).not.toContain(canary);
    // The whole stored entry, not just what the resolver chose to return.
    const entry = store.resolve(reference, "queue");
    expect(entry.ok).toBe(true);
    expect(JSON.stringify(entry)).not.toContain(canary);
  });

  it("refuses a forged token, one from another process, and an expired one", () => {
    const { store, advance } = storeAt();
    const { reference } = queueOf(store);

    expect(resolveQueueReference(store, "que_forgedtoken", "sonarr")).toMatchObject({
      ok: false,
      error: { code: "stale_reference" },
    });
    // A reference minted by a previous process lifetime is refused with its own
    // message, not merely reported as unknown.
    const other = storeAt(1_000, "aaaaaaaa");
    const foreign = mintQueueReference(other.store, trackedItem());
    const rejected = resolveQueueReference(store, foreign, "sonarr");
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.message).toContain("before this server process started");
    }

    advance(6 * 60_000);
    expect(resolveQueueReference(store, reference, "sonarr")).toMatchObject({ ok: false });
  });

  it("refuses a reference bound to another application or another kind", () => {
    const { store } = storeAt();
    const { reference } = queueOf(store);

    const wrongApplication = resolveQueueReference(store, reference, "radarr");
    expect(wrongApplication.ok).toBe(false);
    if (!wrongApplication.ok) {
      expect(wrongApplication.error.code).toBe("invalid_input");
      expect(wrongApplication.error.message).toContain("different application");
    }

    // A history reference is not a queue reference, and the prefix says so
    // before anything is looked up.
    const history = mintHistoryReference(store, historyRecord());
    expect(resolveQueueReference(store, history, "sonarr")).toMatchObject({
      ok: false,
      error: { code: "stale_reference" },
    });
  });
});

describe("activity references retain what a transition needs", () => {
  it("retains the item kind, status, tracked state, and media association", () => {
    const { store } = storeAt();
    const { context } = queueOf(store);

    expect(context).toEqual({
      application: "sonarr",
      queueItemId: 502,
      itemKind: "tracked_download",
      status: "completed",
      trackedState: "import_blocked",
      mediaId: 12,
    });
  });

  it("distinguishes a pending release from a tracked download", () => {
    const { store } = storeAt();
    const pending = queueOf(store, pendingItem());

    expect(pending.context.itemKind).toBe("pending_release");
    expect(pending.context.status).toBe("delay");
    expect(pending.context.trackedState).toBeUndefined();
  });

  it("rejects a reference whose kind is not the one the intent requires", () => {
    const { store } = storeAt();
    const tracked = queueOf(store);
    const pending = queueOf(store, pendingItem());

    // An intent valid only for a pending release, applied to a tracked
    // download, fails on the retained kind alone — before any upstream request.
    const wrong = resolveQueueReference(store, tracked.reference, "sonarr", {
      requireKind: "pending_release",
    });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) {
      expect(wrong.error.code).toBe("invalid_input");
      expect(wrong.error.message).toContain("tracked download");
      expect(wrong.error.message).toContain("pending release");
    }

    // And the other way round.
    expect(
      resolveQueueReference(store, pending.reference, "sonarr", {
        requireKind: "tracked_download",
      }).ok,
    ).toBe(false);

    // The matching requirement still resolves.
    expect(
      resolveQueueReference(store, tracked.reference, "sonarr", {
        requireKind: "tracked_download",
      }).ok,
    ).toBe(true);
  });

  it("carries no media association for a row upstream could not associate", () => {
    const { store } = storeAt();
    const unknown = queueOf(
      store,
      trackedItem({
        context: { application: "sonarr", kind: "tracked_download", queueItemId: 504 },
        media: undefined,
      }),
    );

    expect(unknown.context.mediaId).toBeUndefined();
    expect(unknown.context.queueItemId).toBe(504);
  });

  it("names history and blocklist records without exposing their identifiers", () => {
    const { store } = storeAt();
    const history = mintHistoryReference(store, historyRecord());
    const blocklist = mintBlocklistReference(store, blocklistRecord());

    expect(tokenParts(store, history).prefix).toBe("his");
    expect(tokenParts(store, blocklist).prefix).toBe("blk");
    // The identifier is not what either token is made of: minting the same
    // record again produces a different token that resolves to the same
    // identifier, so neither can be derived from the other.
    expect(mintHistoryReference(store, historyRecord())).not.toBe(history);
    expect(mintBlocklistReference(store, blocklistRecord())).not.toBe(blocklist);

    expect(resolveHistoryReference(store, history, "prowlarr")).toEqual({
      ok: true,
      value: { application: "prowlarr", historyRecordId: 9001 },
    });
    expect(resolveBlocklistReference(store, blocklist, "radarr")).toEqual({
      ok: true,
      value: { application: "radarr", blocklistRecordId: 7101 },
    });

    // Each kind refuses the other's token, so a blocklist removal can never be
    // aimed at a history record.
    expect(resolveHistoryReference(store, blocklist, "prowlarr").ok).toBe(false);
    expect(resolveBlocklistReference(store, history, "radarr").ok).toBe(false);
  });

  it("retains the media association a history mutation re-reads through", () => {
    const { store, advance } = storeAt();
    const associated = mintHistoryReference(store, {
      ...historyRecord(),
      application: "sonarr",
      context: { application: "sonarr", historyRecordId: 9001, mediaId: 12 },
    });

    expect(associated).not.toContain("12");
    expect(resolveHistoryReference(store, associated, "sonarr")).toEqual({
      ok: true,
      value: { application: "sonarr", historyRecordId: 9001, mediaId: 12 },
    });

    // A reference outlives its query but not by much: once it has expired the
    // remedy is to read history again, which is what `stale_reference` says.
    advance(15 * 60_000 + 1);
    const expired = resolveHistoryReference(store, associated, "sonarr");
    expect(expired.ok).toBe(false);
    if (!expired.ok) {
      expect(expired.error.code).toBe("stale_reference");
    }
  });

  it("refuses a history reference whose retained association is corrupt", () => {
    const { store } = storeAt();
    const plant = (detail: Readonly<Record<string, unknown>>) =>
      store.mint({
        kind: "history",
        applications: ["sonarr"],
        payload: () => ({
          kind: "domain",
          snapshot: { upstreamId: "9001", fingerprint: "abc", detail },
        }),
      }).reference;

    const good = { kind: "history_record", eventType: "grabbed", mediaId: 12 };
    expect(resolveHistoryReference(store, plant(good), "sonarr").ok).toBe(true);
    // Absence is legitimate — Prowlarr history has no media association — so
    // only a value this module would never have written is refused.
    expect(
      resolveHistoryReference(store, plant({ ...good, mediaId: undefined }), "sonarr"),
    ).toEqual({ ok: true, value: { application: "sonarr", historyRecordId: 9001 } });

    for (const corrupt of [{ mediaId: -1 }, { mediaId: 1.5 }, { mediaId: "12" }]) {
      const resolved = resolveHistoryReference(store, plant({ ...good, ...corrupt }), "sonarr");
      expect(resolved.ok).toBe(false);
      if (!resolved.ok) {
        expect(resolved.error.code).toBe("invalid_input");
      }
    }
  });

  it("refuses a stored payload whose retained state is corrupt rather than coercing it", () => {
    const { store } = storeAt();
    const plant = (detail: Readonly<Record<string, unknown>>) =>
      store.mint({
        kind: "queue",
        applications: ["sonarr"],
        payload: () => ({
          kind: "domain",
          snapshot: { upstreamId: "502", fingerprint: "abc", detail },
        }),
      }).reference;

    const good = {
      kind: "queue_item",
      status: "completed",
      trackedState: "import_blocked",
      mediaId: 12,
    };
    // The control: the same shape this module writes still resolves, so the
    // rejections below are about the corruption and not about the shape.
    expect(resolveQueueReference(store, plant(good), "sonarr").ok).toBe(true);

    // A field holding something this module would never have written is
    // refused. Defaulting a malformed status to `unknown` would hand a later
    // transition a plausible state that nothing vouches for.
    for (const corrupt of [
      { ...good, status: "not-a-status" },
      { ...good, status: undefined },
      { ...good, trackedState: "not-a-state" },
      { ...good, mediaId: -1 },
      { ...good, mediaId: 1.5 },
      { ...good, mediaId: "12" },
    ]) {
      const resolved = resolveQueueReference(store, plant(corrupt), "sonarr");
      expect(resolved.ok).toBe(false);
      if (!resolved.ok) {
        expect(resolved.error.code).toBe("invalid_input");
      }
    }

    // Absence is not corruption where absence is legitimate: a pending release
    // has no tracked state, and upstream does not always associate a row.
    const sparse = plant({ kind: "queue_item", status: "delay" });
    expect(resolveQueueReference(store, sparse, "sonarr")).toEqual({
      ok: true,
      value: {
        application: "sonarr",
        queueItemId: 502,
        itemKind: "pending_release",
        status: "delay",
        trackedState: undefined,
        mediaId: undefined,
      },
    });
  });

  it("derives the item kind from the status, so the two can never disagree", () => {
    const { store } = storeAt();
    // The kind is not stored beside the status, so a payload claiming to be a
    // pending release while carrying a tracked download's status cannot be
    // expressed — which is what would otherwise let a pending-only intent
    // through the check meant to stop it.
    const plant = (status: string) =>
      store.mint({
        kind: "queue",
        applications: ["sonarr"],
        payload: () => ({
          kind: "domain",
          snapshot: {
            upstreamId: "502",
            fingerprint: "abc",
            detail: { kind: "queue_item", status },
          },
        }),
      }).reference;

    for (const [status, expected] of [
      ["delay", "pending_release"],
      ["fallback", "pending_release"],
      ["completed", "tracked_download"],
      ["downloading", "tracked_download"],
      ["failed", "tracked_download"],
      ["unknown", "tracked_download"],
    ] as const) {
      const resolved = resolveQueueReference(store, plant(status), "sonarr");
      expect(resolved.ok).toBe(true);
      if (resolved.ok) {
        expect(resolved.value.itemKind).toBe(expected);
      }
      // And the requirement check follows the same derivation.
      expect(
        resolveQueueReference(store, plant(status), "sonarr", { requireKind: "pending_release" })
          .ok,
      ).toBe(expected === "pending_release");
    }
  });

  it("refuses a reference of the right kind whose payload is not an activity record", () => {
    const { store } = storeAt();
    // A queue-prefixed token minted by something other than this module — the
    // third check, the one that catches a defect rather than a caller.
    const foreign = store.mint({
      kind: "queue",
      applications: ["sonarr"],
      payload: () => ({
        kind: "domain",
        snapshot: { upstreamId: "502", fingerprint: "abc", detail: { kind: "media" } },
      }),
    }).reference;

    const resolved = resolveQueueReference(store, foreign, "sonarr");
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      // Named as the sort of record that was required, so a reader is told
      // which half of its input was wrong rather than "activity record".
      expect(resolved.error.message).toContain("does not name a queue item");
    }
  });

  it("names the retained field that failed rather than the record that did not", () => {
    const { store } = storeAt();
    const plant = (kind: "queue" | "history", detail: Readonly<Record<string, unknown>>) =>
      store.mint({
        kind,
        applications: ["sonarr"],
        payload: () => ({
          kind: "domain",
          snapshot: { upstreamId: "9001", fingerprint: "abc", detail },
        }),
      }).reference;

    const messageOf = (resolved: { ok: boolean; error?: { message: string } }): string => {
      if (resolved.ok || resolved.error === undefined) {
        throw new Error("Expected the reference to be refused");
      }
      return resolved.error.message;
    };

    // A history record whose identifier is perfectly good and whose retained
    // association is not. The two failures below must never read alike: one is
    // "this is the wrong sort of reference", the other is "this is the right
    // reference carrying state nothing vouches for".
    const corruptAssociation = messageOf(
      resolveHistoryReference(
        store,
        plant("history", { kind: "history_record", eventType: "grabbed", mediaId: -1 }),
        "sonarr",
      ),
    );
    const wrongRecord = messageOf(
      resolveHistoryReference(store, plant("history", { kind: "queue_item" }), "sonarr"),
    );

    expect(corruptAssociation).toContain("retained media association is unusable");
    expect(corruptAssociation).not.toContain("does not name a history record");
    expect(wrongRecord).toContain("does not name a history record");
    expect(wrongRecord).not.toContain("retained media association");

    // The queue resolver names which of its three retained fields failed, for
    // the same reason: the row's identity is intact in every one of these.
    const queueDetail = { kind: "queue_item", status: "completed", trackedState: "importing" };
    expect(
      messageOf(
        resolveQueueReference(store, plant("queue", { ...queueDetail, status: "no" }), "sonarr"),
      ),
    ).toContain("retained queue status is unusable");
    expect(
      messageOf(
        resolveQueueReference(
          store,
          plant("queue", { ...queueDetail, trackedState: "no" }),
          "sonarr",
        ),
      ),
    ).toContain("retained tracked download state is unusable");
    expect(
      messageOf(
        resolveQueueReference(store, plant("queue", { ...queueDetail, mediaId: -1 }), "sonarr"),
      ),
    ).toContain("retained media association is unusable");
  });
});
