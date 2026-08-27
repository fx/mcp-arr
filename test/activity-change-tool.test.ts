import { afterEach, describe, expect, it } from "vitest";
import type { FetchLike } from "../src/http/client.js";
import { createWorkflowState } from "../src/state/workflow.js";
import { findToolDefinition, type ToolDefinition } from "../src/tools/definitions.js";
import type { ToolContext } from "../src/tools/dispatch.js";
import type { ToolResult } from "../src/tools/results.js";
import type { ActivityViewResult } from "../src/tools/schemas/activity-results.js";
import { fixturePathFor, loadFixture } from "./support/fixtures.js";
import {
  type FixtureInstance,
  instanceEnvironment,
  startFixtureInstance,
} from "./support/instance-server.js";
import {
  createTestToolContext,
  fixtureRoot,
  jsonResponse,
  testApiKeys,
} from "./support/tool-context.js";

/**
 * `arr_activity_change`, end to end through the registered tool.
 *
 * Every reference a mutation uses is obtained the way a caller obtains one: by
 * running `arr_activity_query` first against the same context and using the
 * reference it published. Nothing is hand-minted, so a test cannot pass with a
 * reference no caller could have held.
 *
 * Most of these run against the loopback fixture instance, which answers the
 * recorded fixtures and applies the two writes to its own copy — so a test can
 * assert both what was sent and what a later read would see. The cases about a
 * lost answer use a stub instead, because dropping a reply mid-write is the one
 * behavior a well-behaved double cannot produce.
 */

const changeTool = findToolDefinition("arr_activity_change") as ToolDefinition;
const queryTool = findToolDefinition("arr_activity_query") as ToolDefinition;

const started: FixtureInstance[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((running) => running.close()));
});

async function instance(application: "sonarr" | "radarr"): Promise<FixtureInstance> {
  const running = await startFixtureInstance(application);
  started.push(running);
  return running;
}

async function call(
  tool: ToolDefinition,
  context: ToolContext,
  args: unknown,
): Promise<ToolResult<unknown>> {
  const parsed = tool.inputSchema.safeParse(args);
  if (!parsed.success) {
    throw new Error(`Arguments rejected by the published schema: ${parsed.error.message}`);
  }
  const result = await tool.handle(context, parsed.data);
  expect(tool.outputSchema.safeParse(result).success).toBe(true);
  return result;
}

function outcomeFor(result: ToolResult<unknown>, application: string) {
  const outcome = result.applications.find((entry) => entry.application === application);
  if (outcome === undefined) {
    throw new Error(`No outcome for ${application}`);
  }
  return outcome;
}

function dataFor(result: ToolResult<unknown>, application: string): ActivityViewResult {
  const outcome = outcomeFor(result, application);
  if (outcome.status !== "ok") {
    throw new Error(`${application} did not succeed: ${outcome.error?.code ?? "unknown"}`);
  }
  return outcome.data as ActivityViewResult;
}

/** The reference `arr_activity_query` published for one record of a view. */
async function referenceFor(
  context: ToolContext,
  application: "sonarr" | "radarr",
  view: "history" | "blocklist",
  recordId: number,
): Promise<string> {
  const result = await call(queryTool, context, { view, applications: [application] });
  const data = dataFor(result, application);
  const records = (data as { items?: readonly Record<string, unknown>[] }).items ?? [];
  // The published record carries no upstream identifier — that is the point —
  // so the row is selected by its position in the recorded fixture rather than
  // by an identity the caller is never given.
  const index = recordIndexFor(view, recordId);
  const chosen = records[index];
  const reference = chosen?.reference;
  if (typeof reference !== "string") {
    throw new Error(`No ${view} reference published at index ${index}`);
  }
  return reference;
}

/**
 * Which published row stands for which recorded identifier.
 *
 * The tool deliberately publishes no upstream identifier, so a test cannot look
 * one up in the result. The recorded fixtures are fixed and ordered, so the row
 * is named here instead of being searched for by an identity the caller is
 * never given.
 */
function recordIndexFor(view: "history" | "blocklist", recordId: number): number {
  const positions: Readonly<Record<number, number>> = {
    // sonarr history: 9001 grabbed, 9002 imported, 9003 failed, 9004 deleted.
    9001: 0,
    9002: 1,
    9003: 2,
    // radarr history: 9101 grabbed.
    9101: 0,
    // sonarr blocklist: 7001, 7002. radarr blocklist: 7101.
    7001: 0,
    7002: 1,
    7101: 0,
  };
  const index = positions[recordId];
  if (index === undefined) {
    throw new Error(`No recorded position for ${view} record ${recordId}`);
  }
  return index;
}

function mutation(outcome: ToolResult<unknown>) {
  const detail = outcome.mutation;
  if (detail === undefined) {
    throw new Error("Expected a mutation envelope");
  }
  return detail;
}

