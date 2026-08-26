import { describe, expect, it } from "vitest";
import { createManualClock } from "../src/state/clock.js";
import {
  createReferenceStore,
  type DomainSnapshot,
  type ReferenceStore,
  referenceKindForToken,
  referenceLifetimes,
} from "../src/state/references.js";
import { referenceKinds, referencePrefixes } from "../src/tools/schemas/common.js";

const upstreamId = "4821";
const secretDetail = {
  // Neither of these may ever be derivable from a token; both are the kind of
  // value the reference exists to keep out of the caller's hands.
  apiKey: "sonarr-secret-key",
  path: "/mnt/media/Series/Example/Season 01",
};

function snapshot(): DomainSnapshot {
  return { upstreamId, fingerprint: "abc123", detail: secretDetail };
}

function storeAt(
  now = 1_000,
  lifetimeId?: string,
): { store: ReferenceStore; advance(ms: number): void } {
  const clock = createManualClock(now);
  const store = createReferenceStore({
    clock,
    ...(lifetimeId === undefined ? {} : { lifetimeId }),
  });
  return { store, advance: (ms) => clock.advance(ms) };
}

function mintRelease(store: ReferenceStore) {
  return store.mint({
    kind: "release",
    applications: ["sonarr"],
    payload: () => ({ kind: "domain", snapshot: snapshot() }),
  });
}

