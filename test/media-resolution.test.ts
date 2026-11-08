import { describe, expect, it } from "vitest";
import { type QualityProfileRecord, readQualityProfiles } from "../src/adapters/library/changes.js";
import { UpstreamError } from "../src/http/errors.js";
import {
  allowedQualityCount,
  chooseProfile,
  profileResolution,
  type Resolution,
  rateProfile,
} from "../src/tools/media/resolution.js";
import { fixtureBody } from "./support/library.js";
import { readOnlyClient } from "./support/tool-context.js";

/**
 * Choosing a quality profile by resolution.
 *
 * The `qualityprofile` fixtures recorded at each application's minimum carry
 * their profiles with emptied `items`, so they prove the reader tolerates that
 * shape and nothing about how a cutoff resolves. The bodies below are written in
 * the upstream shape — a single quality is `{quality, items: [], allowed}`, a
 * group is `{id, name, items: [...qualities], allowed}`, and `cutoff` names one
 * or the other — and the selection rules are exercised over in-code profiles.
 * The last block holds the reader and the rules to the populated profiles newer
 * instances genuinely report.
 */

function quality(id: number, resolution: number, allowed = true): Record<string, unknown> {
  return {
    quality: { id, name: `Example ${resolution}`, source: "web", resolution },
    items: [],
    allowed,
  };
}

function group(
  id: number,
  qualities: readonly Record<string, unknown>[],
  allowed = true,
): Record<string, unknown> {
  return { id, name: `Example group ${id}`, items: qualities, allowed };
}

function profileBody(
  id: number,
  name: string,
  cutoff: unknown,
  items: readonly unknown[],
): Record<string, unknown> {
  return { id, name, upgradeAllowed: true, cutoff, items, minFormatScore: 0, formatItems: [] };
}

async function readProfiles(body: unknown): Promise<readonly QualityProfileRecord[]> {
  const client = readOnlyClient("sonarr", async (path) => {
    expect(path).toBe("qualityprofile");
    return body;
  });
  return readQualityProfiles(client, "sonarr");
}

/** A profile with one allowed quality per resolution named, cut off at `cutoff`. */
function ladderProfile(
  id: number,
  name: string,
  cutoff: number,
  allowed: readonly number[] = [cutoff],
): QualityProfileRecord {
  return {
    id,
    name,
    cutoff,
    items: allowed.map((resolution) => ({
      allowed: true,
      qualities: [{ id: resolution, resolution }],
    })),
  };
}

function choose(
  profiles: readonly QualityProfileRecord[],
  requested: Resolution,
  defaultName?: string,
): number | undefined {
  return chooseProfile(profiles.map(rateProfile), requested, defaultName)?.profile.id;
}

