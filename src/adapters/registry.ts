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
  readonly timeoutMs?: number | undefined;
}

export interface AdapterRegistry {
  readonly adapters: readonly ApplicationAdapter[];
  adapter(application: ApplicationId): ApplicationAdapter | undefined;
  /** Probes every configured application; one failure never affects another. */
  probe(): Promise<readonly ApplicationCapability[]>;
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
      timeoutMs: dependencies.timeoutMs,
      fetch: dependencies.fetch,
    });

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
  };
}
