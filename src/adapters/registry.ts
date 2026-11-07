import { z } from "zod";
import {
  type ApplicationApiVersion,
  type ApplicationDescriptor,
  type ApplicationId,
  applicationDescriptors,
} from "../applications.js";
import type { EnvironmentConfiguration, InstanceConfiguration } from "../config/environment.js";
import { findInstance } from "../config/environment.js";
import { createUpstreamClient, type FetchLike, type UpstreamClient } from "../http/client.js";
import { isUpstreamError, type UpstreamErrorKind } from "../http/errors.js";
import { meetsMinimumVersion } from "./version.js";

export const systemStatusPath = "system/status";

const systemStatusSchema = z.object({
  version: z.string().min(1),
  appName: z.string().min(1).optional(),
});

export type SystemStatus = z.infer<typeof systemStatusSchema>;

interface CapabilityBase {
  readonly application: ApplicationId;
  readonly apiVersion: ApplicationApiVersion;
  readonly minimumVersion: string;
}

export interface UnconfiguredCapability {
  readonly application: ApplicationId;
  readonly status: "unconfigured";
}

export interface UpstreamFailure {
  readonly kind: UpstreamErrorKind;
  readonly message: string;
}

export interface UnavailableCapability extends CapabilityBase {
  readonly status: "unavailable";
  readonly failure: UpstreamFailure;
}

export interface UnsupportedCapability extends CapabilityBase {
  readonly status: "unsupported";
  readonly version: string;
}

export interface AvailableCapability extends CapabilityBase {
  readonly status: "available";
  readonly version: string;
}

export type ProbedCapability = UnavailableCapability | UnsupportedCapability | AvailableCapability;

export type ApplicationCapability = UnconfiguredCapability | ProbedCapability;

export interface ApplicationAdapter {
  readonly application: ApplicationId;
  readonly apiVersion: ApplicationApiVersion;
  readonly minimumVersion: string;
  readonly client: UpstreamClient;
  /** Probes `system/status`. Resolves with a capability instead of rejecting. */
  probe(): Promise<ProbedCapability>;
}

export interface AdapterRegistryDependencies {
  readonly fetch?: FetchLike | undefined;
  /** Abandons every upstream request the registry's clients make, as the client's own `signal` does. */
  readonly signal?: AbortSignal | undefined;
}

export interface AdapterRegistry {
  readonly adapters: readonly ApplicationAdapter[];
  adapter(application: ApplicationId): ApplicationAdapter | undefined;
  /** Probes every configured application; one failure never affects another. */
  probe(): Promise<readonly ApplicationCapability[]>;
  /**
   * The text with every configured API key taken out, or `undefined` where it
   * cannot be published at all. See {@link withholdSecrets}.
   */
  withholdSecrets(text: string): string | undefined;
}

/** What a configured secret becomes where it appeared in published text. */
export const redactedSecretMarker = "[redacted key]";

/**
 * The shortest secret a marker may stand in for.
 *
 * Marking where a secret appeared tells a reader where its characters were,
 * and for a short secret that is most of the secret: replacing a three-letter
 * key in an ordinary title leaves the surrounding letters to say what it was.
 * Text carrying a shorter one is withheld whole instead.
 */
export const minimumMarkableSecretLength = 8;

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Takes every occurrence of the given secrets out of a piece of text.
 *
 * This is an exact-value rule, beside the shape rules the upstream text
 * sanitizer applies, because a configured key need not look like one: an
 * operator may have set a short or hand-written key that no credential shape
 * would match. Matching ignores case, since an upstream source may well have
 * changed it. A secret of at least {@link minimumMarkableSecretLength}
 * characters is replaced by {@link redactedSecretMarker}; text that carries a
 * shorter one, anywhere, is withheld whole and answers `undefined`, for the
 * reason that constant gives. Longer secrets are taken first, so one that
 * contains another is not left half-replaced.
 */