describe("opaque reference store", () => {
  it("mints a token bound to its kind, application, and expiry", () => {
    const { store } = storeAt(1_000);
    const entry = mintRelease(store);

    expect(referenceKindForToken(entry.reference)).toBe("release");
    expect(entry.kind).toBe("release");
    expect(entry.applications).toEqual(["sonarr"]);
    expect(entry.createdAt).toBe(1_000);
    expect(entry.expiresAt).toBe(1_000 + referenceLifetimes.release);
    expect(store.resolve(entry.reference, "release")).toEqual({ ok: true, entry });
  });

  it("encodes nothing about the object it stands for", () => {
    const { store } = storeAt();
    const first = mintRelease(store);
    const second = mintRelease(store);

    for (const entry of [first, second]) {
      expect(entry.reference).not.toContain(upstreamId);
      expect(entry.reference).not.toContain(secretDetail.apiKey);
      expect(entry.reference).not.toContain("mnt");
      expect(entry.reference).not.toContain("Series");
    }
    // Two references to identical state are different tokens, so a token
    // cannot be reconstructed from the object it names.
    expect(first.reference).not.toBe(second.reference);
  });

  it("publishes a distinct prefix for every reference kind", () => {
    const prefixes = referenceKinds.map((kind) => referencePrefixes[kind]);
    expect(new Set(prefixes).size).toBe(referenceKinds.length);
    for (const kind of referenceKinds) {
      expect(referenceKindForToken(`${referencePrefixes[kind]}_00000001`)).toBe(kind);
    }
    expect(referenceKindForToken("00000001")).toBeUndefined();
    expect(referenceKindForToken("zzz_00000001")).toBeUndefined();
  });

  it("refuses a reference of the wrong kind without looking it up", () => {
    const { store } = storeAt();
    const release = mintRelease(store);

    expect(store.resolve(release.reference, "import_candidate")).toEqual({
      ok: false,
      reason: "wrong_kind",
      kind: "import_candidate",
    });
    expect(store.resolve(release.reference, "release").ok).toBe(true);
  });

  it("calls a token it never could have minted malformed, not foreign", () => {
    const { store } = storeAt();
    const malformed = [
      // No prefix at all.
      "not-a-reference",
      // The right prefix, but a body no minted token ever has. Telling the
      // caller its reference predates a restart would send it looking for a
      // server event that never happened.
      "rel_forgedforgedforged",
      "rel_00000001",
      `rel_${"a".repeat(29)}`,
      `rel_${"a".repeat(31)}`,
      // The right length, but not the alphabet base64url produces.
      `rel_${"a".repeat(29)}!`,
    ];

    for (const token of malformed) {
      expect(store.resolve(token, "release"), token).toEqual({
        ok: false,
        reason: "malformed",
        kind: "release",
      });
    }
  });

  it("refuses a reference minted in a previous process lifetime", () => {
    const previous = storeAt(1_000, "AAAAAAAA");
    const restarted = storeAt(1_000, "BBBBBBBB");
    const entry = mintRelease(previous.store);

    expect(previous.store.resolve(entry.reference, "release").ok).toBe(true);
    // Well formed and genuinely ours, just from before the restart. This is the
    // one case whose remediation is "the server restarted, ask again".
    expect(restarted.store.resolve(entry.reference, "release")).toEqual({
      ok: false,
      reason: "foreign_lifetime",
      kind: "release",
    });
  });

  it("refuses a lifetime that is neither finite nor deliberately endless", () => {
    const { store } = storeAt();
    const mint = (lifetimeMs: number) =>
      store.mint({
        kind: "release",
        applications: ["sonarr"],
        lifetimeMs,
        payload: () => ({ kind: "domain", snapshot: snapshot() }),
      });

    // NaN would never compare as expired and would read as non-finite, making a
    // broken lifetime indistinguishable from an intentional never-expiring one.
    expect(() => mint(Number.NaN)).toThrow(RangeError);
    expect(() => mint(Number.POSITIVE_INFINITY)).not.toThrow();
    expect(() => mint(1_000)).not.toThrow();
  });

  it("expires on the injected clock rather than on elapsed real time", () => {
    const { store, advance } = storeAt(0);
    const entry = mintRelease(store);

    advance(referenceLifetimes.release - 1);
    expect(store.resolve(entry.reference, "release").ok).toBe(true);

    advance(1);
    expect(store.resolve(entry.reference, "release")).toEqual({
      ok: false,
      reason: "expired",
      kind: "release",
    });
    // An expired entry is dropped, so a later resolve cannot revive it.
    expect(store.size()).toBe(0);
  });

  it("keeps apply receipts and job projections for the whole process lifetime", () => {
    expect(referenceLifetimes.apply).toBe(Number.POSITIVE_INFINITY);
    expect(referenceLifetimes.job).toBe(Number.POSITIVE_INFINITY);
  });

  it("replaces a payload without changing the token or its binding", () => {
    const { store } = storeAt();
    const entry = mintRelease(store);
    const replaced: DomainSnapshot = { upstreamId: "99", fingerprint: "def456" };

    expect(store.update(entry.reference, "release", { kind: "domain", snapshot: replaced })).toBe(
      true,
    );
    const resolution = store.resolve(entry.reference, "release");
    expect(resolution.ok && resolution.entry.payload).toEqual({
      kind: "domain",
      snapshot: replaced,
    });
    expect(resolution.ok && resolution.entry.applications).toEqual(["sonarr"]);
    expect(store.update(entry.reference, "queue", { kind: "domain", snapshot: replaced })).toBe(
      false,
    );
  });

  it("stays bounded by evicting the oldest expiring entries", () => {
    const clock = createManualClock(0);
    const store = createReferenceStore({ clock, maxEntries: 3 });
    const minted = Array.from({ length: 4 }, () => mintRelease(store));

    expect(store.size()).toBe(3);
    // Eviction degrades exactly the way expiry does, which every caller of a
    // reference already has to handle.
    expect(store.resolve(minted[0]?.reference ?? "", "release").ok).toBe(false);
    expect(store.resolve(minted[3]?.reference ?? "", "release").ok).toBe(true);
  });

  it("evicts an already-expired entry before a live one", () => {
    const clock = createManualClock(0);
    const store = createReferenceStore({ clock, maxEntries: 2 });
    const stale = mintRelease(store);
    clock.advance(referenceLifetimes.release);
    const live = mintRelease(store);
    const newest = mintRelease(store);

    expect(store.resolve(stale.reference, "release").ok).toBe(false);
    expect(store.resolve(live.reference, "release").ok).toBe(true);
    expect(store.resolve(newest.reference, "release").ok).toBe(true);
  });

  it("never lets expiring references crowd out a receipt or a job projection", () => {
    const clock = createManualClock(0);
    const store = createReferenceStore({ clock, maxEntries: 2, maxDurableEntries: 8 });
    const job = store.mint({
      kind: "job",
      applications: ["sonarr"],
      payload: () => ({ kind: "domain", snapshot: snapshot() }),
    });

    for (let index = 0; index < 20; index += 1) {
      mintRelease(store);
    }

    // Losing this would turn a safe retry into a duplicate mutation, so the two
    // ceilings are counted apart.
    expect(store.resolve(job.reference, "job").ok).toBe(true);
  });

  it("bounds non-expiring references by their own ceiling", () => {
    const clock = createManualClock(0);
    const store = createReferenceStore({ clock, maxDurableEntries: 2 });
    const minted = Array.from({ length: 3 }, () =>
      store.mint({
        kind: "job",
        applications: ["sonarr"],
        payload: () => ({ kind: "domain", snapshot: snapshot() }),
      }),
    );

    // A job that can no longer be resolved degrades to `unknown`, which is a
    // behavior every reader of a job reference already handles.
    expect(store.resolve(minted[0]?.reference ?? "", "job").ok).toBe(false);
    expect(store.resolve(minted[2]?.reference ?? "", "job").ok).toBe(true);
  });
});
