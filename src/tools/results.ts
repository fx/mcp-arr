import { z } from "zod";
import type { ApplicationId } from "../applications.js";
import { createToolError, type ToolError, type ToolErrorCode, toolErrorSchema } from "./errors.js";
import type { ToolName } from "./names.js";
import {
  applicationIdSchema,
  applyReferenceSchema,
  type Continuation,
  continuationSchema,
  jobReferenceSchema,
  planReferenceSchema,
} from "./schemas/common.js";

/** Whether the call as a whole produced everything the caller asked for. */
export const toolResultStatuses = ["ok", "partial", "error"] as const;

export type ToolResultStatus = (typeof toolResultStatuses)[number];

/**
 * Why one application did or did not contribute to the result. This describes
 * the call, not the application's capability state: `arr_capabilities` reports
 * an unreachable instance as an `ok` outcome whose data says `unavailable`,
 * because observing that fact is exactly what the caller asked for.
 */
export const applicationOutcomeStatuses = [
  "ok",
  "unconfigured",
  "unavailable",
  "unsupported",
  "error",
] as const;

export type ApplicationOutcomeStatus = (typeof applicationOutcomeStatuses)[number];

export const itemOutcomeStatuses = ["ok", "error"] as const;

export type ItemOutcomeStatus = (typeof itemOutcomeStatuses)[number];

/**
 * How consequential a requested or predicted effect is. Plans disclose effects
 * so the calling agent can decide; the server never withholds a destructive
 * effect from a plan in order to make the plan look safer.
 */
export const effectSeverities = ["informational", "consequential", "destructive"] as const;

export type EffectSeverity = (typeof effectSeverities)[number];

/** The four states an in-memory apply record can hold. */
export const applyRecordStates = ["applying", "succeeded", "failed", "outcome_unknown"] as const;

export type ApplyRecordState = (typeof applyRecordStates)[number];

export const effectSchema = z.strictObject({
  application: applicationIdSchema,
  severity: z.enum(effectSeverities),
  summary: z.string().min(1),
});

export type Effect = z.infer<typeof effectSchema>;

export const receiptSchema = z.strictObject({
  reference: applyReferenceSchema,
  state: z.enum(applyRecordStates),
});

export type Receipt = z.infer<typeof receiptSchema>;

/**
 * One value a plan's validity depends on, disclosed as a digest.
 *
 * The digest is what makes staleness decidable, and returning it lets a caller
 * see which facts a plan is resting on. It is a one-way hash of state the same
 * caller can read through the query tools, so it discloses nothing new — which
 * is exactly why a read-set observation must never be a secret value.
 */
export const readSetFingerprintSchema = z.strictObject({
  key: z.string().min(1).max(120),
  digest: z.string().min(1).max(64),
});

/**
 * The mutation half of the envelope. Present only on mutation tools, and only
 * once a mutation actually runs; the fields are declared now so plan
 * references, job references, and receipts can be filled in without changing
 * the published output schema.
 */
export const mutationDetailSchema = z.strictObject({
  requestedEffects: z.array(effectSchema),
  predictedEffects: z.array(effectSchema),
  /** Returned by plan mode; the facts applying this plan will re-check. */
  readSet: z.array(readSetFingerprintSchema).optional(),
  plan: planReferenceSchema.optional(),
  job: jobReferenceSchema.optional(),
  receipt: receiptSchema.optional(),
});

export type MutationDetail = z.infer<typeof mutationDetailSchema>;

/**
 * How many applications one mutation can target.
 *
 * It follows from the schema directly above: the mutation half of the envelope
 * carries one plan reference, one job reference, and one receipt, each of which
 * describes a single instance. A mutation that ran on two would produce records
 * this shape cannot report, so the dispatcher refuses one that resolves to more
 * — and a mutation intent that names the application it targets must not be
 * able to name a second, or the schema advertises an intent always refused.
 */
