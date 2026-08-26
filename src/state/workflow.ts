import { type ApplyRecordStore, createApplyRecordStore } from "./apply-records.js";
import { type Clock, systemClock } from "./clock.js";
import { createJobStore, type JobStore } from "./jobs.js";
import { createPlanStore, type PlanStore } from "./plans.js";
import { createReferenceStore, type ReferenceStore } from "./references.js";

/**
 * Every piece of state this server owns.
 *
 * All of it is process memory: there is no database, no local file, and no
 * recovery path across a restart. That is the deliberate design — the upstream
 * applications stay authoritative, and anything this server would have to
 * persist is instead re-derived by asking them again.
 *
 * The four stores share one reference store so a plan, a receipt, and a job
 * reference expire, bind to an application, and reject a previous lifetime by
 * exactly the same code that governs a queue or release reference.
 */
export interface WorkflowState {
  readonly clock: Clock;
  readonly references: ReferenceStore;
  readonly plans: PlanStore;
  readonly applies: ApplyRecordStore;
  readonly jobs: JobStore;
}

export interface WorkflowStateOptions {
  /** Injected so expiration is testable by assignment rather than by sleeping. */
  readonly clock?: Clock | undefined;
  /**
   * Fixes the process lifetime identifier. Supplied only by tests that need two
   * stores to disagree about which process minted a reference.
   */
  readonly lifetimeId?: string | undefined;
  readonly maxReferences?: number | undefined;
}

export function createWorkflowState(options: WorkflowStateOptions = {}): WorkflowState {
  const clock = options.clock ?? systemClock;
  const references = createReferenceStore({
    clock,
    lifetimeId: options.lifetimeId,
    maxEntries: options.maxReferences,
  });

  return {
    clock,
    references,
    plans: createPlanStore(references, clock),
    applies: createApplyRecordStore(references, clock),
    jobs: createJobStore(references, clock),
  };
}
