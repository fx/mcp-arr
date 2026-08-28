import type { AdapterRegistry, ApplicationCapability } from "../adapters/registry.js";
import { type ApplicationId, applicationIds } from "../applications.js";
import type { ApplyRecord, ApplySettlement } from "../state/apply-records.js";
import {
  compareReadSet,
  fingerprintReadSet,
  type PlanRecord,
  type ReadSetFingerprint,
  type ReadSetObservation,
} from "../state/plans.js";
import { type ReferenceStore, referenceKindForToken } from "../state/references.js";
import type { WorkflowState } from "../state/workflow.js";
import {
  createToolError,
  type ToolError,
  toolErrorForReferenceFailure,
  toolErrorForThrown,
  toolErrorForUpstreamFailure,
  toolErrorProvesNoEffect,
} from "./errors.js";
import type { ToolName } from "./names.js";
import {
  checkOperationSupport,
  type OperationDefinition,
  type OperationInvocation,
  type OperationMode,
  type OperationRegistry,
} from "./operations.js";
import {
  type ApplicationOutcome,
  applicationOutcome,
  buildToolResult,
  type Effect,
  type ItemOutcome,
  type MutationDetail,
  maxMutationApplications,
  type Receipt,
  type ToolResult,
} from "./results.js";
import { isReferenceProperty, type ReferenceKind } from "./schemas/common.js";

/**
 * Everything a tool handler is allowed to reach. All three dependencies are
 * injected so tool behavior is testable without a network, without the
 * module-level operation inventory, and without waiting for a reference to
 * expire in real time.
 */
export interface ToolContext {
  readonly registry: AdapterRegistry;
  readonly operations: OperationRegistry;
  readonly state: WorkflowState;
}

export interface DispatchRequest {
  readonly tool: ToolName;
  /** The already-validated public discriminator value, if the tool has one. */
  readonly variant: string | undefined;
  /**
   * The caller's application filter. When absent the operation's own declared
   * applications are targeted, narrowed further by any opaque reference the
   * input carried, since such a reference already names one application.
   */
  readonly applications: readonly ApplicationId[] | undefined;
  readonly mode: OperationMode;
  /**
   * Set when the caller applied a recorded plan instead of restating the
   * intent. The intent then lives in the plan record rather than in the input,
   * so dispatch cannot derive a variant from the arguments alone.
   */
  readonly planReference: string | undefined;
  readonly input: unknown;
}

/**
 * Resolves one application's capability without probing anything unnecessary:
 * an application with no adapter was never configured, so no request is sent
 * and no placeholder credential is required to say so.
 */
export async function capabilityFor(
  context: ToolContext,
  application: ApplicationId,
): Promise<ApplicationCapability> {
  const adapter = context.registry.adapter(application);
  if (adapter === undefined) {
    return { application, status: "unconfigured" };
  }
  return adapter.probe();
}

function describeUnsupported(
  application: ApplicationId,
  tool: ToolName,
  requiredVersion: string | undefined,
): string {
  return requiredVersion === undefined
    ? `${application}: this ${tool} variant is not available on this application`
    : `${application}: this ${tool} variant requires version ${requiredVersion} or newer`;
}

function unsupportedOutcome(
  application: ApplicationId,
  tool: ToolName,
  requiredVersion: string | undefined,
): ApplicationOutcome<unknown> {
  return applicationOutcome({
    application,
    status: "unsupported",
    error: createToolError({
      code: "unsupported_capability",
      message: describeUnsupported(application, tool, requiredVersion),
      application,
    }),
  });
}

function unconfiguredOutcome(application: ApplicationId): ApplicationOutcome<unknown> {
  return applicationOutcome({
    application,
    status: "unconfigured",
    error: createToolError({
      code: "unconfigured_application",
      message: `${application}: no instance is configured`,
      application,
    }),
  });
}

function errorOutcome(
  application: ApplicationId,
  error: ToolError,
  items?: readonly ItemOutcome[] | undefined,
): ApplicationOutcome<unknown> {
  return applicationOutcome({ application, status: "error", error, items });
}