describe("readQualityProfiles", () => {
  it("reads the recorded profiles of both applications, emptied items and all", async () => {
    for (const application of ["sonarr", "radarr"] as const) {
      const body = await fixtureBody<readonly Record<string, unknown>[]>(
        application,
        "qualityprofile",
      );
      const client = readOnlyClient(application, async () => body);
      const profiles = await readQualityProfiles(client, application);

      expect(profiles.map((profile) => profile.id)).toEqual(body.map((profile) => profile.id));
      for (const profile of profiles) {
        expect(profile.name, application).toBeTypeOf("string");
        expect(profile.items).toEqual([]);
        // With no entries, nothing can say what the cutoff resolves to.
        expect(profileResolution(profile)).toBeUndefined();
      }
    }
  });

  it("reads single qualities and groups with their resolutions and allowed flags", async () => {
    const [profile] = await readProfiles([
      profileBody(3, "Example Web", 1001, [
        quality(4, 720),
        group(1001, [quality(3, 1080), quality(15, 1080)]),
        quality(19, 2160, false),
      ]),
    ]);

    expect(profile).toEqual({
      id: 3,
      name: "Example Web",
      cutoff: 1001,
      items: [
        { allowed: true, qualities: [{ id: 4, resolution: 720 }] },
        {
          groupId: 1001,
          allowed: true,
          qualities: [
            { id: 3, resolution: 1080 },
            { id: 15, resolution: 1080 },
          ],
        },
        { allowed: false, qualities: [{ id: 19, resolution: 2160 }] },
      ],
    });
  });

  it("keeps what it can read of a profile and drops only what it cannot", async () => {
    const profiles = await readProfiles([
      // No identifier: nothing could be added with it.
      { name: "Example Unidentified", cutoff: 1, items: [] },
      profileBody(5, "Example Odd", "not a number", [
        quality(4, 720),
        { quality: "not an object", allowed: true },
        "not an entry",
        { quality: { id: 9, resolution: "1080" }, items: [], allowed: true },
      ]),
      { id: 6, name: 42, cutoff: 4, items: "not a list" },
    ]);

    expect(profiles).toEqual([
      {
        id: 5,
        name: "Example Odd",
        cutoff: undefined,
        items: [
          { allowed: true, qualities: [{ id: 4, resolution: 720 }] },
          { allowed: true, qualities: [{ id: 9, resolution: undefined }] },
        ],
      },
      { id: 6, name: undefined, cutoff: 4, items: [] },
    ]);
    for (const profile of profiles) {
      expect(profileResolution(profile)).toBeUndefined();
    }
  });

  it("refuses a body that is not a list at all", async () => {
    await expect(readProfiles({ records: [] })).rejects.toBeInstanceOf(UpstreamError);
  });
});

describe("profileResolution", () => {
  it("is the resolution of a cutoff that names a single quality", async () => {
    const [profile] = await readProfiles([
      profileBody(1, "Example HD", 4, [quality(1, 480), quality(4, 720), quality(3, 1080)]),
    ]);

    expect(profileResolution(profile as QualityProfileRecord)).toBe("720p");
  });

  it("is the highest known resolution in a cutoff group", async () => {
    const [profile] = await readProfiles([
      profileBody(2, "Example Mixed", 1002, [
        quality(1, 480),
        group(1002, [quality(4, 720), quality(19, 2160), quality(3, 1080)]),
      ]),
    ]);

    expect(profileResolution(profile as QualityProfileRecord)).toBe("2160p");
  });

  it("ignores a group member whose resolution is unknown", async () => {
    const [profile] = await readProfiles([
      profileBody(2, "Example Mixed", 1002, [group(1002, [quality(4, 720), quality(30, 1440)])]),
    ]);

    expect(profileResolution(profile as QualityProfileRecord)).toBe("720p");
  });

  it("knows only the five accepted resolutions", () => {
    for (const pixels of [0, 360, 1440, 4320]) {
      expect(
        profileResolution(ladderProfile(1, "Example", pixels)),
        String(pixels),
      ).toBeUndefined();
    }
    for (const [pixels, resolution] of [
      [480, "480p"],
      [576, "576p"],
      [720, "720p"],
      [1080, "1080p"],
      [2160, "2160p"],
    ] as const) {
      expect(profileResolution(ladderProfile(1, "Example", pixels))).toBe(resolution);
    }
  });

  it("has none when the cutoff names nothing, or names a quality and a group alike", async () => {
    const [missing, ambiguous, unknownGroup] = await readProfiles([
      profileBody(1, "Example Missing", 99, [quality(4, 720)]),
      profileBody(2, "Example Ambiguous", 4, [quality(4, 720), group(4, [quality(3, 1080)])]),
      profileBody(3, "Example Unknown", 1003, [group(1003, [quality(30, 1440)])]),
    ]);

    expect(profileResolution(missing as QualityProfileRecord)).toBeUndefined();
    expect(profileResolution(ambiguous as QualityProfileRecord)).toBeUndefined();
    expect(profileResolution(unknownGroup as QualityProfileRecord)).toBeUndefined();
  });

  it("does not look for the cutoff inside a group's members", async () => {
    const [profile] = await readProfiles([
      profileBody(1, "Example Nested", 3, [group(1001, [quality(3, 1080)])]),
    ]);

    expect(profileResolution(profile as QualityProfileRecord)).toBeUndefined();
  });
});

