import { isIP } from "node:net";
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

/** Selects the transport the process serves MCP on: `stdio` or `http`. */
export const transportVariable = "ARR_MCP_TRANSPORT";
/** The address the HTTP listener binds to. Read only under the HTTP transport. */
export const httpHostVariable = "ARR_MCP_HTTP_HOST";
/** The TCP port the HTTP listener binds to. Read only under the HTTP transport. */
export const httpPortVariable = "ARR_MCP_HTTP_PORT";
/** The bearer token every HTTP request must present. Read only under the HTTP transport. */
export const authTokenVariable = "ARR_MCP_AUTH_TOKEN";

/** Loopback, so a listener nobody configured is reachable from this host only. */
export const defaultHttpHost = "127.0.0.1";
/** Clear of the ports the supported applications and their usual neighbors default to. */
export const defaultHttpPort = 9797;

/** The variables that apply only once the HTTP transport is selected, in report order. */
const httpVariables = [httpHostVariable, httpPortVariable, authTokenVariable] as const;

const minimumTokenLength = 32;
const maximumTokenLength = 4096;
/** RFC 6750's `b64token`: the only characters a bearer credential may carry. */
const b64token = /^[A-Za-z0-9\-._~+/]+=*$/u;

const minimumUpstreamTimeoutMs = 1;
/**
 * Bounded for correctness rather than policy. `setTimeout` holds its delay in a
 * signed 32-bit integer and clamps anything larger to 1ms, so an overflowing
 * value would abort every request almost immediately — the inverse of what was
 * asked for, and invisible to the client's own finite-and-positive guard, which
 * such a value passes.
 */
const maximumUpstreamTimeoutMs = 600_000;

/** The variable that selects which toolsets a process publishes. */
export const toolsetVariable = "ARR_MCP_TOOLSET";

/**
 * The toolsets a process can publish, in the order they are registered. A
 * selection is always reported in this order, whatever order the operator
 * wrote it in, so `media,arr` and `arr,media` publish the same listing.
 */
export const toolsetNames = ["arr", "media"] as const;

export type ToolsetName = (typeof toolsetNames)[number];

/** The spelling that selects every toolset, and that must stand alone. */
const allToolsetsAlias = "all";

/**
 * What an absent selection publishes: the `media` toolset, as Tool Contracts
 * requires. A deployment that wants the fourteen `arr` tools names `arr`.
 */
const defaultToolsets: readonly ToolsetName[] = ["media"];

/**
 * The deployment defaults the `media` toolset adds new titles with, one
 * quality profile and one root folder per kind of title.
 */
export const mediaDefaultVariables = {
  movie: {
    qualityProfile: "ARR_MCP_MEDIA_MOVIE_QUALITY_PROFILE",
    rootFolder: "ARR_MCP_MEDIA_MOVIE_ROOT_FOLDER",
  },
  series: {
    qualityProfile: "ARR_MCP_MEDIA_SERIES_QUALITY_PROFILE",
    rootFolder: "ARR_MCP_MEDIA_SERIES_ROOT_FOLDER",
  },
} as const;

export type MediaDefaultKind = keyof typeof mediaDefaultVariables;
export type MediaDefaultSetting = keyof (typeof mediaDefaultVariables)[MediaDefaultKind];

/** Every `media` default variable, in a fixed order authored here. */
export const mediaDefaultVariableNames: readonly string[] = [
  mediaDefaultVariables.movie.qualityProfile,
  mediaDefaultVariables.movie.rootFolder,
  mediaDefaultVariables.series.qualityProfile,
  mediaDefaultVariables.series.rootFolder,
];

/**
 * The variable that publishes `media_remove`. It is a `media` setting like the
 * defaults above, but a switch rather than a name, so it is parsed on its own.
 */
export const mediaAllowRemoveVariable = "ARR_MCP_MEDIA_ALLOW_REMOVE";

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

/**
 * The transport the process serves MCP on, with the listener settings the
 * HTTP transport needs. Stdio carries none: its settings are rejected rather
 * than ignored, so this shape can never hold a listener the process will not
 * open.
 */
export type TransportConfiguration =
  | { readonly kind: "stdio" }
  | {
      readonly kind: "http";
      readonly host: string;
      readonly port: number;
      /**
       * The bearer token every request must present, in plain text because the
       * listener has to compare against it. Like an instance API key, never log
       * or serialize it.
       */
      readonly token: string;
    };

/** The HTTP member of {@link TransportConfiguration}. */
export type HttpTransportConfiguration = Extract<TransportConfiguration, { readonly kind: "http" }>;

/**
 * One kind's configured defaults. Each is a name or path as the operator wrote
 * it, and each is resolved against the instance only when a title is added, so
 * an instance that is unreachable at startup cannot stop the server starting.
 */
export interface MediaKindDefaults {
  /** The quality profile name new titles of this kind are added with. */
  readonly qualityProfile?: string | undefined;
  /** The root folder path new titles of this kind are added under. */
  readonly rootFolder?: string | undefined;
}

