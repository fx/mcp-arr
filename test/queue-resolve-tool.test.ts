import { beforeEach, describe, expect, it } from "vitest";
import { createWorkflowState, type WorkflowState } from "../src/state/workflow.js";
import { findToolDefinition, type ToolDefinition } from "../src/tools/definitions.js";
import type { ToolContext } from "../src/tools/dispatch.js";
import { type OperationDefinition, operationDefinitions } from "../src/tools/operations.js";
import {
  createQueueReconciliationReader,
  queueResolveHandler,
  queueResolvePreconditions,
  reconciliationTargetsFor,
} from "../src/tools/queue-resolve.js";
import type { ToolResult } from "../src/tools/results.js";
import { activityFixture } from "./support/activity.js";
import {
  allApplicationsEnvironment,
  createTestToolContext,
  jsonResponse,
  testApiKeys,
} from "./support/tool-context.js";

/**
 * `arr_queue_resolve` plan, apply, and reconciliation, end to end.
 *
 * The tool is not registered yet — task 3 of change 0006 does that — so the
 * operation registry these tests run against is the real one with the queue
 * variants paired to this change's handler and precondition reader. That
 * pairing is exactly what task 3 will add, so everything below exercises the
 * real dispatcher: plan recording, read-set comparison, receipts, replay, and
 * settlement all belong to it and none of them is simulated here.
 *
 * Every queue reference is obtained the way a caller obtains one, by running
 * `arr_activity_query` against the same context first. Nothing is hand-minted.
 */

const resolveTool = findToolDefinition("arr_queue_resolve") as ToolDefinition;
const queryTool = findToolDefinition("arr_activity_query") as ToolDefinition;

/** The registry task 3 will produce, assembled here so the tests can run now. */
const operations: readonly OperationDefinition[] = operationDefinitions.map((operation) =>
  operation.tool === "arr_queue_resolve"
    ? {
        ...operation,
        handler: queueResolveHandler,
        readPreconditions: queueResolvePreconditions,
      }
    : operation,
);

const canary = "CANARY-QUEUE-APPLY-77";

interface QueueRow extends Record<string, unknown> {
  id: number;
  status: string;
}

interface Instance {
  readonly fetch: (input: string, init: RequestInit) => Promise<Response>;
  readonly requests: { method: string; route: string; query: URLSearchParams }[];
  rows: QueueRow[];
  blocklist: Record<string, unknown>[];
  history: Record<string, unknown>[];
  commands: Record<string, unknown>[];
  /** How a delete behaves, so a lost answer can be produced deliberately. */
  deleteBehavior: "accept" | "lose" | "refuse";
  unreachable: boolean;
}

/**
 * A Sonarr whose queue this test can change.
 *
 * The rows start as the recorded, version-labelled queue fixture, so what the
 * readers parse is a real payload rather than a hand-written one; only the
 * mutations below alter it. Writes are applied to its own copy, so a test can
 * assert both what was sent and what a later read would see.
 */
async function createInstance(): Promise<Instance> {
  const fixture = await activityFixture<{ records: QueueRow[] }>("sonarr", "queue");
  const instance: Instance = {
    requests: [],
    rows: fixture.records.map((record) => ({
      ...record,
      title: `${String(record.title)} ${canary}`,
      downloadId: canary,
      outputPath: `/downloads/${canary}/payload`,
      errorMessage: `stalled at /downloads/${canary}`,
    })),
    blocklist: [],
    history: [],
    commands: [],
    deleteBehavior: "accept",
    unreachable: false,
    fetch: async (input, init) => {
      const url = new URL(input);
      // The configured Sonarr URL carries a path prefix, so the route is what
      // follows the versioned API base rather than what follows the host.
      const route = url.pathname.slice(url.pathname.indexOf("/api/v3/") + "/api/v3/".length);
      const method = init.method ?? "GET";
      instance.requests.push({ method, route, query: url.searchParams });

      if (instance.unreachable) {
        throw new Error("connection refused");
      }
      if ((init.headers as Record<string, string>)["X-Api-Key"] !== testApiKeys.sonarr) {
        return jsonResponse({ message: "unauthorized" }, 401);
      }

      if (method === "DELETE" || method === "POST") {
        const id = Number(route.split("/").at(-1));
        if (instance.deleteBehavior === "refuse") {
          return jsonResponse({ message: "rejected" }, 400);
        }
        if (instance.deleteBehavior === "lose") {
          // The instance may well have applied it; the answer never arrives.
          throw new Error("socket hang up");
        }
        instance.rows = instance.rows.filter((row) => row.id !== id);
        return new Response(null, { status: 204 });
      }

      switch (route) {
        case "system/status":
          return jsonResponse({ appName: "Sonarr", version: "4.0.19.2979" });
        case "queue":
          return jsonResponse({
            page: 1,
            pageSize: instance.rows.length,
            totalRecords: instance.rows.length,
            records: instance.rows,
          });
        case "queue/details":
          return jsonResponse(instance.rows);
        case "blocklist":
          return jsonResponse({
            page: 1,
            pageSize: instance.blocklist.length,
            totalRecords: instance.blocklist.length,
            records: instance.blocklist,
          });
        case "history/series":
          return jsonResponse(instance.history);
        case "command":
          return jsonResponse(instance.commands);
        default:
          return jsonResponse({ message: "unknown route" }, 404);
      }
    },
  };
  return instance;
}

