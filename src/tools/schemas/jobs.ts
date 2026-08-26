import { z } from "zod";
import { toolResultSchema } from "../results.js";
import { jobReferenceSchema, mutationBaseShape, planApplySchema, variantUnion } from "./common.js";

/**
 * Reads a normalized job projection. The reference is process-local, so a
 * reference minted before a restart is rejected rather than guessed at, and
 * the caller never needs to know the upstream command payload shape.
 */
export const jobGetInputSchema = z.strictObject({
  job: jobReferenceSchema,
});

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

export const jobGetOutputSchema = toolResultSchema();
export const jobCancelOutputSchema = toolResultSchema({ mutation: true });
