import { z } from "zod";
import { toolNames } from "../names.js";
import { operationSideEffects } from "../operations.js";
import { toolResultSchema } from "../results.js";
import { applicationFilterSchema } from "./common.js";

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
  tool: z.enum(toolNames),
  variant: z.string().min(1).optional(),
  sideEffect: z.enum(operationSideEffects),
});

export const capabilityUnsupportedOperationSchema = z.strictObject({
  tool: z.enum(toolNames),
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
  /** Operations this instance can run right now. */
  supportedOperations: z.array(capabilityOperationSchema),
  /** Operations this instance would need a newer release to run. */
  unsupportedOperations: z.array(capabilityUnsupportedOperationSchema),
  /**
   * Operations this server publishes but has not implemented yet. Calling one
   * returns `unsupported_capability`; the list shrinks as each domain change
   * supplies its behavior.
   */
  unimplementedOperations: z.array(capabilityOperationSchema),
});

export type CapabilityReport = z.infer<typeof capabilityReportSchema>;

export const capabilitiesInputSchema = z.strictObject({
  /**
   * Restricts the report to the named applications. Omitting it reports every
   * application, including the ones that are not configured — reporting an
   * unconfigured application never requires placeholder credentials.
   */
  applications: applicationFilterSchema.optional(),
});

export const capabilitiesOutputSchema = toolResultSchema({ data: capabilityReportSchema });
