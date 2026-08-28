import { z } from "zod";
import {
  jobCancelOutcomes,
  jobResults,
  jobStatuses,
  terminalJobStatuses,
} from "../../state/jobs.js";
import { toolResultSchema } from "../results.js";
import {
  applicationIdSchema,
  isoDateTimeSchema,
  jobReferenceSchema,
  mutationBaseShape,
  planApplySchema,
} from "./common.js";
import { objectInput, variantUnion } from "./publish.js";

/**
 * Reads a normalized job projection. The reference is process-local, so a
 * reference minted before a restart is rejected rather than guessed at, and
 * the caller never needs to know the upstream command payload shape.
 */
export const jobGetInputSchema = objectInput(
  z.strictObject({
    job: jobReferenceSchema,
  }),
);

/**
 * Requests cancellation of a projected job. Cancellation is a request, not a
 * guarantee: an upstream command that has started and does not permit
 * cancellation is reported as uncancellable rather than as cancelled.
 */
export const jobCancelInputSchema = variantUnion(
  z.union([
    z.strictObject({
      ...mutationBaseShape,
      job: jobReferenceSchema,
    }),
    planApplySchema,
  ]),
);

/** Progress is reported only when the application actually reports it. */
export const jobProgressSchema = z.strictObject({
  completed: z.int().min(0),
  total: z.int().min(0),
});

/**
 * What a job ended as. It is preserved for the process lifetime, so it remains
 * readable after the application has discarded its own command record.
 */
export const jobTerminalSchema = z.strictObject({
  status: z.enum(terminalJobStatuses),
  result: z.enum(jobResults),
  at: isoDateTimeSchema,
});

/**
 * The projection both job tools return.
 *
 * The upstream command is identified by the name and id this server observed,
 * never by a command payload a caller could resubmit, and the per-item outcomes
 * travel in the shared item list rather than here.
 */
export const jobProjectionSchema = z.strictObject({
  job: jobReferenceSchema,
  application: applicationIdSchema,
  command: z.strictObject({
    name: z.string().min(1),
    upstreamId: z.string().min(1),
  }),
  status: z.enum(jobStatuses),
  progress: jobProgressSchema.optional(),
  terminal: jobTerminalSchema.optional(),
  /** Whether this server currently believes cancellation is possible at all. */
  cancellable: z.boolean(),
});

export type JobProjection = z.infer<typeof jobProjectionSchema>;

/**
 * What a cancellation returns, discriminated by which stage produced it.
 *
 * Both stages carry the same projection, because a plan and its apply describe
 * the same job. Only the applied one carries the outcome: which of the five
 * cancellation outcomes happened is knowable exactly once a cancellation has
 * been attempted, so a plan has none to report and an apply must never omit it.
 * Requiring it on one variant rather than making it optional on a flat shape is
 * what keeps an applied cancellation that reports no outcome invalid — which is
 * the whole reason the field exists — while letting a plan validate against the
 * tool's own declared output. The grab and search-start results discriminate on
 * the same property for the same reason.
 */
export const jobCancellationSchema = z.discriminatedUnion("stage", [
  z.strictObject({ stage: z.literal("planned"), ...jobProjectionSchema.shape }),
  z.strictObject({
    stage: z.literal("applied"),
    ...jobProjectionSchema.shape,
    outcome: z.enum(jobCancelOutcomes),
  }),
]);

export type JobCancellationProjection = z.infer<typeof jobCancellationSchema>;

export const jobGetOutputSchema = toolResultSchema({ data: jobProjectionSchema });
export const jobCancelOutputSchema = toolResultSchema({
  data: jobCancellationSchema,
  mutation: true,
});