function errorResult(error: ToolError): ToolResult<unknown> {
  return buildToolResult({ errors: [error] });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface CollectedReference {
  readonly token: string;
  readonly kind: ReferenceKind;
}

/**
 * Collects the opaque references an already-validated input carried.
 *
 * Two filters have to agree before a value is treated as a reference. The
 * property must be one the schemas declare as reference-bearing, so
 * caller-authored free text — a Prowlarr search term, a media title — is never
 * resolved; and the value must carry a prefix this server mints, so a property
 * one tool declares as reference-bearing is passed over rather than rejected
 * where another tool gives the same name a different meaning. Neither filter is
 * redundant: `referenceProperties` is a list a schema change can add to, and
 * the second filter is what keeps that from turning an ordinary string into a
 * lookup. Anything that satisfies neither is the schema's business, and the
 * schema already validated it.
 */
function collectReferences(input: unknown): readonly CollectedReference[] {
  const found: CollectedReference[] = [];

  const visit = (value: unknown, referenceBearing: boolean): void => {
    if (typeof value === "string") {
      const kind = referenceBearing ? referenceKindForToken(value) : undefined;
      if (kind !== undefined) {
        found.push({ token: value, kind });
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item, referenceBearing);
      }
      return;
    }
    if (!isRecord(value)) {
      return;
    }
    for (const [name, property] of Object.entries(value)) {
      visit(property, isReferenceProperty(name));
    }
  };

  visit(input, false);
  return found;
}

interface ReferenceBinding {
  /** The one application every resolved reference agreed on, if there was one. */
  readonly application: ApplicationId | undefined;
}

type ReferenceCheck =
  | { readonly ok: true; readonly binding: ReferenceBinding }
  | { readonly ok: false; readonly error: ToolError };

/**
 * Resolves every reference an input carried, before an application is selected.
 *
 * This is the single place a wrong-kind, forged, expired, or previous-lifetime
 * reference is rejected, and it runs before any adapter is probed — which is
 * what makes "no upstream request is sent" a property of the dispatcher rather
 * than a promise each handler has to keep. Resolution also narrows the target:
 * a reference names its application, so a tool whose operation is declared for
 * all three never fans out across instances the caller did not mean.
 */
function checkReferences(references: ReferenceStore, input: unknown): ReferenceCheck {
  const applications = new Set<ApplicationId>();

  for (const { token, kind } of collectReferences(input)) {
    const resolution = references.resolve(token, kind);
    if (!resolution.ok) {
      return { ok: false, error: toolErrorForReferenceFailure(resolution.reason, kind) };
    }
    for (const application of resolution.entry.applications) {
      applications.add(application);
    }
  }

  if (applications.size > 1) {
    return {
      ok: false,
      error: createToolError({
        code: "invalid_input",
        message: "the supplied references belong to more than one application",
      }),
    };
  }
  return { ok: true, binding: { application: [...applications][0] } };
}

/**
 * Selects the applications to target, in the canonical application order and
 * without duplicates, so a caller cannot make one instance run the same
 * mutation twice by naming it twice. A reference binding wins over the caller's
 * filter, because the reference is the thing that actually names an instance.
 */
function selectApplications(
  requested: readonly ApplicationId[] | undefined,
  operation: OperationDefinition,
  bound: ApplicationId | undefined,
): readonly ApplicationId[] {
  if (bound !== undefined) {
    return [bound];
  }
  // An empty filter is treated as no filter. The published schema requires at
  // least one entry, so this can only arrive from an internal caller, and
  // answering it with an empty successful envelope would report that nothing
  // failed while nothing ran either.
  const wanted = new Set<ApplicationId>(
    requested === undefined || requested.length === 0 ? operation.applications : requested,
  );
  return applicationIds.filter((application) => wanted.has(application));
}

/**
 * How one application's run contributed to the envelope.
 *
 * Plan references, job references, and receipts are collected here rather than
 * written straight into the outcome because the published mutation envelope
 * carries them once per call, not once per application.
 */
interface OperationRun {
  readonly outcome: ApplicationOutcome<unknown>;
  readonly requestedEffects: readonly Effect[];
  readonly predictedEffects: readonly Effect[];
  /** The fingerprints a plan recorded, disclosed so a caller can see them. */
  readonly readSet?: readonly ReadSetFingerprint[];
  readonly plan?: string;
  readonly job?: string;
  readonly receipt?: Receipt;
}

