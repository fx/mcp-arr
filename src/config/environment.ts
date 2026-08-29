import {
  type ApplicationDescriptor,
  type ApplicationId,
  applicationDescriptors,
} from "../applications.js";
import { defaultUpstreamTimeoutMs } from "../http/client.js";
import { describeBaseUrlProblem, normalizeBaseUrl } from "./base-url.js";

export type EnvironmentRecord = Readonly<Record<string, string | undefined>>;

/**
 * The variable that sets the deadline every outbound upstream request is
 * given. It is not an instance connection setting — it selects, addresses, and
 * authenticates to nothing — so it is global rather than per application.
 */
export const upstreamTimeoutVariable = "ARR_UPSTREAM_TIMEOUT_MS";

const minimumUpstreamTimeoutMs = 1;
/**
 * Bounded for correctness rather than policy. `setTimeout` holds its delay in a
 * signed 32-bit integer and clamps anything larger to 1ms, so an overflowing
 * value would abort every request almost immediately — the inverse of what was
 * asked for, and invisible to the client's own finite-and-positive guard, which
 * such a value passes.
 */
const maximumUpstreamTimeoutMs = 600_000;

/**
 * One application's resolved connection settings.
 *
 * This type deliberately carries the API key and base URL in plain enumerable
 * fields: no request can send `X-Api-Key` without them. Redaction is enforced
 * where a value would reach a caller — startup diagnostics, normalized upstream
 * errors, and tool results — not here. Do not log or serialize this record.
 */
export interface InstanceConfiguration {
  readonly application: ApplicationId;
  readonly baseUrl: string;
  readonly apiKey: string;
}

export interface EnvironmentConfiguration {
  readonly instances: readonly InstanceConfiguration[];
  /**
   * The deadline, in milliseconds, every outbound upstream request is given.
   * Always present: an absent variable resolves to the default rather than to
   * nothing, so no caller has to decide what a missing deadline means.
   */
  readonly upstreamTimeoutMs: number;
}

/**
 * Raised when the process environment does not describe a usable instance set.
 * Every problem names environment variables only; configured values are never
 * included so the diagnostic stays safe to print.
 */
export class ConfigurationError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`invalid environment configuration: ${problems.join("; ")}`);
    this.name = "ConfigurationError";
    this.problems = [...problems];
  }
}

type VariableState =
  | { readonly kind: "absent" }
  | { readonly kind: "empty" }
  | { readonly kind: "value"; readonly value: string };

function readVariable(env: EnvironmentRecord, name: string): VariableState {
  const raw = env[name];
  if (raw === undefined) {
    return { kind: "absent" };
  }
  const value = raw.trim();
  return value === "" ? { kind: "empty" } : { kind: "value", value };
}

function parsePair(
  env: EnvironmentRecord,
  descriptor: ApplicationDescriptor,
  problems: string[],
): InstanceConfiguration | undefined {
  const url = readVariable(env, descriptor.urlVariable);
  const apiKey = readVariable(env, descriptor.apiKeyVariable);

  if (url.kind === "absent" && apiKey.kind === "absent") {
    return undefined;
  }

  for (const [name, state] of [
    [descriptor.urlVariable, url],
    [descriptor.apiKeyVariable, apiKey],
  ] as const) {
    if (state.kind === "empty") {
      problems.push(`${name} is set but empty`);
    }
  }
  if (url.kind === "absent") {
    problems.push(`${descriptor.urlVariable} is required when ${descriptor.apiKeyVariable} is set`);
  }
  if (apiKey.kind === "absent") {
    problems.push(`${descriptor.apiKeyVariable} is required when ${descriptor.urlVariable} is set`);
  }
  if (url.kind !== "value" || apiKey.kind !== "value") {
    return undefined;
  }

  const normalized = normalizeBaseUrl(url.value);
  if (!normalized.ok) {
    problems.push(`${descriptor.urlVariable} ${describeBaseUrlProblem(normalized.problem)}`);
    return undefined;
  }

  return { application: descriptor.id, baseUrl: normalized.baseUrl, apiKey: apiKey.value };
}