export const maxMutationApplications = 1;

export const itemOutcomeSchema = z.strictObject({
  reference: z.string().min(1).max(128),
  status: z.enum(itemOutcomeStatuses),
  warnings: z.array(z.string().min(1)),
  error: toolErrorSchema.optional(),
});

export interface ItemOutcome {
  readonly reference: string;
  readonly status: ItemOutcomeStatus;
  readonly warnings: readonly string[];
  readonly error?: ToolError;
}

export interface ApplicationOutcome<TData = never> {
  readonly application: ApplicationId;
  readonly status: ApplicationOutcomeStatus;
  readonly warnings: readonly string[];
  readonly data?: TData;
  readonly items?: readonly ItemOutcome[];
  readonly continuation?: Continuation;
  readonly error?: ToolError;
}

export interface ToolResult<TData = never> {
  readonly status: ToolResultStatus;
  readonly applications: readonly ApplicationOutcome<TData>[];
  readonly warnings: readonly string[];
  readonly errors: readonly ToolError[];
  readonly mutation?: MutationDetail;
}

export interface ToolResultSchemaOptions {
  /**
   * The per-application payload. Omitted for tools whose domain behavior a
   * later change supplies: until then no payload can be produced, so declaring
   * one would publish a shape nothing can satisfy.
   */
  readonly data?: z.ZodType | undefined;
  /** Whether the tool can carry plan, job, and receipt detail. */
  readonly mutation?: boolean | undefined;
}

/**
 * Each envelope's payload, beside the envelope it was built into.
 *
 * Publication needs the per-application payload and nothing else — it is the
 * only part of the envelope that differs between tools, and the only part whose
 * fields a caller has to be told about. Recording it here rather than leaving a
 * consumer to walk `applications[].data` back out of a converted envelope keeps
 * this module the only place that knows where the payload sits, and keeps "this
 * tool has no payload" a fact rather than a navigation that came up empty.
 *
 * Weak because the key is the schema itself: an envelope nothing holds any more
 * takes its entry with it.
 */
const payloadSchemas = new WeakMap<z.ZodType, z.ZodType>();

/** The per-application payload one tool's output schema carries, if any. */
export function payloadSchemaOf(outputSchema: z.ZodType): z.ZodType | undefined {
  return payloadSchemas.get(outputSchema);
}

/**
 * Builds one tool's declared output schema.
 *
 * The returned schema is intentionally typed as an opaque {@link z.ZodType}:
 * the shape varies per tool, and every envelope this project produces is
 * checked against it at runtime before it leaves the process, so the compile
 * time authority stays with {@link ToolResult}.
 */
export function toolResultSchema(options: ToolResultSchemaOptions = {}): z.ZodType {
  const outcomeShape: Record<string, z.ZodType> = {
    application: applicationIdSchema,
    status: z.enum(applicationOutcomeStatuses),
    warnings: z.array(z.string().min(1)),
    items: z.array(itemOutcomeSchema).optional(),
    continuation: continuationSchema.optional(),
    error: toolErrorSchema.optional(),
  };
  if (options.data !== undefined) {
    outcomeShape.data = options.data.optional();
  }

  const resultShape: Record<string, z.ZodType> = {
    status: z.enum(toolResultStatuses),
    applications: z.array(z.strictObject(outcomeShape)),
    warnings: z.array(z.string().min(1)),
    errors: z.array(toolErrorSchema),
  };
  if (options.mutation === true) {
    resultShape.mutation = mutationDetailSchema.optional();
  }

  const schema = z.strictObject(resultShape);
  if (options.data !== undefined) {
    payloadSchemas.set(schema, options.data);
  }
  return schema;
}

export interface ApplicationOutcomeInput<TData> {
  readonly application: ApplicationId;
  readonly status: ApplicationOutcomeStatus;
  readonly warnings?: readonly string[] | undefined;
  readonly data?: TData | undefined;
  readonly items?: readonly ItemOutcome[] | undefined;
  readonly continuation?: Continuation | undefined;
  readonly error?: ToolError | undefined;
}

