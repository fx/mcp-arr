import { readCommandRecord } from "../adapters/jobs.js";
import type { JobRecord, JobStore } from "../state/jobs.js";
import type { PreconditionRead } from "../state/plans.js";
import { createToolError, type ToolError, toolErrorForReferenceFailure } from "./errors.js";
import type { OperationHandler, OperationInvocation, PreconditionReader } from "./operations.js";
import type { Effect } from "./results.js";
import type { JobCancellationProjection, JobProjection } from "./schemas/jobs.js";

/**
 * Restates a job record as the published projection.
 *
 * It carries what this server observed, never the upstream command payload: the
 * identity is a name and an id, the status is normalized, and the per-item
 * outcomes travel in the shared item list rather than in the payload.
 */
export function projectJob(record: JobRecord): JobProjection {
  return {
    job: record.reference,
    application: record.application,
    command: record.command,
    status: record.status,
    ...(record.progress === undefined ? {} : { progress: record.progress }),
    ...(record.terminal === undefined
      ? {}
      : {
          terminal: {
            status: record.terminal.status,
            result: record.terminal.result,
            at: new Date(record.terminal.at).toISOString(),
          },
        }),
    cancellable: record.cancellation.supported,
  };
}

function readJobReference(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return undefined;
  }
  const job = (input as Record<string, unknown>).job;
  return typeof job === "string" ? job : undefined;
}

type ResolvedJob =
  | { readonly ok: true; readonly record: JobRecord }
  | { readonly ok: false; readonly error: ToolError };

function resolveJob(store: JobStore, invocation: OperationInvocation): ResolvedJob {
  const reference = readJobReference(invocation.input);
  if (reference === undefined) {
    return {
      ok: false,
      error: createToolError({
        code: "invalid_input",
        message: `${invocation.application}: a job reference is required`,
        application: invocation.application,
      }),
    };
  }

  const resolution = store.resolve(reference);
  if (!resolution.ok) {
    return {
      ok: false,
      error: toolErrorForReferenceFailure(resolution.reason, "job", invocation.application),
    };
  }
  return { ok: true, record: resolution.record };
}

/** A job read's answer: the record to publish, and anything only this call saw. */
interface RefreshedJob {
  readonly record: JobRecord;
  /**
   * Warnings about the refresh itself rather than about the job. They are not
   * folded into the record, because "the instance was unreachable a moment ago"
   * describes this one call and would otherwise outlive the outage for the rest
   * of the process.
   */
  readonly warnings: readonly string[];
}

/**
 * Brings a job projection up to date with the command behind it.
 *
 * A job that has ended is answered from its terminal snapshot and nothing is
 * asked upstream. That is not an optimization: the snapshot cannot improve, and
 * re-reading it is precisely what would downgrade an observed `successful` to
 * an indefinite result once the command record ages out. Not asking is what
 * keeps the answer true.
 *
 * Anything still running is read back and folded in through the job store's own
 * observation path, so the normalization, the terminal snapshot, and the
 * warning bounds are the ones every other observation goes through. An instance
 * this server could not reach leaves the held record alone and says so, because
 * a job read is answerable with the instance switched off and turning that into
 * a failure would hide the state the caller asked for.
 */
async function refreshJob(
  invocation: OperationInvocation,
  record: JobRecord,
): Promise<RefreshedJob> {
  if (record.terminal !== undefined) {
    return { record, warnings: [] };
  }

  // The adapter is the job's own application's: dispatch binds the target from
  // the reference the input carried, so a job reference can only ever be run
  // against the instance it was minted for.
  const refresh = await readCommandRecord(
    invocation.adapter.client,
    record.application,
    record.command.upstreamId,
  );
  if (refresh.status === "unreachable") {
    return {
      record,
      warnings: [
        `${refresh.failure.message}; this projection is the state this server last observed`,
      ],
    };
  }

  const observed = invocation.state.jobs.observe(record.reference, refresh.observation);
  return { record: observed.ok ? observed.record : record, warnings: [] };
}

/**
 * Reads a job projection.
 *
 * A job still running is refreshed from its upstream command first, so the read
 * reports the state the command is in rather than the one it was in when the
 * reference was minted. A job that has ended is answered from the record alone,
 * which is why the read still answers after the upstream command record has
 * expired: the terminal snapshot outlives it.
 */
export const jobGetHandler: OperationHandler = async (invocation) => {
  const resolved = resolveJob(invocation.state.jobs, invocation);
  if (!resolved.ok) {
    return { status: "error", error: resolved.error };
  }

  const { record, warnings } = await refreshJob(invocation, resolved.record);
  return {
    status: "ok",
    data: projectJob(record),
    warnings: [...record.warnings, ...warnings],
    items: record.terminal?.items ?? record.items,
  };
};

/**
 * The read set a cancellation plan depends on: whether the job is still
 * running, and whether it can still be cancelled. Both are local facts, which
 * is what makes a stale cancellation plan detectable without an upstream call.
 */
export const jobCancelPreconditions: PreconditionReader = (invocation) => {
  const resolved = resolveJob(invocation.state.jobs, invocation);
  if (!resolved.ok) {
    // The reader's own error already carries the right code, and a reference
    // that no longer resolves is a stale reference rather than a conflict.
    return Promise.resolve<PreconditionRead>({ status: "blocked", error: resolved.error });
  }

  const record = resolved.record;
  return Promise.resolve<PreconditionRead>({
    status: "ok",
    observations: [
      { key: "job-status", value: record.status },
      { key: "job-cancellable", value: record.cancellation.supported },
    ],
  });
};

function cancellationEffect(record: JobRecord): Effect {
  return {
    application: record.application,
    severity: "consequential",
    summary: `request cancellation of ${record.command.name}`,
  };
}

/**
 * Requests cancellation of a projected job.
 *
 * Plan mode discloses the effect and predicts nothing it cannot know: a job the
 * server currently believes to be uncancellable predicts no cancellation, and a
 * cancellable one predicts a request rather than a stop, because an application
 * that accepts a cancellation is not the same as a command that halted.
 */
export const jobCancelHandler: OperationHandler = async (invocation) => {
  const resolved = resolveJob(invocation.state.jobs, invocation);
  if (!resolved.ok) {
    return { status: "error", error: resolved.error };
  }
  const record = resolved.record;

  if (invocation.mode === "plan") {
    return {
      status: "ok",
      data: projectJob(record),
      plan: {
        requestedEffects: [cancellationEffect(record)],
        predictedEffects: record.cancellation.supported ? [cancellationEffect(record)] : [],
        warnings: record.cancellation.supported
          ? []
          : ["this job cannot be cancelled; applying the plan will report it as uncancellable"],
      },
    };
  }

  const cancellation = await invocation.state.jobs.cancel(record.reference);
  if ("unresolved" in cancellation) {
    return {
      status: "error",
      error: toolErrorForReferenceFailure(cancellation.unresolved, "job", invocation.application),
    };
  }

  const projection: JobCancellationProjection = {
    ...projectJob(cancellation.record),
    outcome: cancellation.outcome,
  };
  return {
    status: "ok",
    data: projection,
    warnings: cancellation.warnings,
    effects: [cancellationEffect(record)],
    // An unconfirmed cancellation request must not leave a receipt that says
    // the mutation succeeded: the request may well have reached the
    // application, and the record has to stay open to reconciliation.
    ...(cancellation.outcome === "unknown"
      ? {
          outcomeUnknown: createToolError({
            code: "conflict",
            message: `${invocation.application}: the cancellation request was not confirmed`,
            application: invocation.application,
          }),
        }
      : {}),
  };
};
