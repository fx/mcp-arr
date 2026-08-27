import type { ApplicationId } from "../applications.js";
import type { ToolError } from "../tools/errors.js";
import type { ProjectedToolName } from "../tools/names.js";
import type { ApplyRecordState, ItemOutcome } from "../tools/results.js";
import type { Clock } from "./clock.js";
import { readTransientSecrets } from "./plans.js";
import type { ReferenceEntry, ReferenceFailureReason, ReferenceStore } from "./references.js";
import { canonicalJson, fingerprint } from "./tokens.js";

/**
 * The in-memory receipt for one mutation.
 *
 * It is created before the mutation is sent, which is the only ordering that
 * makes a lost response recoverable: a record that only existed after a
 * successful reply would be missing in exactly the case it is needed.
 */
export interface ApplyRecord {
  readonly reference: string;
  readonly tool: ProjectedToolName;
  readonly variant: string | undefined;
  readonly application: ApplicationId;
  /**
   * Identifies the exact mutation this record stands for. The published input
   * schemas carry no apply-reference field, so repeating an apply is repeating
   * its arguments; keying the record by a digest of those arguments is what
   * makes the repeat resolve to this same record instead of a second mutation.
   */
  readonly key: string;
  readonly state: ApplyRecordState;
  /** How many times a mutation was actually sent for this record. */
  readonly attempts: number;
  readonly startedAt: number;
  readonly settledAt?: number | undefined;
  readonly error?: ToolError | undefined;
  /** The job this mutation started, when it started one. */
  readonly job?: string | undefined;
  /**
   * The per-item outcomes the mutation reported, retained because the receipt
   * is the whole of what a repeat is answered from.
   *
   * A bulk mutation is not transactional, so one that partly failed is a normal
   * result rather than an error — and a record that kept only its state would
   * answer the repeat with an unqualified success, concealing exactly the
   * partial failure the caller repeated it to see.
   */
  readonly items?: readonly ItemOutcome[] | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Rewrites a value so nothing a caller chose about ordering can be seen.
 *
 * Every collection a mutation intent carries is a set in meaning — the queue
 * items to resolve, the releases to grab, the fields to reconcile, the secrets
 * to resupply — and none of the published schemas gives an array's order a
 * meaning. So naming the same two items in the other order is the same
 * mutation, and it has to reach the same receipt; if it did not, the reordered
 * repeat would miss the record and be sent upstream a second time, which is
 * exactly the duplicate the receipt exists to prevent.
 *
 * Duplicates collapse for the same reason: naming one item twice does not ask
 * for two mutations. Object property order needs no handling here because
 * {@link canonicalJson} already sorts keys.
 */
function orderIndependent(value: unknown): unknown {
  if (Array.isArray(value)) {
    const unique = new Map<string, unknown>();
    for (const item of value) {
      const canonical = orderIndependent(item);
      unique.set(canonicalJson(canonical), canonical);
    }
    return [...unique.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([, item]) => item);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, orderIndependent(item)]),
    );
  }
  return value;
}

/**
 * Derives the identity of an apply.
 *
 * Two fields are deliberately excluded. Secret values are excluded rather than
 * hashed in, because a receipt that survives for the process lifetime must not
 * depend on a credential and two applies differing only in a rotated password
 * are the same mutation. `mode` is excluded because it records how the caller
 * arrived, not what it is changing: an intent that was planned first and the
 * same intent supplied directly must land on one receipt, or the second route
 * would send the mutation a second time.
 *
 * What remains is then made independent of every ordering the caller controls;
 * see {@link orderIndependent}.
 */
export function applyIntentKey(input: BeginApplyInput): string {
  return fingerprint({
    tool: input.tool,
    variant: input.variant ?? null,
    application: input.application,
    intent: orderIndependent(identifyingFields(input.intent)),
  });
}

function identifyingFields(intent: unknown): unknown {
  if (!isRecord(intent)) {
    return intent;
  }
  const { mode: _mode, secrets: _secrets, ...identifying } = intent;
  const names = readTransientSecrets(intent).map((secret) => secret.name);
  return names.length === 0 ? identifying : { ...identifying, secrets: names };
}