/**
 * Builds one application's outcome. Optional fields are omitted rather than set
 * to `undefined` so the serialized envelope contains only what actually
 * happened.
 */
export function applicationOutcome<TData>(
  input: ApplicationOutcomeInput<TData>,
): ApplicationOutcome<TData> {
  return {
    application: input.application,
    status: input.status,
    warnings: input.warnings ?? [],
    ...(input.data === undefined ? {} : { data: input.data }),
    ...(input.items === undefined ? {} : { items: input.items }),
    ...(input.continuation === undefined ? {} : { continuation: input.continuation }),
    ...(input.error === undefined ? {} : { error: input.error }),
  };
}

function isCleanOutcome(outcome: ApplicationOutcome<unknown>): boolean {
  return outcome.status === "ok" && !(outcome.items ?? []).some((item) => item.status === "error");
}

export interface ToolResultInput<TData> {
  readonly applications?: readonly ApplicationOutcome<TData>[] | undefined;
  readonly warnings?: readonly string[] | undefined;
  readonly errors?: readonly ToolError[] | undefined;
  readonly mutation?: MutationDetail | undefined;
}

/**
 * Derives the overall status from the per-application and per-item outcomes.
 *
 * A mixed result is reported as `partial` and additionally carries a
 * `partial_failure` error, so a caller that only inspects the top-level status
 * or the top-level error list still learns that something failed. Concealing a
 * failure inside an otherwise successful envelope is the specific outcome this
 * function exists to prevent.
 */
export function buildToolResult<TData>(input: ToolResultInput<TData> = {}): ToolResult<TData> {
  const applications = input.applications ?? [];
  const warnings = input.warnings ?? [];
  const errors = [...(input.errors ?? [])];

  // An application that answered but reported a failed item still contributed,
  // so the envelope is partial rather than a total failure.
  const contributed = applications.filter((outcome) => outcome.status === "ok").length;
  const clean = applications.filter(isCleanOutcome).length;

  let status: ToolResultStatus;
  if (applications.length === 0) {
    status = errors.length > 0 ? "error" : "ok";
  } else if (clean === applications.length) {
    status = errors.length > 0 ? "partial" : "ok";
  } else if (contributed === 0) {
    status = "error";
  } else {
    status = "partial";
  }

  if (status === "partial" && !errors.some((error) => error.code === "partial_failure")) {
    errors.push(
      createToolError({
        code: "partial_failure",
        message: "some applications or items did not complete successfully",
      }),
    );
  }

  return {
    status,
    applications,
    warnings,
    errors,
    ...(input.mutation === undefined ? {} : { mutation: input.mutation }),
  };
}

/**
 * How one tool says what happened, where the envelope's own status cannot.
 *
 * An outcome's `status` describes the call, not the domain answer, and for
 * almost every tool those coincide — a read that could not reach its instance
 * is not an `ok` outcome. `arr_capabilities` is the deliberate exception: it
 * reports an unreachable instance as an `ok` outcome whose data says
 * `unavailable`, because observing that is exactly what was asked for. Printing
 * the status there would tell an operator that everything is fine at the moment
 * nothing is, so a tool that knows better supplies its own wording here.
 *
 * Both hooks may decline by returning `undefined`, which falls back to the
 * envelope's own status, and both may only restate values the envelope already
 * carries — the summary must never become a second, unredacted channel.
 */
export interface ToolSummary {
  /** Replaces the leading overall status. */
  lead?(result: ToolResult<unknown>): string | undefined;
  /** Replaces one application's status with its domain state. */
  outcome?(outcome: ApplicationOutcome<unknown>): string | undefined;
}

