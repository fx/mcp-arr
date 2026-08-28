import type { UpstreamFailure } from "../adapters/registry.js";
import type { ApplicationId } from "../applications.js";
import type { ItemOutcome } from "../tools/results.js";
import type { Clock } from "./clock.js";
import type { ReferenceEntry, ReferenceFailureReason, ReferenceStore } from "./references.js";

/**
 * The normalized job vocabulary.
 *
 * `unknown` is a first-class status rather than an error: an upstream command
 * record is itself ephemeral, so a job this server projected can outlive the
 * command it was projected from. Saying so is more useful than inventing a
 * status or failing the read.
 */
export const jobStatuses = [
  "queued",
  "started",
  "completed",
  "failed",
  "aborted",
  "cancelled",
  "unknown",
] as const;

export type JobStatus = (typeof jobStatuses)[number];

export const terminalJobStatuses = ["completed", "failed", "aborted", "cancelled"] as const;

export type TerminalJobStatus = (typeof terminalJobStatuses)[number];

const terminalStatusSet: ReadonlySet<JobStatus> = new Set<JobStatus>(terminalJobStatuses);

export function isTerminalJobStatus(status: JobStatus): status is TerminalJobStatus {
  return terminalStatusSet.has(status);
}

/**
 * What a completed command's separate result says about how it ended.
 *
 * Three answers, and the difference between the last two is the whole point.
 * `successful` and `unsuccessful` are the two words the applications were
 * observed to use, and they decide the outcome. **No** result at all is
 * Prowlarr, which sends the field on no command it answers: an application that
 * reports only a state has said the command finished and nothing more, and a
 * finished command with nothing said against it is a completion.
 *
 * A result that is *present* and is neither word — `unknown` is the one
 * observed — is a different answer entirely. The application was asked how the
 * command ended and declined to say. Reading that as a completion would publish
 * a definite success the application refused to state, and because a completion
 * is terminal the projection would never be revisited, so the invention would be
 * permanent. So it becomes `unknown`: the job stays open to a later reading, and
 * no caller reads a success out of a non-answer.
 */
function completedCommandStatus(result: string | undefined): JobStatus {
  const reported = result?.trim().toLowerCase();
  switch (reported) {
    // Absent, and blank — which the upstream parser already normalizes to
    // absent — are the same statement: nothing was said beyond "it finished".
    case undefined:
    case "":
    case "successful":
      return "completed";
    case "unsuccessful":
      return "failed";
    default:
      return "unknown";
  }
}

/**
 * Maps an upstream command's reported state onto the normalized vocabulary.
 *
 * Sonarr, Radarr, and Prowlarr all report a command state alongside a separate
 * result, and a command that finished unsuccessfully reports `completed` with
 * an unsuccessful result. Folding the two together here is what stops a failed
 * command from being projected as a successful one, and stops a result the
 * application would not commit to from being projected as either. Anything this
 * function does not recognize becomes `unknown` rather than a guess.
 */
export function normalizeJobStatus(
  state: string | undefined,
  result?: string | undefined,
): JobStatus {
  switch (state?.toLowerCase()) {
    case "queued":
      return "queued";
    case "started":
    case "running":
      return "started";
    case "completed":
      return completedCommandStatus(result);
    case "failed":
      return "failed";
    case "aborted":
      return "aborted";
    case "cancelled":
    case "canceled":
      return "cancelled";
    default:
      return "unknown";
  }
}

/** How a terminal job ended, independent of which upstream word produced it. */
export const jobResults = ["succeeded", "failed", "cancelled", "aborted"] as const;

export type JobResult = (typeof jobResults)[number];

export function jobResultFor(status: TerminalJobStatus): JobResult {
  switch (status) {
    case "completed":
      return "succeeded";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "aborted":
      return "aborted";
  }
}

export interface JobProgress {
  readonly completed: number;
  readonly total: number;
}

/** The upstream command a job stands for. Never a command name a caller chose. */
export interface UpstreamCommandIdentity {
  readonly name: string;
  /** Kept as a string so both integer and GUID command ids fit unchanged. */
  readonly upstreamId: string;
}

