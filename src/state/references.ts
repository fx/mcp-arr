import type { ApplicationId } from "../applications.js";
import { type ReferenceKind, referenceKinds, referencePrefixes } from "../tools/schemas/common.js";
import type { ApplyRecord } from "./apply-records.js";
import type { Clock } from "./clock.js";
import type { JobRecord } from "./jobs.js";
import type { PlanRecord } from "./plans.js";
import { createLifetimeId, mintToken, readTokenLifetime } from "./tokens.js";

const minute = 60_000;

/**
 * How long a reference of each kind stays resolvable.
 *
 * The lifetimes encode how volatile the thing behind the reference is and what
 * losing it costs. A queue item or a release is re-derivable by repeating the
 * query that produced it, so those expire quickly and an expired one is a
 * recoverable `stale_reference`. Apply records and job projections never expire
 * within the process: they are the only record this server holds of a mutation
 * it sent, and discarding one would turn a safe retry into a duplicate
 * mutation or hide a job's terminal result.
 */
export const referenceLifetimes: Readonly<Record<ReferenceKind, number>> = {
  media: 15 * minute,
  media_file: 15 * minute,
  queue: 5 * minute,
  release: 10 * minute,
  import_candidate: 10 * minute,
  history: 15 * minute,
  blocklist: 15 * minute,
  configuration: 15 * minute,
  plan: 10 * minute,
  apply: Number.POSITIVE_INFINITY,
  job: Number.POSITIVE_INFINITY,
};

/**
 * The default ceiling on live expiring references.
 *
 * All state is in process memory with no eviction from upstream, so an
 * unbounded map is a leak in a long-running server. Evicting the oldest entry
 * degrades exactly the way an expired one does — the caller repeats the query —
 * which is a behavior every expiring reference kind already has to handle.
 */
export const defaultMaxReferences = 4096;

/**
 * The separate, much larger ceiling on references that never expire.
 *
 * Apply receipts and job projections are counted apart from everything else so
 * a burst of short-lived queue or release references can never push a receipt
 * out: losing one would turn a safe retry into a duplicate mutation, or hide a
 * job's terminal result. The bound still exists, because a process that ran for
 * months would otherwise grow without limit, but it is reached only by that
 * many distinct mutations in one lifetime.
 *
 * It is a ceiling eviction respects, not one it enforces at any cost. See
 * {@link isEvictable}: a record whose loss would permit a duplicate mutation is
 * kept even past this number, because a few more kilobytes is not a trade worth
 * making against sending a destructive mutation twice.
 */
export const defaultMaxDurableReferences = 16_384;

/**
 * What a domain reference stands for.
 *
 * The upstream identity lives here, in the store, and never in the token: the
 * token is random, so a caller can neither read an upstream id out of it nor
 * construct one for an object this server never returned. The fingerprint is a
 * digest of the object as it looked when the reference was minted, which is
 * what later changes compare against to detect that the object moved on.
 */
export interface DomainSnapshot {
  /** The upstream identifier, kept as a string so both int and GUID ids fit. */
  readonly upstreamId: string;
  readonly fingerprint: string;
  /**
   * Normalized detail the owning domain change attaches, such as the queue
   * item's tracked download state. It never carries a download URL, an API
   * key, or a canonical filesystem path.
   */
  readonly detail?: Readonly<Record<string, unknown>>;
}

/**
 * Everything a reference can stand for, discriminated so a resolver narrows to
 * the record it needs without a cast.
 */
export type ReferencePayload =
  | { readonly kind: "domain"; readonly snapshot: DomainSnapshot }
  | { readonly kind: "plan"; readonly plan: PlanRecord }
  | { readonly kind: "apply"; readonly apply: ApplyRecord }
  | { readonly kind: "job"; readonly job: JobRecord };

export interface ReferenceEntry {
  readonly reference: string;
  readonly kind: ReferenceKind;
  /**
   * The applications this reference is bound to. A domain reference always
   * names exactly one; a plan names the applications its call targeted, which
   * is also one for every mutation this server accepts.
   */
  readonly applications: readonly ApplicationId[];
  readonly createdAt: number;
  /** {@link Number.POSITIVE_INFINITY} for a kind that lives as long as the process. */
  readonly expiresAt: number;
  readonly payload: ReferencePayload;
}

/**
 * Why a reference did not resolve. Every reason is reported to the caller as a
 * `stale_reference` (or, for a plan, a `stale_plan`) with its own message: the
 * codes are a stable contract and all four failures have the same remedy, but
 * telling a caller that its reference predates a restart is more useful than
 * telling it the reference is simply unknown.
 */
