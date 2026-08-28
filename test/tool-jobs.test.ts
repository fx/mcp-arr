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

function harness(): JobHarness {
  const clock = createManualClock(0);
  const state = createWorkflowState({ clock });
  const requested: string[] = [];
  const context = createTestToolContext({
    environment: allApplicationsEnvironment,
    state,
    fetch: async (url) => {
      requested.push(url);
      return jsonResponse({ appName: "Sonarr", version: "9.9.9.9" });
    },
  });
  return { context, state, requested, clock };
}

/**
 * Calls one job tool and holds its envelope to the tool's own published output
 * schema.
 *
 * Asserting the return value alone would pass for an envelope the server then
 * refuses to publish: `runTool` validates every result against this same schema
 * before it leaves the process and replaces a non-conforming one with
 * `unexpected_response`. Checking it here is what makes these tests evidence
 * about what a caller receives rather than about what the handler returned.
 */
async function callTool(
  context: ToolContext,
  name: "arr_job_get" | "arr_job_cancel",
  input: unknown,
): Promise<ToolResult<unknown>> {
  const definition = findToolDefinition(name);
  if (definition === undefined) {
    throw new Error(`${name} must be registered`);
  }
  const parsed = definition.inputSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`${name} rejected its own sample input`);
  }
  const result = await definition.handle(context, parsed.data);
  expect(definition.outputSchema.safeParse(result).success, name).toBe(true);
  return result;
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
    const { context, state, requested } = harness();
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
    // Job projection is process-local, so reading one contacts nothing.
    expect(requested).toEqual([]);
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
  function running(cancellation: JobCancellationSupport) {
    const context = harness();
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
      expect(projectionOf(result).stage, scenario.outcome).toBe("applied");
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
    // The plan describes the job and reports no outcome, because nothing has
    // been attempted; the stage is what says so.
    expect(projectionOf(result)).toMatchObject({ stage: "planned", cancellable: true });
    expect(projectionOf(result).outcome).toBeUndefined();
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
    // A plan for a job that cannot be cancelled is still a plan: it carries the
    // same planned stage and no outcome, rather than reporting `uncancellable`
    // for a cancellation nobody has requested.
    expect(projectionOf(result)).toMatchObject({ stage: "planned", cancellable: false });
    expect(projectionOf(result).outcome).toBeUndefined();
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
    const context = harness();
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
    expect(context.requested).toEqual([]);
  });
});
