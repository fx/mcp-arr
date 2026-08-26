import { beforeEach, describe, expect, it } from "vitest";
import type { ApplicationId } from "../src/applications.js";
import type { ApplyAttempt } from "../src/state/apply-records.js";
import { createManualClock, type ManualClock } from "../src/state/clock.js";
import { referenceLifetimes } from "../src/state/references.js";
import { createWorkflowState, type WorkflowState } from "../src/state/workflow.js";
import {
  type DispatchRequest,
  dispatchOperation,
  type ToolContext,
} from "../src/tools/dispatch.js";
import { createToolError } from "../src/tools/errors.js";
import {
  createOperationRegistry,
  type OperationDefinition,
  type OperationInvocation,
  type OperationOutcome,
  operationDefinitions,
} from "../src/tools/operations.js";
import type { ToolResult } from "../src/tools/results.js";
import {
  allApplicationsEnvironment,
  createTestToolContext,
  jsonResponse,
} from "./support/tool-context.js";

const password = "provider-password";
const statusBody = { appName: "Sonarr", version: "9.9.9.9" };

function baseOperation(tool: string, variant: string | undefined): OperationDefinition {
  const found = operationDefinitions.find(
    (operation) => operation.tool === tool && operation.variant === variant,
  );
  if (found === undefined) {
    throw new Error(`Missing operation for ${tool}/${variant ?? "-"}`);
  }
  return found;
}

/**
 * A harness that stands in for the domain changes that have not landed yet.
 *
 * The precondition reader observes a mutable value, so a test changes "upstream
 * state" by assignment; the handler records every call, so a test can assert
 * that a mutation was never attempted rather than only that its result looked
 * like a failure.
 */
interface Harness {
  readonly context: ToolContext;
  readonly state: WorkflowState;
  readonly clock: ManualClock;
  /** Every upstream URL the injected fetch was asked for. */
  readonly requested: string[];
  /** One entry per handler call, so a skipped mutation is observable. */
  readonly handled: OperationInvocation[];
  /** The stand-in for effect-relevant upstream state. */
  observed: unknown;
  mediaReference(application?: ApplicationId): string;
}

function createHarness(
  operations: readonly OperationDefinition[],
  handled: OperationInvocation[],
): Harness {
  const clock = createManualClock(0);
  const state = createWorkflowState({ clock });
  const requested: string[] = [];
  const context = createTestToolContext({
    environment: allApplicationsEnvironment,
    operations,
    state,
    fetch: async (url) => {
      requested.push(url);
      return jsonResponse(statusBody);
    },
  });

  return {
    context,
    state,
    clock,
    requested,
    handled,
    observed: "monitored",
    mediaReference(application: ApplicationId = "sonarr"): string {
      return state.references.mint({
        kind: "media",
        applications: [application],
        payload: () => ({ kind: "domain", snapshot: { upstreamId: "17", fingerprint: "v1" } }),
      }).reference;
    },
  };
}

function requestFor(
  overrides: Partial<DispatchRequest> & Pick<DispatchRequest, "tool">,
): DispatchRequest {
  return {
    variant: undefined,
    applications: undefined,
    mode: "read",
    planReference: undefined,
    input: {},
    ...overrides,
  };
}

function mutationOf(result: ToolResult<unknown>) {
  const mutation = result.mutation;
  if (mutation === undefined) {
    throw new Error("Expected a mutation envelope");
  }
  return mutation;
}

function codes(result: ToolResult<unknown>): string[] {
  return [
    ...result.errors.map((error) => error.code),
    ...result.applications.flatMap((outcome) =>
      outcome.error === undefined ? [] : [outcome.error.code],
    ),
  ];
}

/** Only the version probe is allowed; a mutation would be a different path. */
function onlyProbes(requested: readonly string[]): boolean {
  return requested.every((url) => url.endsWith("/system/status"));
}