/**
 * A snapshot preserved when a job reaches a terminal status.
 *
 * It exists because the upstream command record is discarded fairly quickly,
 * while a caller may only read the job afterwards. Once written it is never
 * overwritten, so a later read that can no longer see the command still reports
 * what the job actually did.
 */
export interface JobTerminalSnapshot {
  readonly status: TerminalJobStatus;
  readonly result: JobResult;
  readonly items: readonly ItemOutcome[];
  readonly at: number;
}

/**
 * Whether the upstream command behind a job can be cancelled, and how to ask.
 *
 * The request is a function rather than a route because nothing about the
 * upstream call belongs in this store: the domain change that started the job
 * supplies the call, and this store only decides what its answer means.
 */
export type JobCancellationSupport =
  | { readonly supported: false }
  | { readonly supported: true; readonly request: JobCancellationRequest };

export type JobCancellationRequest = () => Promise<CancellationAcknowledgement>;

/**
 * What upstream said about a cancellation request. These are observations, not
 * outcomes: the store turns them into an outcome together with what it already
 * knows about the job, so no adapter can report a cancellation that did not
 * happen.
 */
export type CancellationAcknowledgement =
  /** Upstream confirmed the command is no longer running. */
  | { readonly kind: "accepted" }
  /** Upstream took the request; the command may still be winding down. */
  | { readonly kind: "requested" }
  /** Upstream refuses: this command cannot be cancelled. */
  | { readonly kind: "rejected" }
  /** The command had already finished before the request arrived. */
  | { readonly kind: "already_finished"; readonly status: TerminalJobStatus }
  | { readonly kind: "unavailable"; readonly failure: UpstreamFailure };

export interface JobRecord {
  readonly reference: string;
  readonly application: ApplicationId;
  readonly command: UpstreamCommandIdentity;
  readonly status: JobStatus;
  readonly progress?: JobProgress | undefined;
  readonly items: readonly ItemOutcome[];
  readonly warnings: readonly string[];
  readonly terminal?: JobTerminalSnapshot | undefined;
  readonly cancellation: JobCancellationSupport;
  /** When this projection last reflected an upstream observation. */
  readonly observedAt: number;
}

/**
 * One observation of an upstream command, already read and shaped by an
 * adapter. `state` and `result` are the upstream words; normalization happens
 * here so every application's commands project identically.
 */
export interface UpstreamCommandObservation {
  readonly state?: string | undefined;
  readonly result?: string | undefined;
  readonly progress?: JobProgress | undefined;
  readonly items?: readonly ItemOutcome[] | undefined;
  readonly warnings?: readonly string[] | undefined;
}

export interface ProjectJobInput {
  readonly application: ApplicationId;
  readonly command: UpstreamCommandIdentity;
  readonly observation: UpstreamCommandObservation;
  readonly cancellation: JobCancellationSupport;
}

export type JobResolution =
  | { readonly ok: true; readonly record: JobRecord }
  | { readonly ok: false; readonly reason: ReferenceFailureReason };

/** The five answers `arr_job_cancel` is allowed to give. */
export const jobCancelOutcomes = [
  "cancelled",
  "cancellation_requested",
  "uncancellable",
  "completed",
  "unknown",
] as const;

export type JobCancelOutcome = (typeof jobCancelOutcomes)[number];

export interface JobCancellation {
  readonly outcome: JobCancelOutcome;
  readonly record: JobRecord;
  readonly warnings: readonly string[];
}

/**
 * How many distinct warnings one job projection retains. Enough to describe
 * what went wrong with a job, and small enough that a chatty upstream source
 * cannot turn a process-lifetime record into a log.
 */
export const maxJobWarnings = 20;

/** Appended in place of the warnings the cap discarded, so the loss is visible. */
export const droppedWarningNotice = "older warnings for this job were dropped";