/**
 * Decides how a failed mutation settles its receipt.
 *
 * Only a failure that proves the application did not act settles as `failed`,
 * because that is the one state a later attempt is allowed to reuse. Everything
 * else — a timeout, an unreachable instance, an answer this server could not
 * make sense of — leaves the outcome unknown, so a lost or unreadable reply is
 * never mistaken for a refusal and re-sent.
 */
function settlementFor(error: ToolError): ApplySettlement {
  return toolErrorProvesNoEffect(error.code)
    ? { status: "failed", error }
    : { status: "outcome_unknown", error };
}

async function readPreconditions(
  operation: OperationDefinition,
  invocation: OperationInvocation,
): Promise<
  | {
      readonly ok: true;
      readonly observations: readonly ReadSetObservation[];
      readonly warnings: readonly string[];
      /** The reader's own resolved state, handed to the handler unchanged. */
      readonly validated: unknown;
    }
  | { readonly ok: false; readonly error: ToolError }
> {
  if (operation.readPreconditions === undefined) {
    return { ok: true, observations: [], warnings: [], validated: undefined };
  }

  let read: Awaited<ReturnType<typeof operation.readPreconditions>>;
  try {
    read = await operation.readPreconditions(invocation);
  } catch (error) {
    return { ok: false, error: toolErrorForThrown(error, invocation.application) };
  }

  if (read.status === "blocked") {
    return { ok: false, error: read.error };
  }
  return {
    ok: true,
    observations: read.observations,
    warnings: read.warnings ?? [],
    validated: read.validated,
  };
}

interface RunOptions {
  readonly context: ToolContext;
  readonly request: DispatchRequest;
  readonly operation: OperationDefinition;
  readonly application: ApplicationId;
  /** The effective intent: the caller's input, or a recorded plan's intent. */
  readonly input: unknown;
  readonly plan: PlanRecord | undefined;
}

async function invokeHandler(
  operation: OperationDefinition,
  invocation: OperationInvocation,
): Promise<Awaited<ReturnType<OperationDefinition["handler"]>>> {
  try {
    return await operation.handler(invocation);
  } catch (error) {
    return { status: "error", error: toolErrorForThrown(error, invocation.application) };
  }
}

function runFor(
  outcome: ApplicationOutcome<unknown>,
  extra: Omit<OperationRun, "outcome"> = { requestedEffects: [], predictedEffects: [] },
): OperationRun {
  return { outcome, ...extra };
}

/**
 * Runs a read: no plan, no receipt, and no current-state validation, because
 * nothing is about to change.
 */
async function runRead(
  options: RunOptions,
  invocation: OperationInvocation,
): Promise<OperationRun> {
  const outcome = await invokeHandler(options.operation, invocation);
  if (outcome.status === "error") {
    return runFor(errorOutcome(options.application, outcome.error, outcome.items));
  }
  return runFor(
    applicationOutcome({
      application: options.application,
      status: "ok",
      warnings: outcome.warnings ?? [],
      data: outcome.data,
      items: outcome.items,
      continuation: outcome.continuation,
    }),
  );
}

/**
 * Runs plan mode.
 *
 * Plan performs the non-mutating validation available now, records what it
 * read, and returns a reference. It is explicitly not authorization: nothing is
 * marked approved, and applying the recorded plan later re-reads everything.
 */
async function runPlan(
  options: RunOptions,
  invocation: OperationInvocation,
): Promise<OperationRun> {
  const preconditions = await readPreconditions(options.operation, invocation);
  if (!preconditions.ok) {
    return runFor(errorOutcome(options.application, preconditions.error));
  }

  const outcome = await invokeHandler(options.operation, {
    ...invocation,
    validated: preconditions.validated,
  });
  if (outcome.status === "error") {
    return runFor(errorOutcome(options.application, outcome.error));
  }
  if (outcome.plan === undefined) {
    return runFor(
      errorOutcome(
        options.application,
        createToolError({
          code: "unsupported_capability",
          message: `${options.application}: this operation does not support plan mode yet`,
          application: options.application,
        }),
      ),
    );
  }

  const warnings = [
    ...preconditions.warnings,
    ...(outcome.warnings ?? []),
    ...(outcome.plan.warnings ?? []),
  ];
  const record = options.context.state.plans.record({
    tool: options.operation.tool,
    variant: options.operation.variant,
    applications: [options.application],
    intent: options.input,
    requestedEffects: outcome.plan.requestedEffects,
    predictedEffects: outcome.plan.predictedEffects,
    warnings,
    observations: preconditions.observations,
  });

  return runFor(
    applicationOutcome({
      application: options.application,
      status: "ok",
      warnings,
      data: outcome.data,
      items: outcome.items,
    }),
    {
      requestedEffects: record.requestedEffects,
      predictedEffects: record.predictedEffects,
      readSet: record.readSet,
      plan: record.reference,
    },
  );
}

