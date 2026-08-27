import { z } from "zod";
import { projectedToolNames } from "../names.js";
import { operationSideEffects } from "../operations.js";
import { toolResultSchema } from "../results.js";
import { applicationFilterSchema, detailLevelSchema } from "./common.js";

/**
 * The four states a capability report distinguishes. They are deliberately
 * separate from the envelope's per-application outcome status: observing that
 * an instance is unreachable is a successful capability report, so the outcome
 * is `ok` while the report itself says `unavailable`.
 */
export const capabilityStates = [
  "available",
  "unconfigured",
  "unavailable",
  "unsupported",
] as const;

export type CapabilityState = (typeof capabilityStates)[number];

/**
 * How a supported operation is reached. The projection names the public tool
 * and variant a caller would invoke, never an internal operation identifier.
 */
export const capabilityOperationSchema = z.strictObject({
  tool: z.enum(projectedToolNames),
  variant: z.string().min(1).optional(),
  sideEffect: z.enum(operationSideEffects),
});

export const capabilityUnsupportedOperationSchema = z.strictObject({
  tool: z.enum(projectedToolNames),
  variant: z.string().min(1).optional(),
  sideEffect: z.enum(operationSideEffects),
  /** The version this instance would need before the operation becomes usable. */
  requiredVersion: z.string().min(1),
});

export const capabilityReportSchema = z.strictObject({
  state: z.enum(capabilityStates),
  apiVersion: z.enum(["v1", "v3"]),
  minimumVersion: z.string().min(1),
  /** The version the instance reported, absent when it was never reached. */
  version: z.string().min(1).optional(),
  /**
   * Operations this instance can run right now.
   *
   * Enumerated at every detail level, deliberately: it is the one list a
   * caller acts on, and a count of usable operations would tell it nothing it
   * could call, forcing a second and larger request. It is also self-bounding
   * — it names only what one application declares and this server implements —
   * whereas the two lists below grow with everything an instance cannot do.
   */
  supportedOperations: z.array(capabilityOperationSchema),
  /** How many operations this instance would need a newer release to run. */
  unsupportedOperationCount: z.int().min(0),
  /**
   * How many operations this server publishes but has not implemented yet.
   * Calling one returns `unsupported_capability`; the count falls as each
   * domain change supplies its behavior.
   */
  unimplementedOperationCount: z.int().min(0),
  /**
   * The operations behind {@link unsupportedOperationCount}, present only when
   * the caller asked for `full` detail. Absent means "not asked for", never
   * "none": the count beside it is the answer at `summary` detail.
   */
  unsupportedOperations: z.array(capabilityUnsupportedOperationSchema).optional(),
  /** The operations behind `unimplementedOperationCount`, on the same terms. */
  unimplementedOperations: z.array(capabilityOperationSchema).optional(),
});

export type CapabilityReport = z.infer<typeof capabilityReportSchema>;

export const capabilitiesInputSchema = z.strictObject({
  /**
   * Restricts the report to the named applications. Omitting it reports every
   * application, including the ones that are not configured — reporting an
   * unconfigured application never requires placeholder credentials.
   */
  applications: applicationFilterSchema.optional(),
  /**
   * How much of what an instance *cannot* do is enumerated. The report is
   * bounded by default: `summary` counts the operations an instance cannot
   * currently perform, and only `full` lists them. Orienting is the first call
   * an agent makes, so the expensive shape is the one it has to ask for.
   */
  detail: detailLevelSchema.default("summary"),
});

export const capabilitiesOutputSchema = toolResultSchema({ data: capabilityReportSchema });