function summaries(effects: readonly { readonly summary: string }[]): readonly string[] {
  return effects.map((effect) => effect.summary);
}

describe("arr_activity_change plan mode", () => {
  it("discloses the blocklist and replacement-search effects of a mark-failed", async () => {
    const sonarr = await instance("sonarr");
    const context = createTestToolContext({ environment: instanceEnvironment([sonarr]) });
    const reference = await referenceFor(context, "sonarr", "history", 9001);

    const result = await call(changeTool, context, {
      intent: "mark_history_failed",
      mode: "plan",
      records: [reference],
    });

    const detail = mutation(result);
    expect(summaries(detail.requestedEffects)).toEqual([
      expect.stringContaining("mark the grab of"),
      expect.stringContaining("blocklist"),
      expect.stringContaining("replacement search"),
    ]);
    // The recorded Sonarr instance redownloads failed grabs, including the
    // interactively grabbed ones, so the search is disclosed as certain.
    expect(summaries(detail.predictedEffects).at(-1)).toContain("start a replacement search");
    expect(detail.plan).toBeDefined();
    expect(detail.readSet?.length).toBeGreaterThan(0);
    // Plan mode sends no write, which the instance's own record proves.
    expect(sonarr.failedHistory).toEqual([]);
  });

  it("says no replacement search follows where the instance does not redownload", async () => {
    const radarr = await instance("radarr");
    const context = createTestToolContext({ environment: instanceEnvironment([radarr]) });
    const reference = await referenceFor(context, "radarr", "history", 9101);

    const result = await call(changeTool, context, {
      intent: "mark_history_failed",
      mode: "plan",
      records: [reference],
    });

    expect(summaries(mutation(result).predictedEffects).at(-1)).toContain(
      "no replacement search follows",
    );
  });

  it("describes a blocklist removal as re-allowing and not as deleting", async () => {
    const sonarr = await instance("sonarr");
    const context = createTestToolContext({ environment: instanceEnvironment([sonarr]) });
    const reference = await referenceFor(context, "sonarr", "blocklist", 7001);

    const result = await call(changeTool, context, {
      intent: "remove_blocklist_record",
      mode: "plan",
      records: [reference],
    });

    const predicted = summaries(mutation(result).predictedEffects);
    expect(predicted).toContain(
      "no media file, download-client payload, or queue item is removed by this change",
    );
    expect(predicted.some((summary) => summary.includes("grabbed again"))).toBe(true);
    expect(sonarr.removedBlocklist).toEqual([]);
  });
});

