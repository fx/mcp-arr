import { z } from "zod";
import type { ApplicationId } from "../../applications.js";
import type { UpstreamBody, UpstreamClient } from "../../http/client.js";
import { UpstreamError } from "../../http/errors.js";
import { createToolError, type ToolError, toolErrorForThrown } from "../../tools/errors.js";
import { type ProviderDomain, routeFor } from "./domains.js";

/**
 * Provider tests, and the one bypass that may follow a warned one.
 *
 * Testing a provider is the only thing this server does that reaches past the
 * instance: the instance opens a connection to a tracker, a download client, or
 * a notification service, and in the notification case a person receives a
 * message. Three rules follow from that and hold throughout this module.
 *
 * The reach is declared before it happens and reported after. A caller planning
 * a test is told which kind of external effect it has, and a caller reading the
 * result is told whether it happened, because "we sent a test message to your
 * phone" is not something to discover afterwards.
 *
 * A test has three outcomes and they never collapse into two. Passing, being
 * warned, and failing validation are different answers, and only the middle one
 * may be overridden — folding a failure in with a warning is exactly how a
 * bypass comes to override something it was never meant to.
 *
 * And the bypass is never a default. Nothing here saves past a warning because
 * saving was easier that way: a caller asks for it in a separate typed intent,
 * the request that carries it out names what it skipped, and a provider that
 * failed outright is refused however loudly the caller asked.
 */

/**
 * How far past the instance a test reaches.
 *
 * Every provider test contacts something outside the instance — that is what
 * makes it a test rather than a form check. The distinction that matters to a
 * caller is whether a *person* is on the other end, because a delivered message
 * cannot be taken back and a failed connection attempt can be forgotten.
 */
export const externalEffects = ["contacts_service", "delivers_message"] as const;

export type ExternalEffect = (typeof externalEffects)[number];

/**
 * What testing each provider family reaches.
 *
 * Stated per domain rather than inferred from the implementation name, because
 * an implementation this project has never heard of still belongs to a domain
 * whose testing behavior is known: any notification provider delivers something
 * to somebody, whatever it is called.
 */
const domainEffects: Readonly<Record<ProviderDomain, ExternalEffect>> = {
  indexers: "contacts_service",
  download_clients: "contacts_service",
  applications: "contacts_service",
  notifications: "delivers_message",
  import_lists: "contacts_service",
  metadata: "contacts_service",
  proxies: "contacts_service",
};

export function externalEffectOf(domain: ProviderDomain): ExternalEffect {
  return domainEffects[domain];
}

/** What a caller is told before a test runs, in the words the effect deserves. */
export function describeExternalEffect(domain: ProviderDomain, application: ApplicationId): string {
  return domainEffects[domain] === "delivers_message"
    ? `${application}: this test delivers a real notification to whoever this provider is configured to reach`
    : `${application}: this test makes ${application} contact the external service this provider is configured for`;
}

/**
 * The three answers a provider test gives.
 *
 * `warned` is the only one a save may proceed past, and it is a distinct state
 * rather than a flavour of either neighbour precisely so that it can be the
 * only one.
 */
export const providerTestOutcomes = ["passed", "warned", "failed"] as const;

export type ProviderTestOutcome = (typeof providerTestOutcomes)[number];

/** One thing the instance objected to, reduced to what a caller can act on. */
export interface ValidationFinding {
  readonly severity: "warning" | "error";
  /** The provider field it is about, where the instance named one. */
  readonly field?: string | undefined;
  readonly message: string;
}

const findingSchema = z.object({
  isWarning: z.boolean().nullish(),
  severity: z.string().nullish(),
  propertyName: z.string().nullish(),
  errorMessage: z.string().nullish(),
});

function text(value: string | null | undefined): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Reads one validation entry, and decides warning from error conservatively.
 *
 * An entry is a warning only where the instance said so. Anything unlabelled,
 * or labelled with a severity this server does not recognize, is an error —
 * because the consequence of being wrong in that direction is a save refused
 * that could have proceeded, and the consequence of being wrong in the other is
 * a bypass overriding a real failure.
 */
