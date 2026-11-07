import { z } from "zod";
import { mediaDefaultVariables } from "../../config/environment.js";
import {
  type ToolErrorCode,
  toolErrorCodes,
  toolErrorForThrown,
  toolErrorPolicy,
} from "../errors.js";
import { kindRoutes, type TitleKind } from "./kinds.js";

/**
 * The `media` toolset's normalized failure.
 *
 * The same stable codes the `arr` toolset uses, with nothing that names the
 * application behind a kind. Both the message and the remediation are chosen
 * from the tables below by kind and code and never carry upstream text: an
 * upstream failure's own message names the application and the route it was
 * sending to, which is exactly the vocabulary this toolset keeps away from its
 * callers.
 */
export interface MediaError {
  readonly code: ToolErrorCode;
  readonly message: string;
  readonly recoverable: boolean;
  readonly remediation: string;
}

/** Built over a code schema so the published copy can loosen it to a string. */
export function mediaErrorShape<TCode extends z.ZodType>(code: TCode) {
  return z.strictObject({
    code,
    message: z.string().min(1),
    recoverable: z.boolean(),
    remediation: z.string().min(1),
  });
}

export const mediaErrorSchema = mediaErrorShape(z.enum(toolErrorCodes));

/**
 * Why the deployment's own configuration did not decide a choice an add needs.
 *
 * `unknown` is a configured value that names nothing on the instance, `none` is
 * an instance with nothing to choose from, `ambiguous` is several candidates
 * and no configured choice, and `no_resolution` is a request for a resolution
 * that no quality profile's cutoff states.
 */
export type DeploymentProblem =
  | {
      readonly setting: "qualityProfile" | "rootFolder";
      readonly reason: "unknown" | "none" | "ambiguous";
    }
  | { readonly setting: "resolution" };

/** The wording each code reads with, for a kind's titles. */
const messages: Readonly<Record<ToolErrorCode, (noun: string) => string>> = {
  invalid_input: () => "the arguments were not accepted",
  unconfigured_application: (noun) => `${noun} are not available on this server`,
  unsupported_capability: (noun) => `the source of ${noun} runs a version this server cannot use`,
  unavailable_application: (noun) => `the source of ${noun} could not be reached`,
  upstream_authentication: (noun) => `the source of ${noun} refused this server's credentials`,
  upstream_rejection: (noun) => `the source of ${noun} refused the request`,
  rate_limit: (noun) => `the source of ${noun} is limiting requests`,
  timeout: (noun) => `the source of ${noun} did not answer in time`,
  stale_reference: (noun) => `the source of ${noun} answered in a way this server cannot use`,
  stale_plan: (noun) => `the source of ${noun} answered in a way this server cannot use`,
  conflict: (noun) => `the source of ${noun} reported a conflicting change`,
  partial_failure: () => "some of the request did not complete",
  unexpected_response: (noun) => `the source of ${noun} answered in a way this server cannot use`,
  not_found: () => "no title of that kind has that id",
  deployment_configuration: (noun) =>
    `this server's configuration does not decide how to add ${noun}`,
};

/**
 * What a caller can do about each code, for a kind's titles.
 *
 * Exhaustive over the codes, so a code added later has to be given its own
 * wording here rather than fall through to one that names something a caller
 * of this toolset was never told about. The stale codes are never produced by
 * this toolset — it mints no references — and read like an unexpected
 * response for the same reason {@link mediaErrorFor} maps them onto one.
 */
const remediations: Readonly<Record<ToolErrorCode, (kind: TitleKind) => string>> = {
  invalid_input: () =>
    "Correct the arguments to match the tool's declared input schema and call it again.",
  unconfigured_application: (kind) =>
    `${kindRoutes[kind].pluralSentence} are not available on this server; ask its operator to configure them.`,
  unsupported_capability: (kind) =>
    `Ask this server's operator to upgrade the source of ${kindRoutes[kind].plural}.`,
  unavailable_application: (kind) =>
    `Retry later; if it persists, ask this server's operator to check the source of ${kindRoutes[kind].plural}.`,
  upstream_authentication: (kind) =>
    `Ask this server's operator to correct the credentials for the source of ${kindRoutes[kind].plural}.`,
  upstream_rejection: () => "Find the title again and retry with the kind and id it returned.",
  rate_limit: () => "Wait before retrying.",
  timeout: () => "Retry once; if it persists, wait before trying again.",
  stale_reference: (kind) =>
    `Ask this server's operator to check the version of the source of ${kindRoutes[kind].plural}.`,
  stale_plan: (kind) =>
    `Ask this server's operator to check the version of the source of ${kindRoutes[kind].plural}.`,
  conflict: () => "Find the title again to see its current state, then retry.",
  partial_failure: () => "Retry the call.",
  unexpected_response: (kind) =>
    `Ask this server's operator to check the version of the source of ${kindRoutes[kind].plural}.`,
  not_found: () => "Search for the title again and use an id the search returned.",
  deployment_configuration: () =>
    "Ask this server's operator to correct its configuration before retrying.",
};

