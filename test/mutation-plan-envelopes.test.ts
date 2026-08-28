import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ToolDefinition, toolDefinitions } from "../src/tools/definitions.js";
import type { ToolContext } from "../src/tools/dispatch.js";
import type { ToolName } from "../src/tools/names.js";
import { runTool } from "../src/tools/register.js";
import type { ToolResult } from "../src/tools/results.js";
import { jobCancelOutputSchema } from "../src/tools/schemas/jobs.js";
import { publishedResultSchema } from "../src/tools/schemas/publish-results.js";
import {
  type FixtureInstance,
  instanceEnvironment,
  startFixtureInstance,
} from "./support/instance-server.js";
import { definitionOf, isRecord } from "./support/projection.js";
import { createTestToolContext } from "./support/tool-context.js";

/**
 * Every mutation tool's plan-mode envelope, against that tool's own published
 * output schema.
 *
 * This is the check whose absence let `arr_job_cancel` publish an output schema
 * its plan mode could not satisfy. A test that asserts what a handler returned
 * says nothing about what a caller receives: `runTool` validates every envelope
 * against the tool's declared output schema before it leaves the process and
 * replaces one that fails with `unexpected_response`, so a plan can be correct
 * in every observable way and still reach the caller as a failure naming the
 * application's version.
 *
 * The cases are driven off the published tool list rather than written out, so a
 * mutation tool added later is covered the day it is registered — the
 * completeness guard below fails until it has a plan here. Every reference is
 * obtained the way a caller obtains one, by running the matching read tool
 * against the same context first, so no plan is validated against a reference no
 * caller could have held.
 */

/** Every tool that mutates, taken from what each one publishes about itself. */
const mutationTools: readonly ToolDefinition[] = toolDefinitions.filter(
  (definition) => definition.annotations.readOnlyHint === false,
);

interface PlanCase {
  readonly tool: ToolName;
  /** How this plan is named when it fails, since one tool may have several. */
  readonly label: string;
  readonly args: Record<string, unknown>;
  /**
   * Whether this plan discloses a payload of its own.
   *
   * Stated per case rather than derived from the tool's declared payload,
   * because a payload is optional in the envelope and several plans disclose
   * their intent entirely through the mutation detail. Saying so here is what
   * makes the conformance claim below about a payload that was really there —
   * and what fails if a plan that used to describe what it would do stops.
   */
  readonly payload: boolean;
}

const started: FixtureInstance[] = [];
let context: ToolContext;
let planCases: readonly PlanCase[] = [];

interface CalledTool {
  /** The handler's own envelope, before anything validated or replaced it. */
  readonly envelope: ToolResult<unknown>;
  /** What a host receives, which is a replacement where the envelope failed. */
  readonly structured: unknown;
}

/**
 * Calls one tool the way its host does, keeping the envelope the handler
 * produced.
 *
 * Both halves are needed and neither substitutes for the other: the handler's
 * envelope is what the declared output schema is asked about, and the structured
 * content is what a caller actually receives — which is where a refused envelope
 * shows up as `unexpected_response` rather than as a missing field.
 *
 * The shared helper in `support/projection.ts` records the same envelope but
 * parses it, so a refusal arrives here as a thrown Zod error rather than as
 * something to report. This test exists to name what was refused, so it keeps
 * the envelope unvalidated and leaves the verdict to the assertions.
 */
async function call(name: ToolName, args: Record<string, unknown>): Promise<CalledTool> {
  const definition = definitionOf(name);
  const parsed = definition.inputSchema.safeParse(args);
  if (!parsed.success) {
    throw new Error(`${name} rejected ${JSON.stringify(args)}: ${parsed.error.message}`);
  }

  let envelope: ToolResult<unknown> | undefined;
  const recording: ToolDefinition = {
    ...definition,
    async handle(recordingContext: ToolContext, input: unknown): Promise<ToolResult<unknown>> {
      envelope = await definition.handle(recordingContext, input);
      return envelope;
    },
  };

  const called = await runTool(recording, context, parsed.data);
  if (envelope === undefined) {
    throw new Error(`${name} produced no envelope`);
  }
  return { envelope, structured: called.structuredContent };
}

