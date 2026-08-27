import { z } from "zod";
import type { ApplicationId } from "../../applications.js";
import type { UpstreamBody, UpstreamClient } from "../../http/client.js";
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

/**
 * Reads whatever the instance answered a test with.
 *
 * These APIs report a clean test as an empty success and a rejected one as a
 * body listing what failed, so both shapes are read here rather than only the
 * one a passing test produces. A body this server cannot make sense of yields
 * no findings, which — combined with the rule below — leaves a rejection
 * classified as a failure rather than as a warning nothing described.
 */
export function readFindings(body: unknown): readonly ValidationFinding[] {
  if (!Array.isArray(body)) {
    return [];
  }
  return body.flatMap((entry) => {
    const finding = readFinding(entry);
    return finding === undefined ? [] : [finding];
  });
}

/**
 * Classifies one answered test.
 *
 * An accepted test with warnings is warned rather than passed: the instance
 * took it and still had something to say. A rejected test is failed unless
 * every finding it listed is a warning — and a rejection that listed nothing
 * this server could read is failed too, because an unreadable refusal is not
 * evidence that a bypass is safe.
 */
export function classifyTest(
  accepted: boolean,
  findings: readonly ValidationFinding[],
): ProviderTestOutcome {
  if (findings.some((finding) => finding.severity === "error")) {
    return "failed";
  }
  if (accepted) {
    return findings.length === 0 ? "passed" : "warned";
  }
  return findings.length === 0 ? "failed" : "warned";
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
  | { readonly status: "error"; readonly error: ToolError; readonly attempted: boolean };

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

  let dispatched = false;
  try {
    dispatched = true;
    const answered = await client.validate(route, request.payload);
    const findings = readFindings(answered.body);
    return {
      status: "ok",
      attempted: true,
      outcome: classifyTest(answered.accepted, findings),
      findings,
      effect: domainEffects[request.domain],
    };
  } catch (error) {
    return {
      status: "error",
      attempted: dispatched,
      error: toolErrorForThrown(error, application),
    };
  }
}

/**
 * The query a save carries when a caller explicitly asked to bypass warnings.
 *
 * Absent unless asked for. The parameter is only ever emitted with `true`,
 * because an explicit `false` and no parameter at all mean the same thing to
 * these applications and sending one would suggest a decision was made where
 * none was.
 */
export function bypassQuery(bypass: boolean): Readonly<Record<string, boolean>> {
  return bypass ? { forceSave: true } : {};
}

/**
 * What a bypass skipped, said plainly, for the result to carry.
 *
 * Every warning is named. A bypass that reported only how many there were would
 * let a caller record having overridden something without recording what.
 */
export function describeBypass(
  application: ApplicationId,
  findings: readonly ValidationFinding[],
): readonly string[] {
  return [
    `${application}: this save skipped the instance's validation warnings, which it would otherwise have refused`,
    ...findings
      .filter((finding) => finding.severity === "warning")
      .map(
        (finding) =>
          `${application}: skipped warning${finding.field === undefined ? "" : ` on ${finding.field}`}: ${finding.message}`,
      ),
  ];
}

/**
 * Whether a bypass may proceed, and why not where it may not.
 *
 * This is the gate the whole bypass rests on, so it is one function with one
 * answer. A failed test is refused however explicitly the bypass was asked for:
 * the instance reported something that is not a warning, and no field on a
 * request makes that into one.
 */
export function checkBypass(
  application: ApplicationId,
  result: ProviderTestResult,
): ToolError | undefined {
  if (isBypassable(result.outcome) || result.outcome === "passed") {
    return undefined;
  }
  return createToolError({
    code: "upstream_rejection",
    message: `${application}: this provider failed validation rather than raising warnings, and a bypass does not override a failure`,
    application,
  });
}
