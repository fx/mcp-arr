import type { ApplicationId } from "../applications.js";

/**
 * The downloads `media_fix` is acting on, or has started an import for, and
 * the movies and episodes those imports are for.
 *
 * A `media` call has no plan to apply and no reference to retry, so the one
 * thing that stops two calls acting on one download is this map. A call
 * claims a download before it reads it, with a synchronous check-and-set, so
 * two overlapping calls cannot both hold it; the claim is released once a
 * replacement's request has returned, and an import's claim is kept until the
 * import is seen to finish. Where the answer to either was lost, the claim is
 * kept until there is evidence of what happened, or a bound passes.
 *
 * An import also claims every movie or episode it is for, so two downloads can
 * never be imported into the same one at once. Those claims belong to the
 * download's claim and are released with it.
 *
 * It is process memory and lives exactly as long as the process: one map,
 * held by the workflow state, shared by the stdio session and by every HTTP
 * request alike. It is bounded, and a full map refuses a new claim rather than
 * evicting one, because evicting a claim is how a second import would start.
 */

/** The most downloads that may be claimed at once. */
export const maxDownloadClaims = 1_000;

/** The two actions whose outcome a claim can be left waiting on. */
export type PendingAction = "import" | "replace";

/**
 * What a claim is waiting on: an import that was started, or an action that
 * was sent and whose answer was lost, so whether it took effect is not known.
 */
export interface PendingOutcome {
  readonly action: PendingAction;
  readonly application: ApplicationId;
  /**
   * The upstream command identifier an import was accepted as, or `undefined`
   * where the request was sent and no usable answer came back. A replacement
   * has no command, so it is held only when its answer was lost.
   */
  readonly commandId?: string | undefined;
  /** When the action was sent, by the context's clock. */
  readonly attemptedAt: number;
  /** The library record the download is filed under. */
  readonly mediaId: number;
  /** The episodes an import is for; empty for a movie and for a replacement. */
  readonly episodeIds: readonly number[];
}

export type ClaimAttempt = "claimed" | "held" | "full";

export interface DownloadClaims {
  /** Claims a download, or says why it could not: someone holds it, or the map is full. */
  tryClaim(key: string): ClaimAttempt;
  /** Releases a claim, whatever it held, and every target it claimed. */
  release(key: string): void;
  /** Keeps a held claim until the outcome of what it sent is known. */
  markPending(key: string, claimed: PendingOutcome): void;
  /** What a claim is waiting on, where it is waiting on anything. */
  pendingOf(key: string): PendingOutcome | undefined;
  /**
   * Releases a claim only while it is still waiting on this very outcome, so
   * a refresh that finished late cannot release a claim another call has
   * since taken.
   */
  releasePending(key: string, claimed: PendingOutcome): void;
  /**
   * Every claim waiting on an outcome, whatever its download now looks like —
   * including one whose download has left the queue, which no read of the
   * queue would ever name again.
   */
  pending(): readonly (readonly [key: string, claimed: PendingOutcome])[];
  /**
   * Claims every target for the download a held claim names, all or none: it
   * fails, claiming nothing, when another download holds any of them.
   */
  tryClaimTargets(owner: string, targets: readonly string[]): boolean;
  /** Whether a download other than this one holds a target. */
  targetHeldByOther(owner: string, target: string): boolean;
  /** How many downloads are claimed. */
  readonly size: number;
}

type Claim =
  | { readonly kind: "acting" }
  | { readonly kind: "pending"; readonly outcome: PendingOutcome };

export function createDownloadClaims(maxEntries = maxDownloadClaims): DownloadClaims {
  const claims = new Map<string, Claim>();
  const targets = new Map<string, string>();
  const drop = (key: string): void => {
    claims.delete(key);
    for (const [target, owner] of targets) {
      if (owner === key) {
        targets.delete(target);
      }
    }
  };
  return {
    tryClaim(key) {
      if (claims.has(key)) {
        return "held";
      }
      if (claims.size >= maxEntries) {
        return "full";
      }
      claims.set(key, { kind: "acting" });
      return "claimed";
    },
    release(key) {
      drop(key);
    },
    markPending(key, claimed) {
      claims.set(key, { kind: "pending", outcome: claimed });
    },
    pendingOf(key) {
      const claim = claims.get(key);
      return claim?.kind === "pending" ? claim.outcome : undefined;
    },
    releasePending(key, claimed) {
      const claim = claims.get(key);
      if (claim?.kind === "pending" && claim.outcome === claimed) {
        drop(key);
      }
    },
    pending() {
      return [...claims].flatMap(([key, claim]) =>
        claim.kind === "pending" ? [[key, claim.outcome] as const] : [],
      );
    },
    tryClaimTargets(owner, wanted) {
      if (wanted.some((target) => (targets.get(target) ?? owner) !== owner)) {
        return false;
      }
      for (const target of wanted) {
        targets.set(target, owner);
      }
      return true;
    },
    targetHeldByOther(owner, target) {
      return (targets.get(target) ?? owner) !== owner;
    },
    get size() {
      return claims.size;
    },
  };
}
