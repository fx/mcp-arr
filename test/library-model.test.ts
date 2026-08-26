import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  configurationPointer,
  configurationPointerKinds,
  isMediaApplication,
  mediaApplications,
  mediaKinds,
  mediaRef,
  mediaRefKey,
  seasonRef,
  wantedReasons,
} from "../src/adapters/library/model.js";
import {
  count,
  endOf,
  flag,
  languageNames,
  mediaInfo,
  parseUpstream,
  text,
  textList,
} from "../src/adapters/library/parse.js";
import { radarrRoutes } from "../src/adapters/library/radarr.js";
import { sonarrRoutes } from "../src/adapters/library/sonarr.js";
import { applicationIds } from "../src/applications.js";
import { isUpstreamError } from "../src/http/errors.js";

describe("media identities", () => {
  it("qualifies every identity with the application that owns it", () => {
    const sonarrSeries = mediaRef("sonarr", "series", 12);
    const radarrMovie = mediaRef("radarr", "movie", 12);

    expect(sonarrSeries).toEqual({ application: "sonarr", kind: "series", id: "12" });
    // The same number in two applications is two different objects, and the
    // key never collapses them.
    expect(mediaRefKey(sonarrSeries)).toBe("sonarr:series:12");
    expect(mediaRefKey(radarrMovie)).toBe("radarr:movie:12");
    expect(mediaRefKey(sonarrSeries)).not.toBe(mediaRefKey(radarrMovie));
    expect(mediaRefKey(mediaRef("sonarr", "episode", 12))).not.toBe(mediaRefKey(sonarrSeries));
  });

  it("gives a season the composite identity upstream does not", () => {
    expect(seasonRef("sonarr", 12, 2)).toEqual({
      application: "sonarr",
      kind: "season",
      id: "12/2",
    });
    expect(mediaRefKey(seasonRef("sonarr", 12, 2))).toBe("sonarr:season:12/2");
  });

  it("points at configuration objects by their upstream identifier", () => {
    expect(configurationPointer("radarr", "quality_profile", 2)).toEqual({
      application: "radarr",
      kind: "quality_profile",
      id: "2",
    });
    expect(configurationPointerKinds).toEqual(["quality_profile", "root_folder", "tag"]);
  });

  it("names only the two applications that own a library", () => {
    expect(mediaApplications).toEqual(["sonarr", "radarr"]);
    expect(applicationIds.filter(isMediaApplication)).toEqual(["sonarr", "radarr"]);
    expect(isMediaApplication("prowlarr")).toBe(false);
    expect(mediaKinds).toContain("episode_file");
    expect(wantedReasons).toEqual(["missing", "cutoff_unmet"]);
  });
});

describe("upstream routes", () => {
  it("reads only from routes that cannot change anything", () => {
    expect(Object.values(sonarrRoutes)).toEqual([
      "series",
      "series/lookup",
      "episode",
      "episodefile",
      "wanted/missing",
      "wanted/cutoff",
      "calendar",
    ]);
    expect(Object.values(radarrRoutes)).toEqual([
      "movie",
      "movie/lookup",
      "collection",
      "moviefile",
      "wanted/missing",
      "wanted/cutoff",
      "calendar",
    ]);
  });
});

describe("upstream value normalization", () => {
  it("treats null, absent, and blank upstream values as absent", () => {
    expect(text(null)).toBeUndefined();
    expect(text(undefined)).toBeUndefined();
    expect(text("   ")).toBeUndefined();
    expect(text("  Example  ")).toBe("Example");

    expect(count(null)).toBeUndefined();
    expect(count(Number.NaN)).toBeUndefined();
    expect(count(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(count(0)).toBe(0);

    expect(flag(null)).toBeUndefined();
    expect(flag(false)).toBe(false);

    expect(textList(null)).toBeUndefined();
    expect(textList([])).toBeUndefined();
    expect(textList([" ", null])).toBeUndefined();
    expect(textList(["Drama", "  ", "Mystery"])).toEqual(["Drama", "Mystery"]);

    expect(languageNames(null)).toBeUndefined();
    expect(languageNames([{ name: "English" }, { name: null }])).toEqual(["English"]);

    expect(mediaInfo(null)).toBeUndefined();
    expect(mediaInfo({ videoCodec: "x264", audioChannels: 2 })).toEqual({
      videoCodec: "x264",
      audioCodec: undefined,
      audioChannels: 2,
      resolution: undefined,
      runTime: undefined,
    });
  });

  it("derives an event end only when both the start and a runtime are usable", () => {
    expect(endOf("2019-04-01T20:00:00Z", 45)).toBe("2019-04-01T20:45:00.000Z");
    expect(endOf(undefined, 45)).toBeUndefined();
    expect(endOf("2019-04-01T20:00:00Z", undefined)).toBeUndefined();
    expect(endOf("2019-04-01T20:00:00Z", 0)).toBeUndefined();
    expect(endOf("not a date", 45)).toBeUndefined();
  });

  it("reports an unmappable payload as a redacted upstream failure", () => {
    const schema = z.array(z.object({ id: z.number() }));

    expect(parseUpstream(schema, [{ id: 1 }], "sonarr", "series")).toEqual([{ id: 1 }]);

    let thrown: unknown;
    try {
      parseUpstream(schema, { secretField: "an unexpected body" }, "sonarr", "series");
    } catch (error) {
      thrown = error;
    }

    expect(isUpstreamError(thrown)).toBe(true);
    expect(JSON.stringify(thrown)).not.toContain("an unexpected body");
  });
});