/**
 * Answers a repeat from the receipt an identical apply already produced.
 *
 * This runs before anything else, and that ordering is the point. A retry of a
 * mutation whose answer was lost arrives *after* that mutation may have changed
 * the very state its plan was validated against, so checking the plan first
 * would answer `stale_plan` and bury the outcome-unknown receipt — the only
 * record this server holds of a request upstream may have accepted.
 */
function replayReceipt(options: RunOptions, existing: ApplyRecord): OperationRun {
  return runFor(
    applicationOutcome({
      application: options.application,
      // A record whose outcome was never established is not a success to report
      // as one: the caller has to reconcile it, and a cheerful `ok` would
      // suggest there is nothing left to do.
      status: existing.state === "outcome_unknown" ? "error" : "ok",
      warnings: [
        "this exact mutation was already applied by this server; its existing receipt is returned and nothing was sent again",
      ],
      // Replayed rather than recomputed: a bulk mutation that partly failed
      // must repeat as the partial result it was, not as a clean success.
      items: existing.items,
      error: existing.error,
    }),
    {
      requestedEffects: [],
      predictedEffects: [],
      ...(existing.job === undefined ? {} : { job: existing.job }),
      receipt: { reference: existing.reference, state: existing.state },
    },
  );
}

/**
 * Decides how a completed handler settles its receipt.
 *
 * The three answers are not interchangeable. One whose answer was lost settles
 * as outcome-unknown and stays reconcilable; a mutation nothing was sent for
 * settles as `failed`, which is the one state a later identical attempt may
 * reuse; everything else succeeded.
 *
 * Only the first two retain the per-item outcomes, because only they are ever
 * answered from. A repeat of a succeeded or outcome-unknown apply is served
 * entirely from its receipt, so a bulk mutation that partly failed has to keep
 * saying so. A `failed` receipt is never served from at all — the next
 * identical attempt re-runs the mutation and produces outcomes of its own,
 * which is the same fact that makes reusing that record safe. This call's
 * caller still sees them: they travel in the response envelope, which is where
 * outcomes nothing will be asked for a second time belong.
 *
 * An unknown outcome is checked first, and the order is the safety property. A
 * handler that reports both is saying it sent something whose result it could
 * not establish *and* that some part of the call never went out; reading that
 * as `failed` would license a retry of a mutation that may already have
 * applied, and would discard the only record that made reconciliation
 * possible. Rounding the other way costs at worst a reconciliation nobody
 * needed.
 */
function settlementForOutcome(
  outcome: Extract<Awaited<ReturnType<OperationDefinition["handler"]>>, { status: "ok" }>,
): ApplySettlement {
  if (outcome.outcomeUnknown !== undefined) {
    return { status: "outcome_unknown", error: outcome.outcomeUnknown, items: outcome.items };
  }
  if (outcome.unattempted !== undefined) {
    return { status: "failed", error: outcome.unattempted };
  }
  return { status: "succeeded", job: outcome.job, items: outcome.items };
}

/**
 * Runs apply mode.
 *
 * The order is the contract: answer a repeat from its existing receipt, then
 * validate current state, then claim the receipt, then send. A receipt claimed
 * after the request would be missing in the one case it exists for, and a
 * repeat of the same apply never reaches the instance a second time.
 */