/** The payload the first application contributed, or `undefined` for none. */
function dataOf(envelope: ToolResult<unknown>): Record<string, unknown> | undefined {
  const data = envelope.applications[0]?.data;
  return isRecord(data) ? data : undefined;
}

function requireData(name: ToolName, envelope: ToolResult<unknown>): Record<string, unknown> {
  const data = dataOf(envelope);
  if (data === undefined) {
    const failure = envelope.applications[0]?.error?.code ?? envelope.errors[0]?.code ?? "nothing";
    throw new Error(`${name} returned no payload: ${failure}`);
  }
  return data;
}

/** The rows a read tool published, as records. */
function rowsOf(data: Record<string, unknown>, field: string): readonly Record<string, unknown>[] {
  const items = data[field];
  return Array.isArray(items) ? items.filter(isRecord) : [];
}

function referenceOf(row: Record<string, unknown> | undefined, what: string): string {
  const reference = row?.reference;
  if (typeof reference !== "string") {
    throw new Error(`Expected a ${what} reference`);
  }
  return reference;
}

/**
 * One reference of the requested kind, taken from a real answer.
 *
 * A row is named by the identity the view publishes where the case needs a
 * particular one — an import-blocked queue row rather than a pending release —
 * and falls back to the first row otherwise.
 */
async function referenceFrom(
  name: ToolName,
  args: Record<string, unknown>,
  identity?: string,
): Promise<string> {
  const { envelope } = await call(name, args);
  const rows = rowsOf(requireData(name, envelope), "items");
  const row = identity === undefined ? rows[0] : rows.find((item) => item.id === identity);
  return referenceOf(row, `${String(args.view)} row`);
}

/** The job reference an applied automatic search hands back. */
async function startedJob(series: string): Promise<string> {
  const { envelope } = await call("arr_search_start", {
    target: "sonarr_series",
    mode: "apply",
    series,
  });
  const job = envelope.mutation?.job;
  if (job === undefined) {
    throw new Error("Expected a job reference from an applied automatic search");
  }
  return job;
}

beforeAll(async () => {
  const sonarr = await startFixtureInstance("sonarr");
  started.push(sonarr);
  context = createTestToolContext({ environment: instanceEnvironment([sonarr]) });

  const series = await referenceFrom("arr_library_query", { view: "series" });
  const episode = await referenceFrom("arr_library_query", { view: "episodes", series });
  const history = await referenceFrom("arr_activity_query", { view: "history" });
  // The import-blocked row: the one a tracked queue transition applies to, and
  // the one a manual import has candidates for.
  const queue = await referenceFrom("arr_activity_query", { view: "queue" }, "502");

  const searched = await call("arr_release_search", { target: "sonarr_episode", episode });
  const release = referenceOf(
    rowsOf(requireData("arr_release_search", searched.envelope), "releases")[0],
    "release",
  );

  const inspected = await call("arr_import_inspect", {
    source: "queue_item",
    queue,
    applications: ["sonarr"],
  });
  const candidate = referenceOf(
    rowsOf(requireData("arr_import_inspect", inspected.envelope), "candidates").find((row) => {
      const decision = row.decision;
      return isRecord(decision) && decision.importable === true;
    }),
    "importable candidate",
  );

  const job = await startedJob(series);

  planCases = [
    {
      tool: "arr_search_start",
      label: "sonarr_series",
      args: { target: "sonarr_series", mode: "plan", series },
      payload: true,
    },
    {
      tool: "arr_release_grab",
      label: "releases",
      args: { mode: "plan", releases: [release] },
      payload: true,
    },
    {
      tool: "arr_queue_resolve",
      label: "ignore_tracking",
      args: { intent: "ignore_tracking", mode: "plan", items: [queue] },
      payload: false,
    },
    {
      tool: "arr_activity_change",
      label: "mark_history_failed",
      args: { intent: "mark_history_failed", mode: "plan", records: [history] },
      payload: false,
    },
    {
      tool: "arr_import_execute",
      label: "copy",
      args: { mode: "plan", candidates: [candidate], importMode: "copy" },
      payload: false,
    },
    {
      tool: "arr_library_change",
      label: "set_monitoring",
      args: { intent: "set_monitoring", mode: "plan", items: [series], monitored: true },
      payload: false,
    },
    { tool: "arr_job_cancel", label: "cancel", args: { mode: "plan", job }, payload: true },
  ];
}, 30_000);