/**
 * A failure that belongs to the call rather than to any one kind: arguments
 * the schema refused, or a handler that failed in a way it did not report.
 */
export function callError(
  code: "invalid_input" | "unexpected_response",
  message: string,
): MediaError {
  return {
    code,
    message,
    recoverable: toolErrorPolicy(code).recoverable,
    remediation:
      code === "invalid_input"
        ? remediations.invalid_input("movie")
        : "Retry the call; if it fails again, ask this server's operator to report it.",
  };
}

/** A failure of one code for one kind of title. */
export function mediaError(kind: TitleKind, code: ToolErrorCode): MediaError {
  return {
    code,
    message: messages[code](kindRoutes[kind].plural),
    recoverable: toolErrorPolicy(code).recoverable,
    remediation: remediations[code](kind),
  };
}

/**
 * A failure the upstream boundary already normalized, reworded for a kind.
 *
 * The code survives and the upstream message does not. A stale code cannot be
 * the caller's doing here, since a `media` call names a title by a stable id
 * and never by something this server minted, so it is reported as the
 * unexpected response it is.
 */
export function mediaErrorForCode(kind: TitleKind, code: ToolErrorCode): MediaError {
  return mediaError(
    kind,
    code === "stale_reference" || code === "stale_plan" ? "unexpected_response" : code,
  );
}

/** A failure thrown while serving one kind, normalized as above. */
export function mediaErrorFor(kind: TitleKind, thrown: unknown): MediaError {
  return mediaErrorForCode(
    kind,
    toolErrorForThrown(thrown, kindRoutes[kind].application, "server_composed").code,
  );
}

function describeDeploymentProblem(
  kind: TitleKind,
  problem: DeploymentProblem,
): { readonly message: string; readonly remediation: string } {
  const noun = kindRoutes[kind].plural;
  if (problem.setting === "resolution") {
    return {
      message: `no quality profile for ${noun} has a cutoff with a known resolution`,
      remediation:
        `Ask this server's operator to give a quality profile for ${noun} a cutoff quality ` +
        "with a known resolution.",
    };
  }

  const variable = mediaDefaultVariables[kind][problem.setting];
  const thing = problem.setting === "qualityProfile" ? "quality profile" : "root folder";
  switch (problem.reason) {
    case "unknown":
      return {
        message: `${variable} names a ${thing} the source of ${noun} does not have`,
        remediation: `Ask this server's operator to correct ${variable} to name an existing ${thing}.`,
      };
    case "none":
      return {
        message: `the source of ${noun} has no ${thing} to add them with`,
        remediation: `Ask this server's operator to create a ${thing} for ${noun} and set ${variable} to it.`,
      };
    case "ambiguous":
      return {
        message: `the source of ${noun} has several ${thing}s and ${variable} is not set`,
        remediation: `Ask this server's operator to set ${variable} to the ${thing} new ${noun} should use.`,
      };
  }
}

/**
 * A failure only the operator can correct, naming what has to change.
 *
 * This is the one failure whose remediation does name the instance's own
 * concepts, because it is addressed to the operator through the caller and the
 * operator has to know which variable, or which setting, to change.
 */
export function deploymentError(kind: TitleKind, problem: DeploymentProblem): MediaError {
  const { message, remediation } = describeDeploymentProblem(kind, problem);
  return {
    code: "deployment_configuration",
    message,
    recoverable: toolErrorPolicy("deployment_configuration").recoverable,
    remediation,
  };
}
