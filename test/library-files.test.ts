import { beforeAll, describe, expect, it } from "vitest";
import type { UpstreamResource } from "../src/adapters/library/changes.js";
import {
  deleteFileResource,
  deleteRecordResource,
  type FileResource,
  fileParentId,
  fileResourcePath,
  fileState,
  matchOption,
  readFileResource,
  readLanguageOptions,
  readQualityOptions,
  recordDeletionQuery,
  recordDeletionState,
  rewriteFileResource,
} from "../src/adapters/library/files.js";
import { fixtureBody, jsonResponse, libraryHarness } from "./support/library.js";

/**
 * The media-file and deletion adapters, exercised against the recorded
 * fixtures.
 *
 * The rewriting functions are pure and are called directly; everything that
 * reaches an instance goes through the real upstream client with an injected
 * fetch, so the assertions cover the method, route, and query a real instance
 * would receive.
 */

const fixtures: Record<string, unknown> = {};

beforeAll(async () => {
  for (const route of ["episodefile", "qualitydefinition", "language"]) {
    fixtures[`sonarr/${route}`] = await fixtureBody("sonarr", route);
  }
  for (const route of ["moviefile", "qualitydefinition", "language"]) {
    fixtures[`radarr/${route}`] = await fixtureBody("radarr", route);
  }
});

function body(application: "sonarr" | "radarr", route: string): unknown {
  const value = fixtures[`${application}/${route}`];
  if (value === undefined) {
    throw new Error(`Missing loaded fixture for ${application} ${route}`);
  }
  return value;
}

function firstFile(application: "sonarr" | "radarr", route: string): FileResource {
  const file = (body(application, route) as readonly FileResource[])[0];
  if (file === undefined) {
    throw new Error(`The recorded ${application} ${route} fixture is empty`);
  }
  return file;
}

describe("media file reads and rewrites", () => {
  it("reads one file from the route its kind lives at", async () => {
    const harness = libraryHarness("sonarr", () =>
      jsonResponse(firstFile("sonarr", "episodefile")),
    );
    const file = await readFileResource(harness.client, "sonarr", "episode_file", 2001);

    expect(harness.calls[0]?.url.pathname).toBe("/api/v3/episodefile/2001");
    expect(harness.calls[0]?.init.method).toBe("GET");
    expect(fileParentId("episode_file", file)).toBe(12);
    expect(fileResourcePath("movie_file", 501)).toBe("moviefile/501");
  });

  it("groups a file by the parent the instance reports rather than by its kind", () => {
    const file = firstFile("radarr", "moviefile");

    expect(fileParentId("movie_file", file)).toBe(8);
    // A file whose parent the instance did not report cannot be grouped at all,
    // which the tool layer turns into a per-file failure rather than a guess.
    expect(fileParentId("movie_file", { ...file, movieId: 0 })).toBeUndefined();
  });

  it("fingerprints exactly what a file mutation depends on", () => {
    const file = firstFile("sonarr", "episodefile");
    const state = fileState("episode_file", file);

    expect(state).toEqual({
      id: 2001,
      parent: 12,
      seasonNumber: 1,
      relativePath: "Season 01/Example Series - S01E01 - Example Pilot Bluray-1080p.mkv",
      quality: "Bluray-1080p",
      languages: [1],
      releaseGroup: "EXAMPLEGRP",
    });
    // A field nothing here depends on cannot move the fingerprint.
    expect(fileState("episode_file", { ...file, customFormatScore: 99 })).toEqual(state);
  });

  it("writes a quality over a file and keeps its revision and unknown fields", async () => {
    const options = await optionsFor("sonarr", "qualitydefinition");
    const wanted = matchOption(options, "webdl-720p");
    if (wanted === undefined) {
      throw new Error("The recorded quality definitions offer no WEBDL-720p");
    }

    const rewritten = rewriteFileResource(firstFile("sonarr", "episodefile"), { quality: wanted });
    if (rewritten.status !== "ok") {
      throw new Error("Expected a usable rewrite");
    }

    expect(rewritten.changed).toBe(true);
    expect(rewritten.resource).toMatchObject({
      id: 2001,
      quality: {
        quality: { id: 4, name: "WEBDL-720p" },
        revision: { version: 1, real: 0, isRepack: false },
      },
      qualityCutoffNotMet: false,
    });
  });

  it("reports a file already in the requested state as unchanged", () => {
    const rewritten = rewriteFileResource(firstFile("sonarr", "episodefile"), {
      releaseGroup: "EXAMPLEGRP",
    });

    expect(rewritten).toMatchObject({ status: "ok", changed: false });
  });

  it("matches an option by name without guessing a nearest one", async () => {
    const languages = await optionsFor("sonarr", "language");

    expect(matchOption(languages, " english ")).toMatchObject({ id: 1, name: "English" });
    expect(matchOption(languages, "Engl")).toBeUndefined();
  });

  async function optionsFor(application: "sonarr" | "radarr", route: string) {
    const harness = libraryHarness(application, () => jsonResponse(body(application, route)));
    return route === "language"
      ? readLanguageOptions(harness.client, application)
      : readQualityOptions(harness.client, application);
  }
});

describe("deletion", () => {
  it("spells each application's own deletion choices and always sends both", () => {
    expect(recordDeletionQuery("sonarr", { deleteFiles: false, addImportListExclusion: true })) //
      .toEqual({ deleteFiles: false, addImportListExclusion: true });
    expect(recordDeletionQuery("radarr", { deleteFiles: true, addImportListExclusion: false })) //
      .toEqual({ deleteFiles: true, addImportExclusion: false });
  });

  it("sends a record deletion with its choices in the query", async () => {
    const harness = libraryHarness("sonarr", () => new Response(null, { status: 200 }));

    await deleteRecordResource(
      harness.client,
      "series/12",
      recordDeletionQuery("sonarr", { deleteFiles: false, addImportListExclusion: false }),
    );

    expect(harness.calls[0]?.init.method).toBe("DELETE");
    expect(harness.calls[0]?.url.pathname).toBe("/api/v3/series/12");
    expect(harness.calls[0]?.url.searchParams.get("deleteFiles")).toBe("false");
    // An answer with no content at all is what these deletions actually return.
    expect(harness.calls[0]?.init.body).toBeUndefined();
  });

  it("sends a file deletion to the file's own route", async () => {
    const harness = libraryHarness("radarr", () => new Response(null, { status: 200 }));

    await deleteFileResource(harness.client, "movie_file", 501);

    expect(harness.calls[0]?.init.method).toBe("DELETE");
    expect(harness.calls[0]?.url.pathname).toBe("/api/v3/moviefile/501");
  });

  it("fingerprints what a deletion plan discloses about the record", () => {
    const resource: UpstreamResource = {
      id: 14,
      title: "Example Retired Series",
      path: "/media/example/series/Example Retired Series",
      statistics: { episodeFileCount: 2, sizeOnDisk: 1024 },
    };

    expect(recordDeletionState(resource)).toEqual({
      id: 14,
      title: "Example Retired Series",
      path: "/media/example/series/Example Retired Series",
      hasFile: undefined,
      fileCount: 2,
      sizeOnDisk: 1024,
    });
  });
});
