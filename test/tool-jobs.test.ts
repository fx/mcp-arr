import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import { createManualClock } from "../src/state/clock.js";
import type { CancellationAcknowledgement, JobCancellationSupport } from "../src/state/jobs.js";
import { createWorkflowState, type WorkflowState } from "../src/state/workflow.js";
import { findToolDefinition } from "../src/tools/definitions.js";
import type { ToolContext } from "../src/tools/dispatch.js";
import { createToolError } from "../src/tools/errors.js";
import type { ItemOutcome, ToolResult } from "../src/tools/results.js";
import {
  allApplicationsEnvironment,
  createTestToolContext,
  jsonResponse,
} from "./support/tool-context.js";

const closeables: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(closeables.splice(0).map((closeable) => closeable.close()));
});

const command = { name: "MissingEpisodeSearch", upstreamId: "77" };

const items: readonly ItemOutcome[] = [
  { reference: "med_00000001", status: "ok", warnings: [] },
  {
    reference: "med_00000002",
    status: "error",
    warnings: [],
    error: createToolError({
      code: "upstream_rejection",
      message: "sonarr: nothing satisfied the profile",
      application: "sonarr",
    }),
  },
];

function acknowledging(acknowledgement: CancellationAcknowledgement): JobCancellationSupport {
  return { supported: true, request: async () => acknowledgement };
}

interface JobHarness {
  readonly context: ToolContext;
  readonly state: WorkflowState;
  readonly requested: string[];
  readonly clock: ReturnType<typeof createManualClock>;
}

/** One answer the fake instance gives when asked for the command behind a job. */
type CommandAnswer = { readonly record: unknown } | { readonly status: number };

/**
 * A server with one fake instance whose command record a test describes.
 *
 * The answers are consumed in order and the last one repeats, so a test can
 * describe an instance whose reply changes between two polls — which is the
 * whole of the degradation this change exists to survive. A harness given no
 * answer at all serves `404`, the way all three applications answer a command
 * identifier they no longer hold.
 */
function harness(answers: readonly CommandAnswer[] = []): JobHarness {
  const clock = createManualClock(0);
  const state = createWorkflowState({ clock });
  const requested: string[] = [];
  let reads = 0;
  const context = createTestToolContext({
    environment: allApplicationsEnvironment,
    state,
    fetch: async (url) => {
      requested.push(url);
      if (!/\/command\/[^/]+$/u.test(url)) {
        return jsonResponse({ appName: "Sonarr", version: "9.9.9.9" });
      }
      const answer = answers[Math.min(reads, answers.length - 1)];
      reads += 1;
      if (answer === undefined) {
        return jsonResponse({ message: "not found" }, 404);
      }
      return "status" in answer
        ? jsonResponse({ message: "unavailable" }, answer.status)
        : jsonResponse(answer.record);
    },
  });
  return { context, state, requested, clock };
}

/** The command record an instance answers with, in the shape all three send. */
function commandRecord(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: Number(command.upstreamId),
    name: command.name,
    commandName: "Missing Episode Search",
    status: "started",
    trigger: "manual",
    body: { name: command.name, trigger: "manual", updateScheduledTask: true },
    ...overrides,
  };
}

/** The upstream command route the refresh reads, for one application. */
function commandRoute(application: "sonarr" | "radarr"): string {
  const base =
    application === "sonarr"
      ? "https://sonarr.example.invalid/sonarr/api/v3"
      : "https://radarr.example.invalid/api/v3";
  return `${base}/command/${command.upstreamId}`;
}

function callTool(context: ToolContext, name: "arr_job_get" | "arr_job_cancel", input: unknown) {
  const definition = findToolDefinition(name);
  if (definition === undefined) {
    throw new Error(`${name} must be registered`);
  }
  const parsed = definition.inputSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`${name} rejected its own sample input`);
  }
  return definition.handle(context, parsed.data);
}

function projectionOf(result: ToolResult<unknown>): Record<string, unknown> {
  const data = result.applications[0]?.data;
  if (data === undefined || typeof data !== "object") {
    throw new Error("Expected a job projection");
  }
  return data as Record<string, unknown>;
}