export interface BeginApplyInput {
  readonly tool: ProjectedToolName;
  readonly variant: string | undefined;
  readonly application: ApplicationId;
  /** The validated apply intent, exactly as the mutation will be built from it. */
  readonly intent: unknown;
}

/**
 * Whether the caller may send the mutation.
 *
 * `replayed` is the whole point of the store: it means an identical apply
 * already exists, so the existing receipt is returned and nothing is sent
 * upstream. There is no third answer that quietly sends the mutation again.
 */
export type ApplyAttempt =
  | { readonly status: "proceed"; readonly record: ApplyRecord }
  | { readonly status: "replayed"; readonly record: ApplyRecord };

export type ApplySettlement =
  | {
      readonly status: "succeeded";
      readonly job?: string | undefined;
      readonly items?: readonly ItemOutcome[] | undefined;
    }
  | { readonly status: "failed"; readonly error: ToolError }
  /** The request may have been accepted and the answer was lost. */
  | {
      readonly status: "outcome_unknown";
      readonly error: ToolError;
      readonly items?: readonly ItemOutcome[] | undefined;
    };

/**
 * What authoritative upstream state says about a mutation whose outcome was
 * lost. The readers that produce this arrive with the domain changes that know
 * where to look — queue, history, command, library, or configuration state.
 */
export type ApplyReconciliation =
  | { readonly status: "succeeded"; readonly job?: string | undefined }
  | { readonly status: "failed"; readonly error: ToolError }
  /** Upstream could not answer either; the record stays outcome-unknown. */
  | { readonly status: "indeterminate" };

export type ApplyReconciliationReader = (record: ApplyRecord) => Promise<ApplyReconciliation>;

export type ApplyReconcileResult =
  | { readonly status: "reconciled"; readonly record: ApplyRecord }
  | { readonly status: "indeterminate"; readonly record: ApplyRecord }
  /** The record already has a settled outcome, or has not been sent yet. */
  | { readonly status: "not_applicable"; readonly record: ApplyRecord }
  | { readonly status: "unresolved"; readonly reason: ReferenceFailureReason };

export type ApplyResolution =
  | { readonly ok: true; readonly record: ApplyRecord }
  | { readonly ok: false; readonly reason: ReferenceFailureReason };

export interface ApplyRecordStore {
  /**
   * Claims the right to send one mutation. Always call this before the upstream
   * request, and honor a `replayed` answer by returning its record unchanged.
   */
  begin(input: BeginApplyInput): ApplyAttempt;
  /**
   * Looks up the receipt an identical apply already produced, without creating
   * one. It exists so a caller can answer a repeat from the existing record
   * before it does anything else — a retry must reach its receipt even when the
   * mutation it is retrying has already changed the state a plan was validated
   * against.
   */
  find(input: BeginApplyInput): ApplyRecord | undefined;
  settle(reference: string, settlement: ApplySettlement): ApplyRecord | undefined;
  resolve(reference: string): ApplyResolution;
  /**
   * Re-derives a lost outcome from authoritative upstream state. Only an
   * outcome-unknown record is reconcilable; a settled one is returned as-is
   * rather than being re-opened.
   */
  reconcile(reference: string, reader: ApplyReconciliationReader): Promise<ApplyReconcileResult>;
}

function applyPayloadOf(entry: ReferenceEntry): ApplyRecord | undefined {
  return entry.payload.kind === "apply" ? entry.payload.apply : undefined;
}

/**
 * Apply records, kept in the shared reference store.
 *
 * The state machine is deliberately small. A record starts `applying`, settles
 * to `succeeded`, `failed`, or `outcome_unknown`, and only `outcome_unknown` can
 * move again — through reconciliation against upstream, never through a second
 * blind mutation. A `failed` record is the one case a fresh attempt is allowed
 * to reuse, because a mutation upstream rejected demonstrably did not take
 * effect, so retrying it is a retry rather than a duplicate.
 */