async function runApply(
  options: RunOptions,
  invocation: OperationInvocation,
): Promise<OperationRun> {
  const claim = {
    tool: options.operation.tool,
    variant: options.operation.variant,
    application: options.application,
    intent: options.input,
  };

  const existing = options.context.state.applies.find(claim);
  // A `failed` record is the one an attempt may reuse: upstream demonstrably
  // refused it, so re-running is a retry rather than a duplicate, and it goes
  // through current-state validation again like any other apply.
  if (existing !== undefined && existing.state !== "failed") {
    return replayReceipt(options, existing);
  }

  const preconditions = await readPreconditions(options.operation, invocation);
  if (!preconditions.ok) {
    return runFor(errorOutcome(options.application, preconditions.error));
  }

  const plan = options.plan;
  if (plan !== undefined) {
    const comparison = compareReadSet(plan.readSet, fingerprintReadSet(preconditions.observations));
    if (comparison.status === "changed") {
      const moved = [...comparison.changed, ...comparison.missing].join(", ");
      return runFor(
        errorOutcome(
          options.application,
          createToolError({
            code: "stale_plan",
            message: `${options.application}: the state this plan validated has changed (${moved})`,
            application: options.application,
          }),
        ),
      );
    }
  }

  const attempt = options.context.state.applies.begin(claim);
  if (attempt.status === "replayed") {
    return replayReceipt(options, attempt.record);
  }

  const outcome = await invokeHandler(options.operation, {
    ...invocation,
    validated: preconditions.validated,
  });
  if (outcome.status === "error") {
    const settled = options.context.state.applies.settle(
      attempt.record.reference,
      settlementFor(outcome.error),
    );
    return runFor(errorOutcome(options.application, outcome.error, outcome.items), {
      requestedEffects: [],
      predictedEffects: [],
      receipt: { reference: attempt.record.reference, state: settled?.state ?? "failed" },
    });
  }

  // A handler that ran but could not establish what its request did settles as
  // outcome-unknown, never as a success. Reporting the mutation as succeeded
  // would both mislead the caller and close the record to reconciliation.
  const settled = options.context.state.applies.settle(
    attempt.record.reference,
    settlementForOutcome(outcome),
  );
  const failure = outcome.outcomeUnknown ?? outcome.unattempted;

  return runFor(
    applicationOutcome({
      application: options.application,
      // Neither an outcome nothing established nor a mutation that was never
      // sent is reported as `ok`. The receipt already says so, and an envelope
      // that said otherwise would describe the call more favorably than the
      // record it carries — a caller reading only the text summary would act on
      // a success that nothing observed. A replayed receipt in the same state
      // has always been reported this way; this is the first-time path
      // agreeing. The per-item outcomes travel either way, because they are
      // what says which selections failed.
      status: failure === undefined ? "ok" : "error",
      warnings: [...preconditions.warnings, ...(outcome.warnings ?? [])],
      data: outcome.data,
      items: outcome.items,
      error: failure,
    }),
    {
      requestedEffects: outcome.effects ?? plan?.requestedEffects ?? [],
      predictedEffects: [],
      ...(outcome.job === undefined ? {} : { job: outcome.job }),
      receipt: { reference: attempt.record.reference, state: settled?.state ?? "succeeded" },
    },
  );
}

async function runOperation(options: RunOptions): Promise<OperationRun> {
  const { context, request, operation, application } = options;

  if (!operation.applications.includes(application)) {
    return runFor(unsupportedOutcome(application, request.tool, undefined));
  }

  // Resolved before probing so an unconfigured application costs no request,
  // and so the handler below receives an adapter the type system has narrowed.
  const adapter = context.registry.adapter(application);
  if (adapter === undefined) {
    return runFor(unconfiguredOutcome(application));
  }

  if (operation.upstream === "required") {
    const support = checkOperationSupport(operation, await adapter.probe());
    if (support.status === "unconfigured") {
      return runFor(unconfiguredOutcome(application));
    }
    if (support.status === "unavailable") {
      return runFor(
        applicationOutcome({
          application,
          status: "unavailable",
          error: toolErrorForUpstreamFailure(support.failure, application),
        }),
      );
    }
    if (support.status === "unsupported") {
      return runFor(unsupportedOutcome(application, request.tool, support.requiredVersion));
    }
  }

  const invocation: OperationInvocation = {
    application,
    adapter,
    mode: request.mode,
    input: options.input,
    state: context.state,
    plan: options.plan,
  };

  switch (request.mode) {
    case "read":
      return runRead(options, invocation);
    case "plan":
      return runPlan(options, invocation);
    case "apply":
      return runApply(options, invocation);
  }
}

interface ResolvedPlanApply {
  readonly operation: OperationDefinition;
  readonly plan: PlanRecord;
  readonly input: unknown;
  readonly application: ApplicationId;
}

