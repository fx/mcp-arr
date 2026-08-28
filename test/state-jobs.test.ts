import { describe, expect, it } from "vitest";
import { createManualClock, type ManualClock } from "../src/state/clock.js";
import {
  type CancellationAcknowledgement,
  createJobStore,
  droppedWarningNotice,
  isTerminalJobStatus,
  type JobStore,
  jobCancelOutcomes,
  jobResultFor,
  maxJobWarnings,
  normalizeJobStatus,
} from "../src/state/jobs.js";
import { createReferenceStore } from "../src/state/references.js";
import { createToolError } from "../src/tools/errors.js";
import type { ItemOutcome } from "../src/tools/results.js";

const command = { name: "SeriesSearch", upstreamId: "912" };

const perItem: readonly ItemOutcome[] = [
  { reference: "med_00000001", status: "ok", warnings: [] },
  {
    reference: "med_00000002",
    status: "error",
    warnings: [],
    error: createToolError({
      code: "upstream_rejection",
      message: "sonarr: no release satisfied the profile",
      application: "sonarr",
    }),
  },
];

function store(now = 0): { jobs: JobStore; clock: ManualClock } {
  const clock = createManualClock(now);
  return { jobs: createJobStore(createReferenceStore({ clock }), clock), clock };
}

function acknowledging(acknowledgement: CancellationAcknowledgement) {
  return { supported: true, request: async () => acknowledgement } as const;
}

describe("job status normalization", () => {
  it("maps every upstream command state onto the normalized vocabulary", () => {
    expect(normalizeJobStatus("queued")).toBe("queued");
    expect(normalizeJobStatus("started")).toBe("started");
    expect(normalizeJobStatus("running")).toBe("started");
    expect(normalizeJobStatus("completed")).toBe("completed");
    expect(normalizeJobStatus("failed")).toBe("failed");
    expect(normalizeJobStatus("aborted")).toBe("aborted");
    expect(normalizeJobStatus("cancelled")).toBe("cancelled");
    expect(normalizeJobStatus("canceled")).toBe("cancelled");
    expect(normalizeJobStatus("Started")).toBe("started");
  });

  it("does not project an unsuccessful command as a successful one", () => {
    expect(normalizeJobStatus("completed", "unsuccessful")).toBe("failed");
    expect(normalizeJobStatus("completed", "successful")).toBe("completed");
  });

  it("separates a result an application never sends from one it declined to state", () => {
    // Prowlarr sends no result field on any command it answers, so a completed
    // command with no result is simply a completion.
    expect(normalizeJobStatus("completed")).toBe("completed");
    expect(normalizeJobStatus("completed", undefined)).toBe("completed");
    expect(normalizeJobStatus("completed", "  ")).toBe("completed");

    // A result that is present and indefinite is the opposite: the application
    // was asked how the command ended and would not say. `completed` is
    // terminal, so reading it as one would publish a success the application
    // refused to state and nothing would ever revisit it.
    expect(jobResultFor("completed")).toBe("succeeded");
    expect(normalizeJobStatus("completed", "unknown")).toBe("unknown");
    expect(normalizeJobStatus("completed", "Unknown")).toBe("unknown");
    expect(normalizeJobStatus("completed", "partial")).toBe("unknown");
  });

  it("reports an unrecognized or absent state as unknown rather than guessing", () => {
    expect(normalizeJobStatus(undefined)).toBe("unknown");
    expect(normalizeJobStatus("")).toBe("unknown");
    expect(normalizeJobStatus("marooned")).toBe("unknown");
  });

  it("settles an orphaned command instead of polling one that will never move", () => {
    // `orphaned` is a real upstream command status — this project's own
    // activity model lists it — and it means the command was queued or running
    // when the application restarted and will not be resumed. Left
    // unrecognized it normalizes to the non-terminal `unknown`, which since
    // this change means a read that asks the instance again every single time.
    expect(normalizeJobStatus("orphaned")).toBe("aborted");
    expect(normalizeJobStatus("Orphaned")).toBe("aborted");
    expect(isTerminalJobStatus(normalizeJobStatus("orphaned"))).toBe(true);
    expect(jobResultFor("aborted")).toBe("aborted");
  });

  it("summarizes how each terminal status ended", () => {
    expect(jobResultFor("completed")).toBe("succeeded");
    expect(jobResultFor("failed")).toBe("failed");
    expect(jobResultFor("cancelled")).toBe("cancelled");
    expect(jobResultFor("aborted")).toBe("aborted");
  });
});