export type MediaDefaults = Readonly<Record<MediaDefaultKind, MediaKindDefaults>>;

export interface ToolsetSelection {
  /** Never empty, and always in {@link toolsetNames} order. */
  readonly names: readonly ToolsetName[];
  /** Present exactly when `media` is selected. */
  readonly media?: MediaDefaults | undefined;
  /**
   * Whether `media_remove` is published. Present only when `media` is selected
   * and {@link mediaAllowRemoveVariable} is set.
   */
  readonly mediaAllowRemove?: boolean | undefined;
}

export interface EnvironmentConfiguration {
  readonly instances: readonly InstanceConfiguration[];
  /** Which toolsets this process publishes, fixed for its lifetime. */
  readonly toolsets: ToolsetSelection;
  /**
   * The deadline, in milliseconds, every outbound upstream request is given.
   * Always present: an absent variable resolves to the default rather than to
   * nothing, so no caller has to decide what a missing deadline means.
   */
  readonly upstreamTimeoutMs: number;
  /** Always present: an absent selection resolves to stdio. */
  readonly transport: TransportConfiguration;
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

function parseHttpHost(env: EnvironmentRecord, problems: string[]): string {
  const state = readVariable(env, httpHostVariable);
  if (state.kind === "absent") {
    return defaultHttpHost;
  }
  if (state.kind === "empty") {
    problems.push(`${httpHostVariable} is set but empty`);
    return defaultHttpHost;
  }
  // An address and nothing else. A name would be resolved at bind time, and
  // what it resolves to — and so who can reach the listener — would then be
  // decided by whatever answers that lookup rather than by this setting.
  if (isIP(state.value) === 0) {
    problems.push(`${httpHostVariable} must be an IPv4 or IPv6 address`);
    return defaultHttpHost;
  }
  return state.value;
}

function parseHttpPort(env: EnvironmentRecord, problems: string[]): number {
  const state = readVariable(env, httpPortVariable);
  if (state.kind === "absent") {
    return defaultHttpPort;
  }
  if (state.kind === "empty") {
    problems.push(`${httpPortVariable} is set but empty`);
    return defaultHttpPort;
  }
  // Digits only, for the reasons the timeout gives: `Number` would accept
  // spellings nobody wrote as a port.
  const value = /^\d+$/.test(state.value) ? Number(state.value) : Number.NaN;
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    problems.push(`${httpPortVariable} must be a whole number from 1 to 65535`);
    return defaultHttpPort;
  }
  return value;
}

function parseAuthToken(env: EnvironmentRecord, problems: string[]): string {
  const state = readVariable(env, authTokenVariable);
  if (state.kind === "absent") {
    problems.push(`${authTokenVariable} is required when ${transportVariable} is http`);
    return "";
  }
  if (state.kind === "empty") {
    problems.push(`${authTokenVariable} is set but empty`);
    return "";
  }
  if (
    state.value.length < minimumTokenLength ||
    state.value.length > maximumTokenLength ||
    !b64token.test(state.value)
  ) {
    problems.push(
      `${authTokenVariable} must be ${minimumTokenLength} to ${maximumTokenLength} ` +
        "characters from the RFC 6750 b64token alphabet",
    );
    return "";
  }
  return state.value;
}

/**
 * Reads the transport selection and, under HTTP, the listener settings.
 *
 * Under stdio each HTTP setting that is present at all — empty included — is
 * a problem of its own: a deployment that set a token and forgot to select the
 * transport would otherwise start a stdio server nobody intended. An unusable
 * selection is reported alone, since which settings belong to it is then
 * unknown. Like the timeout, an unusable value is accumulated, and the
 * returned stand-in exists only so there is something to return.
 */
function parseTransport(env: EnvironmentRecord, problems: string[]): TransportConfiguration {
  const state = readVariable(env, transportVariable);
  if (state.kind === "empty") {
    problems.push(`${transportVariable} is set but empty`);
    return { kind: "stdio" };
  }
  if (state.kind === "value" && state.value !== "stdio" && state.value !== "http") {
    problems.push(`${transportVariable} must be stdio or http`);
    return { kind: "stdio" };
  }
  if (state.kind === "absent" || state.value === "stdio") {
    for (const name of httpVariables) {
      if (env[name] !== undefined) {
        problems.push(`${name} requires ${transportVariable}=http`);
      }
    }
    return { kind: "stdio" };
  }

  const host = parseHttpHost(env, problems);
  const port = parseHttpPort(env, problems);
  const token = parseAuthToken(env, problems);
  return { kind: "http", host, port, token };
}

function isToolsetName(value: string): value is ToolsetName {
  return (toolsetNames as readonly string[]).includes(value);
}

/**
 * Reads the toolset selection, or `undefined` where the value is unusable.
 *
 * Entries are trimmed and matched exactly. Each kind of mistake is reported
 * once, by naming the variable and what is wrong with it, and never by quoting
 * an entry: an unknown name is as likely to be a pasted secret as a typo.
 */