function readFinding(value: unknown): ValidationFinding | undefined {
  const parsed = findingSchema.safeParse(value);
  if (!parsed.success) {
    return undefined;
  }
  const message = text(parsed.data.errorMessage);
  if (message === undefined) {
    return undefined;
  }
  const severity = text(parsed.data.severity)?.toLowerCase();
  const warning = parsed.data.isWarning === true || severity === "warning";
  return {
    severity: warning ? "warning" : "error",
    field: text(parsed.data.propertyName),
    message,
  };
}

/** What one answer to a test contained, and what could not be read out of it. */
export interface ValidationReading {
  readonly findings: readonly ValidationFinding[];
  /**
   * How many entries the instance sent that this server could not read.
   *
   * Counted rather than discarded. An entry nobody could read is not evidence
   * of anything, and dropping it would let a refusal that listed one warning and
   * one unreadable objection be bypassed as though the warning were all of it.
   */
  readonly unreadable: number;
}

/**
 * Reads whatever the instance answered a test with.
 *
 * These APIs report a clean test as an empty success and a rejected one as a
 * body listing what failed, so both shapes are read here rather than only the
 * one a passing test produces. A body that is not a list at all is one
 * unreadable entry rather than nothing, for the same reason: a rejection this
 * server cannot parse must not read as a rejection with nothing in it.
 */
export function readValidation(body: unknown): ValidationReading {
  if (body === undefined || body === null) {
    return { findings: [], unreadable: 0 };
  }
  if (!Array.isArray(body)) {
    return { findings: [], unreadable: 1 };
  }

  const findings: ValidationFinding[] = [];
  let unreadable = 0;
  for (const entry of body) {
    const finding = readFinding(entry);
    if (finding === undefined) {
      unreadable += 1;
    } else {
      findings.push(finding);
    }
  }
  return { findings, unreadable };
}

/**
 * Classifies one answered test.
 *
 * An accepted test with warnings is warned rather than passed: the instance
 * took it and still had something to say. A rejected test is failed unless
 * every objection it raised is a warning this server could read — a rejection
 * that listed nothing readable is failed, and so is one that listed a warning
 * alongside something unreadable, because the unread part is exactly what a
 * bypass would be overriding blind.
 */
export function classifyTest(accepted: boolean, reading: ValidationReading): ProviderTestOutcome {
  if (reading.findings.some((finding) => finding.severity === "error")) {
    return "failed";
  }
  if (accepted) {
    // An accepted answer already says the instance took it, so an entry that
    // could not be read alongside that is a warning nobody can name rather
    // than a refusal: it is reported as warned, not as a failure the instance
    // did not report.
    return reading.findings.length === 0 && reading.unreadable === 0 ? "passed" : "warned";
  }
  return reading.unreadable > 0 || reading.findings.length === 0 ? "failed" : "warned";
}

/** Whether a save may proceed past this outcome when a caller explicitly asks. */
export function isBypassable(outcome: ProviderTestOutcome): boolean {
  return outcome === "warned";
}

export interface ProviderTestRequest {
  readonly domain: ProviderDomain;
  /** The complete provider resource to test, built by the write path. */
  readonly payload: UpstreamBody;
}

export interface ProviderTestResult {
  readonly outcome: ProviderTestOutcome;
  readonly findings: readonly ValidationFinding[];
  /** How many of the instance's objections this server could not read. */
  readonly unreadable: number;
  /** What the test reached, as a fact about what happened rather than a plan. */
  readonly effect: ExternalEffect;
  /**
   * Whether the request actually went out.
   *
   * A proof rather than an inference: it is set where the request is sent and
   * nowhere else, so a caller settling a receipt can tell a test that never ran
   * from one whose answer it could not read.
   */
  readonly attempted: boolean;
}

export type ProviderTestOutcomeResult =
  | ({ readonly status: "ok" } & ProviderTestResult)
  | {
      readonly status: "error";
      readonly error: ToolError;
      readonly attempted: boolean;
      /**
       * What the attempt reached, present exactly when one was made.
       *
       * A notification test whose answer was lost may already have delivered
       * its message. A result that said only "this failed" would invite a retry
       * that sends a second one, so the effect travels with the failure as well
       * as with the success.
       */
      readonly effect?: ExternalEffect | undefined;
    };

/** The route a provider domain's test is sent to. */
export function providerTestRoute(
  domain: ProviderDomain,
  application: ApplicationId,
): string | undefined {
  const route = routeFor(domain, application);
  return route === undefined ? undefined : `${route}/test`;
}

