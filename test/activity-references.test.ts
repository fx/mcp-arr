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
  it("mints a token that carries nothing about the record it names", () => {
    const { store } = storeAt();
    const { reference } = queueOf(store);

    // The published cursor and reference schemas both accept only this
    // alphabet, and the prefix is the only part that means anything.
    expect(reference).toMatch(/^que_[A-Za-z0-9_-]{8,64}$/u);
    expect(reference).not.toContain(canary);
    expect(reference).not.toContain("502");
    expect(reference).not.toContain("12");
    expect(reference).not.toContain("sonarr");
  });

  it("mints a different token for the same record every time", () => {
    const { store } = storeAt();
    const item = trackedItem();
    // Nothing about the record determines the token, so two references to one
    // row cannot be recognized as the same row by comparing them.
    expect(mintQueueReference(store, item)).not.toBe(mintQueueReference(store, item));
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

    expect(history).toMatch(/^his_[A-Za-z0-9_-]{8,64}$/u);
    expect(blocklist).toMatch(/^blk_[A-Za-z0-9_-]{8,64}$/u);
    expect(history).not.toContain("9001");
    expect(blocklist).not.toContain("7101");

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
      expect(resolved.error.message).toContain("does not name an activity record");
    }
  });
});