describe("plan and apply", () => {
  let handled: OperationInvocation[];
  let harness: Harness;

  const setMonitoring: OperationDefinition = {
    ...baseOperation("arr_library_change", "set_monitoring"),
    readPreconditions: async () =>
      ({ status: "ok", observations: [{ key: "monitored", value: harness.observed }] }) as const,
    handler: async (invocation): Promise<OperationOutcome> => {
      handled.push(invocation);
      if (invocation.mode === "plan") {
        return {
          status: "ok",
          plan: {
            requestedEffects: [
              {
                application: invocation.application,
                severity: "consequential",
                summary: "monitor",
              },
            ],
            predictedEffects: [],
          },
        };
      }
      return { status: "ok", data: { applied: true } };
    },
  };

  beforeEach(() => {
    handled = [];
    harness = createHarness([setMonitoring], handled);
  });

  function intentFor(media: string) {
    return { intent: "set_monitoring", mode: "plan", items: [media], monitored: true };
  }

  async function plan(media: string): Promise<ToolResult<unknown>> {
    return dispatchOperation(
      harness.context,
      requestFor({
        tool: "arr_library_change",
        variant: "set_monitoring",
        mode: "plan",
        input: intentFor(media),
      }),
    );
  }

  it("returns effects and an opaque plan reference bound to one application", async () => {
    const media = harness.mediaReference();
    const result = await plan(media);

    expect(result.status).toBe("ok");
    const mutation = mutationOf(result);
    expect(mutation.requestedEffects).toEqual([
      { application: "sonarr", severity: "consequential", summary: "monitor" },
    ]);
    expect(mutation.plan?.startsWith("pln_")).toBe(true);
    expect(mutation.receipt).toBeUndefined();
    // The media reference names Sonarr, so Radarr is never targeted or probed.
    expect(result.applications.map((outcome) => outcome.application)).toEqual(["sonarr"]);

    const record = harness.state.plans.resolve(mutation.plan ?? "");
    expect(record.ok && record.record.readSet.map((entry) => entry.key)).toEqual(["monitored"]);
    expect(record.ok && record.record.intent).toEqual(intentFor(media));
    // Plan mode discloses the fingerprints applying it will re-check.
    expect(mutation.readSet).toEqual(record.ok ? record.record.readSet : undefined);
    expect(mutation.readSet?.[0]?.digest).not.toContain("monitored");
  });

  it("applies a recorded plan whose preconditions still hold", async () => {
    const media = harness.mediaReference();
    const planned = mutationOf(await plan(media));
    const planReference = planned.plan ?? "";

    const result = await dispatchOperation(
      harness.context,
      requestFor({
        tool: "arr_library_change",
        mode: "apply",
        planReference,
        input: { mode: "apply", plan: planReference },
      }),
    );

    expect(result.status).toBe("ok");
    expect(handled.map((invocation) => invocation.mode)).toEqual(["plan", "apply"]);
    // The replayed intent, not the plan-reference form the caller sent.
    expect(handled[1]?.input).toEqual(intentFor(media));
    expect(handled[1]?.plan?.reference).toBe(planReference);
    expect(mutationOf(result).receipt?.state).toBe("succeeded");
  });

  it("does not resend the mutation when the same intent arrives directly afterwards", async () => {
    const media = harness.mediaReference();
    const planReference = mutationOf(await plan(media)).plan ?? "";
    const applied = await dispatchOperation(
      harness.context,
      requestFor({
        tool: "arr_library_change",
        mode: "apply",
        planReference,
        input: { mode: "apply", plan: planReference },
      }),
    );

    const direct = await dispatchOperation(
      harness.context,
      requestFor({
        tool: "arr_library_change",
        variant: "set_monitoring",
        mode: "apply",
        input: { intent: "set_monitoring", mode: "apply", items: [media], monitored: true },
      }),
    );

    // Planning first and applying directly are two routes to one mutation, so
    // they must land on one receipt rather than mutate twice.
    expect(handled.map((invocation) => invocation.mode)).toEqual(["plan", "apply"]);
    expect(mutationOf(direct).receipt).toEqual(mutationOf(applied).receipt);
  });

  it("returns the outcome-unknown receipt on retry, even though the state moved", async () => {
    const media = harness.mediaReference();
    const timingOut: OperationDefinition = {
      ...setMonitoring,
      handler: async (invocation) => {
        handled.push(invocation);
        if (invocation.mode === "plan") {
          return {
            status: "ok",
            plan: { requestedEffects: [], predictedEffects: [] },
          };
        }
        // The request reached the application, which applied it, and only the
        // answer was lost.
        harness.observed = "unmonitored";
        return {
          status: "error",
          error: createToolError({
            code: "timeout",
            message: "sonarr: the request timed out",
            application: "sonarr",
          }),
        };
      },
    };
    const lossy = { ...harness.context, operations: createOperationRegistry([timingOut]) };

    const planReference =
      mutationOf(
        await dispatchOperation(
          lossy,
          requestFor({
            tool: "arr_library_change",
            variant: "set_monitoring",
            mode: "plan",
            input: intentFor(media),
          }),
        ),
      ).plan ?? "";
    const applyAgain = () =>
      dispatchOperation(
        lossy,
        requestFor({
          tool: "arr_library_change",
          mode: "apply",
          planReference,
          input: { mode: "apply", plan: planReference },
        }),
      );

    const first = await applyAgain();
    expect(mutationOf(first).receipt?.state).toBe("outcome_unknown");

    const second = await applyAgain();

    // Checking the plan first would answer stale_plan and bury the only record
    // this server holds of a request the application may have accepted.
    expect(codes(second)).not.toContain("stale_plan");
    expect(mutationOf(second).receipt).toEqual(mutationOf(first).receipt);
    expect(handled.map((invocation) => invocation.mode)).toEqual(["plan", "apply"]);
  });

  it("fails a planned apply as stale and sends no mutation when the read set moved", async () => {
    const media = harness.mediaReference();
    const planned = mutationOf(await plan(media));
    const planReference = planned.plan ?? "";
    harness.requested.length = 0;
    handled.length = 0;

    harness.observed = "unmonitored";
    const result = await dispatchOperation(
      harness.context,
      requestFor({
        tool: "arr_library_change",
        mode: "apply",
        planReference,
        input: { mode: "apply", plan: planReference },
      }),
    );

    expect(codes(result)).toContain("stale_plan");
    expect(result.applications[0]?.error?.message).toContain("monitored");
    // The handler is the only thing that can mutate, and it was never reached.
    expect(handled).toEqual([]);
    expect(onlyProbes(harness.requested)).toBe(true);
    // A stale plan leaves no receipt behind, so nothing suggests a half-apply.
    expect(mutationOf(result).receipt).toBeUndefined();
  });

  it("validates current state immediately before a direct apply", async () => {
    const blocking: OperationDefinition = {
      ...setMonitoring,
      readPreconditions: async ({ application }) => ({
        status: "blocked",
        error: createToolError({
          code: "conflict",
          message: `${application}: the series no longer exists`,
          application,
        }),
      }),
    };
    const blocked = createHarness([blocking], handled);
    const media = blocked.mediaReference();

    const result = await dispatchOperation(
      blocked.context,
      requestFor({
        tool: "arr_library_change",
        variant: "set_monitoring",
        mode: "apply",
        applications: ["sonarr"],
        input: { intent: "set_monitoring", mode: "apply", items: [media], monitored: true },
      }),
    );

    expect(codes(result)).toContain("conflict");
    expect(handled).toEqual([]);
    expect(onlyProbes(blocked.requested)).toBe(true);
  });

  it("applies directly without ever having planned", async () => {
    const media = harness.mediaReference();
    const result = await dispatchOperation(
      harness.context,
      requestFor({
        tool: "arr_library_change",
        variant: "set_monitoring",
        mode: "apply",
        input: { intent: "set_monitoring", mode: "apply", items: [media], monitored: true },
      }),
    );

    expect(result.status).toBe("ok");
    expect(handled.map((invocation) => invocation.mode)).toEqual(["apply"]);
    expect(mutationOf(result).receipt?.state).toBe("succeeded");
  });

  it("refuses to apply a plan through a tool that did not create it", async () => {
    const media = harness.mediaReference();
    const planReference = mutationOf(await plan(media)).plan ?? "";
    handled.length = 0;

    const result = await dispatchOperation(
      harness.context,
      requestFor({
        tool: "arr_queue_resolve",
        mode: "apply",
        planReference,
        input: { mode: "apply", plan: planReference },
      }),
    );

    expect(codes(result)).toEqual(["invalid_input"]);
    expect(result.errors[0]?.message).toContain("arr_library_change");
    expect(handled).toEqual([]);
  });

  it("rejects a plan whose own references expired before it was applied", async () => {
    // A queue-shaped lifetime: the reference the plan was built from outlives
    // neither the plan nor the caller's pause, so the replayed intent has to be
    // re-validated rather than trusted.
    const media = harness.state.references.mint({
      kind: "media",
      applications: ["sonarr"],
      lifetimeMs: 1_000,
      payload: () => ({ kind: "domain", snapshot: { upstreamId: "17", fingerprint: "v1" } }),
    }).reference;
    const planReference = mutationOf(await plan(media)).plan ?? "";
    handled.length = 0;
    harness.clock.advance(1_000);

    const result = await dispatchOperation(
      harness.context,
      requestFor({
        tool: "arr_library_change",
        mode: "apply",
        planReference,
        input: { mode: "apply", plan: planReference },
      }),
    );

    expect(codes(result)).toEqual(["stale_reference"]);
    expect(handled).toEqual([]);
    expect(onlyProbes(harness.requested)).toBe(true);
  });

  it("rejects an expired plan reference without reinterpreting it", async () => {
    const media = harness.mediaReference();
    const planReference = mutationOf(await plan(media)).plan ?? "";
    handled.length = 0;
    harness.clock.advance(referenceLifetimes.plan);

    const result = await dispatchOperation(
      harness.context,
      requestFor({
        tool: "arr_library_change",
        mode: "apply",
        planReference,
        input: { mode: "apply", plan: planReference },
      }),
    );

    expect(codes(result)).toEqual(["stale_plan"]);
    expect(handled).toEqual([]);
  });

  it("refuses a mutation that would target more than one application", async () => {
    const searchMissing: OperationDefinition = {
      ...baseOperation("arr_search_start", "missing"),
      handler: async (invocation) => {
        handled.push(invocation);
        return { status: "ok", data: {} };
      },
    };
    const spread = createHarness([searchMissing], handled);

    const result = await dispatchOperation(
      spread.context,
      requestFor({
        tool: "arr_search_start",
        variant: "missing",
        mode: "apply",
        input: { target: "missing", mode: "apply", monitoredOnly: true },
      }),
    );

    expect(codes(result)).toEqual(["invalid_input"]);
    expect(result.errors[0]?.message).toContain("sonarr, radarr");
    expect(handled).toEqual([]);
    expect(spread.requested).toEqual([]);
  });
});

