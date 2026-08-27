import type { ApplicationId } from "../applications.js";
import { describeUpstreamPathProblem, type UpstreamPathProblem } from "../config/base-url.js";

export const upstreamErrorKinds = [
  "invalid-request",
  "unavailable",
  "timeout",
  "authentication",
  "validation",
  "not-found",
  "rate-limit",
  "unexpected-response",
] as const;

export type UpstreamErrorKind = (typeof upstreamErrorKinds)[number];

/** Why a request body could not be sent. Currently one case, kept typed. */
export type UpstreamBodyProblem = "unserializable";

export interface UpstreamErrorDetails {
  readonly application: ApplicationId;
  /**
   * The relative upstream route, such as `system/status`. Never a full URL, and
   * omitted only when the request was rejected before a route was resolved.
   */
  readonly operation?: string | undefined;
  readonly status?: number | undefined;
  readonly timeoutMs?: number | undefined;
  /**
   * Why a path was unusable. A typed discriminant rather than a free string, so
   * a caller-supplied path can never be smuggled into the message.
   */
  readonly pathProblem?: UpstreamPathProblem | undefined;
  /**
   * Why a request body was unusable, for the same reason and in the same form.
   * A serializer's own message can quote the value it choked on, so the value
   * never travels: only this discriminant does.
   */
  readonly bodyProblem?: UpstreamBodyProblem | undefined;
}

export interface SerializedUpstreamError {
  readonly name: string;
  readonly kind: UpstreamErrorKind;
  readonly application: ApplicationId;
  readonly operation: string | undefined;
  readonly status: number | undefined;
  readonly pathProblem: UpstreamPathProblem | undefined;
  readonly bodyProblem: UpstreamBodyProblem | undefined;
  readonly message: string;
}

function describeStatus(status: number | undefined): string {
  return status === undefined ? "" : ` (status ${status})`;
}

function formatMessage(kind: UpstreamErrorKind, details: UpstreamErrorDetails): string {
  const subject =
    details.operation === undefined
      ? `${details.application}: the request`
      : `${details.application}: the request to ${details.operation}`;
  switch (kind) {
    case "invalid-request":
      // Which part of the request was unusable is named, because a failure that
      // blamed the path for a body this project could not serialize would point
      // at the wrong fault — and at the wrong system.
      if (details.bodyProblem !== undefined) {
        return `${details.application}: the request was not sent because its body could not be serialized as JSON`;
      }
      return `${details.application}: the request was not sent because its path ${
        details.pathProblem === undefined
          ? "is unusable"
          : describeUpstreamPathProblem(details.pathProblem)
      }`;
    case "unavailable":
      return `${subject} could not reach the instance`;
    case "timeout":
      return details.timeoutMs === undefined
        ? `${subject} timed out`
        : `${subject} timed out after ${details.timeoutMs}ms`;
    case "authentication":
      return `${subject} was rejected by the instance's API key check${describeStatus(details.status)}`;
    case "validation":
      return `${subject} was rejected as invalid by the instance${describeStatus(details.status)}`;
    case "not-found":
      return `${subject} did not match an existing resource${describeStatus(details.status)}`;
    case "rate-limit":
      return `${subject} was rate limited by the instance${describeStatus(details.status)}`;
    case "unexpected-response":
      return `${subject} returned an unexpected response${describeStatus(details.status)}`;
  }
}

/**
 * A normalized upstream failure. It deliberately carries no response body, no
 * response headers, no request URL, and no `cause`, so a configured API key can
 * never be reached through the error, its message, or its serialized form.
 */
export class UpstreamError extends Error {
  readonly kind: UpstreamErrorKind;
  readonly application: ApplicationId;
  readonly operation: string | undefined;
  readonly status: number | undefined;
  readonly pathProblem: UpstreamPathProblem | undefined;
  readonly bodyProblem: UpstreamBodyProblem | undefined;

  constructor(kind: UpstreamErrorKind, details: UpstreamErrorDetails) {
    super(formatMessage(kind, details));
    this.name = "UpstreamError";
    this.kind = kind;
    this.application = details.application;
    this.operation = details.operation;
    this.status = details.status;
    this.pathProblem = details.pathProblem;
    this.bodyProblem = details.bodyProblem;
  }

  toJSON(): SerializedUpstreamError {
    return {
      name: this.name,
      kind: this.kind,
      application: this.application,
      operation: this.operation,
      status: this.status,
      pathProblem: this.pathProblem,
      bodyProblem: this.bodyProblem,
      message: this.message,
    };
  }
}

export function isUpstreamError(value: unknown): value is UpstreamError {
  return value instanceof UpstreamError;
}

export function upstreamErrorKindForStatus(status: number): UpstreamErrorKind {
  switch (status) {
    case 400:
    case 422:
      return "validation";
    case 401:
    case 403:
      return "authentication";
    case 404:
      return "not-found";
    case 429:
      return "rate-limit";
    default:
      return "unexpected-response";
  }
}