export const referenceFailureReasons = [
  "malformed",
  "wrong_kind",
  "foreign_lifetime",
  "unknown",
  "expired",
] as const;

export type ReferenceFailureReason = (typeof referenceFailureReasons)[number];

export type ReferenceResolution =
  | { readonly ok: true; readonly entry: ReferenceEntry }
  | {
      readonly ok: false;
      readonly reason: ReferenceFailureReason;
      /** The kind the caller required, which is what its message describes. */
      readonly kind: ReferenceKind;
    };

export interface MintInput {
  readonly kind: ReferenceKind;
  readonly applications: readonly ApplicationId[];
  /**
   * Built from the token, because every record this store holds carries its own
   * reference. Passing the token in is what makes a record and the token that
   * names it impossible to pair up incorrectly.
   */
  readonly payload: (reference: string) => ReferencePayload;
  /** Overrides {@link referenceLifetimes} for this entry only. */
  readonly lifetimeMs?: number | undefined;
}

export interface ReferenceStore {
  /** Identifies this process lifetime; every token this store mints carries it. */
  readonly lifetimeId: string;
  mint(input: MintInput): ReferenceEntry;
  resolve(token: string, kind: ReferenceKind): ReferenceResolution;
  /** Replaces a live entry's payload, keeping its token, binding, and expiry. */
  update(token: string, kind: ReferenceKind, payload: ReferencePayload): boolean;
  /** The number of live entries, used by tests and by the eviction bound. */
  size(): number;
}

export interface ReferenceStoreOptions {
  readonly clock: Clock;
  readonly lifetimeId?: string | undefined;
  /** The ceiling on expiring references; see {@link defaultMaxReferences}. */
  readonly maxEntries?: number | undefined;
  /** The separate ceiling on references that never expire within the process. */
  readonly maxDurableEntries?: number | undefined;
}

const kindByPrefix = new Map<string, ReferenceKind>(
  referenceKinds.map((kind) => [referencePrefixes[kind], kind]),
);

/**
 * The kind a token claims to be, from its prefix alone.
 *
 * This is a claim, not proof: the store still checks the stored kind, so a
 * token that claims one kind and resolves to another is rejected rather than
 * trusted. It exists so a caller that has not yet decided which kind it needs —
 * the shared dispatcher, resolving whatever references an input carried — can
 * look one up without guessing.
 */
export function referenceKindForToken(token: string): ReferenceKind | undefined {
  const separator = token.indexOf("_");
  return separator <= 0 ? undefined : kindByPrefix.get(token.slice(0, separator));
}

/**
 * Whether dropping an entry can be observed as anything worse than expiry.
 *
 * Almost everything qualifies: a caller repeats the query that produced a
 * domain reference, creates a new plan, or reads a job whose projection now
 * says `unknown` — all behaviors those kinds already have to handle.
 *
 * An apply receipt is the exception, and only in the states where it is still
 * the answer to a repeat. Dropping one that is `applying`, `succeeded`, or
 * `outcome_unknown` would let the identical apply mint a fresh receipt and send
 * the mutation a second time, which is precisely what the receipt exists to
 * prevent. A `failed` receipt is safe to drop, because a repeat of a mutation
 * upstream demonstrably refused is allowed to run again anyway.
 */
function isEvictable(entry: ReferenceEntry): boolean {
  const payload = entry.payload;
  return payload.kind !== "apply" || payload.apply.state === "failed";
}

/**
 * The in-memory reference store.
 *
 * It is the single place a token is turned back into an object identity, which
 * is what lets every tool reject a wrong-kind, forged, expired, or
 * previous-lifetime reference the same way and before any upstream request.
 */