describe("secret-bearing plans", () => {
  let handled: OperationInvocation[];
  let harness: Harness;

  const reconcile: OperationDefinition = {
    ...baseOperation("arr_config_reconcile", "reconcile_provider"),
    readPreconditions: async () => ({ status: "ok", observations: [] }),
    handler: async (invocation): Promise<OperationOutcome> => {
      handled.push(invocation);
      if (invocation.mode === "plan") {
        return {
          status: "ok",
          plan: {
            requestedEffects: [
              {
                application: invocation.application,
                severity: "consequential",
                summary: "reconcile the indexer",
              },
            ],
            predictedEffects: [],
          },
        };
      }
      return { status: "ok", data: { reconciled: true } };
    },
  };

  const planInput = {
    intent: "reconcile_provider",
    mode: "plan",
    application: "sonarr",
    domain: "indexers",
    fields: [{ name: "baseUrl", value: "https://indexer.example.invalid" }],
    secrets: [{ name: "apiKey", value: password }],
  };

  beforeEach(() => {
    handled = [];
    harness = createHarness([reconcile], handled);
  });

  async function planned(): Promise<string> {
    const result = await dispatchOperation(
      harness.context,
      requestFor({
        tool: "arr_config_reconcile",
        variant: "reconcile_provider",
        mode: "plan",
        applications: ["sonarr"],
        input: planInput,
      }),
    );
    return mutationOf(result).plan ?? "";
  }

  it("retains the secret's name and presence but never its value", async () => {
    const planReference = await planned();
    const record = harness.state.plans.resolve(planReference);

    expect(record.ok && record.record.requiredSecrets.map((secret) => secret.name)).toEqual([
      "apiKey",
    ]);
    expect(JSON.stringify(record)).not.toContain(password);
    expect(JSON.stringify(harness.state.references.resolve(planReference, "plan"))).not.toContain(
      password,
    );
  });

  it("refuses to apply the plan until the named secret is resupplied", async () => {
    const planReference = await planned();
    handled.length = 0;

    const result = await dispatchOperation(
      harness.context,
      requestFor({
        tool: "arr_config_reconcile",
        mode: "apply",
        planReference,
        input: { mode: "apply", plan: planReference },
      }),
    );

    expect(codes(result)).toEqual(["invalid_input"]);
    expect(result.errors[0]?.message).toContain("apiKey");
    expect(handled).toEqual([]);
  });

  it("uses a resupplied secret for that request alone", async () => {
    const planReference = await planned();
    handled.length = 0;

    const result = await dispatchOperation(
      harness.context,
      requestFor({
        tool: "arr_config_reconcile",
        mode: "apply",
        planReference,
        input: {
          mode: "apply",
          plan: planReference,
          secrets: [{ name: "apiKey", value: password }],
        },
      }),
    );

    expect(result.status).toBe("ok");
    expect(JSON.stringify(handled[0]?.input)).toContain(password);
    // The plan record is unchanged: the value was never written back into it.
    expect(JSON.stringify(harness.state.plans.resolve(planReference))).not.toContain(password);
    expect(JSON.stringify(result)).not.toContain(password);
  });

  it("says so when a secret is supplied to a plan that needs none", async () => {
    const planless = createHarness([reconcile], handled);
    const result = await dispatchOperation(
      planless.context,
      requestFor({
        tool: "arr_config_reconcile",
        variant: "reconcile_provider",
        mode: "plan",
        applications: ["sonarr"],
        input: { ...planInput, secrets: undefined },
      }),
    );
    const planReference = mutationOf(result).plan ?? "";

    const applied = await dispatchOperation(
      planless.context,
      requestFor({
        tool: "arr_config_reconcile",
        mode: "apply",
        planReference,
        input: {
          mode: "apply",
          plan: planReference,
          secrets: [{ name: "apiKey", value: password }],
        },
      }),
    );

    expect(applied.applications[0]?.warnings).toContain(
      "this plan requires no transient secret; the supplied value(s) were not used",
    );
    expect(JSON.stringify(handled.at(-1)?.input)).not.toContain(password);
  });

  it("says so when the resupplied secret is not the planned one", async () => {
    const planReference = await planned();

    const result = await dispatchOperation(
      harness.context,
      requestFor({
        tool: "arr_config_reconcile",
        mode: "apply",
        planReference,
        input: {
          mode: "apply",
          plan: planReference,
          secrets: [{ name: "apiKey", value: "rotated" }],
        },
      }),
    );

    expect(result.applications[0]?.warnings).toContain(
      "the resupplied apiKey differs from the value the plan validated",
    );
  });
});