export interface JobStore {
  project(input: ProjectJobInput): JobRecord;
  /**
   * Folds a fresh upstream observation into an existing projection. A terminal
   * snapshot already written is preserved, so a later observation that can no
   * longer see the command cannot erase what the job did.
   */
  observe(reference: string, observation: UpstreamCommandObservation): JobResolution;
  resolve(reference: string): JobResolution;
  /**
   * Requests cancellation and reports which of the five outcomes actually
   * happened. `unresolved` is the sixth possibility and is not an outcome: the
   * reference itself did not resolve, so nothing was requested.
   */
  cancel(
    reference: string,
  ): Promise<JobCancellation | { readonly unresolved: ReferenceFailureReason }>;
}

function jobPayloadOf(entry: ReferenceEntry): JobRecord | undefined {
  return entry.payload.kind === "job" ? entry.payload.job : undefined;
}

/**
 * Job projections, kept in the shared reference store.
 *
 * The upstream application stays authoritative for what a command is doing;
 * this store only holds the normalization and the terminal snapshot, both of
 * which vanish with the process. Nothing here polls: an observation arrives
 * when a tool call reads the command.
 */
export function createJobStore(references: ReferenceStore, clock: Clock): JobStore {
  const write = (record: JobRecord): JobRecord => {
    references.update(record.reference, "job", { kind: "job", job: record });
    return record;
  };

  const resolve = (reference: string): JobResolution => {
    const resolution = references.resolve(reference, "job");
    if (!resolution.ok) {
      return { ok: false, reason: resolution.reason };
    }
    const record = jobPayloadOf(resolution.entry);
    return record === undefined ? { ok: false, reason: "wrong_kind" } : { ok: true, record };
  };

  /**
   * Merges a new observation's warnings into the ones already held.
   *
   * Two bounds, because a job projection lives for the whole process. Repeats
   * are dropped, since polling a stalled job re-reports the same warning every
   * time and a warning is a statement about the job, so saying it once is
   * saying it. Distinct warnings are capped as well, because an upstream source
   * that stamps a time or a counter into its text defeats de-duplication
   * entirely. The newest are kept — a projection describes the job now — and
   * the loss is disclosed rather than silent.
   */
  const mergeWarnings = (
    existing: readonly string[],
    observed: readonly string[] | undefined,
  ): readonly string[] => {
    const merged = [
      ...new Set([
        ...existing.filter((warning) => warning !== droppedWarningNotice),
        ...(observed ?? []),
      ]),
    ];

    // Once the cap has bitten, the notice stays and the content keeps its own
    // smaller ceiling. Recomputing "did it overflow" from the merged length
    // alone would let the notice appear and disappear on alternating reads as
    // dropping it freed the very slot that made the list fit.
    if (!existing.includes(droppedWarningNotice) && merged.length <= maxJobWarnings) {
      return merged;
    }
    const retained = maxJobWarnings - 1;
    return [droppedWarningNotice, ...merged.slice(Math.max(0, merged.length - retained))];
  };

  const fold = (record: JobRecord, observation: UpstreamCommandObservation): JobRecord => {
    const now = clock.now();
    const observed = normalizeJobStatus(observation.state, observation.result);
    const items = observation.items ?? record.items;

    // A job that already ended keeps the status and items it ended with. Only
    // the observation timestamp and any new warning move afterwards.
    if (record.terminal !== undefined) {
      return {
        ...record,
        status: record.terminal.status,
        items: record.terminal.items,
        warnings: mergeWarnings(record.warnings, observation.warnings),
        observedAt: now,
      };
    }

    const terminal: JobTerminalSnapshot | undefined = isTerminalJobStatus(observed)
      ? { status: observed, result: jobResultFor(observed), items, at: now }
      : undefined;

    return {
      ...record,
      status: observed,
      progress: observation.progress ?? record.progress,
      items,
      warnings: mergeWarnings(record.warnings, observation.warnings),
      terminal,
      // Nothing that has ended can be cancelled, and keeping the request around
      // would let a later call send a pointless upstream cancellation.
      cancellation: terminal === undefined ? record.cancellation : { supported: false },
      observedAt: now,
    };
  };

  return {
    project(input: ProjectJobInput): JobRecord {
      const now = clock.now();
      const status = normalizeJobStatus(input.observation.state, input.observation.result);
      const items = input.observation.items ?? [];
      const terminal: JobTerminalSnapshot | undefined = isTerminalJobStatus(status)
        ? { status, result: jobResultFor(status), items, at: now }
        : undefined;

      const entry = references.mint({
        kind: "job",
        applications: [input.application],
        payload: (reference) => ({
          kind: "job",
          job: {
            reference,
            application: input.application,
            command: input.command,
            status,
            progress: input.observation.progress,
            items,
            warnings: mergeWarnings([], input.observation.warnings),
            terminal,
            cancellation: terminal === undefined ? input.cancellation : { supported: false },
            observedAt: now,
          },
        }),
      });

      const record = jobPayloadOf(entry);
      if (record === undefined) {
        throw new Error("A minted job reference must hold a job record");
      }
      return record;
    },

    observe(reference: string, observation: UpstreamCommandObservation): JobResolution {
      const resolution = resolve(reference);
      return resolution.ok
        ? { ok: true, record: write(fold(resolution.record, observation)) }
        : resolution;
    },

    resolve,

    async cancel(
      reference: string,
    ): Promise<JobCancellation | { readonly unresolved: ReferenceFailureReason }> {
      const resolution = resolve(reference);
      if (!resolution.ok) {
        return { unresolved: resolution.reason };
      }
      const record = resolution.record;

      if (record.terminal !== undefined) {
        return {
          outcome: record.terminal.status === "cancelled" ? "cancelled" : "completed",
          record,
          warnings: [],
        };
      }
      if (!record.cancellation.supported) {
        return { outcome: "uncancellable", record, warnings: [] };
      }

      let acknowledgement: CancellationAcknowledgement;
      try {
        acknowledgement = await record.cancellation.request();
      } catch {
        // A thrown cancellation is exactly the case where pretending is worst:
        // the request may well have reached the application.
        return {
          outcome: "unknown",
          record: write({ ...record, status: "unknown", observedAt: clock.now() }),
          warnings: ["the cancellation request failed before an answer was received"],
        };
      }

      return settleCancellation(record, acknowledgement, clock, write);
    },
  };
}

