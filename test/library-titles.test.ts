import { describe, expect, it } from "vitest";
import {
  readEpisodeFileResolutions,
  readEpisodeStates,
  readLibraryTitleByExternalId,
  readLibraryTitleById,
  readLibraryTitles,
} from "../src/adapters/library/titles.js";
import { fixtureBody, jsonResponse, libraryHarness, without } from "./support/library.js";

/**
 * The narrow library reads the `media` toolset decides over, against the
 * recorded library, episode, and file fixtures.
 *
 * A title is found by reading the whole library list, the route the recorded
 * fixtures cover, and matching its identifier here.
 */

type UpstreamRecord = Record<string, unknown>;

describe("readLibraryTitleByExternalId", () => {
  it("reads the whole series list and matches the TVDB id locally", async () => {
    const series = await fixtureBody<UpstreamRecord[]>("sonarr", "series");
    const { client, calls } = libraryHarness("sonarr", () => jsonResponse(series));

    const found = await readLibraryTitleByExternalId(client, "sonarr", 100_002);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.pathname).toMatch(/\/api\/v3\/series$/u);
    // The filtered route is not used: which version honours it is not established.
    expect([...(calls[0]?.url.searchParams.keys() ?? [])]).toEqual([]);
    expect(found).toMatchObject({
      application: "sonarr",
      id: 13,
      externalId: 100_002,
      title: "Example Anime",
      monitored: true,
      qualityProfileId: 2,
    });
    // A series record says nothing about a file of its own.
    expect(found?.hasFile).toBeUndefined();
    expect(found?.fileResolution).toBeUndefined();
  });

  it("reads a movie's file state, release dates, and file resolution from its list record", async () => {
    const movies = await fixtureBody<UpstreamRecord[]>("radarr", "movie");
    const { client } = libraryHarness("radarr", () => jsonResponse(movies));

    expect(await readLibraryTitleByExternalId(client, "radarr", 200_001)).toMatchObject({
      id: 8,
      hasFile: true,
      isAvailable: true,
      fileResolution: 1080,
    });
    expect(await readLibraryTitleByExternalId(client, "radarr", 200_002)).toMatchObject({
      id: 9,
      hasFile: false,
      isAvailable: false,
      releaseDates: ["2026-11-20T00:00:00Z"],
      fileResolution: undefined,
    });
  });

  it("answers undefined for a title not in the library", async () => {
    const movies = await fixtureBody<UpstreamRecord[]>("radarr", "movie");
    for (const answer of [movies, []]) {
      const { client } = libraryHarness("radarr", () => jsonResponse(answer));
      expect(await readLibraryTitleByExternalId(client, "radarr", 999_999)).toBeUndefined();
    }
  });

  it("keeps a movie's file flag absent where the record does not state it", async () => {
    const movies = await fixtureBody<UpstreamRecord[]>("radarr", "movie");
    const silent = movies.map((movie) => without(movie, "hasFile"));
    const { client } = libraryHarness("radarr", () => jsonResponse(silent));

    const found = await readLibraryTitleByExternalId(client, "radarr", 200_001);

    expect(found?.id).toBe(8);
    expect(found?.hasFile).toBeUndefined();
  });

  it("refuses an answer that is not a list of records", async () => {
    const { client } = libraryHarness("sonarr", () => jsonResponse({ id: 12 }));
    await expect(readLibraryTitleByExternalId(client, "sonarr", 100_001)).rejects.toMatchObject({
      kind: "unexpected-response",
    });
  });
});