describe("job projection", () => {
  it("projects a running command with its identity, progress, and cancellability", () => {
    const { jobs } = store(2_000);
    const record = jobs.project({
      application: "sonarr",
      command,
      observation: { state: "started", progress: { completed: 3, total: 10 } },
      cancellation: acknowledging({ kind: "accepted" }),
    });

    expect(record.reference.startsWith("job_")).toBe(true);
    expect(record.application).toBe("sonarr");
    expect(record.command).toEqual(command);
    expect(record.status).toBe("started");
    expect(record.progress).toEqual({ completed: 3, total: 10 });
    expect(record.terminal).toBeUndefined();
    expect(record.cancellation.supported).toBe(true);
    expect(record.observedAt).toBe(2_000);
  });

  it("folds a later observation into the projection", () => {
    const { jobs, clock } = store(0);
    const record = jobs.project({
      application: "radarr",
      command,
      observation: { state: "queued" },
      cancellation: acknowledging({ kind: "requested" }),
    });

    clock.advance(1_500);
    const observed = jobs.observe(record.reference, {
      state: "started",
      progress: { completed: 1, total: 4 },
      warnings: ["one indexer did not answer"],
    });

    expect(observed.ok && observed.record.status).toBe("started");
    expect(observed.ok && observed.record.progress).toEqual({ completed: 1, total: 4 });
    expect(observed.ok && observed.record.warnings).toEqual(["one indexer did not answer"]);
    expect(observed.ok && observed.record.observedAt).toBe(1_500);
  });

  it("surfaces per-item outcomes instead of concealing a partial failure", () => {
    const { jobs } = store();
    const record = jobs.project({
      application: "sonarr",
      command,
      observation: { state: "completed", items: perItem },
      cancellation: { supported: false },
    });

    expect(record.items).toEqual(perItem);
    expect(record.terminal?.items).toEqual(perItem);
    expect(record.terminal?.result).toBe("succeeded");
    expect(record.items.filter((item) => item.status === "error")).toHaveLength(1);
  });

  it("does not settle a job on a result the application declined to state", () => {
    const { jobs, clock } = store(0);
    const record = jobs.project({
      application: "sonarr",
      command,
      observation: { state: "completed", result: "unknown" },
      cancellation: { supported: false },
    });

    // No snapshot, so nothing published a success, and the job stays open to a
    // later reading rather than being frozen on the non-answer.
    expect(record.status).toBe("unknown");
    expect(record.terminal).toBeUndefined();

    clock.advance(1_000);
    const later = jobs.observe(record.reference, {
      state: "completed",
      result: "successful",
      items: perItem,
    });

    expect(later.ok && later.record.status).toBe("completed");
    expect(later.ok && later.record.terminal).toEqual({
      status: "completed",
      result: "succeeded",
      items: perItem,
      at: 1_000,
    });
  });

  it("settles a job whose command was orphaned by an application restart", () => {
    const { jobs, clock } = store(0);
    const record = jobs.project({
      application: "sonarr",
      command,
      observation: { state: "queued" },
      cancellation: acknowledging({ kind: "accepted" }),
    });

    clock.advance(500);
    const orphaned = jobs.observe(record.reference, { state: "orphaned" });

    // Terminal, so the read that follows is answered from the snapshot and
    // nothing asks the instance about a command that will never run again.
    expect(orphaned.ok && orphaned.record.status).toBe("aborted");
    expect(orphaned.ok && orphaned.record.terminal).toEqual({
      status: "aborted",
      result: "aborted",
      items: [],
      at: 500,
    });
    expect(orphaned.ok && orphaned.record.cancellation.supported).toBe(false);
  });

  it("preserves the terminal snapshot after the upstream command record is gone", () => {
    const { jobs, clock } = store(0);
    const record = jobs.project({
      application: "sonarr",
      command,
      observation: { state: "started" },
      cancellation: acknowledging({ kind: "accepted" }),
    });

    clock.advance(100);
    jobs.observe(record.reference, { state: "completed", result: "unsuccessful", items: perItem });

    clock.advance(60_000);
    // The application discarded its command record, so the next observation can
    // say nothing about it. The projection must not forget what the job did.
    const degraded = jobs.observe(record.reference, {
      state: undefined,
      warnings: ["the application no longer holds this command record"],
    });

    expect(degraded.ok && degraded.record.status).toBe("failed");
    expect(degraded.ok && degraded.record.terminal).toEqual({
      status: "failed",
      result: "failed",
      items: perItem,
      at: 100,
    });
    expect(degraded.ok && degraded.record.items).toEqual(perItem);
    expect(degraded.ok && degraded.record.warnings).toContain(
      "the application no longer holds this command record",
    );
  });

  it("does not grow its warning list as the same observation repeats", () => {
    const { jobs } = store();
    const record = jobs.project({
      application: "sonarr",
      command,
      observation: { state: "started" },
      cancellation: acknowledging({ kind: "accepted" }),
    });

    for (let index = 0; index < 5; index += 1) {
      jobs.observe(record.reference, { state: "started", warnings: ["one indexer is throttled"] });
    }

    const resolved = jobs.resolve(record.reference);
    expect(resolved.ok && resolved.record.warnings).toEqual(["one indexer is throttled"]);
  });

  it("caps distinct warnings and says that it dropped the older ones", () => {
    const { jobs } = store();
    const record = jobs.project({
      application: "sonarr",
      command,
      observation: { state: "started" },
      cancellation: acknowledging({ kind: "accepted" }),
    });

    // De-duplication alone does not bound this: an upstream source that stamps
    // a counter or a time into its text produces a distinct warning every poll.
    for (let index = 0; index < maxJobWarnings * 2; index += 1) {
      jobs.observe(record.reference, { state: "started", warnings: [`attempt ${index} stalled`] });
    }

    const resolved = jobs.resolve(record.reference);
    const warnings = resolved.ok ? resolved.record.warnings : [];
    expect(warnings).toHaveLength(maxJobWarnings);
    expect(warnings[0]).toBe(droppedWarningNotice);
    expect(warnings.at(-1)).toBe(`attempt ${maxJobWarnings * 2 - 1} stalled`);
    // The notice is not itself accumulated as the cap keeps being hit.
    expect(warnings.filter((warning) => warning === droppedWarningNotice)).toHaveLength(1);
  });

  it("caps the warnings a single projection starts with", () => {
    const { jobs } = store();
    const record = jobs.project({
      application: "sonarr",
      command,
      observation: {
        state: "started",
        warnings: Array.from(
          { length: maxJobWarnings + 5 },
          (_, index) => `indexer ${index} failed`,
        ),
      },
      cancellation: { supported: false },
    });

    expect(record.warnings).toHaveLength(maxJobWarnings);
    expect(record.warnings[0]).toBe(droppedWarningNotice);
  });

  it("rejects a job reference this process never issued", () => {
    const { jobs } = store();

    expect(jobs.resolve("job_neverissuedneverissued")).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(jobs.observe("rel_00000001", { state: "started" })).toEqual({
      ok: false,
      reason: "wrong_kind",
    });
  });
});