describe("allowedQualityCount", () => {
  it("counts each allowed quality, every member of an allowed group included", async () => {
    const [profile] = await readProfiles([
      profileBody(1, "Example", 4, [
        quality(1, 480, false),
        quality(4, 720),
        group(1001, [quality(3, 1080), quality(15, 1080)]),
        group(1002, [quality(19, 2160)], false),
      ]),
    ]);

    expect(allowedQualityCount(profile as QualityProfileRecord)).toBe(3);
  });
});

describe("chooseProfile", () => {
  const hd = ladderProfile(1, "Example 720", 720);
  const fullHd = ladderProfile(2, "Example 1080", 1080);
  const ultraHd = ladderProfile(3, "Example 2160", 2160);

  it("chooses the profile whose resolution is the one asked for", () => {
    expect(choose([hd, fullHd, ultraHd], "2160p")).toBe(3);
    expect(choose([hd, fullHd, ultraHd], "720p")).toBe(1);
  });

  it("chooses the nearest resolution when none matches", () => {
    expect(choose([hd, fullHd], "2160p")).toBe(2);
    expect(choose([fullHd, ultraHd], "480p")).toBe(2);
  });

  it("chooses the lower of two equally near resolutions", () => {
    // 1080p sits one step from both 720p and 2160p on the ladder.
    expect(choose([ultraHd, hd], "1080p")).toBe(1);
    // 576p sits one step from both 480p and 720p.
    expect(choose([hd, ladderProfile(4, "Example 480", 480)], "576p")).toBe(4);
  });

  it("prefers the configured default among the candidates", () => {
    const other = ladderProfile(5, "Example Other 1080", 1080, [720, 1080]);
    const narrow = ladderProfile(6, "Example Narrow 1080", 1080);

    expect(choose([narrow, other], "1080p", "Example Other 1080")).toBe(5);
    expect(choose([narrow, other], "2160p", "Example Other 1080")).toBe(5);
  });

  it("ignores a configured default that is not a candidate", () => {
    expect(choose([hd, fullHd], "1080p", "Example 720")).toBe(2);
    expect(choose([hd, fullHd], "1080p", "Example Absent")).toBe(2);
  });

  it("then prefers the profile allowing the fewest qualities", () => {
    const wide = ladderProfile(7, "Example A Wide", 1080, [480, 720, 1080]);
    const narrow = ladderProfile(8, "Example Z Narrow", 1080, [720, 1080]);

    expect(choose([wide, narrow], "1080p")).toBe(8);
  });

  it("then the name that sorts first, by code unit and with no name last", () => {
    const lower = ladderProfile(9, "example", 1080);
    const upper = ladderProfile(10, "Example", 1080);
    const unnamed: QualityProfileRecord = { ...ladderProfile(11, "", 1080), name: undefined };

    // Code-unit order puts every capital before every lowercase letter, which
    // no locale-aware collation would.
    expect(choose([lower, unnamed, upper], "1080p")).toBe(10);
    expect(choose([unnamed, lower], "1080p")).toBe(9);
  });

  it("then the lowest identifier, whatever order the profiles arrive in", () => {
    const first = ladderProfile(12, "Example Same", 1080);
    const second = ladderProfile(13, "Example Same", 1080);

    expect(choose([second, first], "1080p")).toBe(12);
    expect(choose([first, second], "1080p")).toBe(12);
  });

  it("never chooses a profile with no resolution", () => {
    const unknown = ladderProfile(14, "Example Unknown", 1440);

    expect(choose([unknown, hd], "2160p")).toBe(1);
  });

  it("chooses nothing when no profile has a resolution", () => {
    expect(choose([], "1080p")).toBeUndefined();
    expect(
      choose([ladderProfile(15, "Example Unknown", 1440)], "1080p", "Example Unknown"),
    ).toBeUndefined();
  });

  it("resolves a cutoff group before choosing", async () => {
    const profiles = await readProfiles([
      profileBody(20, "Example Group 2160", 1001, [
        group(1001, [quality(3, 1080), quality(19, 2160)]),
      ]),
      profileBody(21, "Example Single 1080", 3, [quality(3, 1080)]),
    ]);

    expect(choose(profiles, "2160p")).toBe(20);
    expect(choose(profiles, "1080p")).toBe(21);
  });
});

