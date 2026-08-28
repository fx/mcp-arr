import type { ApplicationId } from "../applications.js";
import type { ToolError } from "../tools/errors.js";
import type { ProjectedToolName } from "../tools/names.js";
import type { Effect } from "../tools/results.js";
import type { Clock } from "./clock.js";
import {
  type ReferenceEntry,
  type ReferenceFailureReason,
  type ReferenceStore,
  referenceLifetimes,
} from "./references.js";
import { fingerprint } from "./tokens.js";

/**
 * One named value an operation read while planning.
 *
 * The adapter declares what it read; the runtime decides what to do about it.
 * Keeping the raw value here rather than a digest means the fingerprinting rule
 * lives in one place and every operation's read set is comparable the same way.
 */
export interface ReadSetObservation {
  /** Stable within one operation, such as `queue-item-status` or `job-status`. */
  readonly key: string;
  readonly value: unknown;
}

export interface ReadSetFingerprint {
  readonly key: string;
  readonly digest: string;
}

/**
 * What an operation observed, or why it refuses to go further.
 *
 * `blocked` is not the same as a changed read set: it says the current state
 * cannot be validated at all, so neither a direct apply nor a planned apply may
 * send a mutation. That distinction is why the reader returns a result instead
 * of throwing. It carries a complete {@link ToolError} rather than a message,
 * so a reader that already knows the right code — a reference that no longer
 * resolves is `stale_reference`, not a conflict — keeps it.
 */
export type PreconditionRead =
  | {
      readonly status: "ok";
      readonly observations: readonly ReadSetObservation[];
      readonly warnings?: readonly string[];
      /**
       * What the reader resolved while it read, handed to the operation's own
       * handler unchanged.
       *
       * A mutation must act on the state it validated, not on state it re-read
       * afterwards, and the two are not the same thing: re-reading opens a
       * window in which the record changed between the check and the write.
       * Carrying the reader's own result closes it, and saves every mutation a
       * second round of upstream reads. It never leaves the process — nothing
       * here reaches a tool result, and the plan record keeps only the
       * fingerprints of {@link observations}.
       */
      readonly validated?: unknown;
    }
  | { readonly status: "blocked"; readonly error: ToolError };

export function fingerprintReadSet(
  observations: readonly ReadSetObservation[],
): readonly ReadSetFingerprint[] {
  return observations
    .map((observation) => ({ key: observation.key, digest: fingerprint(observation.value) }))
    .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
}

export type ReadSetComparison =
  | { readonly status: "unchanged" }
  | {
      readonly status: "changed";
      /** Keys whose value differs from the planned observation. */
      readonly changed: readonly string[];
      /** Keys the plan observed that the current read no longer reports. */
      readonly missing: readonly string[];
    };

/**
 * Decides whether a plan is still applicable.
 *
 * A key the plan never observed appearing now is not staleness: the plan made
 * no claim about it, and treating it as a change would make every plan stale
 * the moment an adapter learns to read one more thing. A key the plan observed
 * that has vanished *is* staleness, because the plan's reasoning depended on it.
 */
export function compareReadSet(
  planned: readonly ReadSetFingerprint[],
  observed: readonly ReadSetFingerprint[],
): ReadSetComparison {
  const current = new Map(observed.map((entry) => [entry.key, entry.digest]));
  const changed: string[] = [];
  const missing: string[] = [];

  for (const entry of planned) {
    const digest = current.get(entry.key);
    if (digest === undefined) {
      missing.push(entry.key);
    } else if (digest !== entry.digest) {
      changed.push(entry.key);
    }
  }

  return changed.length === 0 && missing.length === 0
    ? { status: "unchanged" }
    : { status: "changed", changed, missing };
}

export interface PlanRecord {
  readonly reference: string;
  readonly tool: ProjectedToolName;
  readonly variant: string | undefined;
  readonly applications: readonly ApplicationId[];
  /**
   * The validated direct intent.
   *
   * Retaining it is what lets apply replay the plan without the caller
   * restating it, so the record does hold the arguments the caller supplied —
   * for the plan's lifetime, in process memory, and never in a tool result. No
   * tool accepts a credential as an argument; if one is reintroduced, the
   * requirements for handling it are in the Configuration Reconciliation spec's
   * withdrawn surface.
   *
   * Its own `mode` field still reads `plan`, because it is the arguments the
   * planning call carried; how a handler is being run is decided by
   * `OperationInvocation.mode`, never by this.
   */
  readonly intent: unknown;
  readonly requestedEffects: readonly Effect[];
  /**
   * Effects that follow only if the conditions the plan describes still hold —
   * a plan discloses them rather than presenting a mutation as narrower than it
   * is.
   */
  readonly predictedEffects: readonly Effect[];
  readonly warnings: readonly string[];
  readonly readSet: readonly ReadSetFingerprint[];
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface RecordPlanInput {
  readonly tool: ProjectedToolName;
  readonly variant: string | undefined;
  readonly applications: readonly ApplicationId[];
  readonly intent: unknown;
  readonly requestedEffects: readonly Effect[];
  readonly predictedEffects: readonly Effect[];
  readonly warnings: readonly string[];
  readonly observations: readonly ReadSetObservation[];
}

export type PlanResolution =
  | { readonly ok: true; readonly record: PlanRecord }
  | { readonly ok: false; readonly reason: ReferenceFailureReason };

export interface PlanStore {
  record(input: RecordPlanInput): PlanRecord;
  resolve(token: string): PlanResolution;
}

function planPayloadOf(entry: ReferenceEntry): PlanRecord | undefined {
  return entry.payload.kind === "plan" ? entry.payload.plan : undefined;
}

/**
 * Plan records, kept in the shared reference store.
 *
 * Plans live beside every other reference kind on purpose: a plan reference is
 * a reference, so it expires, is bound to its applications, and is rejected
 * after a restart by exactly the same code that rejects a stale queue
 * reference. Plan mode is not authorization, so nothing here records approval,
 * a caller identity, or a confirmation state.
 */
export function createPlanStore(references: ReferenceStore, clock: Clock): PlanStore {
  return {
    record(input: RecordPlanInput): PlanRecord {
      const createdAt = clock.now();
      const entry = references.mint({
        kind: "plan",
        applications: input.applications,
        payload: (reference) => ({
          kind: "plan",
          plan: {
            reference,
            tool: input.tool,
            variant: input.variant,
            applications: [...input.applications],
            intent: input.intent,
            requestedEffects: [...input.requestedEffects],
            predictedEffects: [...input.predictedEffects],
            warnings: [...input.warnings],
            readSet: fingerprintReadSet(input.observations),
            createdAt,
            expiresAt: createdAt + referenceLifetimes.plan,
          },
        }),
      });

      const record = planPayloadOf(entry);
      if (record === undefined) {
        throw new Error("A minted plan reference must hold a plan record");
      }
      return record;
    },

    resolve(token: string): PlanResolution {
      const resolution = references.resolve(token, "plan");
      if (!resolution.ok) {
        return { ok: false, reason: resolution.reason };
      }
      const record = planPayloadOf(resolution.entry);
      return record === undefined ? { ok: false, reason: "wrong_kind" } : { ok: true, record };
    },
  };
}