function describeMissingConfiguration(): string {
  const pairs = applicationDescriptors.map(
    (descriptor) => `${descriptor.urlVariable} and ${descriptor.apiKeyVariable}`,
  );
  return `no application is configured; set ${pairs.join(", or ")}`;
}

/**
 * Reads the upstream request deadline, falling back to the client's own
 * default when the variable is absent.
 *
 * An unusable value is accumulated as a problem rather than thrown, so it is
 * reported alongside every other configuration problem in one diagnostic; the
 * default is returned in that case only so this function has a value to give
 * back, since the accumulated problem rejects startup before it can be used.
 * The problem names the variable and never the value, like every other one.
 */
function parseUpstreamTimeout(env: EnvironmentRecord, problems: string[]): number {
  const state = readVariable(env, upstreamTimeoutVariable);
  if (state.kind === "absent") {
    return defaultUpstreamTimeoutMs;
  }
  if (state.kind === "empty") {
    problems.push(`${upstreamTimeoutVariable} is set but empty`);
    return defaultUpstreamTimeoutMs;
  }

  // Digits and nothing else, tested before conversion, because `Number`
  // accepts far more spellings than a decimal integer and would silently
  // accept a value the operator did not write: `" "` becomes 0, `"1e4"`
  // becomes 10000, `"0x7530"` becomes 30000, and `"+30000"` becomes 30000.
  // Magnitude comes free — a digit string past `Number.MAX_SAFE_INTEGER`
  // converts to a number above the cap and is refused by the range check.
  const value = /^\d+$/.test(state.value) ? Number(state.value) : Number.NaN;
  if (
    !Number.isInteger(value) ||
    value < minimumUpstreamTimeoutMs ||
    value > maximumUpstreamTimeoutMs
  ) {
    problems.push(
      `${upstreamTimeoutVariable} must be a whole number of milliseconds between ` +
        `${minimumUpstreamTimeoutMs} and ${maximumUpstreamTimeoutMs}`,
    );
    return defaultUpstreamTimeoutMs;
  }
  return value;
}

/**
 * Reads the six supported instance variables and the optional upstream timeout
 * from an injected environment record. Each application is optional, but an
 * incomplete, empty, or invalid pair rejects startup, as does an unusable
 * timeout.
 *
 * @throws {ConfigurationError} when no application is usable.
 */
export function parseEnvironment(env: EnvironmentRecord): EnvironmentConfiguration {
  const problems: string[] = [];
  const instances: InstanceConfiguration[] = [];

  for (const descriptor of applicationDescriptors) {
    const instance = parsePair(env, descriptor, problems);
    if (instance !== undefined) {
      instances.push(instance);
    }
  }

  if (problems.length === 0 && instances.length === 0) {
    problems.push(describeMissingConfiguration());
  }
  // Deliberately after the check above and before the throw below. The
  // missing-application diagnostic is emitted only when nothing else has been
  // reported, so a timeout problem recorded earlier would suppress it and an
  // environment with neither an application nor a usable timeout would be told
  // only about the timeout. Recording it here keeps both, keeps an unusable
  // value fatal, and leaves it last in the accumulation order.
  const upstreamTimeoutMs = parseUpstreamTimeout(env, problems);
  if (problems.length > 0) {
    throw new ConfigurationError(problems);
  }

  return { instances, upstreamTimeoutMs };
}

export function loadEnvironment(env: EnvironmentRecord = process.env): EnvironmentConfiguration {
  return parseEnvironment(env);
}

export function findInstance(
  configuration: EnvironmentConfiguration,
  application: ApplicationId,
): InstanceConfiguration | undefined {
  return configuration.instances.find((instance) => instance.application === application);
}
