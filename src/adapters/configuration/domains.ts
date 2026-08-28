import type { ApplicationId } from "../../applications.js";

/**
 * The configuration domains this server can observe, and the upstream route
 * each one is read from.
 *
 * Three families are kept apart because their reconciliation rules differ, not
 * because their routes differ. A *provider* carries a dynamic, version-specific
 * `fields` array derived from a schema endpoint; a *profile* is a full-resource
 * document whose ordering matters; a *resource* is a small flat record. The
 * observation side already has to know which family it is reading, because only
 * a provider has dynamic fields to classify.
 */

export const providerDomains = [
  "indexers",
  "download_clients",
  "applications",
  "notifications",
  "import_lists",
  "metadata",
  "proxies",
] as const;

export const profileDomains = [
  "quality_profiles",
  "custom_formats",
  "release_profiles",
  "delay_profiles",
  "app_profiles",
] as const;

export const resourceDomains = [
  "tags",
  "root_folders",
  "remote_path_mappings",
  "import_list_exclusions",
] as const;

export const configurationDomains = [
  ...providerDomains,
  ...profileDomains,
  ...resourceDomains,
] as const;

export type ProviderDomain = (typeof providerDomains)[number];

export type ProfileDomain = (typeof profileDomains)[number];

export type ResourceDomain = (typeof resourceDomains)[number];

export type ConfigurationDomain = (typeof configurationDomains)[number];

export type ConfigurationFamily = "provider" | "profile" | "resource";

const providerDomainSet: ReadonlySet<string> = new Set(providerDomains);
const profileDomainSet: ReadonlySet<string> = new Set(profileDomains);

export function isProviderDomain(domain: ConfigurationDomain): domain is ProviderDomain {
  return providerDomainSet.has(domain);
}

export function familyOf(domain: ConfigurationDomain): ConfigurationFamily {
  if (providerDomainSet.has(domain)) {
    return "provider";
  }
  return profileDomainSet.has(domain) ? "profile" : "resource";
}

/**
 * Which upstream route each application answers a domain from.
 *
 * The route is per application rather than per domain because the three
 * applications name the same concept differently — Prowlarr's application list
 * is `applications` and its profiles are `appprofile`, neither of which exists
 * in Sonarr or Radarr. An application with no entry does not model the domain at
 * all, which is what {@link applicationsForDomain} reports; that is a single
 * source of truth, so a domain can never be advertised for an application no
 * route was ever written for.
 *
 * Sonarr and Radarr have no indexer-proxy provider list, and Prowlarr has no
 * media library, so neither gets an entry it could not answer.
 */
export const configurationRoutes: Readonly<
  Record<ConfigurationDomain, Readonly<Partial<Record<ApplicationId, string>>>>
> = {
  indexers: { sonarr: "indexer", radarr: "indexer", prowlarr: "indexer" },
  download_clients: {
    sonarr: "downloadclient",
    radarr: "downloadclient",
    prowlarr: "downloadclient",
  },
  applications: { prowlarr: "applications" },
  notifications: { sonarr: "notification", radarr: "notification", prowlarr: "notification" },
  import_lists: { sonarr: "importlist", radarr: "importlist" },
  metadata: { sonarr: "metadata", radarr: "metadata" },
  proxies: { prowlarr: "indexerproxy" },
  quality_profiles: { sonarr: "qualityprofile", radarr: "qualityprofile" },
  custom_formats: { sonarr: "customformat", radarr: "customformat" },
  release_profiles: { sonarr: "releaseprofile" },
  delay_profiles: { sonarr: "delayprofile", radarr: "delayprofile" },
  app_profiles: { prowlarr: "appprofile" },
  tags: { sonarr: "tag", radarr: "tag", prowlarr: "tag" },
  root_folders: { sonarr: "rootfolder", radarr: "rootfolder" },
  remote_path_mappings: { sonarr: "remotepathmapping", radarr: "remotepathmapping" },
  // Radarr names this resource `exclusions` and answers `importlistexclusion`
  // with a 404; Sonarr does the reverse. Verified against both recorded
  // minimum versions, in both the plain and the paged form.
  import_list_exclusions: { sonarr: "importlistexclusion", radarr: "exclusions" },
};

/**
 * Which applications serve an upstream-paged form of a domain's collection.
 *
 * The paged route is derived from the entry above rather than written out, so
 * it can never name a collection the application does not answer the domain
 * from. Only the exclusion domain offers one on either application; every other
 * configuration route returns its whole collection at once, which the service
 * pages itself.
 */
const upstreamPagedDomains: Readonly<
  Partial<Record<ConfigurationDomain, readonly ApplicationId[]>>
> = {
  import_list_exclusions: ["sonarr", "radarr"],
};

/** How one application answers one domain, and which side applies the window. */
export interface ConfigurationRead {
  /** The route the observation sends. */
  readonly route: string;
  /** Whether the instance applies the page window rather than the service. */
  readonly upstreamPaged: boolean;
}

/**
 * The read an observation performs, which is the paged form wherever the
 * application serves one.
 *
 * Preferring the paged form is what bounds an observation by the query's page
 * bound upstream rather than after the fact, so a collection is never fetched
 * whole to return one page of it.
 */
export function configurationReadFor(
  domain: ConfigurationDomain,
  application: ApplicationId,
): ConfigurationRead | undefined {
  const route = configurationRoutes[domain][application];
  if (route === undefined) {
    return undefined;
  }
  return upstreamPagedDomains[domain]?.includes(application) === true
    ? { route: `${route}/paged`, upstreamPaged: true }
    : { route, upstreamPaged: false };
}

export function routeFor(
  domain: ConfigurationDomain,
  application: ApplicationId,
): string | undefined {
  return configurationRoutes[domain][application];
}

/** The applications that model a domain, derived from the route table alone. */
export function applicationsForDomain(domain: ConfigurationDomain): readonly ApplicationId[] {
  return Object.keys(configurationRoutes[domain]) as readonly ApplicationId[];
}
