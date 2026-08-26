import {
  type ApplicationDescriptor,
  type ApplicationId,
  applicationDescriptors,
} from "../applications.js";
import { describeBaseUrlProblem, normalizeBaseUrl } from "./base-url.js";

export type EnvironmentRecord = Readonly<Record<string, string | undefined>>;

export interface InstanceConfiguration {
  readonly application: ApplicationId;
  readonly baseUrl: string;
  readonly apiKey: string;
}

export interface EnvironmentConfiguration {
  readonly instances: readonly InstanceConfiguration[];
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
 * Reads the six supported instance variables from an injected environment
 * record. Each application is optional, but an incomplete, empty, or invalid
 * pair rejects startup.
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
  if (problems.length > 0) {
    throw new ConfigurationError(problems);
  }

  return { instances };
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