let instance: Instance;
let state: WorkflowState;
let context: ToolContext;

beforeEach(async () => {
  instance = await createInstance();
  state = createWorkflowState();
  context = createTestToolContext({
    environment: { ...allApplicationsEnvironment },
    fetch: instance.fetch,
    state,
    operations,
  });
});

async function run(definition: ToolDefinition, args: unknown): Promise<ToolResult<unknown>> {
  const parsed = definition.inputSchema.safeParse(args);
  if (!parsed.success) {
    throw new Error(`Arguments rejected by the published schema: ${parsed.error.message}`);
  }
  const result = await definition.handle(context, parsed.data);
  expect(definition.outputSchema.safeParse(result).success).toBe(true);
  return result;
}

/** The queue references a caller would hold, obtained the way a caller gets them. */
async function queueReferences(): Promise<readonly string[]> {
  const result = await run(queryTool, {
    view: "queue",
    detail: "summary",
    applications: ["sonarr"],
  });
  const outcome = result.applications[0];
  if (outcome?.status !== "ok" || outcome.data === undefined) {
    throw new Error(`The queue query did not succeed: ${outcome?.error?.code ?? "no outcome"}`);
  }
  const data = outcome.data as { view: string; items: readonly { reference: string }[] };
  return data.items.map((item) => item.reference);
}

/** The reference for one fixture row, by the upstream identifier it stands for. */
async function referenceFor(queueItemId: number): Promise<string> {
  const references = await queueReferences();
  const index = instance.rows.findIndex((row) => row.id === queueItemId);
  const reference = references[index];
  if (reference === undefined) {
    throw new Error(`No reference was published for queue item ${String(queueItemId)}`);
  }
  return reference;
}

function outcomeOf(result: ToolResult<unknown>) {
  const outcome = result.applications[0];
  if (outcome === undefined) {
    throw new Error("The result carried no application outcome");
  }
  return outcome;
}

function deletes(): { route: string; query: URLSearchParams }[] {
  return instance.requests.filter((request) => request.method === "DELETE");
}

// 502 is the blocked import in the recorded fixture, and 503 the pending release.
const blockedImport = 502;
const pendingRelease = 503;

describe("queue resolution plan mode", () => {
  it("plans a removal without sending anything and discloses its effects", async () => {
    const reference = await referenceFor(blockedImport);
    const result = await run(resolveTool, {
      intent: "remove_from_client_and_delete_data",
      mode: "plan",
      items: [reference],
    });

    expect(outcomeOf(result).status).toBe("ok");
    expect(result.mutation?.plan).toMatch(/^pln_/u);
    expect(result.mutation?.requestedEffects.map((effect) => effect.summary).join(" | ")).toContain(
      "delete the data it downloaded",
    );
    expect(result.mutation?.predictedEffects.length).toBeGreaterThan(0);
    expect(result.mutation?.readSet?.length).toBe(1);
    // Planning reads; it never writes.
    expect(deletes()).toHaveLength(0);
    expect(instance.rows.some((row) => row.id === blockedImport)).toBe(true);
  });

  it("predicts nothing when no selected row can be resolved", async () => {
    const reference = await referenceFor(pendingRelease);
    // A pending release refuses a tracked intent before any upstream request.
    const result = await run(resolveTool, {
      intent: "remove_from_client_and_delete_data",
      mode: "plan",
      items: [reference],
    });

    expect(result.mutation?.predictedEffects).toEqual([]);
    expect(outcomeOf(result).items?.[0]?.status).toBe("error");
    expect(deletes()).toHaveLength(0);
  });
});

