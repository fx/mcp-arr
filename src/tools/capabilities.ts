import type { ApplicationCapability } from "../adapters/registry.js";
import { type ApplicationId, applicationIds, describeApplication } from "../applications.js";
import { capabilityFor, type ToolContext } from "./dispatch.js";
import {
  checkOperationSupport,
  isImplementedOperation,
  type OperationDefinition,
} from "./operations.js";
import {
  type ApplicationOutcome,
  applicationOutcome,
  buildToolResult,
  type ToolResult,
  type ToolSummary,
} from "./results.js";
import {
  type CapabilityReport,
  type CapabilityState,
  capabilityStates,
} from "./schemas/capabilities.js";
import type { DetailLevel } from "./schemas/common.js";

interface ProjectedOperation {
  readonly tool: CapabilityReport["supportedOperations"][number]["tool"];
  readonly variant?: string;
  readonly sideEffect: CapabilityReport["supportedOperations"][number]["sideEffect"];
}

function project(operation: OperationDefinition): ProjectedOperation {
  return {
    tool: operation.tool,
    ...(operation.variant === undefined ? {} : { variant: operation.variant }),
    sideEffect: operation.sideEffect,
  };
}

function capabilityState(capability: ApplicationCapability): CapabilityState {
  return capability.status;
}

function warningsFor(capability: ApplicationCapability): readonly string[] {
  const descriptor = describeApplication(capability.application);
  switch (capability.status) {
    case "unconfigured":
      return [
        `${capability.application} is not configured; set ${descriptor.urlVariable} and ${descriptor.apiKeyVariable}`,
      ];
    case "unavailable":
      // Already redacted by the upstream boundary: no body, header, URL, or key.
      return [capability.failure.message];
    case "unsupported":
      return [
        `${capability.application} reports ${capability.version}, older than the supported minimum ${capability.minimumVersion}`,
      ];
    case "available":
      return [];
  }
}

/**
 * Projects the internal operation inventory onto one application.
 *
 * Only operations that name this application are considered, and each is
 * reported by the public tool and variant a caller would invoke. An operation
 * that needs a newer release is counted as unsupported with the version it
 * needs, rather than being emulated or quietly omitted.
 *
 * What an instance cannot do is counted rather than listed unless the caller
 * asked for `full` detail: those two lists together are most of the payload
 * and none of it is callable, so the enumeration is the shape a caller has to
 * request.
 */
function projectOperations(
  capability: ApplicationCapability,
  operations: readonly OperationDefinition[],
  detail: DetailLevel,
): Pick<
  CapabilityReport,
  | "supportedOperations"
  | "unsupportedOperationCount"
  | "unimplementedOperationCount"
  | "unsupportedOperations"
  | "unimplementedOperations"
> {
  const supportedOperations: CapabilityReport["supportedOperations"] = [];
  const unsupportedOperations: NonNullable<CapabilityReport["unsupportedOperations"]> = [];
  const unimplementedOperations: NonNullable<CapabilityReport["unimplementedOperations"]> = [];

  for (const operation of operations) {
    const support = checkOperationSupport(operation, capability);
    if (support.status === "supported") {
      // Only an operation with real adapter behavior is advertised as usable;
      // a declared one without a handler would answer unsupported_capability.
      const target = isImplementedOperation(operation)
        ? supportedOperations
        : unimplementedOperations;
      target.push(project(operation));
      continue;
    }
    if (
      support.status === "unsupported" &&
      support.reason === "version" &&
      support.requiredVersion !== undefined
    ) {
      unsupportedOperations.push({
        ...project(operation),
        requiredVersion: support.requiredVersion,
      });
    }
  }

  return {
    supportedOperations,
    unsupportedOperationCount: unsupportedOperations.length,
    unimplementedOperationCount: unimplementedOperations.length,
    ...(detail === "full" ? { unsupportedOperations, unimplementedOperations } : {}),
  };
}

export function buildCapabilityReport(
  capability: ApplicationCapability,
  operations: readonly OperationDefinition[],
  detail: DetailLevel,
): CapabilityReport {
  const descriptor = describeApplication(capability.application);
  const version =
    capability.status === "available" || capability.status === "unsupported"
      ? capability.version
      : undefined;

  return {
    state: capabilityState(capability),
    apiVersion: descriptor.apiVersion,
    minimumVersion: descriptor.minimumVersion,
    ...(version === undefined ? {} : { version }),
    ...projectOperations(capability, operations, detail),
  };
}

/**
 * Reports what every selected application can currently do.
 *
 * Each application is reported as a successful outcome even when it is
 * unconfigured, unreachable, or too old: observing that fact is what the
 * caller asked for, so one unreachable instance never fails the whole result.
 *
 * The detail level bounds every state the same way, and anything short of an
 * explicit `full` bounds the report — there is no second default to drift from
 * the schema's own.
 */
export async function reportCapabilities(
  context: ToolContext,
  applications: readonly ApplicationId[] | undefined,
  detail?: DetailLevel,
): Promise<ToolResult<CapabilityReport>> {
  const selected = new Set<ApplicationId>(applications ?? applicationIds);
  const targets = applicationIds.filter((application) => selected.has(application));

  const outcomes = await Promise.all(
    targets.map(async (application) => {
      const capability = await capabilityFor(context, application);
      return applicationOutcome<CapabilityReport>({
        application,
        status: "ok",
        warnings: warningsFor(capability),
        data: buildCapabilityReport(
          capability,
          context.operations.operations,
          detail === "full" ? "full" : "summary",
        ),
      });
    }),
  );

  return buildToolResult<CapabilityReport>({ applications: outcomes });
}

/**
 * Narrows an outcome's payload back to a capability report.
 *
 * The summary hooks receive the erased envelope, so the report is re-checked
 * rather than cast; an outcome carrying anything else declines and falls back
 * to the envelope's own status.
 */
function readCapabilityReport(value: unknown): CapabilityReport | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const state = (value as { state?: unknown }).state;
  return (capabilityStates as readonly unknown[]).includes(state)
    ? (value as CapabilityReport)
    : undefined;
}

function describeCapability(report: CapabilityReport): string {
  // The version is what turns "available" into something an operator can check
  // against the instance they think they configured.
  return report.state === "available" && report.version !== undefined
    ? `available ${report.version}`
    : report.state;
}

/**
 * How `arr_capabilities` describes itself.
 *
 * Every application it reports is an `ok` outcome, because observing an
 * unreachable instance is a successful observation — so the envelope's status
 * is the one thing here that must not be printed. The summary reports the
 * capability state the caller actually asked about, and leads with how many
 * applications are usable rather than with the fact that the report itself
 * succeeded. This is the first call an operator makes, and its one line has to
 * be true of the instances rather than of the call.
 */
export const capabilitySummary: ToolSummary = {
  lead(result: ToolResult<unknown>): string | undefined {
    const reports = result.applications
      .map((outcome) => readCapabilityReport(outcome.data))
      .filter((report): report is CapabilityReport => report !== undefined);
    if (reports.length === 0) {
      return undefined;
    }
    const available = reports.filter((report) => report.state === "available").length;
    return available === 0
      ? "no application available"
      : `${available} of ${reports.length} application(s) available`;
  },

  outcome(outcome: ApplicationOutcome<unknown>): string | undefined {
    const report = readCapabilityReport(outcome.data);
    return report === undefined ? undefined : describeCapability(report);
  },
};