describe("readLibraryTitleById", () => {
  it("finds a record by its library identifier from the same list", async () => {
    const movies = await fixtureBody<UpstreamRecord[]>("radarr", "movie");
    const { client, calls } = libraryHarness("radarr", () => jsonResponse(movies));

    expect((await readLibraryTitleById(client, "radarr", 9))?.externalId).toBe(200_002);
    expect(await readLibraryTitleById(client, "radarr", 99)).toBeUndefined();
    expect(calls.map((call) => call.url.pathname.replace(/^.*\/api\/v3\//u, ""))).toEqual([
      "movie",
      "movie",
    ]);
  });
});

describe("readLibraryTitles", () => {
  it("reads every series with its TVDB id", async () => {
    const series = await fixtureBody<UpstreamRecord[]>("sonarr", "series");
    const { client } = libraryHarness("sonarr", () => jsonResponse(series));

    const titles = await readLibraryTitles(client, "sonarr");

    expect(titles.map((title) => [title.id, title.externalId])).toEqual([
      [12, 100_001],
      [13, 100_002],
      [14, 100_003],
    ]);
  });
});

describe("readEpisodeStates", () => {
  it("reads one series' episodes and keeps every file flag as stated", async () => {
    const episodes = await fixtureBody<UpstreamRecord[]>("sonarr", "episode");
    const answer = episodes.map((episode) =>
      episode.id === 1004 ? without(episode, "hasFile") : episode,
    );
    const { client, calls } = libraryHarness("sonarr", () => jsonResponse(answer));

    const states = await readEpisodeStates(client, 12);

    expect(calls[0]?.url.searchParams.get("seriesId")).toBe("12");
    // Episode 1002 belongs to series 13 and is left out.
    expect(states).toEqual([
      {
        id: 1001,
        seasonNumber: 1,
        episodeNumber: 1,
        hasFile: true,
        monitored: true,
        airDateUtc: "2019-04-01T20:00:00Z",
      },
      {
        id: 1003,
        seasonNumber: 2,
        episodeNumber: 1,
        hasFile: false,
        monitored: false,
        airDateUtc: "2026-09-30T20:00:00Z",
      },
      {
        id: 1004,
        seasonNumber: 2,
        episodeNumber: 2,
        hasFile: undefined,
        monitored: true,
        airDateUtc: "2020-05-10T20:00:00Z",
      },
    ]);
  });

  it("narrows to one season locally", async () => {
    const episodes = await fixtureBody<UpstreamRecord[]>("sonarr", "episode");
    const { client } = libraryHarness("sonarr", () => jsonResponse(episodes));

    const states = await readEpisodeStates(client, 12, 2);

    expect(states.map((state) => state.id)).toEqual([1003, 1004]);
  });

  it("fails the read on an episode that names no series, rather than counting it in", async () => {
    // An instance that ignored the scope answers with every series' episodes;
    // one that does not say whose it is could be any of them.
    const episodes = await fixtureBody<UpstreamRecord[]>("sonarr", "episode");
    for (const parentless of [
      without(episodes[0] as UpstreamRecord, "seriesId"),
      { ...episodes[0], seriesId: null },
    ]) {
      const { client } = libraryHarness("sonarr", () => jsonResponse([...episodes, parentless]));

      await expect(readEpisodeStates(client, 12)).rejects.toMatchObject({
        kind: "unexpected-response",
      });
    }
  });
});

describe("readEpisodeFileResolutions", () => {
  it("reads the resolution of every episode file of a series", async () => {
    const files = await fixtureBody<UpstreamRecord[]>("sonarr", "episodefile");
    const { client, calls } = libraryHarness("sonarr", () => jsonResponse(files));

    expect(await readEpisodeFileResolutions(client, 12)).toEqual([1080, 720]);
    expect(calls[0]?.url.pathname).toMatch(/\/episodefile$/u);
    expect(calls[0]?.url.searchParams.get("seriesId")).toBe("12");
  });

  it("contributes nothing for a file whose quality names no resolution", async () => {
    const files = await fixtureBody<UpstreamRecord[]>("sonarr", "episodefile");
    const unknown = files.map((file) => ({
      ...file,
      quality: { quality: { id: 0, name: "Unknown", resolution: 0 } },
    }));
    const { client } = libraryHarness("sonarr", () => jsonResponse(unknown));

    expect(await readEpisodeFileResolutions(client, 12)).toEqual([]);
  });

  it("leaves out another series' file and fails the read on one that names none", async () => {
    const files = await fixtureBody<UpstreamRecord[]>("sonarr", "episodefile");
    const other = { ...files[0], seriesId: 13 };
    const { client } = libraryHarness("sonarr", () => jsonResponse([...files, other]));
    expect(await readEpisodeFileResolutions(client, 12)).toEqual([1080, 720]);

    const parentless = without(files[0] as UpstreamRecord, "seriesId");
    const failing = libraryHarness("sonarr", () => jsonResponse([...files, parentless]));
    await expect(readEpisodeFileResolutions(failing.client, 12)).rejects.toMatchObject({
      kind: "unexpected-response",
    });
  });
});
