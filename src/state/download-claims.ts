import type { ApplicationId } from "../applications.js";

/**
 * The downloads `media_fix` is acting on, or has started an import for.
 *
 * A `media` call has no plan to apply and no reference to retry, so the one
 * thing that stops two calls acting on one download is this map. A call
 * claims a download before it reads it, with a synchronous check-and-set, so
 * two overlapping calls cannot both hold it; the claim is released once a
 * replacement's request has returned, and an import's claim is kept, with the
 * command it started, until that command is seen to finish.
 *
 * It is process memory and lives exactly as long as the process: one map,
 * held by the workflow state, shared by the stdio session and by every HTTP
 * request alike. It is bounded, and a full map refuses a new claim rather than
 * evicting one, because evicting a claim is how a second import would start.
 */

/** The most downloads that may be claimed at once. */
export const maxDownloadClaims = 1_000;

/** The import a claim is waiting on. */
export interface ClaimedImport {
  readonly application: ApplicationId;
  /** The upstream command identifier the import was accepted as. */
  readonly commandId: string;
}

export type ClaimAttempt = "claimed" | "held" | "full";

export interface DownloadClaims {
  /** Claims a download, or says why it could not: someone holds it, or the map is full. */
  tryClaim(key: string): ClaimAttempt;
  /** Releases a claim, whatever it held. */
  release(key: string): void;
  /** Keeps a held claim for the import it started. */
  markImporting(key: string, claimed: ClaimedImport): void;
  /** The import a claim is waiting on, where it is waiting on one. */
  importOf(key: string): ClaimedImport | undefined;
  /**
   * Releases a claim only while it is still waiting on this import, so a
   * refresh that finished late cannot release a claim another call has since
   * taken.
   */
  releaseImport(key: string, commandId: string): void;
  /**
   * Every claim waiting on an import, whatever its download now looks like —
   * including one whose download has left the queue, which no read of the
   * queue would ever name again.
   */
  imports(): readonly (readonly [key: string, claimed: ClaimedImport])[];
  /** How many downloads are claimed. */
  readonly size: number;
}

type Claim =
  | { readonly kind: "acting" }
  | { readonly kind: "importing"; readonly import: ClaimedImport };

export function createDownloadClaims(maxEntries = maxDownloadClaims): DownloadClaims {
  const claims = new Map<string, Claim>();
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
      claims.delete(key);
    },
    markImporting(key, claimed) {
      claims.set(key, { kind: "importing", import: claimed });
    },
    importOf(key) {
      const claim = claims.get(key);
      return claim?.kind === "importing" ? claim.import : undefined;
    },
    releaseImport(key, commandId) {
      const claim = claims.get(key);
      if (claim?.kind === "importing" && claim.import.commandId === commandId) {
        claims.delete(key);
      }
    },
    imports() {
      return [...claims].flatMap(([key, claim]) =>
        claim.kind === "importing" ? [[key, claim.import] as const] : [],
      );
    },
    get size() {
      return claims.size;
    },
  };
}