/**
 * Runs one provider test.
 *
 * The refusal is read rather than thrown, because for this endpoint the body of
 * a rejection is the answer: it says what failed and whether each thing was a
 * warning. Only a failure to reach the instance at all is an error here, and it
 * reports whether the request had gone out — a test whose answer was lost may
 * well have delivered its notification.
 */
export async function runProviderTest(
  application: ApplicationId,
  client: UpstreamClient,
  request: ProviderTestRequest,
): Promise<ProviderTestOutcomeResult> {
  const route = providerTestRoute(request.domain, application);
  if (route === undefined) {
    return {
      status: "error",
      attempted: false,
      error: createToolError({
        code: "unsupported_capability",
        message: `${application}: the ${request.domain} configuration domain is not available on this application`,
        application,
      }),
    };
  }

  try {
    const answered = await client.validate(route, request.payload);
    const reading = readValidation(answered.body);
    return {
      status: "ok",
      attempted: true,
      outcome: classifyTest(answered.accepted, reading),
      findings: reading.findings,
      unreadable: reading.unreadable,
      effect: domainEffects[request.domain],
    };
  } catch (error) {
    // Whether the request went out is read from the client's own contract
    // rather than from a flag set beside the call. The client refuses an
    // unusable path and a payload it cannot serialize *before* it reaches for
    // the instance, and reports both as `invalid-request`; everything else it
    // raises happened at or after the request. A flag set before the await
    // would have claimed a delivered notification for a payload that never
    // left this process.
    const dispatched = !(error instanceof UpstreamError && error.kind === "invalid-request");
    return {
      status: "error",
      attempted: dispatched,
      error: toolErrorForThrown(error, application),
      ...(dispatched ? { effect: domainEffects[request.domain] } : {}),
    };
  }
}

/** What a requested bypass amounts to, once the test that preceded it answered. */
export interface BypassDecision {
  /** Set where the bypass may not proceed, which no field on a request changes. */
  readonly refusal?: ToolError | undefined;
  /**
   * The query the save carries. Empty unless something actually needed
   * overriding: the parameter is only ever emitted as `true`, because an
   * explicit `false` and no parameter at all mean the same thing to these
   * applications and sending one would suggest a decision where none was made.
   */
  readonly query: Readonly<Record<string, boolean>>;
  readonly warnings: readonly string[];
}

/**
 * Decides what an explicitly requested bypass does, in one place.
 *
 * The refusal, the parameter, and the disclosure are one answer rather than
 * three, because they have to agree: a save that claimed to have skipped checks
 * while sending no parameter, or that sent one while reporting that nothing was
 * overridden, would describe something that did not happen. Deciding them
 * together is what makes that impossible rather than merely unlikely.
 *
 * A failed test is refused however explicitly the bypass was asked for — the
 * instance reported something that is not a warning, and no field on a request
 * makes it into one. A passed test is not refused, because the caller asked for
 * a save and it would have succeeded; it simply carries no parameter and says
 * that nothing needed skipping.
 */
export function planBypass(application: ApplicationId, result: ProviderTestResult): BypassDecision {
  if (result.outcome === "failed") {
    return {
      query: {},
      warnings: [],
      refusal: createToolError({
        code: "upstream_rejection",
        message:
          result.unreadable > 0
            ? `${application}: this instance raised ${String(result.unreadable)} objection(s) this server could not read, and a bypass does not override something nobody can name`
            : `${application}: this provider failed validation rather than raising warnings, and a bypass does not override a failure`,
        application,
      }),
    };
  }

  if (!isBypassable(result.outcome)) {
    // Passed. The save proceeds as an ordinary one: no parameter, and no claim
    // to have skipped anything, because nothing was raised to skip.
    return {
      query: {},
      warnings: [
        `${application}: this provider raised no validation warnings, so nothing was skipped and the save was sent as an ordinary one`,
      ],
    };
  }

  // Every warning is named. A bypass that reported only how many there were
  // would let a caller record having overridden something without recording
  // what.
  return {
    query: { forceSave: true },
    warnings: [
      `${application}: this save skipped the instance's validation warnings, which it would otherwise have refused`,
      ...result.findings
        .filter((finding) => finding.severity === "warning")
        .map(
          (finding) =>
            `${application}: skipped warning${finding.field === undefined ? "" : ` on ${finding.field}`}: ${finding.message}`,
        ),
    ],
  };
}
