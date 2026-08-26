import { describe, expect, it } from "vitest";
import {
  applicationDescriptors,
  applicationIds,
  describeApplication,
} from "../src/applications.js";
import { approvedFixtureTuples } from "./support/fixtures.js";

describe("applicationDescriptors", () => {
  it("records the researched API versions, minimums, and environment variables", () => {
    expect(applicationDescriptors).toEqual([
      {
        id: "sonarr",
        apiVersion: "v3",
        apiBasePath: "/api/v3",
        minimumVersion: "4.0.19.2979",
        urlVariable: "SONARR_URL",
        apiKeyVariable: "SONARR_API_KEY",
      },
      {
        id: "radarr",
        apiVersion: "v3",
        apiBasePath: "/api/v3",
        minimumVersion: "6.3.0.10514",
        urlVariable: "RADARR_URL",
        apiKeyVariable: "RADARR_API_KEY",
      },
      {
        id: "prowlarr",
        apiVersion: "v1",
        apiBasePath: "/api/v1",
        minimumVersion: "2.5.2.5491",
        urlVariable: "PROWLARR_URL",
        apiKeyVariable: "PROWLARR_API_KEY",
      },
    ]);
    expect(applicationDescriptors.map((descriptor) => descriptor.id)).toEqual([...applicationIds]);
  });

  it("agrees with the approved fixture tuples", () => {
    expect(
      applicationDescriptors.map(({ id, apiVersion, minimumVersion }) => ({
        application: id,
        apiVersion,
        version: minimumVersion,
      })),
    ).toEqual([...approvedFixtureTuples]);
  });
});

describe("describeApplication", () => {
  it("resolves every known application and rejects anything else", () => {
    for (const id of applicationIds) {
      expect(describeApplication(id).id).toBe(id);
    }
    expect(() => describeApplication("lidarr" as (typeof applicationIds)[number])).toThrow(
      "Unknown application: lidarr",
    );
  });
});
