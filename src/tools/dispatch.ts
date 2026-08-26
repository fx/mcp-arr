import type { AdapterRegistry, ApplicationCapability } from "../adapters/registry.js";
import { type ApplicationId, applicationIds } from "../applications.js";
import { createToolError, toolErrorForThrown, toolErrorForUpstreamFailure } from "./errors.js";
import type { ToolName } from "./names.js";
import {
  checkOperationSupport,
  type OperationDefinition,
  type OperationMode,
  type OperationRegistry,
} from "./operations.js";
import {
  type ApplicationOutcome,
  applicationOutcome,
  buildToolResult,
  type ToolResult,
} from "./results.js";

/**
 * Everything a tool handler is allowed to reach. Both dependencies are
 * injected so tool behavior is testable without a network and without the
 * module-level operation inventory.
 */
export interface ToolContext {
  readonly registry: AdapterRegistry;
  readonly operations: OperationRegistry;
}

export interface DispatchRequest {
  readonly tool: ToolName;
  /** The already-validated public discriminator value, if the tool has one. */
  readonly variant: string | undefined;
  /**
   * The caller's application filter. When absent the operation's own declared
   * applications are targeted; a later change narrows this further for inputs
   * whose opaque references already bind one application.
   */
  readonly applications: readonly ApplicationId[] | undefined;
  readonly mode: OperationMode;
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

async function runOperation(
  context: ToolContext,
  request: DispatchRequest,
  operation: OperationDefinition,
  application: ApplicationId,
): Promise<ApplicationOutcome<unknown>> {
  if (!operation.applications.includes(application)) {
    return unsupportedOutcome(application, request.tool, undefined);
  }

  // Resolved before probing so an unconfigured application costs no request,
  // and so the handler below receives an adapter the type system has narrowed.
  const adapter = context.registry.adapter(application);
  if (adapter === undefined) {
    return unconfiguredOutcome(application);
  }

  const support = checkOperationSupport(operation, await adapter.probe());
  if (support.status === "unconfigured") {
    return unconfiguredOutcome(application);
  }
  if (support.status === "unavailable") {
    return applicationOutcome({
      application,
      status: "unavailable",
      error: toolErrorForUpstreamFailure(support.failure, application),
    });
  }
  if (support.status === "unsupported") {
    return unsupportedOutcome(application, request.tool, support.requiredVersion);
  }

  let outcome: Awaited<ReturnType<typeof operation.handler>>;
  try {
    outcome = await operation.handler({
      application,
      adapter,
      mode: request.mode,
      input: request.input,
    });
  } catch (error) {
    return applicationOutcome({
      application,
      status: "error",
      error: toolErrorForThrown(error, application),
    });
  }

  if (outcome.status === "error") {
    return applicationOutcome({
      application,
      status: "error",
      error: outcome.error,
    });
  }

  return applicationOutcome({
    application,
    status: "ok",
    warnings: outcome.warnings,
    data: outcome.data,
    items: outcome.items,
    continuation: outcome.continuation,
  });
}

/**
 * Selects the applications to target, in the canonical application order and
 * without duplicates, so a caller cannot make one instance run the same
 * mutation twice by naming it twice.
 */
function selectApplications(
  requested: readonly ApplicationId[] | undefined,
  operation: OperationDefinition,
): readonly ApplicationId[] {
  const wanted = new Set<ApplicationId>(requested ?? operation.applications);
  return applicationIds.filter((application) => wanted.has(application));
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
  const operation = context.operations.find(request.tool, request.variant);
  if (operation === undefined) {
    return buildToolResult({
      errors: [
        createToolError({
          code: "unsupported_capability",
          message: `${request.tool} does not expose the requested variant`,
        }),
      ],
    });
  }

  const targets = selectApplications(request.applications, operation);
  const outcomes = await Promise.all(
    targets.map((application) => runOperation(context, request, operation, application)),
  );

  return buildToolResult({ applications: outcomes });
}