/** Turns a plan reference back into an intent this dispatcher can run. */
function resolvePlanApply(
  context: ToolContext,
  request: DispatchRequest,
  reference: string,
): ResolvedPlanApply | { readonly error: ToolError } {
  const resolution = context.state.plans.resolve(reference);
  if (!resolution.ok) {
    return { error: toolErrorForReferenceFailure(resolution.reason, "plan") };
  }

  const plan = resolution.record;
  if (plan.tool !== request.tool) {
    return {
      error: createToolError({
        code: "invalid_input",
        message: `that plan was created by ${plan.tool} and cannot be applied through ${request.tool}`,
      }),
    };
  }

  const operation = context.operations.find(plan.tool, plan.variant);
  if (operation === undefined) {
    return {
      error: createToolError({
        code: "unsupported_capability",
        message: `${plan.tool} no longer exposes the variant this plan was created for`,
      }),
    };
  }

  const application = plan.applications[0];
  if (application === undefined || plan.applications.length !== 1) {
    return {
      error: createToolError({
        code: "stale_plan",
        message: "that plan does not name exactly one application to apply it to",
      }),
    };
  }

  return { operation, plan, input: plan.intent, application };
}

function mutationDetail(runs: readonly OperationRun[]): MutationDetail {
  const single = runs.length === 1 ? runs[0] : undefined;
  return {
    requestedEffects: runs.flatMap((run) => [...run.requestedEffects]),
    predictedEffects: runs.flatMap((run) => [...run.predictedEffects]),
    ...(single?.readSet === undefined ? {} : { readSet: [...single.readSet] }),
    ...(single?.plan === undefined ? {} : { plan: single.plan }),
    ...(single?.job === undefined ? {} : { job: single.job }),
    ...(single?.receipt === undefined ? {} : { receipt: single.receipt }),
  };
}

/**
 * A mutation names exactly one application.
 *
 * The published mutation envelope carries one plan reference, one job
 * reference, and one receipt, and each of those describes a single instance.
 * Fanning a mutation across instances would produce records the envelope cannot
 * report, so the call is refused with an instruction instead — one extra call
 * per application, and nothing about what happened goes unreported.
 */
function refuseMultiApplicationMutation(targets: readonly ApplicationId[]): ToolError {
  return createToolError({
    code: "invalid_input",
    message: `name one application for this mutation; it currently targets ${targets.join(", ")}`,
  });
}

/**
 * The single path every domain tool takes to reach an adapter.
 *
 * The operation is resolved from the public tool name and the public variant
 * only; a caller-supplied string never names an internal operation. One
 * application's failure is confined to that application's outcome, and the
 * envelope reports the mix rather than concealing it.
 */
export async function dispatchOperation(
  context: ToolContext,
  request: DispatchRequest,
): Promise<ToolResult<unknown>> {
  const checked = checkReferences(context.state.references, request.input);
  if (!checked.ok) {
    return errorResult(checked.error);
  }

  const planned =
    request.planReference === undefined
      ? undefined
      : resolvePlanApply(context, request, request.planReference);
  if (planned !== undefined && "error" in planned) {
    return errorResult(planned.error);
  }

  if (planned !== undefined) {
    // The replayed intent carries the references the plan was created with, and
    // those are older than the plan reference itself. A queue or media
    // reference that has since expired must be rejected here, not handed to a
    // handler that would resolve it against nothing.
    const replayed = checkReferences(context.state.references, planned.input);
    if (!replayed.ok) {
      return errorResult(replayed.error);
    }
  }

  const operation = planned?.operation ?? context.operations.find(request.tool, request.variant);
  if (operation === undefined) {
    return errorResult(
      createToolError({
        code: "unsupported_capability",
        message: `${request.tool} does not expose the requested variant`,
      }),
    );
  }

  const targets =
    planned === undefined
      ? selectApplications(request.applications, operation, checked.binding.application)
      : [planned.application];

  if (request.mode !== "read" && targets.length > maxMutationApplications) {
    return errorResult(refuseMultiApplicationMutation(targets));
  }

  const runs = await Promise.all(
    targets.map((application) =>
      runOperation({
        context,
        request,
        operation,
        application,
        input: planned?.input ?? request.input,
        plan: planned?.plan,
      }),
    ),
  );

  return buildToolResult({
    applications: runs.map((run) => run.outcome),
    ...(request.mode === "read" ? {} : { mutation: mutationDetail(runs) }),
  });
}
