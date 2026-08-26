import { z } from "zod";
import type { ApplicationId } from "../applications.js";
import { createToolError, type ToolError, toolErrorSchema } from "./errors.js";
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
 * The mutation half of the envelope. Present only on mutation tools, and only
 * once a mutation actually runs; the fields are declared now so plan
 * references, job references, and receipts can be filled in without changing
 * the published output schema.
 */
export const mutationDetailSchema = z.strictObject({
  requestedEffects: z.array(effectSchema),
  predictedEffects: z.array(effectSchema),
  plan: planReferenceSchema.optional(),
  job: jobReferenceSchema.optional(),
  receipt: receiptSchema.optional(),
});

export type MutationDetail = z.infer<typeof mutationDetailSchema>;

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

  return z.strictObject(resultShape);
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

function describeOutcome(outcome: ApplicationOutcome<unknown>): string {
  const failedItems = (outcome.items ?? []).filter((item) => item.status === "error").length;
  const suffix = failedItems === 0 ? "" : ` (${failedItems} item(s) failed)`;
  return `${outcome.application} ${outcome.status}${suffix}`;
}

/**
 * The concise text summary that accompanies every structured result. It repeats
 * only values already present in the envelope, so it cannot become a second,
 * unredacted channel.
 */
export function summarizeToolResult(name: ToolName, result: ToolResult<unknown>): string {
  const parts = [`${name}: ${result.status}`];
  if (result.applications.length > 0) {
    parts.push(result.applications.map(describeOutcome).join(", "));
  }
  if (result.errors.length > 0) {
    parts.push(`errors: ${result.errors.map((error) => error.code).join(", ")}`);
  }
  if (result.warnings.length > 0) {
    parts.push(`${result.warnings.length} warning(s)`);
  }
  return parts.join("; ");
}