describe("mutation receipts and retry", () => {
  let handled: OperationInvocation[];
  let harness: Harness;
  let outcome: OperationOutcome;

  const mutate: OperationDefinition = {
    ...baseOperation("arr_library_change", "set_monitoring"),
    handler: async (invocation) => {
      handled.push(invocation);
      return outcome;
    },
  };

  beforeEach(() => {
    handled = [];
    outcome = { status: "ok", data: { applied: true } };
    harness = createHarness([mutate], handled);
  });

  function applyRequest(media: string): DispatchRequest {
    return requestFor({
      tool: "arr_library_change",
      variant: "set_monitoring",
      mode: "apply",
      input: { intent: "set_monitoring", mode: "apply", items: [media], monitored: true },
    });
  }

  it("returns the existing receipt on a repeat instead of mutating twice", async () => {
    const media = harness.mediaReference();
    const first = await dispatchOperation(harness.context, applyRequest(media));
    const second = await dispatchOperation(harness.context, applyRequest(media));

    expect(handled).toHaveLength(1);
    expect(mutationOf(second).receipt).toEqual(mutationOf(first).receipt);
    expect(second.applications[0]?.warnings.join(" ")).toContain("nothing was sent again");
  });

  it("records the receipt before the mutation is attempted", async () => {
    let inFlight: ApplyAttempt | undefined;
    const observing = createHarness(
      [
        {
          ...mutate,
          handler: async (invocation) => {
            handled.push(invocation);
            // Asking for the same apply while this one is still running must
            // find the existing record, which is only true if it was created
            // before the mutation was attempted rather than after it settled.
            inFlight = invocation.state.applies.begin({
              tool: "arr_library_change",
              variant: "set_monitoring",
              application: invocation.application,
              intent: invocation.input,
            });
            return { status: "ok", data: {} };
          },
        },
      ],
      handled,
    );
    const result = await dispatchOperation(
      observing.context,
      applyRequest(observing.mediaReference()),
    );

    expect(inFlight?.status).toBe("replayed");
    expect(inFlight?.record.state).toBe("applying");
    expect(inFlight?.record.reference).toBe(mutationOf(result).receipt?.reference);
    expect(mutationOf(result).receipt?.state).toBe("succeeded");
  });

  it("marks a lost answer as outcome unknown and reconciles it later", async () => {
    const media = harness.mediaReference();
    outcome = {
      status: "error",
      error: createToolError({
        code: "timeout",
        message: "sonarr: the request timed out",
        application: "sonarr",
      }),
    };

    const result = await dispatchOperation(harness.context, applyRequest(media));
    const receipt = mutationOf(result).receipt;
    expect(receipt?.state).toBe("outcome_unknown");

    const repeated = await dispatchOperation(harness.context, applyRequest(media));
    expect(handled).toHaveLength(1);
    expect(mutationOf(repeated).receipt?.state).toBe("outcome_unknown");
    // A replay of something whose outcome was never established is not a
    // success, and reporting it as one would hide the work still to be done.
    expect(repeated.status).toBe("error");
    expect(repeated.applications[0]?.error?.code).toBe("timeout");

    const reconciled = await harness.state.applies.reconcile(
      receipt?.reference ?? "",
      async () => ({
        status: "succeeded",
      }),
    );
    expect(reconciled.status).toBe("reconciled");
    expect(harness.state.applies.resolve(receipt?.reference ?? "")).toMatchObject({
      ok: true,
      record: { state: "succeeded" },
    });
  });

  it("marks an upstream refusal as failed and lets the caller retry it", async () => {
    const media = harness.mediaReference();
    outcome = {
      status: "error",
      error: createToolError({
        code: "upstream_rejection",
        message: "sonarr: the application rejected the request",
        application: "sonarr",
      }),
    };

    const failed = await dispatchOperation(harness.context, applyRequest(media));
    expect(mutationOf(failed).receipt?.state).toBe("failed");

    outcome = { status: "ok", data: { applied: true } };
    const retried = await dispatchOperation(harness.context, applyRequest(media));

    expect(handled).toHaveLength(2);
    expect(mutationOf(retried).receipt?.reference).toBe(mutationOf(failed).receipt?.reference);
    expect(mutationOf(retried).receipt?.state).toBe("succeeded");
  });

  it("does not treat an answer it could not read as proof the mutation was refused", async () => {
    const media = harness.mediaReference();
    outcome = {
      status: "error",
      error: createToolError({
        code: "unexpected_response",
        message: "sonarr: the request failed unexpectedly",
        application: "sonarr",
      }),
    };

    const first = await dispatchOperation(harness.context, applyRequest(media));
    // The request reached the application; only its reply was unreadable, so
    // the mutation may well have been applied.
    expect(mutationOf(first).receipt?.state).toBe("outcome_unknown");

    outcome = { status: "ok", data: { applied: true } };
    const second = await dispatchOperation(harness.context, applyRequest(media));

    expect(handled).toHaveLength(1);
    expect(mutationOf(second).receipt?.state).toBe("outcome_unknown");
  });

  it("reports a partial failure per item instead of concealing it", async () => {
    const media = harness.mediaReference();
    outcome = {
      status: "ok",
      items: [
        { reference: media, status: "ok", warnings: [] },
        {
          reference: "med_00000002",
          status: "error",
          warnings: [],
          error: createToolError({
            code: "upstream_rejection",
            message: "sonarr: that record no longer exists",
            application: "sonarr",
          }),
        },
      ],
    };

    const result = await dispatchOperation(harness.context, applyRequest(media));

    expect(result.status).toBe("partial");
    expect(result.errors.map((error) => error.code)).toContain("partial_failure");
    expect(result.applications[0]?.items?.filter((item) => item.status === "error")).toHaveLength(
      1,
    );
  });
});