/**
 * Turns one upstream acknowledgement into one of the five outcomes.
 *
 * The mapping is deliberately pessimistic. Only an acknowledgement that
 * upstream considers the command finished produces `cancelled`; a request
 * upstream merely accepted produces `cancellation_requested`, and anything this
 * server could not confirm produces `unknown`.
 */
function settleCancellation(
  record: JobRecord,
  acknowledgement: CancellationAcknowledgement,
  clock: Clock,
  write: (record: JobRecord) => JobRecord,
): JobCancellation {
  const now = clock.now();

  switch (acknowledgement.kind) {
    case "accepted":
      return {
        outcome: "cancelled",
        record: write({
          ...record,
          status: "cancelled",
          terminal: { status: "cancelled", result: "cancelled", items: record.items, at: now },
          cancellation: { supported: false },
          observedAt: now,
        }),
        warnings: [],
      };

    case "requested":
      return {
        outcome: "cancellation_requested",
        record: write({ ...record, observedAt: now }),
        warnings: ["the application accepted the request; the command has not stopped yet"],
      };

    case "rejected":
      return {
        outcome: "uncancellable",
        record: write({ ...record, cancellation: { supported: false }, observedAt: now }),
        warnings: [],
      };

    case "already_finished": {
      const status = acknowledgement.status;
      return {
        outcome: status === "cancelled" ? "cancelled" : "completed",
        record: write({
          ...record,
          status,
          terminal: { status, result: jobResultFor(status), items: record.items, at: now },
          cancellation: { supported: false },
          observedAt: now,
        }),
        warnings: [],
      };
    }

    case "unavailable":
      return {
        outcome: "unknown",
        record: write({ ...record, status: "unknown", observedAt: now }),
        // Already redacted by the upstream boundary: no body, header, or key.
        warnings: [acknowledgement.failure.message],
      };
  }
}