function parseToolsetNames(
  env: EnvironmentRecord,
  problems: string[],
): readonly ToolsetName[] | undefined {
  const state = readVariable(env, toolsetVariable);
  if (state.kind === "absent") {
    return defaultToolsets;
  }
  if (state.kind === "empty") {
    problems.push(`${toolsetVariable} is set but empty`);
    return undefined;
  }

  const entries = state.value.split(",").map((entry) => entry.trim());
  const found = new Set<string>();
  const mistakes = new Set<string>();
  for (const entry of entries) {
    if (entry === "") {
      mistakes.add(`${toolsetVariable} has an empty entry`);
    } else if (entry !== allToolsetsAlias && !isToolsetName(entry)) {
      mistakes.add(
        `${toolsetVariable} names an unknown toolset; use ${toolsetNames.join(", ")}, ` +
          `a comma-separated list of them, or ${allToolsetsAlias}`,
      );
    } else if (found.has(entry)) {
      mistakes.add(`${toolsetVariable} names a toolset more than once`);
    }
    found.add(entry);
  }
  if (found.has(allToolsetsAlias) && entries.length > 1) {
    mistakes.add(`${toolsetVariable} must name ${allToolsetsAlias} on its own`);
  }
  if (mistakes.size > 0) {
    problems.push(...mistakes);
    return undefined;
  }

  return found.has(allToolsetsAlias)
    ? toolsetNames
    : toolsetNames.filter((name) => found.has(name));
}

/**
 * Reads the toolset selection and, when `media` is in it, that toolset's
 * deployment defaults.
 *
 * A default set while `media` is not selected is refused even when it is
 * empty, because a deployment that forgot the selection should fail with a
 * diagnostic rather than start publishing something nobody intended. That
 * check is skipped when the selection itself is unusable: whether the setting
 * belongs is then unknowable, and the selection's own problem is the one the
 * operator has to fix first.
 *
 * The values themselves are free text and are not checked against anything at
 * startup. They name a profile and a folder on an instance, and the instance is
 * consulted only when a title is added.
 */
function parseToolsets(env: EnvironmentRecord, problems: string[]): ToolsetSelection {
  const names = parseToolsetNames(env, problems);
  if (names === undefined) {
    // Never read: the problem just recorded rejects startup. `arr` alone keeps
    // the selection's own invariant, which no media defaults would break.
    return { names: ["arr"] };
  }
  if (!names.includes("media")) {
    for (const variable of [...mediaDefaultVariableNames, mediaAllowRemoveVariable]) {
      if (env[variable] !== undefined) {
        problems.push(`${variable} requires ${toolsetVariable} to select media`);
      }
    }
    return { names };
  }

  const read = (variable: string): string | undefined => {
    const state = readVariable(env, variable);
    if (state.kind === "empty") {
      problems.push(`${variable} is set but empty`);
    }
    return state.kind === "value" ? state.value : undefined;
  };
  const kindDefaults = (kind: MediaDefaultKind): MediaKindDefaults => {
    const qualityProfile = read(mediaDefaultVariables[kind].qualityProfile);
    const rootFolder = read(mediaDefaultVariables[kind].rootFolder);
    return {
      ...(qualityProfile === undefined ? {} : { qualityProfile }),
      ...(rootFolder === undefined ? {} : { rootFolder }),
    };
  };
  const media = { movie: kindDefaults("movie"), series: kindDefaults("series") };
  const allowRemove = parseAllowRemove(env, problems);
  return {
    names,
    media,
    ...(allowRemove === undefined ? {} : { mediaAllowRemove: allowRemove }),
  };
}

/**
 * Reads {@link mediaAllowRemoveVariable}: exactly `true` or `false`, after
 * trimming, and nothing else. A value is never quoted back, for the same
 * reason a toolset name is not.
 */
function parseAllowRemove(env: EnvironmentRecord, problems: string[]): boolean | undefined {
  const state = readVariable(env, mediaAllowRemoveVariable);
  if (state.kind === "absent") {
    return undefined;
  }
  if (state.kind === "empty") {
    problems.push(`${mediaAllowRemoveVariable} is set but empty`);
    return undefined;
  }
  if (state.value !== "true" && state.value !== "false") {
    problems.push(`${mediaAllowRemoveVariable} must be true or false`);
    return undefined;
  }
  return state.value === "true";
}

/**
 * Reads the six supported instance variables and the optional upstream timeout
 * from an injected environment record, then the transport selection and its
 * listener settings, then the toolset selection and its defaults. Each
 * application is optional, but an incomplete, empty, or invalid pair rejects
 * startup, as does an unusable timeout, transport setting, or selection.
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
  // only about the timeout. Recording it here keeps both and keeps an unusable
  // value fatal. The transport settings follow it, and the toolset selection
  // follows those, last, for the same reason.
  const upstreamTimeoutMs = parseUpstreamTimeout(env, problems);
  const transport = parseTransport(env, problems);
  const toolsets = parseToolsets(env, problems);
  if (problems.length > 0) {
    throw new ConfigurationError(problems);
  }

  return { instances, upstreamTimeoutMs, transport, toolsets };
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