describe("arr_job_get", () => {
  it("reports normalized status, progress, command identity, and per-item outcomes", async () => {
    const { context, state, requested } = harness([{ record: commandRecord() }]);
    const record = state.jobs.project({
      application: "sonarr",
      command,
      observation: { state: "started", progress: { completed: 2, total: 5 }, items },
      cancellation: acknowledging({ kind: "accepted" }),
    });

    const result = await callTool(context, "arr_job_get", { job: record.reference });

    // The job has a failed item, and the shared envelope reports that as
    // partial rather than letting an `ok` status bury it.
    expect(result.status).toBe("partial");
    expect(result.errors.map((error) => error.code)).toEqual(["partial_failure"]);
    expect(projectionOf(result)).toMatchObject({
      job: record.reference,
      application: "sonarr",
      command,
      status: "started",
      progress: { completed: 2, total: 5 },
      cancellable: true,
    });
    expect(result.applications[0]?.items).toEqual(items);
    // The projection is process-local, and reading a job that has not ended
    // still asks the instance what its command is doing now.
    expect(requested).toEqual([commandRoute("sonarr")]);
  });

  it("reports the state the command has reached rather than the one it was minted with", async () => {
    // The defect this covers is an unreached code path, not a wrong one: with
    // nothing calling the refresh, the job answers `queued` forever and this
    // assertion is the one that fails.
    const { context, state, requested } = harness([
      { record: commandRecord({ status: "completed", result: "successful" }) },
    ]);
    const record = state.jobs.project({
      application: "sonarr",
      command,
      observation: { state: "queued" },
      cancellation: acknowledging({ kind: "accepted" }),
    });

    const result = await callTool(context, "arr_job_get", { job: record.reference });

    expect(requested).toEqual([commandRoute("sonarr")]);
    expect(projectionOf(result)).toMatchObject({
      status: "completed",
      terminal: { status: "completed", result: "succeeded" },
      // Nothing that has ended can be cancelled.
      cancellable: false,
    });
  });

  it("keeps the first, more definite reading when a later one has lost the result", async () => {
    // Observed on a live instance: the same command answered `completed /
    // successful` and, minutes later, `completed / unknown`. The instance here
    // is ready to answer all three ways in turn; the caller is entitled to the
    // definite reading, so the third answer is never asked for.
    const { context, state, requested } = harness([
      { record: commandRecord({ status: "started" }) },
      { record: commandRecord({ status: "completed", result: "successful" }) },
      { record: commandRecord({ status: "completed", result: "unknown" }) },
    ]);
    const record = state.jobs.project({
      application: "sonarr",
      command,
      observation: { state: "queued" },
      cancellation: { supported: false },
    });

    const running = await callTool(context, "arr_job_get", { job: record.reference });
    const ended = await callTool(context, "arr_job_get", { job: record.reference });
    const again = await callTool(context, "arr_job_get", { job: record.reference });

    // Still running, so the read asked and the answer moved.
    expect(projectionOf(running)).toMatchObject({ status: "started" });
    expect(projectionOf(ended)).toMatchObject({
      status: "completed",
      terminal: { status: "completed", result: "succeeded" },
    });
    expect(projectionOf(again)).toEqual(projectionOf(ended));
    // Two reads reached the instance, not three: a terminal snapshot cannot
    // improve, and asking again is exactly what would have degraded it.
    expect(requested).toEqual([commandRoute("sonarr"), commandRoute("sonarr")]);
  });

  it("refuses a weaker reading even when one reaches the store", async () => {
    // The handler does not ask a second time, but two reads that overlap both
    // resolve a running job before either observes one, so the store's own
    // guard is what settles which reading survives.
    const { state } = harness();
    const record = state.jobs.project({
      application: "sonarr",
      command,
      observation: { state: "started" },
      cancellation: { supported: false },
    });

    state.jobs.observe(record.reference, { state: "completed", result: "successful" });
    const degraded = state.jobs.observe(record.reference, { state: "failed" });

    expect(degraded).toMatchObject({
      ok: true,
      record: { status: "completed", terminal: { status: "completed", result: "succeeded" } },
    });
  });

  it("reports a command the application no longer holds as unknown, without failing", async () => {
    const { context, state, requested } = harness();
    const record = state.jobs.project({
      application: "radarr",
      command,
      observation: { state: "queued" },
      cancellation: { supported: false },
    });

    const result = await callTool(context, "arr_job_get", { job: record.reference });

    expect(requested).toEqual([commandRoute("radarr")]);
    expect(result.status).toBe("ok");
    expect(projectionOf(result)).toMatchObject({ job: record.reference, status: "unknown" });
    expect(result.applications[0]?.warnings).toContain(
      "the application no longer holds this command record",
    );
  });

  it("answers from what it holds when the instance cannot be reached", async () => {
    const { context, state } = harness([{ status: 503 }]);
    const record = state.jobs.project({
      application: "sonarr",
      command,
      observation: { state: "started" },
      cancellation: { supported: false },
    });

    const result = await callTool(context, "arr_job_get", { job: record.reference });

    expect(result.status).toBe("ok");
    expect(projectionOf(result)).toMatchObject({ status: "started" });
    expect(result.applications[0]?.warnings.join(" ")).toContain(
      "this projection is the state this server last observed",
    );
    // A failure that learned nothing is not folded into the record, so it does
    // not outlive the outage.
    expect(state.jobs.resolve(record.reference)).toMatchObject({
      ok: true,
      record: { warnings: [] },
    });
  });

  it("publishes nothing the upstream command carried beyond the projection", async () => {
    const { context, state } = harness([
      { record: commandRecord({ status: "started", duration: "00:00:10.32" }) },
    ]);
    const record = state.jobs.project({
      application: "sonarr",
      command,
      observation: { state: "queued" },
      cancellation: { supported: false },
    });

    const result = await callTool(context, "arr_job_get", { job: record.reference });

    expect(Object.keys(projectionOf(result)).sort()).toEqual([
      "application",
      "cancellable",
      "command",
      "job",
      "status",
    ]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("trigger");
    expect(serialized).not.toContain("updateScheduledTask");
    expect(serialized).not.toContain("00:00:10.32");
    expect(serialized).not.toContain("Missing Episode Search");
  });

  it("reports no progress for a command whose only signal is a sentence", async () => {
    const { context, state } = harness([
      { record: commandRecord({ status: "started", message: "Processing file 1 of 1" }) },
    ]);
    const record = state.jobs.project({
      application: "sonarr",
      command,
      observation: { state: "queued" },
      cancellation: { supported: false },
    });

    const result = await callTool(context, "arr_job_get", { job: record.reference });

    // The sentence is disclosed as a warning; the counts inside it are prose,
    // not a contract, and nothing parses them into the published pair.
    expect(result.applications[0]?.warnings).toContain("Processing file 1 of 1");
    expect(projectionOf(result).progress).toBeUndefined();
  });

  it("still answers from the terminal snapshot after the instance goes away", async () => {
    const { context, state, requested, clock } = harness();
    const record = state.jobs.project({
      application: "radarr",
      command,
      observation: { state: "started" },
      cancellation: acknowledging({ kind: "accepted" }),
    });
    clock.advance(1_000);
    state.jobs.observe(record.reference, { state: "completed", result: "unsuccessful", items });
    clock.advance(600_000);
    state.jobs.observe(record.reference, {
      state: undefined,
      warnings: ["the application no longer holds this command record"],
    });

    const result = await callTool(context, "arr_job_get", { job: record.reference });

    expect(result.status).toBe("partial");
    expect(projectionOf(result)).toMatchObject({
      status: "failed",
      terminal: { status: "failed", result: "failed" },
      cancellable: false,
    });
    expect(result.applications[0]?.items).toEqual(items);
    expect(requested).toEqual([]);
  });

  it("tells a caller its reference was never one this server issued", async () => {
    const { context, requested } = harness();

    const result = await callTool(context, "arr_job_get", { job: "job_neverissuedneverissue" });

    expect(result.status).toBe("error");
    expect(result.errors.map((error) => error.code)).toEqual(["stale_reference"]);
    // Not "the server restarted": nothing about this value was ever a job
    // reference, and sending the caller after a restart it never saw is worse
    // than telling it the argument is wrong.
    expect(result.errors[0]?.message).toContain("never issued");
    expect(result.errors[0]?.message).not.toContain("before this server process started");
    expect(requested).toEqual([]);
  });

  it("distinguishes a job reference this server issued before it restarted", async () => {
    const { context, requested } = harness();
    const previous = createWorkflowState({ clock: createManualClock(0) });
    const stranded = previous.jobs.project({
      application: "sonarr",
      command,
      observation: { state: "started" },
      cancellation: { supported: false },
    }).reference;

    const result = await callTool(context, "arr_job_get", { job: stranded });

    expect(result.status).toBe("error");
    expect(result.errors.map((error) => error.code)).toEqual(["stale_reference"]);
    expect(result.errors[0]?.message).toContain("before this server process started");
    expect(requested).toEqual([]);
  });
});

describe("arr_job_cancel", () => {
  function running(cancellation: JobCancellationSupport, answers: readonly CommandAnswer[] = []) {
    const context = harness(answers);
    const record = context.state.jobs.project({
      application: "sonarr",
      command,
      observation: { state: "started" },
      cancellation,
    });
    return { ...context, record };
  }

  async function cancel(context: ToolContext, job: string): Promise<ToolResult<unknown>> {
    return callTool(context, "arr_job_cancel", { mode: "apply", job });
  }

  it("reports each of the five outcomes without pretending", async () => {
    const cases = [
      {
        acknowledgement: { kind: "accepted" } as const,
        outcome: "cancelled",
        status: "ok",
        receipt: "succeeded",
      },
      {
        acknowledgement: { kind: "requested" } as const,
        outcome: "cancellation_requested",
        status: "ok",
        receipt: "succeeded",
      },
      {
        acknowledgement: { kind: "rejected" } as const,
        outcome: "uncancellable",
        status: "ok",
        receipt: "succeeded",
      },
      {
        acknowledgement: { kind: "already_finished", status: "completed" } as const,
        outcome: "completed",
        status: "ok",
        receipt: "succeeded",
      },
      {
        acknowledgement: {
          kind: "unavailable",
          failure: { kind: "timeout", message: "sonarr: the request timed out" },
        } as const,
        outcome: "unknown",
        // An unconfirmed request may well have reached the application, so
        // neither the receipt nor the envelope claims the mutation succeeded —
        // the projection still reports what was observed.
        status: "error",
        receipt: "outcome_unknown",
      },
    ];

    for (const scenario of cases) {
      const job = running(acknowledging(scenario.acknowledgement));
      const result = await cancel(job.context, job.record.reference);

      expect(result.status, scenario.outcome).toBe(scenario.status);
      expect(projectionOf(result).outcome, scenario.outcome).toBe(scenario.outcome);
      expect(result.mutation?.receipt?.state, scenario.outcome).toBe(scenario.receipt);
    }
  });

  it("leaves an unconfirmed cancellation reconcilable against upstream state", async () => {
    const job = running(
      acknowledging({
        kind: "unavailable",
        failure: { kind: "timeout", message: "sonarr: the request timed out" },
      }),
    );
    const result = await cancel(job.context, job.record.reference);
    const reference = result.mutation?.receipt?.reference ?? "";

    const reconciled = await job.state.applies.reconcile(reference, async () => ({
      status: "succeeded",
    }));

    expect(reconciled.status).toBe("reconciled");
    expect(job.state.applies.resolve(reference)).toMatchObject({
      ok: true,
      record: { state: "succeeded" },
    });
  });

  it("does not let a later read overwrite the outcome cancellation established", async () => {
    // The instance would happily report this command as a plain success. The
    // job was cancelled, and reading it again must keep saying so.
    const job = running(acknowledging({ kind: "accepted" }), [
      { record: commandRecord({ status: "completed", result: "successful" }) },
    ]);

    await cancel(job.context, job.record.reference);
    const read = await callTool(job.context, "arr_job_get", { job: job.record.reference });

    expect(projectionOf(read)).toMatchObject({
      status: "cancelled",
      terminal: { status: "cancelled", result: "cancelled" },
      cancellable: false,
    });
    // Cancellation ended the job, so the read had nothing to ask about.
    expect(job.requested).toEqual([]);
  });

  it("keeps a refused cancellation refused when the job is read again", async () => {
    // A rejection is not an ending, so the read does refresh — and the refresh
    // must not hand back a cancellability the application already denied.
    const job = running(acknowledging({ kind: "rejected" }), [
      { record: commandRecord({ status: "started" }) },
    ]);

    await cancel(job.context, job.record.reference);
    const read = await callTool(job.context, "arr_job_get", { job: job.record.reference });

    expect(job.requested).toEqual([commandRoute("sonarr")]);
    expect(projectionOf(read)).toMatchObject({ status: "started", cancellable: false });
  });

  it("reports a job that never permitted cancellation as uncancellable", async () => {
    const job = running({ supported: false });

    const result = await cancel(job.context, job.record.reference);

    expect(projectionOf(result).outcome).toBe("uncancellable");
    expect(projectionOf(result).cancellable).toBe(false);
  });

  it("reports an unresolvable reference as stale in either mode, before anything runs", async () => {
    const { context, requested } = harness();

    for (const mode of ["plan", "apply"] as const) {
      const result = await callTool(context, "arr_job_cancel", {
        mode,
        job: "job_neverissuedneverissue",
      });

      expect(result.status, mode).toBe("error");
      expect(
        result.errors.map((error) => error.code),
        mode,
      ).toEqual(["stale_reference"]);
      // Nothing was planned and nothing was applied, so there is no receipt.
      expect(result.mutation?.receipt, mode).toBeUndefined();
    }
    expect(requested).toEqual([]);
  });

  it("discloses the effect in plan mode without cancelling anything", async () => {
    let requests = 0;
    const job = running({
      supported: true,
      request: async () => {
        requests += 1;
        return { kind: "accepted" };
      },
    });

    const result = await callTool(job.context, "arr_job_cancel", {
      mode: "plan",
      job: job.record.reference,
    });

    expect(result.status).toBe("ok");
    expect(requests).toBe(0);
    expect(result.mutation?.plan?.startsWith("pln_")).toBe(true);
    expect(result.mutation?.requestedEffects).toEqual([
      {
        application: "sonarr",
        severity: "consequential",
        summary: `request cancellation of ${command.name}`,
      },
    ]);
    expect(job.state.jobs.resolve(job.record.reference)).toMatchObject({
      ok: true,
      record: { status: "started" },
    });
  });

  it("predicts no cancellation for a job it already believes uncancellable", async () => {
    const job = running({ supported: false });

    const result = await callTool(job.context, "arr_job_cancel", {
      mode: "plan",
      job: job.record.reference,
    });

    expect(result.mutation?.predictedEffects).toEqual([]);
    expect(result.applications[0]?.warnings).toContain(
      "this job cannot be cancelled; applying the plan will report it as uncancellable",
    );
  });

  it("fails a recorded cancellation plan as stale once the job has ended", async () => {
    let requests = 0;
    const job = running({
      supported: true,
      request: async () => {
        requests += 1;
        return { kind: "accepted" };
      },
    });
    const planned = await callTool(job.context, "arr_job_cancel", {
      mode: "plan",
      job: job.record.reference,
    });
    const planReference = planned.mutation?.plan ?? "";

    job.state.jobs.observe(job.record.reference, { state: "completed" });
    const result = await callTool(job.context, "arr_job_cancel", {
      mode: "apply",
      plan: planReference,
    });

    expect(result.status).toBe("error");
    expect(result.applications[0]?.error?.code).toBe("stale_plan");
    expect(requests).toBe(0);
    expect(result.mutation?.receipt).toBeUndefined();
  });

  it("returns the existing receipt rather than requesting cancellation twice", async () => {
    let requests = 0;
    const job = running({
      supported: true,
      request: async () => {
        requests += 1;
        return { kind: "requested" };
      },
    });

    const first = await cancel(job.context, job.record.reference);
    const second = await cancel(job.context, job.record.reference);

    expect(requests).toBe(1);
    expect(second.mutation?.receipt).toEqual(first.mutation?.receipt);
    expect(second.applications[0]?.warnings.join(" ")).toContain("nothing was sent again");
  });
});

describe("job tools over the MCP protocol", () => {
  async function connect(context: ToolContext): Promise<Client> {
    const server = createServer(context);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "tool-jobs-test", version: "1.0.0" });
    closeables.push(client, server);

    await server.connect(serverTransport);
    await client.connect(clientTransport);
    // listTools caches the published output schema, so callTool validates the
    // structured content against exactly what a host would have received.
    await client.listTools();
    return client;
  }

  it("returns schema-conforming structured content for both job tools", async () => {
    const context = harness([{ record: commandRecord({ status: "started" }) }]);
    const record = context.state.jobs.project({
      application: "sonarr",
      command,
      observation: { state: "started", progress: { completed: 1, total: 3 } },
      cancellation: acknowledging({ kind: "requested" }),
    });
    const client = await connect(context.context);

    const read = (await client.callTool({
      name: "arr_job_get",
      arguments: { job: record.reference },
    })) as CallToolResult;
    expect(read.isError).toBe(false);
    expect(
      (read.structuredContent as { applications: Array<{ data: { status: string } }> })
        .applications[0]?.data.status,
    ).toBe("started");
    expect(read.content?.[0]).toMatchObject({ type: "text" });

    const cancelled = (await client.callTool({
      name: "arr_job_cancel",
      arguments: { mode: "apply", job: record.reference },
    })) as CallToolResult;
    expect(cancelled.isError).toBe(false);
    const content = cancelled.structuredContent as {
      status: string;
      mutation?: { receipt?: { reference: string; state: string } };
      applications: Array<{ data: { outcome: string } }>;
    };
    expect(content.status).toBe("ok");
    expect(content.applications[0]?.data.outcome).toBe("cancellation_requested");
    expect(content.mutation?.receipt?.reference.startsWith("apl_")).toBe(true);
    // The read refreshed the running job; the cancellation contacted nothing of
    // its own, because the request it sends is the one the job was minted with.
    expect(context.requested).toEqual([commandRoute("sonarr")]);
  });
});
