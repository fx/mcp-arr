export const applicationIds = ["sonarr", "radarr", "prowlarr"] as const;

export type ApplicationId = (typeof applicationIds)[number];

export type ApplicationApiVersion = "v1" | "v3";

export interface ApplicationDescriptor {
  readonly id: ApplicationId;
  readonly apiVersion: ApplicationApiVersion;
  readonly apiBasePath: string;
  readonly minimumVersion: string;
  readonly urlVariable: string;
  readonly apiKeyVariable: string;
}

function describe(
  id: ApplicationId,
  apiVersion: ApplicationApiVersion,
  minimumVersion: string,
): ApplicationDescriptor {
  const prefix = id.toUpperCase();
  return {
    id,
    apiVersion,
    apiBasePath: `/api/${apiVersion}`,
    minimumVersion,
    urlVariable: `${prefix}_URL`,
    apiKeyVariable: `${prefix}_API_KEY`,
  };
}

/**
 * The recorded minimum supported versions. Raise one only when the
 * implementation knowingly depends on behavior an older release lacks.
 */
export const applicationDescriptors: readonly ApplicationDescriptor[] = [
  describe("sonarr", "v3", "4.0.19.2979"),
  describe("radarr", "v3", "6.3.0.10514"),
  describe("prowlarr", "v1", "2.5.2.5491"),
];

const descriptorsById = new Map<ApplicationId, ApplicationDescriptor>(
  applicationDescriptors.map((descriptor) => [descriptor.id, descriptor]),
);

export function describeApplication(id: ApplicationId): ApplicationDescriptor {
  const descriptor = descriptorsById.get(id);
  if (descriptor === undefined) {
    throw new Error(`Unknown application: ${id}`);
  }
  return descriptor;
}
