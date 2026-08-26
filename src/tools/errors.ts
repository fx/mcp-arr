import { z } from "zod";
import type { ApplicationId } from "../applications.js";
import { isUpstreamError, type UpstreamErrorKind } from "../http/errors.js";
import { applicationIdSchema } from "./schemas/common.js";

/**
 * The stable tool error vocabulary. A code is part of the public contract: a
 * calling agent branches on it, so codes are never renamed and a new failure
 * mode reuses an existing code unless its recovery differs.
 */
export const toolErrorCodes = [
  "invalid_input",
  "unconfigured_application",
  "unsupported_capability",
  "unavailable_application",
  "upstream_authentication",
  "upstream_rejection",
  "rate_limit",
  "timeout",
  "stale_reference",
  "stale_plan",
  "conflict",
  "partial_failure",
  "unexpected_response",
] as const;

export type ToolErrorCode = (typeof toolErrorCodes)[number];

interface ToolErrorPolicy {
  /**
   * Whether the caller can reach a different outcome without operator
   * intervention. Unrecoverable codes still carry a remediation hint, but it
   * describes what an operator must change rather than what to retry.
   */
  readonly recoverable: boolean;
  /**
   * A static hint. It is never interpolated with upstream content, so it can
   * carry no response body, header, URL, or credential.
   */
  readonly remediation: string;
}

const toolErrorPolicies: Readonly<Record<ToolErrorCode, ToolErrorPolicy>> = {
  invalid_input: {
    recoverable: true,
    remediation:
      "Correct the arguments to match the tool's declared input schema and call it again.",
  },
  unconfigured_application: {
    recoverable: false,
    remediation:
      "Set that application's URL and API-key environment variables and restart the server.",
  },
  unsupported_capability: {
    recoverable: false,
    remediation: "Call arr_capabilities to list the operations this instance supports.",
  },
  unavailable_application: {
    recoverable: true,
    remediation:
      "Confirm the instance is running and reachable, then retry; other applications are unaffected.",
  },
  upstream_authentication: {
    recoverable: false,
    remediation: "Correct that application's API-key environment variable and restart the server.",
  },
  upstream_rejection: {
    recoverable: true,
    remediation: "Adjust the requested values to satisfy the application's own validation.",
  },
  rate_limit: {
    recoverable: true,
    remediation: "Wait before retrying and reduce the request rate or page size.",
  },
  timeout: {
    recoverable: true,
    remediation: "Retry once; if it persists, reduce the page size or check instance load.",
  },
  stale_reference: {
    recoverable: true,
    remediation: "Repeat the query that produced the reference and use the fresh one.",
  },
  stale_plan: {
    recoverable: true,
    remediation: "Create a new plan for the same intent and apply that plan reference.",
  },
  conflict: {
    recoverable: true,
    remediation: "Re-read the current state, resolve the conflicting change, then retry.",
  },
  partial_failure: {
    recoverable: true,
    remediation: "Inspect the per-application and per-item outcomes and retry only the failures.",
  },
  unexpected_response: {
    recoverable: false,
    remediation: "Check the application version against arr_capabilities and report the mismatch.",
  },
};

export function toolErrorPolicy(code: ToolErrorCode): ToolErrorPolicy {
  return toolErrorPolicies[code];
}

export function isRecoverableToolErrorCode(code: ToolErrorCode): boolean {
  return toolErrorPolicies[code].recoverable;
}

/**
 * A normalized, caller-safe failure. It deliberately has no free-form details
 * field: everything it carries is either a typed discriminant, a static hint,
 * or a message this project produced. Raw upstream bodies, headers,
 * credential-bearing URLs, and stack traces have no field to travel in.
 */
export interface ToolError {
  readonly code: ToolErrorCode;
  readonly message: string;
  readonly application?: ApplicationId;
  readonly recoverable: boolean;
  readonly remediation: string;
}

export const toolErrorSchema = z.strictObject({
  code: z.enum(toolErrorCodes),
  message: z.string().min(1),
  application: applicationIdSchema.optional(),
  recoverable: z.boolean(),
  remediation: z.string().min(1),
});

export interface ToolErrorInput {
  readonly code: ToolErrorCode;
  readonly message: string;
  readonly application?: ApplicationId | undefined;
}

export function createToolError(input: ToolErrorInput): ToolError {
  const policy = toolErrorPolicies[input.code];
  return {
    code: input.code,
    message: input.message,
    ...(input.application === undefined ? {} : { application: input.application }),
    recoverable: policy.recoverable,
    remediation: policy.remediation,
  };
}

/**
 * Maps the upstream boundary's failure kinds onto the public codes.
 *
 * `not-found` becomes `stale_reference` because an upstream resource that no
 * longer exists and a process-local reference that no longer resolves have the
 * same remedy: re-run the query that produced the reference.
 */
const upstreamErrorCodes: Readonly<Record<UpstreamErrorKind, ToolErrorCode>> = {
  "invalid-request": "invalid_input",
  unavailable: "unavailable_application",
  timeout: "timeout",
  authentication: "upstream_authentication",
  validation: "upstream_rejection",
  "not-found": "stale_reference",
  "rate-limit": "rate_limit",
  "unexpected-response": "unexpected_response",
};

export function toolErrorCodeForUpstreamKind(kind: UpstreamErrorKind): ToolErrorCode {
  return upstreamErrorCodes[kind];
}

/**
 * Normalizes an already-redacted upstream failure. `UpstreamError` messages are
 * built from typed discriminants by the HTTP boundary, so reusing the message
 * here keeps a single redaction boundary rather than adding a second one.
 */
export function toolErrorForUpstreamFailure(
  failure: { readonly kind: UpstreamErrorKind; readonly message: string },
  application: ApplicationId,
): ToolError {
  return createToolError({
    code: upstreamErrorCodes[failure.kind],
    message: failure.message,
    application,
  });
}

/**
 * Normalizes an arbitrary thrown value. Anything that is not an
 * {@link isUpstreamError} result is reported with a static message: its own
 * message may embed a URL, a response body, or a configured API key.
 */
export function toolErrorForThrown(error: unknown, application?: ApplicationId): ToolError {
  if (isUpstreamError(error)) {
    return toolErrorForUpstreamFailure(error, error.application);
  }
  return createToolError({
    code: "unexpected_response",
    message:
      application === undefined
        ? "the request failed unexpectedly"
        : `${application}: the request failed unexpectedly`,
    application,
  });
}