afterAll(async () => {
  await Promise.all(started.splice(0).map((running) => running.close()));
});

/** What the declared output schema refused, or the empty string for nothing. */
function refusalOf(definition: ToolDefinition, envelope: ToolResult<unknown>): string {
  const parsed = definition.outputSchema.safeParse(envelope);
  return parsed.success
    ? ""
    : parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; ");
}

describe("plan mode across every mutation tool", () => {
  it("covers each one, so a new mutation tool is not silently left out", () => {
    expect([...new Set(planCases.map((entry) => entry.tool))].sort()).toEqual(
      mutationTools.map((definition) => definition.name).sort(),
    );
  });

  it("returns an envelope each tool's own published output schema admits", async () => {
    for (const planned of planCases) {
      const definition = definitionOf(planned.tool);
      const where = `${planned.tool} (${planned.label})`;
      const { envelope, structured } = await call(planned.tool, planned.args);

      // A plan that failed would conform trivially, so a plan that really ran
      // is required before the conformance claim means anything, and so is the
      // payload where this plan is one that discloses one — that is where an
      // apply-only field sits, and it is what gets an envelope refused.
      expect(envelope.status, where).toBe("ok");
      expect(envelope.mutation?.plan?.startsWith("pln_"), where).toBe(true);
      expect(dataOf(envelope) !== undefined, where).toBe(planned.payload);

      expect(refusalOf(definition, envelope), where).toBe("");
      // And what the caller receives is that same envelope rather than the
      // replacement `runTool` substitutes for a non-conforming one.
      expect(
        publishedResultSchema(definition.outputSchema).safeParse(structured).success,
        where,
      ).toBe(true);
      expect(
        (structured as ToolResult<unknown>).errors.map((error) => error.code),
        where,
      ).not.toContain("unexpected_response");
    }
  }, 30_000);
});

describe("the cancellation output schema", () => {
  const projection = {
    job: "job_00000001",
    application: "sonarr",
    command: { name: "MissingEpisodeSearch", upstreamId: "77" },
    status: "started",
    cancellable: true,
  };

  function envelopeWith(data: Record<string, unknown>): Record<string, unknown> {
    return {
      status: "ok",
      applications: [{ application: "sonarr", status: "ok", warnings: [], data }],
      warnings: [],
      errors: [],
    };
  }

  it("admits a planned cancellation, which carries no outcome", () => {
    expect(
      jobCancelOutputSchema.safeParse(envelopeWith({ stage: "planned", ...projection })).success,
    ).toBe(true);
  });

  it("still refuses an applied cancellation that reports no outcome", () => {
    // The whole reason the field exists. Admitting the planned envelope by
    // making the outcome optional would have let an applied cancellation report
    // none and validate, so the schema stays closed and discriminates instead.
    expect(
      jobCancelOutputSchema.safeParse(envelopeWith({ stage: "applied", ...projection })).success,
    ).toBe(false);
    expect(
      jobCancelOutputSchema.safeParse(
        envelopeWith({ stage: "applied", ...projection, outcome: "cancelled" }),
      ).success,
    ).toBe(true);
  });

  it("refuses a cancellation that names no stage at all", () => {
    expect(
      jobCancelOutputSchema.safeParse(envelopeWith({ ...projection, outcome: "cancelled" }))
        .success,
    ).toBe(false);
  });
});
