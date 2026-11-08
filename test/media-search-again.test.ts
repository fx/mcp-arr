import { beforeEach, describe, expect, it } from "vitest";
import { createManualClock, type ManualClock } from "../src/state/clock.js";
import { createDownloadClaims } from "../src/state/download-claims.js";
import type { SearchAgainResult } from "../src/tools/media/schemas.js";
import { callMediaTool, createMediaContext, noMediaDefaults } from "./support/media.js";
import { type ActivityInstances, createActivityInstances } from "./support/media-activity.js";
import { allApplicationsEnvironment } from "./support/tool-context.js";

/**
 * `media_search_again` over the recorded library.
 *
 * Recorded, series 100001 (record 12) has S01E01 and S02E02 on disk and lacks
 * S02E01, which aired on 2026-09-30 and is not monitored. Movie 200001 has its
 * file, and movie 200002 has none and is not yet released.
 */

let instances: ActivityInstances;
let clock: ManualClock;

beforeEach(async () => {
  instances = await createActivityInstances();
  clock = createManualClock(Date.parse("2026-11-07T00:00:00Z"));
});

function search(input: unknown) {
  return callMediaTool<SearchAgainResult>(
    "media_search_again",
    createMediaContext(instances, noMediaDefaults, allApplicationsEnvironment, {
      claims: createDownloadClaims(),
      clock,
    }),
    input,
  );
}

function commands() {
  return instances.mutations().map((request) => request.body);
}

/** One recorded episode of series 100001, to change in place. */
function recorded(id: number): Record<string, unknown> {
  const found = instances.state("sonarr").episodes.find((candidate) => candidate.id === id);
  if (found === undefined) {
    throw new Error(`No episode ${id}`);
  }
  return found;
}

