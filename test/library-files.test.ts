import { beforeAll, describe, expect, it } from "vitest";
import type { UpstreamResource } from "../src/adapters/library/changes.js";
import {
  allowedCommandNames,
  commandWorkflows,
  deleteFileResource,
  deleteRecordResource,
  type FileResource,
  fileParentId,
  fileResourcePath,
  fileState,
  matchOption,
  moveCommandPayload,
  readFileResource,
  readLanguageOptions,
  readQualityOptions,
  readRenameProposals,
  recordDeletionQuery,
  recordDeletionState,
  renameCommandPayload,
  rewriteFileResource,
  startCommand,
  upstreamCommandName,
} from "../src/adapters/library/files.js";
import { fixtureBody, jsonResponse, libraryHarness, type UpstreamCall } from "./support/library.js";

/**
 * The file and path mutation adapters, exercised against the recorded fixtures.
 *
 * The rewriting and payload functions are pure and are called directly;
 * everything that reaches an instance goes through the real upstream client
 * with an injected fetch, so the assertions cover the method, route, query, and
 * body a real instance would receive.
 */

const fixtures: Record<string, unknown> = {};

beforeAll(async () => {
  for (const route of ["episodefile", "rename", "qualitydefinition", "language"]) {
    fixtures[`sonarr/${route}`] = await fixtureBody("sonarr", route);
  }
  for (const route of ["moviefile", "rename", "qualitydefinition", "language"]) {
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

async function readBody(call: UpstreamCall): Promise<Record<string, unknown>> {
  const raw = call.init.body;
  if (typeof raw !== "string") {
    throw new Error("Expected a serialized JSON request body");
  }
  return JSON.parse(raw) as Record<string, unknown>;
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

  it("fingerprints exactly what a file mutation depends on and nothing more", () => {
    const file = firstFile("sonarr", "episodefile");
    const state = fileState("episode_file", file, "metadata");

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
    expect(fileState("episode_file", { ...file, customFormatScore: 99 }, "metadata")).toEqual(
      state,
    );
    // A deletion depends on the file still being that file under the parent it
    // was grouped by, so a corrected release group must not expire its plan.
    expect(fileState("episode_file", file, "identity")).toEqual({ id: 2001, parent: 12 });
    expect(fileState("episode_file", { ...file, releaseGroup: "OTHERGRP" }, "identity")).toEqual(
      fileState("episode_file", file, "identity"),
    );
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

  it("observes the record's data only when the caller asked to destroy it", () => {
    const resource: UpstreamResource = {
      id: 14,
      title: "Example Retired Series",
      path: "/media/example/series/Example Retired Series",
      statistics: { episodeFileCount: 2, sizeOnDisk: 1024 },
    };
    const keepingFiles = { deleteFiles: false, addImportListExclusion: false };

    // Removing only the library record depends on nothing but the record still
    // being there, so a retitled or relocated record does not expire the plan.
    expect(recordDeletionState(resource, keepingFiles)).toEqual({ id: 14 });
    expect(
      recordDeletionState({ ...resource, title: "Example Renamed Series" }, keepingFiles),
    ).toEqual(recordDeletionState(resource, keepingFiles));

    // Taking the files with it is a scope the plan disclosed, so a record that
    // grew files since must not be taken silently.
    expect(recordDeletionState(resource, { ...keepingFiles, deleteFiles: true })).toEqual({
      id: 14,
      hasFile: undefined,
      fileCount: 2,
      sizeOnDisk: 1024,
    });
  });
});

describe("rename and move commands", () => {
  it("asks each application for its own rename preview", async () => {
    const sonarr = libraryHarness("sonarr", () => jsonResponse(body("sonarr", "rename")));
    const proposals = await readRenameProposals(sonarr.client, "sonarr", {
      kind: "series",
      id: 12,
      seasonNumber: 2,
    });

    expect(sonarr.calls[0]?.url.pathname).toBe("/api/v3/rename");
    expect(sonarr.calls[0]?.url.searchParams.get("seriesId")).toBe("12");
    expect(sonarr.calls[0]?.url.searchParams.get("seasonNumber")).toBe("2");
    expect(sonarr.calls[0]?.init.method).toBe("GET");
    expect(proposals.map((proposal) => proposal.fileId)).toEqual([2001, 2003]);

    const radarr = libraryHarness("radarr", () => jsonResponse(body("radarr", "rename")));
    await readRenameProposals(radarr.client, "radarr", { kind: "movie", id: 8 });

    expect(radarr.calls[0]?.url.searchParams.get("movieId")).toBe("8");
    expect(radarr.calls[0]?.url.searchParams.get("seasonNumber")).toBeNull();
  });

  it("keeps only the proposals that name a file to rename", async () => {
    const harness = libraryHarness("sonarr", () =>
      jsonResponse([
        { seriesId: 12, existingPath: "a.mkv", newPath: "b.mkv" },
        { seriesId: 12, episodeFileId: 0, existingPath: "c.mkv", newPath: "d.mkv" },
        { seriesId: 12, episodeFileId: 2001, existingPath: "e.mkv", newPath: "f.mkv" },
      ]),
    );

    const proposals = await readRenameProposals(harness.client, "sonarr", {
      kind: "series",
      id: 12,
    });

    expect(proposals).toEqual([{ fileId: 2001, existingPath: "e.mkv", newPath: "f.mkv" }]);
  });

  it("names one upstream command per workflow and nothing else", () => {
    expect(commandWorkflows).toEqual(["rename_files", "move_record"]);
    expect(upstreamCommandName("sonarr", "move_record")).toBe("MoveSeries");
    expect(upstreamCommandName("radarr", "move_record")).toBe("MoveMovie");
    expect(allowedCommandNames("sonarr")).toEqual(["RenameFiles", "MoveSeries"]);
    expect(allowedCommandNames("radarr")).toEqual(["RenameFiles", "MoveMovie"]);
  });

  it("sends and keeps the allowlisted name whatever anything else says", async () => {
    // The instance echoes a name of its own, which is unvalidated upstream text
    // and is published by the job projection this acceptance becomes.
    const harness = libraryHarness("sonarr", () =>
      jsonResponse({ id: 4242, name: "SomethingElse", status: "queued" }),
    );

    const accepted = await startCommand(harness.client, "sonarr", "rename_files", {
      // A payload that tried to name its own command would be a bug here rather
      // than caller input, and it still cannot reach the instance.
      name: "ResetApiKey",
      ...renameCommandPayload("sonarr", 12, [2001]),
    });

    expect(harness.calls[0]?.url.pathname).toBe("/api/v3/command");
    expect(harness.calls[0]?.init.method).toBe("POST");
    expect(await readBody(harness.calls[0] as UpstreamCall)).toEqual({
      name: "RenameFiles",
      seriesId: 12,
      files: [2001],
    });
    expect(accepted).toEqual({ upstreamId: 4242, name: "RenameFiles", state: "queued" });
  });

  it("reports a command the instance acknowledged with nothing as unconfirmed", async () => {
    const harness = libraryHarness("radarr", () => new Response(null, { status: 201 }));

    const accepted = await startCommand(
      harness.client,
      "radarr",
      "move_record",
      moveCommandPayload("radarr", {
        recordId: 8,
        sourcePath: "/media/example/movies/Example Movie (2021)",
        destinationRootFolder: "/media/example/archive",
      }),
    );

    expect(harness.calls).toHaveLength(1);
    expect(accepted).toBeUndefined();
  });

  it("builds each application's own move payload from instance-reported paths", () => {
    expect(
      moveCommandPayload("sonarr", {
        recordId: 12,
        sourcePath: "/media/example/series/Example Series",
        destinationRootFolder: "/media/example/archive",
      }),
    ).toEqual({
      seriesId: 12,
      seriesIds: [12],
      sourcePath: "/media/example/series/Example Series",
      destinationRootFolder: "/media/example/archive",
    });
    expect(renameCommandPayload("radarr", 8, [501])).toEqual({ movieId: 8, files: [501] });
  });
});