describe("reference validation before dispatch", () => {
  let handled: OperationInvocation[];
  let harness: Harness;

  const query: OperationDefinition = {
    ...baseOperation("arr_library_query", "series"),
    handler: async (invocation) => {
      handled.push(invocation);
      return { status: "ok", data: {} };
    },
  };

  beforeEach(() => {
    handled = [];
    harness = createHarness([query], handled);
  });

  function seriesRequest(media: string): DispatchRequest {
    return requestFor({
      tool: "arr_library_query",
      variant: "series",
      input: { view: "series", media: [media] },
    });
  }

  it("rejects an expired reference before probing anything", async () => {
    const media = harness.mediaReference();
    harness.clock.advance(referenceLifetimes.media);

    const result = await dispatchOperation(harness.context, seriesRequest(media));

    expect(codes(result)).toEqual(["stale_reference"]);
    expect(result.errors[0]?.message).toContain("expired");
    expect(harness.requested).toEqual([]);
    expect(handled).toEqual([]);
  });

  it("rejects a reference minted before this process started", async () => {
    const previous = createWorkflowState({ clock: createManualClock(0) });
    const foreign = previous.references.mint({
      kind: "media",
      applications: ["sonarr"],
      payload: () => ({ kind: "domain", snapshot: { upstreamId: "1", fingerprint: "v1" } }),
    }).reference;

    const result = await dispatchOperation(harness.context, seriesRequest(foreign));

    expect(codes(result)).toEqual(["stale_reference"]);
    expect(result.errors[0]?.message).toContain("before this server process started");
    expect(harness.requested).toEqual([]);
  });

  it("narrows the target to the application the reference names", async () => {
    const result = await dispatchOperation(
      harness.context,
      requestFor({
        tool: "arr_library_query",
        variant: "series",
        applications: ["sonarr", "radarr", "prowlarr"],
        input: { view: "series", media: [harness.mediaReference("sonarr")] },
      }),
    );

    expect(result.applications.map((outcome) => outcome.application)).toEqual(["sonarr"]);
    expect(handled.map((invocation) => invocation.application)).toEqual(["sonarr"]);
  });

  it("refuses an input whose references name different applications", async () => {
    const result = await dispatchOperation(
      harness.context,
      requestFor({
        tool: "arr_library_query",
        variant: "series",
        input: {
          view: "series",
          media: [harness.mediaReference("sonarr"), harness.mediaReference("radarr")],
        },
      }),
    );

    expect(codes(result)).toEqual(["invalid_input"]);
    expect(harness.requested).toEqual([]);
    expect(handled).toEqual([]);
  });

  it("does not mistake caller-authored free text for a reference", async () => {
    const lookup: OperationDefinition = {
      ...baseOperation("arr_library_query", "lookup"),
      handler: async (invocation) => {
        handled.push(invocation);
        return { status: "ok", data: {} };
      },
    };
    const searching = createHarness([lookup], handled);

    const result = await dispatchOperation(
      searching.context,
      requestFor({
        tool: "arr_library_query",
        variant: "lookup",
        applications: ["sonarr"],
        // Shaped exactly like a release reference, but it is a search term.
        input: { view: "lookup", term: "rel_00000001" },
      }),
    );

    expect(result.status).toBe("ok");
    expect(handled).toHaveLength(1);
  });
});
