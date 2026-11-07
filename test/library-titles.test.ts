import { describe, expect, it } from "vitest";
import {
  readEpisodeStates,
  readFileResolutions,
  readLibraryTitleByExternalId,
  readLibraryTitles,
} from "../src/adapters/library/titles.js";
import { fixtureBody, jsonResponse, libraryHarness, without } from "./support/library.js";

/**
 * The narrow library reads the `media` toolset decides over, against the
 * recorded library, episode, and file fixtures.
 *
 * Whether an instance honours the metadata-identifier filter on `series` and
 * `movie` has not been captured, so each lookup is shown answering the same
 * way whether the instance filtered the list or answered all of it.
 */

type UpstreamRecord = Record<string, unknown>;

describe("readLibraryTitleByExternalId", () => {
  it("asks for a series by TVDB id and matches it locally when the whole library comes back", async () => {
    const series = await fixtureBody<UpstreamRecord[]>("sonarr", "series");
    const { client, calls } = libraryHarness("sonarr", () => jsonResponse(series));

    const found = await readLibraryTitleByExternalId(client, "sonarr", 100_002);

    expect(calls[0]?.url.pathname).toMatch(/\/api\/v3\/series$/u);
    expect(calls[0]?.url.searchParams.get("tvdbId")).toBe("100002");
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
  });

  it("finds a movie by TMDB id from a filtered answer", async () => {
    const movies = await fixtureBody<UpstreamRecord[]>("radarr", "movie");
    const { client, calls } = libraryHarness("radarr", (call) =>
      jsonResponse(
        movies.filter((movie) => String(movie.tmdbId) === call.url.searchParams.get("tmdbId")),
      ),
    );

    const found = await readLibraryTitleByExternalId(client, "radarr", 200_002);

    expect(calls[0]?.url.searchParams.get("tmdbId")).toBe("200002");
    expect(found).toMatchObject({
      id: 9,
      externalId: 200_002,
      hasFile: false,
      isAvailable: false,
      releaseDates: ["2026-11-20T00:00:00Z"],
    });
  });

  it("answers undefined for a title not in the library, filtered or not", async () => {
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
});

describe("readFileResolutions", () => {
  it("reads the resolution of every episode file of a series", async () => {
    const files = await fixtureBody<UpstreamRecord[]>("sonarr", "episodefile");
    const { client, calls } = libraryHarness("sonarr", () => jsonResponse(files));

    expect(await readFileResolutions(client, "sonarr", 12)).toEqual([1080, 720]);
    expect(calls[0]?.url.pathname).toMatch(/\/episodefile$/u);
    expect(calls[0]?.url.searchParams.get("seriesId")).toBe("12");
  });

  it("reads the resolution of a movie's file", async () => {
    const files = await fixtureBody<UpstreamRecord[]>("radarr", "moviefile");
    const { client, calls } = libraryHarness("radarr", () => jsonResponse(files));

    expect(await readFileResolutions(client, "radarr", 8)).toEqual([1080]);
    expect(calls[0]?.url.searchParams.get("movieId")).toBe("8");
  });

  it("contributes nothing for a file whose quality names no resolution", async () => {
    const files = await fixtureBody<UpstreamRecord[]>("radarr", "moviefile");
    const unknown = files.map((file) => ({
      ...file,
      quality: { quality: { id: 0, name: "Unknown", resolution: 0 } },
    }));
    const { client } = libraryHarness("radarr", () => jsonResponse(unknown));

    expect(await readFileResolutions(client, "radarr", 8)).toEqual([]);
  });
});