describe("job cancellation", () => {
  function runningJob(cancellation: Parameters<JobStore["project"]>[0]["cancellation"]) {
    const context = store(0);
    const record = context.jobs.project({
      application: "sonarr",
      command,
      observation: { state: "started" },
      cancellation,
    });
    return { ...context, record };
  }

  it("declares exactly the five outcomes the contract names", () => {
    expect([...jobCancelOutcomes]).toEqual([
      "cancelled",
      "cancellation_requested",
      "uncancellable",
      "completed",
      "unknown",
    ]);
  });

  it("reports cancelled only when the application confirms the command stopped", async () => {
    const { jobs, record } = runningJob(acknowledging({ kind: "accepted" }));
    const cancellation = await jobs.cancel(record.reference);

    expect("unresolved" in cancellation).toBe(false);
    expect(!("unresolved" in cancellation) && cancellation.outcome).toBe("cancelled");
    expect(!("unresolved" in cancellation) && cancellation.record.status).toBe("cancelled");
    expect(!("unresolved" in cancellation) && cancellation.record.terminal?.result).toBe(
      "cancelled",
    );
  });

  it("reports a mere acceptance as a request, not as a stop", async () => {
    const { jobs, record } = runningJob(acknowledging({ kind: "requested" }));
    const cancellation = await jobs.cancel(record.reference);

    expect(!("unresolved" in cancellation) && cancellation.outcome).toBe("cancellation_requested");
    expect(!("unresolved" in cancellation) && cancellation.record.status).toBe("started");
    expect(!("unresolved" in cancellation) && cancellation.record.terminal).toBeUndefined();
    expect(!("unresolved" in cancellation) && cancellation.warnings).toEqual([
      "the application accepted the request; the command has not stopped yet",
    ]);
  });

  it("reports a started command that does not permit cancellation as uncancellable", async () => {
    const refused = await runningJob(acknowledging({ kind: "rejected" }));
    const byRejection = await refused.jobs.cancel(refused.record.reference);
    expect(!("unresolved" in byRejection) && byRejection.outcome).toBe("uncancellable");

    const never = runningJob({ supported: false });
    const byDeclaration = await never.jobs.cancel(never.record.reference);
    expect(!("unresolved" in byDeclaration) && byDeclaration.outcome).toBe("uncancellable");
  });

  it("reports a job that already finished as completed", async () => {
    const finishedUpstream = runningJob(
      acknowledging({ kind: "already_finished", status: "completed" }),
    );
    const raced = await finishedUpstream.jobs.cancel(finishedUpstream.record.reference);
    expect(!("unresolved" in raced) && raced.outcome).toBe("completed");

    const known = runningJob(acknowledging({ kind: "accepted" }));
    known.jobs.observe(known.record.reference, { state: "completed" });
    const settled = await known.jobs.cancel(known.record.reference);
    expect(!("unresolved" in settled) && settled.outcome).toBe("completed");
  });

  it("reports unknown when the request could not be confirmed", async () => {
    const unreachable = runningJob(
      acknowledging({
        kind: "unavailable",
        failure: { kind: "timeout", message: "sonarr: the request timed out" },
      }),
    );
    const byTimeout = await unreachable.jobs.cancel(unreachable.record.reference);
    expect(!("unresolved" in byTimeout) && byTimeout.outcome).toBe("unknown");
    expect(!("unresolved" in byTimeout) && byTimeout.warnings).toEqual([
      "sonarr: the request timed out",
    ]);

    const thrown = runningJob({
      supported: true,
      request: async () => {
        throw new Error("socket closed");
      },
    });
    const byThrow = await thrown.jobs.cancel(thrown.record.reference);
    expect(!("unresolved" in byThrow) && byThrow.outcome).toBe("unknown");
    expect(JSON.stringify(byThrow)).not.toContain("socket closed");
  });

  it("does not treat an unresolvable reference as any of the five outcomes", async () => {
    const { jobs } = store();
    const cancellation = await jobs.cancel("job_neverissuedneverissued");

    expect(cancellation).toEqual({ unresolved: "malformed" });
  });

  it("stops offering cancellation once the job has ended", async () => {
    const { jobs, record } = runningJob(acknowledging({ kind: "accepted" }));
    jobs.observe(record.reference, { state: "completed" });

    const resolved = jobs.resolve(record.reference);
    expect(resolved.ok && resolved.record.cancellation.supported).toBe(false);
    const cancellation = await jobs.cancel(record.reference);
    expect(!("unresolved" in cancellation) && cancellation.outcome).toBe("completed");
  });
});