/**
 * The same rules over the profiles newer instances genuinely report.
 *
 * Unlike the minimum's recordings, the `qualityprofile` fixtures captured at
 * Sonarr 4.0.20.3014 and Radarr 6.4.4.10685 carry every profile's populated
 * quality list, groups and all, and Radarr's include two profiles cut off at a
 * group. They are the evidence that the reader resolves the shape the
 * applications send, not only the shape their documentation describes.
 */
describe("quality profiles as newer instances record them", () => {
  const recorded = { sonarr: "4.0.20.3014", radarr: "6.4.4.10685" } as const;

  async function recordedBody(
    application: keyof typeof recorded,
  ): Promise<readonly Record<string, unknown>[]> {
    return fixtureBody<readonly Record<string, unknown>[], typeof application>(
      application,
      "qualityprofile",
      { version: recorded[application] },
    );
  }

  async function recordedProfiles(
    application: keyof typeof recorded,
    body?: readonly Record<string, unknown>[],
  ): Promise<readonly QualityProfileRecord[]> {
    const served = body ?? (await recordedBody(application));
    return readQualityProfiles(
      readOnlyClient(application, async () => served),
      application,
    );
  }

  function describeProfiles(profiles: readonly QualityProfileRecord[]) {
    return profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      cutoff: profile.cutoff,
      resolution: profileResolution(profile),
      allowed: allowedQualityCount(profile),
    }));
  }

  it("derives every Sonarr profile's resolution from its cutoff quality", async () => {
    // Each allowed group counts every quality it holds. "Max Ultra HD" allows
    // its WEB 1080p group while marking that group's members not allowed; the
    // applications decide by the group's own flag, and so does the count.
    expect(describeProfiles(await recordedProfiles("sonarr"))).toEqual([
      { id: 1, name: "Any", cutoff: 1, resolution: "480p", allowed: 14 },
      { id: 2, name: "SD", cutoff: 1, resolution: "480p", allowed: 6 },
      { id: 3, name: "HD-720p", cutoff: 4, resolution: "720p", allowed: 4 },
      { id: 4, name: "HD-1080p", cutoff: 9, resolution: "1080p", allowed: 4 },
      { id: 5, name: "Ultra-HD", cutoff: 19, resolution: "2160p", allowed: 4 },
      { id: 6, name: "HD - 720p/1080p", cutoff: 7, resolution: "1080p", allowed: 8 },
      { id: 8, name: "Max Ultra HD", cutoff: 21, resolution: "2160p", allowed: 10 },
    ]);
  });

  it("derives every Radarr profile's resolution, cutoff groups included", async () => {
    const profiles = await recordedProfiles("radarr");

    expect(describeProfiles(profiles)).toEqual([
      { id: 1, name: "Any", cutoff: 20, resolution: "480p", allowed: 24 },
      { id: 2, name: "SD", cutoff: 20, resolution: "480p", allowed: 12 },
      { id: 3, name: "HD-720p", cutoff: 6, resolution: "720p", allowed: 4 },
      { id: 4, name: "HD-1080p", cutoff: 7, resolution: "1080p", allowed: 4 },
      { id: 5, name: "Ultra-HD", cutoff: 19, resolution: "2160p", allowed: 4 },
      { id: 6, name: "HD - 720p/1080p", cutoff: 7, resolution: "1080p", allowed: 8 },
      { id: 7, name: "Small 1080p", cutoff: 1002, resolution: "1080p", allowed: 3 },
      { id: 8, name: "WEB/HDTV 4k", cutoff: 1003, resolution: "2160p", allowed: 6 },
      { id: 9, name: "Max Ultra HD", cutoff: 31, resolution: "2160p", allowed: 10 },
    ]);
    // The two cutoffs past 1000 name a group of the profile's own, which is
    // where their resolution came from.
    for (const id of [7, 8]) {
      const profile = profiles.find((candidate) => candidate.id === id);
      const groups = profile?.items.filter((item) => item.groupId === profile.cutoff);
      expect(groups, String(id)).toHaveLength(1);
      expect(groups?.[0]?.qualities.length, String(id)).toBeGreaterThan(1);
    }
  });

  it("chooses a Sonarr profile for every resolution, with and without a default", async () => {
    const profiles = await recordedProfiles("sonarr");
    const cases: readonly (readonly [Resolution, string | undefined, number])[] = [
      // "SD" allows fewer qualities than "Any".
      ["480p", undefined, 2],
      ["480p", "Any", 1],
      // No profile is cut off at 576p; 480p and 720p are equally near, and
      // the lower wins.
      ["576p", undefined, 2],
      ["576p", "Any", 1],
      ["720p", undefined, 3],
      ["720p", "HD-1080p", 3],
      // "HD-1080p" allows fewer qualities than "HD - 720p/1080p".
      ["1080p", undefined, 4],
      ["1080p", "HD - 720p/1080p", 6],
      ["1080p", "Ultra-HD", 4],
      // "Ultra-HD" allows fewer qualities than "Max Ultra HD".
      ["2160p", undefined, 5],
      ["2160p", "Max Ultra HD", 8],
      ["2160p", "HD-1080p", 5],
    ];

    for (const [resolution, defaultName, expected] of cases) {
      expect(choose(profiles, resolution, defaultName), `${resolution} ${defaultName}`).toBe(
        expected,
      );
    }
  });

  it("chooses a Radarr profile for every resolution, with and without a default", async () => {
    const profiles = await recordedProfiles("radarr");
    const cases: readonly (readonly [Resolution, string | undefined, number])[] = [
      ["480p", undefined, 2],
      ["480p", "Any", 1],
      ["576p", undefined, 2],
      ["576p", "Any", 1],
      ["720p", undefined, 3],
      ["720p", "Small 1080p", 3],
      // "Small 1080p", cut off at its WEB 1080p group, allows the fewest.
      ["1080p", undefined, 7],
      ["1080p", "HD-1080p", 4],
      ["1080p", "HD - 720p/1080p", 6],
      ["1080p", "Ultra-HD", 7],
      ["2160p", undefined, 5],
      ["2160p", "WEB/HDTV 4k", 8],
      ["2160p", "Max Ultra HD", 9],
      ["2160p", "Small 1080p", 5],
    ];

    for (const [resolution, defaultName, expected] of cases) {
      expect(choose(profiles, resolution, defaultName), `${resolution} ${defaultName}`).toBe(
        expected,
      );
    }
  });

  it("never chooses a recorded profile cut off at a quality with no known resolution", async () => {
    // Radarr records its pre-release qualities, CAM among them, with a
    // resolution of 0. Cutting both 480p profiles off there leaves them with
    // no resolution, so a request for 480p reaches the nearest that has one,
    // even past a configured default.
    const body = await recordedBody("radarr");
    const cam = 25;
    const edited = body.map((profile) =>
      profile.id === 1 || profile.id === 2 ? { ...profile, cutoff: cam } : profile,
    );
    const profiles = await recordedProfiles("radarr", edited);

    expect(profiles.filter((profile) => profileResolution(profile) === undefined)).toHaveLength(2);
    expect(choose(profiles, "480p")).toBe(3);
    expect(choose(profiles, "480p", "Any")).toBe(3);
    expect(choose(profiles, "576p", "SD")).toBe(3);
  });
});