describe("arr_activity_change apply mode", () => {
  it("marks exactly the named history record failed and receipts it", async () => {
    const sonarr = await instance("sonarr");
    const context = createTestToolContext({ environment: instanceEnvironment([sonarr]) });
    const reference = await referenceFor(context, "sonarr", "history", 9001);

    const result = await call(changeTool, context, {
      intent: "mark_history_failed",
      mode: "apply",
      records: [reference],
    });

    expect(outcomeFor(result, "sonarr").status).toBe("ok");
    expect(sonarr.failedHistory).toEqual([9001]);
    expect(mutation(result).receipt?.state).toBe("succeeded");
    // The write went to the history route, never to the queue.
    expect(sonarr.requests).toContain("history/failed/9001");
    expect(sonarr.requests.some((route) => route.startsWith("queue"))).toBe(false);
  });

  it("removes exactly the named blocklist record, and a later read no longer lists it", async () => {
    const sonarr = await instance("sonarr");
    const context = createTestToolContext({ environment: instanceEnvironment([sonarr]) });
    const reference = await referenceFor(context, "sonarr", "blocklist", 7001);

    const result = await call(changeTool, context, {
      intent: "remove_blocklist_record",
      mode: "apply",
      records: [reference],
    });

    expect(outcomeFor(result, "sonarr").status).toBe("ok");
    expect(sonarr.removedBlocklist).toEqual([7001]);
    expect(mutation(result).receipt?.state).toBe("succeeded");

    const after = await call(queryTool, context, { view: "blocklist", applications: ["sonarr"] });
    const remaining = (dataFor(after, "sonarr") as { items: readonly Record<string, unknown>[] })
      .items;
    expect(remaining).toHaveLength(1);
    // Nothing about media or the download client was touched.
    expect(sonarr.requests.some((route) => route.startsWith("series"))).toBe(false);
  });

  it("answers a repeat from the receipt rather than sending the write again", async () => {
    const sonarr = await instance("sonarr");
    const context = createTestToolContext({ environment: instanceEnvironment([sonarr]) });
    const reference = await referenceFor(context, "sonarr", "history", 9001);
    const args = {
      intent: "mark_history_failed",
      mode: "apply",
      records: [reference],
    };

    const first = await call(changeTool, context, args);
    const repeat = await call(changeTool, context, args);

    expect(sonarr.failedHistory).toEqual([9001]);
    expect(mutation(first).receipt?.reference).toBe(mutation(repeat).receipt?.reference);
    expect(outcomeFor(repeat, "sonarr").warnings.join(" ")).toContain(
      "already applied by this server",
    );
  });

  it("mutates a record named twice exactly once", async () => {
    const sonarr = await instance("sonarr");
    const context = createTestToolContext({ environment: instanceEnvironment([sonarr]) });
    const reference = await referenceFor(context, "sonarr", "history", 9001);

    const result = await call(changeTool, context, {
      intent: "mark_history_failed",
      mode: "apply",
      records: [reference, reference],
    });

    // Neither mutation is idempotent upstream: a grab failed twice can record a
    // second failure and start a second search. The repeat is collapsed before
    // any state is read, so it costs no request either, and the caller is told.
    expect(sonarr.failedHistory).toEqual([9001]);
    expect(sonarr.requests.filter((route) => route === "history/failed/9001")).toHaveLength(1);
    expect(outcomeFor(result, "sonarr").warnings.join(" ")).toContain(
      "repeated record reference(s)",
    );
  });

  it("describes a multi-record selection by count rather than naming one of them", async () => {
    const sonarr = await instance("sonarr");
    const context = createTestToolContext({ environment: instanceEnvironment([sonarr]) });
    const first = await referenceFor(context, "sonarr", "blocklist", 7001);
    const second = await referenceFor(context, "sonarr", "blocklist", 7002);

    const result = await call(changeTool, context, {
      intent: "remove_blocklist_record",
      mode: "plan",
      records: [first, second],
    });

    const requested = summaries(mutation(result).requestedEffects);
    expect(requested[0]).toBe("remove the blocklist records for 2 blocked releases");
    expect(requested.join(" ")).not.toContain("Example Series S02E01");
  });

  it("refuses a history record that is not a grab, and sends nothing for it", async () => {
    const sonarr = await instance("sonarr");
    const context = createTestToolContext({ environment: instanceEnvironment([sonarr]) });
    // 9002 is a download-folder import, which has no release to fail.
    const reference = await referenceFor(context, "sonarr", "history", 9002);

    const result = await call(changeTool, context, {
      intent: "mark_history_failed",
      mode: "apply",
      records: [reference],
    });

    const outcome = outcomeFor(result, "sonarr");
    expect(outcome.items?.[0]?.status).toBe("error");
    expect(outcome.items?.[0]?.error?.code).toBe("conflict");
    expect(sonarr.failedHistory).toEqual([]);
    // Nothing was dispatched and every selection failed, so the receipt is the
    // one state a later attempt may reuse, and the call-level error says so in
    // those terms rather than borrowing the item's.
    expect(mutation(result).receipt?.state).toBe("failed");
    expect(outcomeFor(result, "sonarr").error?.message).toContain("no upstream request was sent");

    // A call that can send nothing does not depend on the instance's
    // failed-download handling, so it is never read: a plan must not carry a
    // fingerprint for state its mutation does not rest on.
    expect(sonarr.requests).not.toContain("config/downloadclient");
  });

  it("refuses a blocklist reference supplied where a history record belongs", async () => {
    const sonarr = await instance("sonarr");
    const context = createTestToolContext({ environment: instanceEnvironment([sonarr]) });
    const blocklist = await referenceFor(context, "sonarr", "blocklist", 7001);

    // The published schema carries the kind in the reference itself, so a
    // cross-kind misuse is refused by validation rather than at runtime — no
    // upstream request, and the caller is told before it ever reaches a handler.
    const rejected = changeTool.inputSchema.safeParse({
      intent: "mark_history_failed",
      mode: "apply",
      records: [blocklist],
    });

    expect(rejected.success).toBe(false);
    expect(sonarr.failedHistory).toEqual([]);
    expect(sonarr.requests.some((route) => route.startsWith("history/failed"))).toBe(false);
  });

  it("reports a record the instance no longer holds as a stale reference", async () => {
    const sonarr = await instance("sonarr");
    const context = createTestToolContext({ environment: instanceEnvironment([sonarr]) });
    const reference = await referenceFor(context, "sonarr", "blocklist", 7001);

    await call(changeTool, context, {
      intent: "remove_blocklist_record",
      mode: "apply",
      records: [reference],
    });

    // The record is gone now, so planning against the same reference has
    // nothing to act on. Plan rather than apply, so the answer comes from the
    // current-state read rather than from the receipt of the first call.
    const planned = await call(changeTool, context, {
      intent: "remove_blocklist_record",
      mode: "plan",
      records: [reference],
    });

    expect(outcomeFor(planned, "sonarr").items?.[0]?.error?.code).toBe("stale_reference");
    expect(mutation(planned).predictedEffects).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Lost answers, which a well-behaved instance cannot produce                  */
/* -------------------------------------------------------------------------- */

interface StubOptions {
  /** Applies the write to the stub's own copy before dropping the answer. */
  readonly applyThenDrop?: boolean;
  readonly dropWrites?: boolean;
}

async function stubContext(options: StubOptions = {}): Promise<ToolContext> {
  const bodies = new Map<string, unknown>();
  for (const route of ["system/status", "history", "history/series", "blocklist"]) {
    bodies.set(
      route,
      structuredClone((await loadFixture(fixtureRoot, fixturePathFor("sonarr", route))).body),
    );
  }
  bodies.set(
    "config/downloadclient",
    structuredClone(
      (await loadFixture(fixtureRoot, fixturePathFor("sonarr", "config/downloadclient"))).body,
    ),
  );

  const removed = new Set<number>();
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    const route = url.pathname.replace(/^\/api\/v3\//u, "");
    const method = init.method ?? "GET";

    if (method === "DELETE" || method === "POST") {
      const blocklistId = /^blocklist\/(\d+)$/u.exec(route);
      if (options.applyThenDrop === true && blocklistId !== null) {
        removed.add(Number(blocklistId[1]));
      }
      if (options.dropWrites === true || options.applyThenDrop === true) {
        throw new Error("connection reset");
      }
      return new Response(null, { status: 200 });
    }

    const body = bodies.get(route);
    if (body === undefined) {
      return jsonResponse({ message: "not found" }, 404);
    }
    if (route === "blocklist" && removed.size > 0) {
      const paged = body as { records: Record<string, unknown>[] };
      const kept = paged.records.filter((record) => !removed.has(Number(record.id)));
      return jsonResponse({ ...paged, records: kept, totalRecords: kept.length });
    }
    return jsonResponse(body);
  };

  return createTestToolContext({
    environment: {
      SONARR_URL: "https://sonarr.example.invalid",
      SONARR_API_KEY: testApiKeys.sonarr as string,
    },
    fetch,
    state: createWorkflowState(),
  });
}

describe("arr_activity_change reconciliation", () => {
  it("confirms a removal whose answer was lost by re-reading the blocklist", async () => {
    const context = await stubContext({ applyThenDrop: true });
    const reference = await referenceFor(context, "sonarr", "blocklist", 7001);

    const result = await call(changeTool, context, {
      intent: "remove_blocklist_record",
      mode: "apply",
      records: [reference],
    });

    const outcome = outcomeFor(result, "sonarr");
    expect(outcome.items?.[0]?.status).toBe("ok");
    expect(outcome.items?.[0]?.warnings.join(" ")).toContain("confirmed it applied");
    // Confirmed means succeeded: the receipt must not stay open for a retry of
    // a mutation this server has established already happened.
    expect(mutation(result).receipt?.state).toBe("succeeded");
  });

  it("reports a removal the instance did not apply as retryable, not unknown", async () => {
    const context = await stubContext({ dropWrites: true });
    const reference = await referenceFor(context, "sonarr", "blocklist", 7001);

    const result = await call(changeTool, context, {
      intent: "remove_blocklist_record",
      mode: "apply",
      records: [reference],
    });

    const outcome = outcomeFor(result, "sonarr");
    const item = outcome.items?.[0];
    expect(item?.status).toBe("error");
    expect(item?.warnings.join(" ")).toContain("unchanged");
    // The item reports what reconciliation established, not the transport
    // symptom that made the answer unknown — that survives only as the reason a
    // re-read was needed.
    expect(item?.error?.code).toBe("conflict");
    expect(item?.error?.message).toContain("did not apply");
    expect(item?.error?.message).toContain("its answer was lost");

    // Re-reading showed the record still there, so nothing is unknown: the
    // receipt settles as failed and the caller may simply try again. The
    // call-level error says which showing settled it rather than repeating one
    // item's transport failure.
    expect(mutation(result).receipt?.state).toBe("failed");
    expect(outcome.error?.message).toContain("re-reading the instance established");
    expect(outcome.error?.message).not.toContain("timed out");
  });

  it("leaves a mark-failed whose answer was lost as outcome-unknown", async () => {
    const context = await stubContext({ dropWrites: true });
    const reference = await referenceFor(context, "sonarr", "history", 9001);

    const result = await call(changeTool, context, {
      intent: "mark_history_failed",
      mode: "apply",
      records: [reference],
    });

    const outcome = outcomeFor(result, "sonarr");
    // The instance records no download-failed event for that download, so
    // nothing was established either way. Reporting success would claim a
    // mutation nothing observed; reporting failure would licence a retry of one
    // that may have applied.
    expect(outcome.status).toBe("error");
    expect(mutation(result).receipt?.state).toBe("outcome_unknown");
  });
});