export function withholdSecrets(text: string, secrets: readonly string[]): string | undefined {
  let withheld = text;
  const ordered = [...new Set(secrets.filter((secret) => secret !== ""))].sort(
    (left, right) => right.length - left.length,
  );
  for (const secret of ordered) {
    const pattern = new RegExp(escapePattern(secret), "giu");
    if (!pattern.test(withheld)) {
      continue;
    }
    if (secret.length < minimumMarkableSecretLength) {
      return undefined;
    }
    withheld = withheld.replace(pattern, redactedSecretMarker);
  }
  return withheld;
}

/**
 * Wraps one upstream client as a version-aware application adapter. The client
 * is injected so adapter behavior can be tested without a network.
 */
export function createApplicationAdapter(
  descriptor: ApplicationDescriptor,
  client: UpstreamClient,
): ApplicationAdapter {
  const base: CapabilityBase = {
    application: descriptor.id,
    apiVersion: descriptor.apiVersion,
    minimumVersion: descriptor.minimumVersion,
  };

  const unavailable = (kind: UpstreamErrorKind, message: string): UnavailableCapability => ({
    ...base,
    status: "unavailable",
    failure: { kind, message },
  });

  return {
    application: descriptor.id,
    apiVersion: descriptor.apiVersion,
    minimumVersion: descriptor.minimumVersion,
    client,

    async probe(): Promise<ProbedCapability> {
      let body: unknown;
      try {
        body = await client.get(systemStatusPath);
      } catch (error) {
        return isUpstreamError(error)
          ? unavailable(error.kind, error.message)
          : unavailable(
              "unexpected-response",
              `${descriptor.id}: probing ${systemStatusPath} failed unexpectedly`,
            );
      }

      const parsed = systemStatusSchema.safeParse(body);
      if (!parsed.success) {
        return unavailable(
          "unexpected-response",
          `${descriptor.id}: ${systemStatusPath} did not report a usable version`,
        );
      }

      const version = parsed.data.version;
      return {
        ...base,
        status: meetsMinimumVersion(version, descriptor.minimumVersion)
          ? "available"
          : "unsupported",
        version,
      };
    },
  };
}

export function createAdapterRegistry(
  configuration: EnvironmentConfiguration,
  dependencies: AdapterRegistryDependencies = {},
): AdapterRegistry {
  const adapters: ApplicationAdapter[] = [];
  const byApplication = new Map<ApplicationId, ApplicationAdapter>();
  const createClient = (
    descriptor: ApplicationDescriptor,
    instance: InstanceConfiguration,
  ): UpstreamClient =>
    createUpstreamClient({
      application: descriptor.id,
      baseUrl: instance.baseUrl,
      apiBasePath: descriptor.apiBasePath,
      apiKey: instance.apiKey,
      timeoutMs: configuration.upstreamTimeoutMs,
      fetch: dependencies.fetch,
      signal: dependencies.signal,
    });

  // Every configured key, held only so text can be checked against them. They
  // leave this closure as markers and never as values.
  const secrets = configuration.instances.map((instance) => instance.apiKey);

  for (const descriptor of applicationDescriptors) {
    const instance = findInstance(configuration, descriptor.id);
    if (instance === undefined) {
      continue;
    }
    const adapter = createApplicationAdapter(descriptor, createClient(descriptor, instance));
    adapters.push(adapter);
    byApplication.set(descriptor.id, adapter);
  }

  return {
    adapters,

    adapter(application: ApplicationId): ApplicationAdapter | undefined {
      return byApplication.get(application);
    },

    async probe(): Promise<readonly ApplicationCapability[]> {
      return Promise.all(
        applicationDescriptors.map(async (descriptor): Promise<ApplicationCapability> => {
          const adapter = byApplication.get(descriptor.id);
          return adapter === undefined
            ? { application: descriptor.id, status: "unconfigured" }
            : adapter.probe();
        }),
      );
    },

    withholdSecrets(text: string): string | undefined {
      return withholdSecrets(text, secrets);
    },
  };
}