export function createReferenceStore(options: ReferenceStoreOptions): ReferenceStore {
  const clock = options.clock;
  const lifetimeId = options.lifetimeId ?? createLifetimeId();
  const maxEntries = options.maxEntries ?? defaultMaxReferences;
  const maxDurableEntries = options.maxDurableEntries ?? defaultMaxDurableReferences;
  // Insertion-ordered, so eviction walks oldest-first without a second index.
  const entries = new Map<string, ReferenceEntry>();

  const isExpired = (entry: ReferenceEntry, now: number): boolean => now >= entry.expiresAt;
  const isDurable = (entry: ReferenceEntry): boolean => !Number.isFinite(entry.expiresAt);

  /**
   * Drops the oldest entries that match `select`, until `remaining` of them are
   * left, and reports how many are left. Insertion order is age order, so the
   * first match walked is always the oldest.
   */
  const drop = (
    remaining: number,
    limit: number,
    select: (entry: ReferenceEntry) => boolean,
  ): number => {
    let live = remaining;
    for (const [token, entry] of entries) {
      if (live <= limit) {
        break;
      }
      if (select(entry)) {
        entries.delete(token);
        live -= 1;
      }
    }
    return live;
  };

  /**
   * Keeps the store bounded without letting one kind starve another, and
   * without ever trading a duplicate mutation for memory.
   *
   * The two buckets are counted separately on purpose: a burst of short-lived
   * queue or release references must never evict an apply receipt or a job
   * projection, because those are the only record this server holds of a
   * mutation it sent. Within the expiring bucket, already-expired entries go
   * first, since dropping them changes nothing a caller could observe. And
   * nothing {@link isEvictable} refuses is ever dropped, so a bucket that holds
   * only unsettled receipts simply grows past its ceiling rather than opening
   * the door to a second mutation.
   */
  const evict = (now: number): void => {
    let expiring = 0;
    let durable = 0;
    for (const entry of entries.values()) {
      if (isDurable(entry)) {
        durable += 1;
      } else {
        expiring += 1;
      }
    }

    if (expiring > maxEntries) {
      expiring = drop(
        expiring,
        maxEntries,
        (entry) => !isDurable(entry) && isExpired(entry, now) && isEvictable(entry),
      );
      drop(expiring, maxEntries, (entry) => !isDurable(entry) && isEvictable(entry));
    }
    if (durable > maxDurableEntries) {
      drop(durable, maxDurableEntries, (entry) => isDurable(entry) && isEvictable(entry));
    }
  };

  const resolve = (token: string, kind: ReferenceKind): ReferenceResolution => {
    const claimed = referenceKindForToken(token);
    if (claimed === undefined) {
      return { ok: false, reason: "malformed", kind };
    }
    if (claimed !== kind) {
      return { ok: false, reason: "wrong_kind", kind };
    }
    // A token that cannot be parsed and a token from another process are
    // different answers with different remedies, so they never share a branch:
    // one means the value was never a reference, the other means it was ours
    // and the server has restarted since.
    const lifetime = readTokenLifetime(token, referencePrefixes[kind]);
    if (lifetime.status === "malformed") {
      return { ok: false, reason: "malformed", kind };
    }
    if (lifetime.lifetimeId !== lifetimeId) {
      return { ok: false, reason: "foreign_lifetime", kind };
    }

    const entry = entries.get(token);
    if (entry === undefined) {
      return { ok: false, reason: "unknown", kind };
    }
    if (entry.kind !== kind) {
      return { ok: false, reason: "wrong_kind", kind };
    }

    const now = clock.now();
    if (isExpired(entry, now)) {
      entries.delete(token);
      return { ok: false, reason: "expired", kind };
    }
    return { ok: true, entry };
  };

  return {
    lifetimeId,
    resolve,

    mint(input: MintInput): ReferenceEntry {
      const now = clock.now();
      const lifetimeMs = input.lifetimeMs ?? referenceLifetimes[input.kind];
      // The same collapse as an unparsable token, one layer down: a NaN
      // lifetime makes `now + lifetimeMs` NaN, which never compares as expired
      // and reads as non-finite — so a broken input would be indistinguishable
      // from a deliberate never-expires entry, and would silently take up a
      // slot in the bucket reserved for those.
      if (!(Number.isFinite(lifetimeMs) || lifetimeMs === Number.POSITIVE_INFINITY)) {
        throw new RangeError("A reference lifetime must be finite or positive infinity");
      }
      const reference = mintToken(referencePrefixes[input.kind], lifetimeId);
      const entry: ReferenceEntry = {
        reference,
        kind: input.kind,
        applications: [...input.applications],
        createdAt: now,
        expiresAt: now + lifetimeMs,
        payload: input.payload(reference),
      };
      entries.set(entry.reference, entry);
      evict(now);
      return entry;
    },

    update(token: string, kind: ReferenceKind, payload: ReferencePayload): boolean {
      const resolution = resolve(token, kind);
      if (!resolution.ok) {
        return false;
      }
      entries.set(token, { ...resolution.entry, payload });
      return true;
    },

    size(): number {
      return entries.size;
    },
  };
}