describe("queue resolution apply mode", () => {
  it("applies a direct intent and sends the reviewed request", async () => {
    const reference = await referenceFor(blockedImport);
    const result = await run(resolveTool, {
      intent: "ignore_tracking",
      mode: "apply",
      items: [reference],
    });

    expect(outcomeOf(result).status).toBe("ok");
    expect(result.mutation?.receipt?.state).toBe("succeeded");

    const sent = deletes();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.route).toBe(`queue/${String(blockedImport)}`);
    expect(Object.fromEntries(sent[0]?.query ?? [])).toEqual({
      removeFromClient: "false",
      blocklist: "false",
      skipRedownload: "true",
      changeCategory: "false",
    });
    expect(instance.rows.some((row) => row.id === blockedImport)).toBe(false);
  });

  it("applies a recorded plan and refuses one whose state moved", async () => {
    const reference = await referenceFor(blockedImport);
    const planned = await run(resolveTool, {
      intent: "blocklist_and_remove",
      mode: "plan",
      items: [reference],
      replacementSearch: "suppress",
    });
    const plan = planned.mutation?.plan as string;

    // The row's tracked state moves the way a real import completing would.
    const row = instance.rows.find((candidate) => candidate.id === blockedImport) as QueueRow;
    row.trackedDownloadState = "imported";

    const stale = await run(resolveTool, { mode: "apply", plan });
    expect(outcomeOf(stale).error?.code).toBe("stale_plan");
    expect(deletes()).toHaveLength(0);
  });

  it("applies a plan whose state has not moved", async () => {
    const reference = await referenceFor(blockedImport);
    const planned = await run(resolveTool, {
      intent: "blocklist_and_remove",
      mode: "plan",
      items: [reference],
      replacementSearch: "allow",
    });

    const applied = await run(resolveTool, {
      mode: "apply",
      plan: planned.mutation?.plan as string,
    });

    expect(outcomeOf(applied).status).toBe("ok");
    expect(Object.fromEntries(deletes()[0]?.query ?? [])).toEqual({
      removeFromClient: "true",
      blocklist: "true",
      skipRedownload: "false",
      changeCategory: "false",
    });
  });

  it("reports each selected row independently when one is stale", async () => {
    const references = await queueReferences();
    const first = await referenceFor(blockedImport);
    const warning = references.find((candidate) => candidate !== first) as string;
    // The second row leaves the queue between the reference being minted and
    // the mutation being applied.
    instance.rows = instance.rows.filter(
      (row) => row.id === blockedImport || row.status === "delay",
    );

    const result = await run(resolveTool, {
      intent: "ignore_tracking",
      mode: "apply",
      items: [first, warning],
    });

    const items = outcomeOf(result).items ?? [];
    expect(items).toHaveLength(2);
    expect(items.filter((item) => item.status === "ok")).toHaveLength(1);
    const failed = items.find((item) => item.status === "error");
    expect(failed?.error?.code).toBe("stale_reference");
    // The healthy row was still resolved: a bulk mutation is not transactional.
    expect(deletes()).toHaveLength(1);
  });

  it("answers a repeated apply from its receipt instead of sending again", async () => {
    const reference = await referenceFor(blockedImport);
    const args = { intent: "ignore_tracking", mode: "apply", items: [reference] };

    const first = await run(resolveTool, args);
    const second = await run(resolveTool, args);

    expect(first.mutation?.receipt?.reference).toBe(second.mutation?.receipt?.reference);
    expect(second.applications[0]?.warnings.join(" ")).toContain("already applied");
    expect(deletes()).toHaveLength(1);
  });

  it("settles as outcome-unknown when the answer is lost", async () => {
    const reference = await referenceFor(blockedImport);
    instance.deleteBehavior = "lose";

    const result = await run(resolveTool, {
      intent: "ignore_tracking",
      mode: "apply",
      items: [reference],
    });

    // Never reported as `ok`: the request may have been accepted.
    expect(outcomeOf(result).status).toBe("error");
    expect(result.mutation?.receipt?.state).toBe("outcome_unknown");
  });

  it("does not record a refused mutation as one that never happened", async () => {
    const reference = await referenceFor(blockedImport);
    instance.deleteBehavior = "refuse";

    const result = await run(resolveTool, {
      intent: "ignore_tracking",
      mode: "apply",
      items: [reference],
    });

    // The request was dispatched and upstream refused it, so the item carries
    // the rejection and the receipt settles from a real attempt. `unattempted`
    // is the one thing it must not be: that would say nothing was sent, and
    // something was.
    expect(outcomeOf(result).items?.[0]?.error?.code).toBe("upstream_rejection");
    expect(result.mutation?.receipt?.state).toBe("succeeded");
    // The envelope still says the call did not fully do what was asked, so a
    // caller reading only the summary is not told of a clean success.
    expect(result.status).toBe("partial");
  });

  it("routes a manual import without sending anything and still succeeds", async () => {
    const reference = await referenceFor(blockedImport);
    const result = await run(resolveTool, {
      intent: "route_to_manual_import",
      mode: "apply",
      items: [reference],
    });

    const item = outcomeOf(result).items?.[0];
    expect(item?.status).toBe("ok");
    expect(item?.warnings.join(" ")).toContain("arr_import_inspect");
    expect(deletes()).toHaveLength(0);
    // A transition that legitimately sends nothing is not an unattempted
    // mutation: the receipt must not settle as failed.
    expect(result.mutation?.receipt?.state).toBe("succeeded");
  });

  it("grabs a pending release through its own route", async () => {
    const reference = await referenceFor(pendingRelease);
    const result = await run(resolveTool, {
      intent: "force_pending_grab",
      mode: "apply",
      items: [reference],
    });

    expect(outcomeOf(result).status).toBe("ok");
    const posted = instance.requests.filter((request) => request.method === "POST");
    expect(posted[0]?.route).toBe(`queue/grab/${String(pendingRelease)}`);
  });

  it("reports an unavailable application without sending anything", async () => {
    const reference = await referenceFor(blockedImport);
    instance.unreachable = true;

    const result = await run(resolveTool, {
      intent: "ignore_tracking",
      mode: "apply",
      items: [reference],
    });

    expect(outcomeOf(result).status).toBe("unavailable");
    expect(outcomeOf(result).error?.code).toBe("unavailable_application");
    expect(deletes()).toHaveLength(0);
  });
});

