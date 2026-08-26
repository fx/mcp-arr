import type { ApplicationCapability } from "../adapters/registry.js";
import { type ApplicationId, applicationIds, describeApplication } from "../applications.js";
import { capabilityFor, type ToolContext } from "./dispatch.js";
import {
  checkOperationSupport,
  isImplementedOperation,
  type OperationDefinition,
} from "./operations.js";
import { applicationOutcome, buildToolResult, type ToolResult } from "./results.js";
import type { CapabilityReport, CapabilityState } from "./schemas/capabilities.js";

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
 * that needs a newer release is listed as unsupported with the version it
 * needs, rather than being emulated or quietly omitted.
 */
function projectOperations(
  capability: ApplicationCapability,
  operations: readonly OperationDefinition[],
): Pick<
  CapabilityReport,
  "supportedOperations" | "unsupportedOperations" | "unimplementedOperations"
> {
  const supportedOperations: CapabilityReport["supportedOperations"] = [];
  const unsupportedOperations: CapabilityReport["unsupportedOperations"] = [];
  const unimplementedOperations: CapabilityReport["unimplementedOperations"] = [];

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

  return { supportedOperations, unsupportedOperations, unimplementedOperations };
}

export function buildCapabilityReport(
  capability: ApplicationCapability,
  operations: readonly OperationDefinition[],
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
    ...projectOperations(capability, operations),
  };
}

/**
 * Reports what every selected application can currently do.
 *
 * Each application is reported as a successful outcome even when it is
 * unconfigured, unreachable, or too old: observing that fact is what the
 * caller asked for, so one unreachable instance never fails the whole result.
 */
export async function reportCapabilities(
  context: ToolContext,
  applications: readonly ApplicationId[] | undefined,
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
        data: buildCapabilityReport(capability, context.operations.operations),
      });
    }),
  );

  return buildToolResult<CapabilityReport>({ applications: outcomes });
}