describe("media_search_again", () => {
  it("searches for exactly the released, monitored episodes with no file", async () => {
    recorded(1003).monitored = true;

    const { content, summary } = await search({ kind: "series", id: 100_001 });

    expect(content).toEqual({
      kind: "series",
      id: 100_001,
      title: "Example Series",
      searched: 1,
      warnings: [],
      errors: [],
    });
    expect(commands()).toEqual([{ name: "EpisodeSearch", episodeIds: [1003] }]);
    expect(summary).toBe("media_search_again: searched for 1 in series 100001");
  });

  it("narrows to one season, and to one episode of it", async () => {
    recorded(1003).monitored = true;
    recorded(1004).hasFile = false;
    recorded(1001).hasFile = false;

    expect((await search({ kind: "series", id: 100_001, season: 2 })).content.searched).toBe(2);
    expect(
      (await search({ kind: "series", id: 100_001, season: 2, episode: 2 })).content,
    ).toMatchObject({
      season: 2,
      episode: 2,
      searched: 1,
    });
    expect(commands()).toEqual([
      { name: "EpisodeSearch", episodeIds: [1003, 1004] },
      { name: "EpisodeSearch", episodeIds: [1004] },
    ]);
  });

  it("skips what is not monitored in a series or season, but not an episode asked for", async () => {
    // Season 2 is unmonitored as a whole, and both its episodes lack a file.
    recorded(1004).monitored = false;
    recorded(1004).hasFile = false;

    expect((await search({ kind: "series", id: 100_001 })).content.searched).toBe(0);
    expect((await search({ kind: "series", id: 100_001, season: 2 })).content.searched).toBe(0);
    expect(instances.mutations()).toEqual([]);

    // Naming the episode asks for it, monitored or not.
    expect(
      (await search({ kind: "series", id: 100_001, season: 2, episode: 1 })).content.searched,
    ).toBe(1);
    // A series that is not monitored is skipped too, however its episodes are.
    recorded(1003).monitored = true;
    const series = instances.state("sonarr").titles.find((record) => record.id === 12);
    if (series !== undefined) {
      series.monitored = false;
    }
    expect((await search({ kind: "series", id: 100_001 })).content.searched).toBe(0);
    expect(commands()).toEqual([{ name: "EpisodeSearch", episodeIds: [1003] }]);
  });

  it("does not search an unaired episode even when it is asked for by number", async () => {
    clock.set(Date.parse("2026-09-01T00:00:00Z"));

    expect(
      (await search({ kind: "series", id: 100_001, season: 2, episode: 1 })).content.searched,
    ).toBe(0);
    expect(instances.mutations()).toEqual([]);
  });

  it("sends nothing when nothing in scope is missing", async () => {
    const { content } = await search({ kind: "series", id: 100_001, season: 1 });

    expect(content.searched).toBe(0);
    expect(instances.mutations()).toEqual([]);
  });

  it("does not search an episode not yet aired, or one whose record does not say it lacks a file", async () => {
    recorded(1003).monitored = true;
    clock.set(Date.parse("2026-09-01T00:00:00Z"));
    expect((await search({ kind: "series", id: 100_001 })).content.searched).toBe(0);

    clock.set(Date.parse("2026-11-07T00:00:00Z"));
    const episode = instances.state("sonarr").episodes.find((candidate) => candidate.id === 1003);
    if (episode !== undefined) {
      delete episode.hasFile;
    }
    expect((await search({ kind: "series", id: 100_001 })).content.searched).toBe(0);
    expect(instances.mutations()).toEqual([]);
  });

  it("reports a season or episode the series does not have", async () => {
    const { content } = await search({ kind: "series", id: 100_001, season: 9 });

    expect(content.searched).toBe(0);
    expect(content.warnings).toEqual([
      "this series has no such season or episode, so nothing was searched for",
    ]);
    expect(instances.mutations()).toEqual([]);
  });

  it("searches for a released movie with no file, and not for one that has it or is unreleased", async () => {
    const movie = instances.state("radarr").titles.find((record) => record.id === 9);
    expect((await search({ kind: "movie", id: 200_002 })).content.searched).toBe(0);
    expect((await search({ kind: "movie", id: 200_001 })).content.searched).toBe(0);
    expect(instances.mutations()).toEqual([]);

    if (movie !== undefined) {
      movie.isAvailable = true;
    }
    expect((await search({ kind: "movie", id: 200_002 })).content).toEqual({
      kind: "movie",
      id: 200_002,
      title: "Example Awaited Movie",
      searched: 1,
      warnings: [],
      errors: [],
    });
    expect(commands()).toEqual([{ name: "MoviesSearch", movieIds: [9] }]);

    // A movie the library does not monitor is not searched for.
    if (movie !== undefined) {
      movie.monitored = false;
    }
    expect((await search({ kind: "movie", id: 200_002 })).content.searched).toBe(0);
    expect(commands()).toEqual([{ name: "MoviesSearch", movieIds: [9] }]);
  });

  it("refuses a title not in the library with conflict, pointing to media_add", async () => {
    const { content, result } = await search({ kind: "series", id: 999_999 });

    expect(result.isError).toBe(true);
    expect(content.errors).toEqual([
      expect.objectContaining({ code: "conflict", remediation: "Add it with media_add first." }),
    ]);
    expect(instances.mutations()).toEqual([]);
  });

  it("refuses an episode without its season, and a season for a movie", async () => {
    for (const input of [
      { kind: "series", id: 100_001, episode: 1 },
      { kind: "movie", id: 200_001, season: 1 },
      { kind: "series", id: 100_001, season: -1 },
      { kind: "series", id: 100_001, season: 1, episode: 0 },
    ]) {
      const { content } = await search(input);
      expect(
        content.errors.map((error) => error.code),
        JSON.stringify(input),
      ).toEqual(["invalid_input"]);
    }
    expect(instances.requests).toEqual([]);
  });

  it("reports a search the instance refused", async () => {
    instances.intercept((request) =>
      request.route === "command" ? new Response(JSON.stringify([]), { status: 400 }) : undefined,
    );
    recorded(1003).monitored = true;

    const { content, result } = await search({ kind: "series", id: 100_001 });

    expect(result.isError).toBe(true);
    expect(content.errors.map((error) => error.code)).toEqual(["upstream_rejection"]);
  });
});