/**
 * How much a bounded read returned.
 *
 * A summary that says only `ok` cannot be acted on: an operator checking a real
 * instance needs to see that a view came back with nothing, which is the shape
 * a wrong filter or an empty library takes.
 */
function describeRecords(outcome: ApplicationOutcome<unknown>): string {
  const continuation = outcome.continuation;
  if (continuation === undefined) {
    return "";
  }
  return ` (${continuation.returned} record(s)${continuation.hasMore ? ", more available" : ""})`;
}

function describeItems(outcome: ApplicationOutcome<unknown>): string {
  const failedItems = (outcome.items ?? []).filter((item) => item.status === "error").length;
  return failedItems === 0 ? "" : ` (${failedItems} item(s) failed)`;
}

function describeOutcome(outcome: ApplicationOutcome<unknown>, summary?: ToolSummary): string {
  const state = summary?.outcome?.(outcome) ?? outcome.status;
  return `${outcome.application} ${state}${describeRecords(outcome)}${describeItems(outcome)}`;
}

/**
 * Every distinct failure the result carries, most specific first.
 *
 * The envelope's own `errors` list is not the whole story: a call that failed
 * everywhere records each cause on the application that produced it and leaves
 * the top-level list empty, so a summary built from `result.errors` alone
 * describes a total failure without naming a single code.
 *
 * Ordering runs from the narrowest scope outwards: an application's item
 * failures, then that application's own failure, then the envelope's errors —
 * where the summarizing `partial_failure` sits. An item names the one thing
 * that went wrong and its outcome only names that something did, so leading
 * with the item is what makes the first code in the line the actionable one.
 *
 * Codes are deduplicated because several applications failing the same way is
 * the common shape, and repeating one code and one hint per application would
 * make the summary longer without making it say more.
 */
function collectErrors(result: ToolResult<unknown>): readonly ToolError[] {
  const byCode = new Map<ToolErrorCode, ToolError>();
  const record = (error: ToolError | undefined): void => {
    if (error !== undefined && !byCode.has(error.code)) {
      byCode.set(error.code, error);
    }
  };

  for (const outcome of result.applications) {
    for (const item of outcome.items ?? []) {
      record(item.error);
    }
    record(outcome.error);
  }
  for (const error of result.errors) {
    record(error);
  }
  return [...byCode.values()];
}

/**
 * Names a failure by its stable code and its remediation hint.
 *
 * A host commonly surfaces only the text when a call reports failure, so a
 * summary that says `error` and stops hides the one thing the caller needs to
 * act on. Both values restated here are drawn from the closed vocabulary in
 * `errors.ts` — the code is an enum member, and the remediation is a static
 * string chosen by that code and never interpolated with upstream content — so
 * neither can carry an upstream body, URL, header, or API key.
 *
 * The error's `message` is deliberately left out. It is the only field an
 * upstream failure contributes text to, and the structured result already
 * carries it in full; keeping it out of the summary keeps the line short and
 * keeps redaction a property of the shape rather than of each call site.
 */
function describeError(error: ToolError): string {
  return `${error.code} (${error.remediation})`;
}

/**
 * The concise text summary that accompanies every structured result. It repeats
 * only values already present in the envelope — and, for a failure, only the
 * stable code and the static remediation hint — so it cannot become a second,
 * unredacted channel.
 */
export function summarizeToolResult(
  name: ToolName,
  result: ToolResult<unknown>,
  summary?: ToolSummary,
): string {
  const parts = [`${name}: ${summary?.lead?.(result) ?? result.status}`];
  if (result.applications.length > 0) {
    parts.push(result.applications.map((outcome) => describeOutcome(outcome, summary)).join(", "));
  }
  const errors = collectErrors(result);
  if (errors.length > 0) {
    parts.push(`errors: ${errors.map(describeError).join(", ")}`);
  }
  if (result.warnings.length > 0) {
    parts.push(`${result.warnings.length} warning(s)`);
  }
  return parts.join("; ");
}
