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
import { fingerprint, secretPresenceFingerprint } from "./tokens.js";

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

/**
 * A transient secret the caller supplied for one request.
 *
 * The value never leaves the request it arrived on. It is read here only to
 * derive the presence fingerprint a plan retains, and is deliberately not a
 * field of {@link PlanRecord}.
 */
export interface TransientSecret {
  readonly name: string;
  readonly value: string;
}

export interface SecretRequirement {
  readonly name: string;
  /** Non-reversible and process-local; see `secretPresenceFingerprint`. */
  readonly presence: string;
}

const secretsProperty = "secrets";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTransientSecret(value: unknown): value is TransientSecret {
  return isRecord(value) && typeof value.name === "string" && typeof value.value === "string";
}

/**
 * Reads the transient secrets a validated mutation input carried.
 *
 * The published schemas declare `secrets` only at the root of an intent, so
 * this looks exactly there: a recursive search would invent a shape no tool
 * accepts and could report two secrets with the same name from different
 * depths.
 */
export function readTransientSecrets(input: unknown): readonly TransientSecret[] {
  if (!isRecord(input)) {
    return [];
  }
  const supplied = input[secretsProperty];
  return Array.isArray(supplied) ? supplied.filter(isTransientSecret) : [];
}

export interface StrippedIntent {
  /** The intent with every secret value removed, safe to retain in a plan. */
  readonly intent: unknown;
  readonly requiredSecrets: readonly SecretRequirement[];
}

/**
 * Separates an intent from the secrets it carried.
 *
 * A plan retains the intent so apply can replay it without the caller restating
 * it, which makes the secret values the one thing that must not survive. They
 * are replaced by names and presence fingerprints, so applying the plan
 * requires the caller to resupply each named secret for that request alone.
 */
export function stripTransientSecrets(input: unknown): StrippedIntent {
  const secrets = readTransientSecrets(input);
  if (!isRecord(input) || secrets.length === 0) {
    return { intent: input, requiredSecrets: [] };
  }

  const { [secretsProperty]: _removed, ...retained } = input;
  return {
    intent: retained,
    requiredSecrets: secrets.map((secret) => ({
      name: secret.name,
      presence: secretPresenceFingerprint(secret.name, secret.value),
    })),
  };
}

export type SecretCheck =
  | { readonly status: "satisfied"; readonly warnings: readonly string[] }
  | { readonly status: "missing"; readonly names: readonly string[] };

/**
 * Checks the secrets a caller resupplied against the ones the plan needs.
 *
 * A differing value is not an error — the caller is supplying the credential to
 * use now, and it may legitimately have been rotated since the plan — but it is
 * worth saying out loud, because a plan validated against one credential is
 * being applied with another.
 */
export function checkResuppliedSecrets(
  required: readonly SecretRequirement[],
  supplied: readonly TransientSecret[],
): SecretCheck {
  const byName = new Map(supplied.map((secret) => [secret.name, secret.value]));
  const missing: string[] = [];
  const warnings: string[] = [];

  for (const requirement of required) {
    const value = byName.get(requirement.name);
    if (value === undefined) {
      missing.push(requirement.name);
      continue;
    }
    if (secretPresenceFingerprint(requirement.name, value) !== requirement.presence) {
      warnings.push(`the resupplied ${requirement.name} differs from the value the plan validated`);
    }
  }

  return missing.length > 0
    ? { status: "missing", names: missing }
    : { status: "satisfied", warnings };
}

export interface PlanRecord {
  readonly reference: string;
  readonly tool: ProjectedToolName;
  readonly variant: string | undefined;
  readonly applications: readonly ApplicationId[];
  /**
   * The validated direct intent, with every transient secret value removed.
   *
   * Retaining the rest of the intent is what lets apply replay it without the
   * caller restating it, so the record does hold the arguments the caller
   * supplied — for the plan's lifetime, in process memory, and never in a tool
   * result. The declared channel for anything that must not be retained is the
   * `secrets` array, whose values are stripped here; a credential placed in an
   * ordinary field instead is retained like any other argument, which is why
   * the tool that accepts such fields documents the secret channel as the way
   * to supply one.
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
  readonly requiredSecrets: readonly SecretRequirement[];
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
      const stripped = stripTransientSecrets(input.intent);
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
            intent: stripped.intent,
            requestedEffects: [...input.requestedEffects],
            predictedEffects: [...input.predictedEffects],
            warnings: [...input.warnings],
            readSet: fingerprintReadSet(input.observations),
            requiredSecrets: stripped.requiredSecrets,
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
