import { describe, expect, it } from "vitest";
import {
  applicationsForDomain,
  configurationDomains,
  configurationReadFor,
  configurationRoutes,
  familyOf,
  isProviderDomain,
  profileDomains,
  providerDomains,
  resourceDomains,
  routeFor,
} from "../src/adapters/configuration/domains.js";
import { applicationIds } from "../src/applications.js";

/**
 * The domain and route table.
 *
 * It is the single source of truth for which application models which
 * configuration domain, so the properties worth pinning are the ones a later
 * edit could quietly break: that support is derived from the routes rather than
 * declared twice, and that every domain lands in exactly one family.
 */

describe("the configuration domain table", () => {
  it("covers every domain exactly once across the three families", () => {
    expect(configurationDomains).toHaveLength(
      providerDomains.length + profileDomains.length + resourceDomains.length,
    );
    expect(new Set(configurationDomains).size).toBe(configurationDomains.length);

    for (const domain of providerDomains) {
      expect(familyOf(domain)).toBe("provider");
      expect(isProviderDomain(domain)).toBe(true);
    }
    for (const domain of profileDomains) {
      expect(familyOf(domain)).toBe("profile");
      expect(isProviderDomain(domain)).toBe(false);
    }
    for (const domain of resourceDomains) {
      expect(familyOf(domain)).toBe("resource");
      expect(isProviderDomain(domain)).toBe(false);
    }
  });

  it("derives application support from the route table rather than declaring it twice", () => {
    for (const domain of configurationDomains) {
      const supported = applicationsForDomain(domain);
      expect(supported.length).toBeGreaterThan(0);

      for (const application of applicationIds) {
        // Supported exactly when a route was written, in both directions, so a
        // domain cannot be advertised for an application that cannot answer it.
        expect(supported.includes(application)).toBe(routeFor(domain, application) !== undefined);
      }
    }
  });

  it("routes each domain to the name its application actually uses", () => {
    expect(routeFor("indexers", "sonarr")).toBe("indexer");
    expect(routeFor("download_clients", "prowlarr")).toBe("downloadclient");
    expect(routeFor("quality_profiles", "radarr")).toBe("qualityprofile");
    // The two media applications name their exclusion list differently, and
    // each answers the other's name with a 404.
    expect(routeFor("import_list_exclusions", "sonarr")).toBe("importlistexclusion");
    expect(routeFor("import_list_exclusions", "radarr")).toBe("exclusions");
    // Prowlarr names two concepts differently from the media applications.
    expect(routeFor("applications", "prowlarr")).toBe("applications");
    expect(routeFor("app_profiles", "prowlarr")).toBe("appprofile");
  });

  it("reads a domain from its paged form wherever the application serves one", () => {
    expect(configurationReadFor("import_list_exclusions", "sonarr")).toEqual({
      route: "importlistexclusion/paged",
      upstreamPaged: true,
    });
    expect(configurationReadFor("import_list_exclusions", "radarr")).toEqual({
      route: "exclusions/paged",
      upstreamPaged: true,
    });
    // Every other route returns its whole collection, which the service pages.
    expect(configurationReadFor("tags", "prowlarr")).toEqual({
      route: "tag",
      upstreamPaged: false,
    });
    expect(configurationReadFor("app_profiles", "sonarr")).toBeUndefined();
  });

  it("reads every domain but the exclusions from its plain collection route", () => {
    for (const domain of configurationDomains) {
      for (const application of applicationIds) {
        const read = configurationReadFor(domain, application);
        const route = routeFor(domain, application);

        if (route === undefined) {
          expect(read).toBeUndefined();
          continue;
        }
        expect(read, `${domain} on ${application}`).toEqual(
          domain === "import_list_exclusions"
            ? { route: `${route}/paged`, upstreamPaged: true }
            : { route, upstreamPaged: false },
        );
      }
    }
  });

  it("reports no route where an application does not model the domain", () => {
    // Prowlarr has no media library, so no roots, profiles, or lists.
    expect(routeFor("root_folders", "prowlarr")).toBeUndefined();
    expect(routeFor("quality_profiles", "prowlarr")).toBeUndefined();
    expect(routeFor("import_lists", "prowlarr")).toBeUndefined();
    // The media applications have neither an application list nor app profiles,
    // and no indexer-proxy provider list of their own.
    expect(routeFor("applications", "sonarr")).toBeUndefined();
    expect(routeFor("app_profiles", "radarr")).toBeUndefined();
    expect(routeFor("proxies", "sonarr")).toBeUndefined();
    // Release profiles are Sonarr's alone; Radarr replaced them with formats.
    expect(routeFor("release_profiles", "radarr")).toBeUndefined();
    expect(applicationsForDomain("release_profiles")).toEqual(["sonarr"]);
  });

  it("writes every route as a relative path, never as a URL or an absolute one", () => {
    for (const routes of Object.values(configurationRoutes)) {
      for (const route of Object.values(routes)) {
        expect(route).toMatch(/^[a-z]+(?:\/[a-z]+)*$/u);
      }
    }
  });
});