describe("queue resolution reconciliation", () => {
  /**
   * Applies with the answer lost, then hands back what the apply validated, so
   * reconciliation compares against the state the mutation was compiled from
   * rather than a second, later reading of the same row.
   */
  async function lostApply(intent = "ignore_tracking") {
    const reference = await referenceFor(blockedImport);
    let validated: unknown;
    const watched: readonly OperationDefinition[] = operations.map((operation) =>
      operation.tool === "arr_queue_resolve"
        ? {
            ...operation,
            handler: async (invocation) => {
              validated = invocation.validated;
              return await queueResolveHandler(invocation);
            },
          }
        : operation,
    );
    context = createTestToolContext({
      environment: { ...allApplicationsEnvironment },
      fetch: instance.fetch,
      state,
      operations: watched,
    });

    instance.deleteBehavior = "lose";
    const result = await run(resolveTool, { intent, mode: "apply", items: [reference] });
    instance.deleteBehavior = "accept";

    const receipt = result.mutation?.receipt;
    expect(receipt?.state).toBe("outcome_unknown");
    return { receipt: receipt?.reference as string, validated, intent };
  }

  it("settles as succeeded when the row has left the queue", async () => {
    const lost = await lostApply();
    // The instance had in fact applied it; only the answer was lost.
    instance.rows = instance.rows.filter((row) => row.id !== blockedImport);

    const reconciled = await state.applies.reconcile(
      lost.receipt,
      createQueueReconciliationReader({
        client: context.registry.adapter("sonarr")?.client as never,
        application: "sonarr",
        intent: "ignore_tracking",
        targets: reconciliationTargetsFor(lost.validated),
      }),
    );

    expect(reconciled.status).toBe("reconciled");
    expect(reconciled.status === "reconciled" && reconciled.record.state).toBe("succeeded");
  });

  it("settles as failed when the row is still queued exactly as it was", async () => {
    const lost = await lostApply();

    const reconciled = await state.applies.reconcile(
      lost.receipt,
      createQueueReconciliationReader({
        client: context.registry.adapter("sonarr")?.client as never,
        application: "sonarr",
        intent: "ignore_tracking",
        targets: reconciliationTargetsFor(lost.validated),
      }),
    );

    expect(reconciled.status).toBe("reconciled");
    expect(reconciled.status === "reconciled" && reconciled.record.state).toBe("failed");
  });

  it("stays indeterminate when the row moved but nothing corroborates it", async () => {
    const lost = await lostApply();
    // Something happened to the row, but nothing says this mutation did it.
    const row = instance.rows.find((candidate) => candidate.id === blockedImport) as QueueRow;
    row.trackedDownloadState = "importing";

    const reconciled = await state.applies.reconcile(
      lost.receipt,
      createQueueReconciliationReader({
        client: context.registry.adapter("sonarr")?.client as never,
        application: "sonarr",
        intent: "ignore_tracking",
        targets: reconciliationTargetsFor(lost.validated),
      }),
    );

    expect(reconciled.status).toBe("indeterminate");
    expect(reconciled.status === "indeterminate" && reconciled.record.state).toBe(
      "outcome_unknown",
    );
  });

  it("does not accept a record about a different download as corroboration", async () => {
    const lost = await lostApply();
    const row = instance.rows.find((candidate) => candidate.id === blockedImport) as QueueRow;
    row.trackedDownloadState = "importing";
    // The right event type, for the right series, and older than this apply —
    // but about another download entirely. Matching on the media association
    // alone would read this as proof; matching on the download identity does
    // not, which is the whole reason the identity is carried.
    instance.history = [
      {
        id: 9000,
        eventType: "downloadIgnored",
        date: "2020-01-01T00:00:00Z",
        seriesId: row.seriesId,
        downloadId: "a-different-download",
        sourceTitle: "some other release",
        quality: { quality: { name: "Bluray-1080p" } },
      },
    ];

    const reconciled = await state.applies.reconcile(
      lost.receipt,
      createQueueReconciliationReader({
        client: context.registry.adapter("sonarr")?.client as never,
        application: "sonarr",
        intent: "ignore_tracking",
        targets: reconciliationTargetsFor(lost.validated),
      }),
    );

    expect(reconciled.status).toBe("indeterminate");
  });

  it("raises an ambiguous row to succeeded when history names this download", async () => {
    const lost = await lostApply();
    const row = instance.rows.find((candidate) => candidate.id === blockedImport) as QueueRow;
    row.trackedDownloadState = "importing";
    instance.history = [
      {
        id: 9001,
        eventType: "downloadIgnored",
        date: "2026-08-27T10:00:00Z",
        seriesId: row.seriesId,
        // The same download-client identifier the queue row carried, which is
        // what the salted digests on both sides are derived from.
        downloadId: canary,
        sourceTitle: `ignored ${canary}`,
        quality: { quality: { name: "Bluray-1080p" } },
      },
    ];

    const reconciled = await state.applies.reconcile(
      lost.receipt,
      createQueueReconciliationReader({
        client: context.registry.adapter("sonarr")?.client as never,
        application: "sonarr",
        intent: "ignore_tracking",
        targets: reconciliationTargetsFor(lost.validated),
      }),
    );

    expect(reconciled.status).toBe("reconciled");
    expect(reconciled.status === "reconciled" && reconciled.record.state).toBe("succeeded");
  });

  it("refuses to re-open a record that already settled", async () => {
    const reference = await referenceFor(blockedImport);
    const applied = await run(resolveTool, {
      intent: "ignore_tracking",
      mode: "apply",
      items: [reference],
    });

    const reconciled = await state.applies.reconcile(
      applied.mutation?.receipt?.reference as string,
      createQueueReconciliationReader({
        client: context.registry.adapter("sonarr")?.client as never,
        application: "sonarr",
        intent: "ignore_tracking",
        targets: [],
      }),
    );

    expect(reconciled.status).toBe("not_applicable");
  });
});

describe("queue resolution disclosure", () => {
  it("leaks nothing the instance authored into a result, plan, or receipt", async () => {
    const reference = await referenceFor(blockedImport);
    const planned = await run(resolveTool, {
      intent: "blocklist_and_remove",
      mode: "plan",
      items: [reference],
      replacementSearch: "suppress",
    });
    const applied = await run(resolveTool, {
      mode: "apply",
      plan: planned.mutation?.plan as string,
    });

    for (const serialized of [JSON.stringify(planned), JSON.stringify(applied)]) {
      expect(serialized).not.toContain(canary);
      expect(serialized).not.toContain("/downloads");
      // The upstream identifier a caller must never be handed back.
      expect(serialized).not.toContain(`"${String(blockedImport)}"`);
    }

    const plan = state.plans.resolve(planned.mutation?.plan as string);
    expect(JSON.stringify(plan.ok && plan.record.readSet)).not.toContain(canary);
  });
});