export function createApplyRecordStore(references: ReferenceStore, clock: Clock): ApplyRecordStore {
  const byKey = new Map<string, string>();

  const write = (record: ApplyRecord): ApplyRecord => {
    references.update(record.reference, "apply", { kind: "apply", apply: record });
    return record;
  };

  const resolve = (reference: string): ApplyResolution => {
    const resolution = references.resolve(reference, "apply");
    if (!resolution.ok) {
      return { ok: false, reason: resolution.reason };
    }
    const record = applyPayloadOf(resolution.entry);
    return record === undefined ? { ok: false, reason: "wrong_kind" } : { ok: true, record };
  };

  /**
   * Resolves the record a key currently names, dropping the index entry when
   * the reference store no longer holds it, so a long-running process does not
   * accumulate keys pointing at records nothing can resolve.
   */
  const recorded = (key: string): ApplyRecord | undefined => {
    const reference = byKey.get(key);
    if (reference === undefined) {
      return undefined;
    }
    const resolution = resolve(reference);
    if (!resolution.ok) {
      byKey.delete(key);
      return undefined;
    }
    return resolution.record;
  };

  return {
    find(input: BeginApplyInput): ApplyRecord | undefined {
      return recorded(applyIntentKey(input));
    },

    begin(input: BeginApplyInput): ApplyAttempt {
      const key = applyIntentKey(input);
      const now = clock.now();
      const existing = recorded(key);

      if (existing !== undefined) {
        if (existing.state !== "failed") {
          return { status: "replayed", record: existing };
        }
        return {
          status: "proceed",
          record: write({
            ...existing,
            state: "applying",
            attempts: existing.attempts + 1,
            startedAt: now,
            settledAt: undefined,
            error: undefined,
          }),
        };
      }

      const entry = references.mint({
        kind: "apply",
        applications: [input.application],
        payload: (reference) => ({
          kind: "apply",
          apply: {
            reference,
            tool: input.tool,
            variant: input.variant,
            application: input.application,
            key,
            state: "applying",
            attempts: 1,
            startedAt: now,
          },
        }),
      });

      const record = applyPayloadOf(entry);
      if (record === undefined) {
        throw new Error("A minted apply reference must hold an apply record");
      }
      byKey.set(key, record.reference);
      return { status: "proceed", record };
    },

    settle(reference: string, settlement: ApplySettlement): ApplyRecord | undefined {
      const resolution = resolve(reference);
      if (!resolution.ok) {
        return undefined;
      }
      return write({
        ...resolution.record,
        state: settlement.status,
        settledAt: clock.now(),
        error: settlement.status === "succeeded" ? undefined : settlement.error,
        job: settlement.status === "succeeded" ? settlement.job : resolution.record.job,
        items:
          settlement.status === "failed"
            ? resolution.record.items
            : (settlement.items ?? resolution.record.items),
      });
    },

    resolve,

    async reconcile(
      reference: string,
      reader: ApplyReconciliationReader,
    ): Promise<ApplyReconcileResult> {
      const resolution = resolve(reference);
      if (!resolution.ok) {
        return { status: "unresolved", reason: resolution.reason };
      }
      const record = resolution.record;
      if (record.state !== "outcome_unknown") {
        return { status: "not_applicable", record };
      }

      const outcome = await reader(record);

      // The reader awaited an upstream read, so the record may have moved on
      // while it did. Re-reading before writing keeps a concurrent settlement,
      // which observed the mutation itself, from being overwritten by a
      // reconciliation that observed only its aftermath.
      const current = resolve(reference);
      if (!current.ok) {
        return { status: "unresolved", reason: current.reason };
      }
      if (current.record.state !== "outcome_unknown") {
        return { status: "not_applicable", record: current.record };
      }
      if (outcome.status === "indeterminate") {
        return { status: "indeterminate", record: current.record };
      }

      return {
        status: "reconciled",
        record: write({
          ...current.record,
          state: outcome.status,
          settledAt: clock.now(),
          error: outcome.status === "failed" ? outcome.error : undefined,
          job: outcome.status === "succeeded" ? outcome.job : current.record.job,
        }),
      };
    },
  };
}
