import { beforeEach, describe, expect, it } from "vitest";
import { systemClock } from "../src/state/clock.js";
import { createDownloadClaims } from "../src/state/download-claims.js";
import type { RemoveResult } from "../src/tools/media/schemas.js";
import { callMediaTool, createMediaContext, noMediaDefaults } from "./support/media.js";
import { type ActivityInstances, createActivityInstances } from "./support/media-activity.js";
import { allApplicationsEnvironment } from "./support/tool-context.js";

/**
 * `media_remove` over the recorded library: movie 200001 is record 8 and
 * series 100001 is record 12.
 */

let instances: ActivityInstances;

beforeEach(async () => {
  instances = await createActivityInstances();
});

function remove(input: unknown) {
  return callMediaTool<RemoveResult>(
    "media_remove",
    createMediaContext(instances, noMediaDefaults, allApplicationsEnvironment, {
      claims: createDownloadClaims(),
      clock: systemClock,
    }),
    input,
  );
}

function deletes() {
  return instances.mutations().map((request) => [request.route, request.query]);
}

describe("media_remove", () => {
  it("removes a movie and keeps its file, never excluding it from being added again", async () => {
    const { content, summary } = await remove({ kind: "movie", id: 200_001 });

    expect(content).toEqual({
      kind: "movie",
      id: 200_001,
      title: "Example Movie",
      outcome: "removed",
      files_deleted: false,
      warnings: [],
      errors: [],
    });
    expect(deletes()).toEqual([["movie/8", { deleteFiles: "false", addImportExclusion: "false" }]]);
    expect(summary).toBe("media_remove: removed movie 200001, files kept");
  });

  it("deletes a series' files only when asked", async () => {
    const { content } = await remove({ kind: "series", id: 100_001, delete_files: true });

    expect(content).toMatchObject({ outcome: "removed", files_deleted: true });
    expect(deletes()).toEqual([
      ["series/12", { deleteFiles: "true", addImportListExclusion: "false" }],
    ]);
  });

  it("reports a title not in the library as not_in_library and changes nothing", async () => {
    const { content, result } = await remove({ kind: "movie", id: 999_999, delete_files: true });

    expect(result.isError).toBe(false);
    expect(content).toEqual({
      kind: "movie",
      id: 999_999,
      outcome: "not_in_library",
      files_deleted: false,
      warnings: [],
      errors: [],
    });
    expect(instances.mutations()).toEqual([]);
  });

  it("reports a concurrent duplicate removal as not_in_library", async () => {
    const [left, right] = await Promise.all([
      remove({ kind: "movie", id: 200_001 }),
      remove({ kind: "movie", id: 200_001 }),
    ]);

    expect([left.content.outcome, right.content.outcome].sort()).toEqual([
      "not_in_library",
      "removed",
    ]);
    expect(instances.state("radarr").titles.some((record) => record.id === 8)).toBe(false);
  });

  it("reports a record another call removed between the read and the delete as not_in_library", async () => {
    instances.intercept((request) => {
      if (request.method === "DELETE") {
        instances.state("radarr").titles = instances
          .state("radarr")
          .titles.filter((record) => record.id !== 8);
      }
      return undefined;
    });

    const { content } = await remove({ kind: "movie", id: 200_001, delete_files: true });

    expect(content).toMatchObject({ outcome: "not_in_library", files_deleted: false });
  });

  it("settles a lost answer by reading the title again", async () => {
    instances.intercept((request) => {
      if (request.method === "DELETE") {
        instances.state("radarr").titles = instances
          .state("radarr")
          .titles.filter((record) => record.id !== 8);
        throw new TypeError("fetch failed");
      }
      return undefined;
    });

    const { content } = await remove({ kind: "movie", id: 200_001 });

    expect(content).toMatchObject({ outcome: "removed", files_deleted: false });
  });

  it("fails a delete the instance refused, or whose effect it cannot confirm", async () => {
    instances.intercept((request) =>
      request.method === "DELETE" ? new Response(JSON.stringify([]), { status: 400 }) : undefined,
    );
    const refused = await remove({ kind: "movie", id: 200_001 });
    expect(refused.result.isError).toBe(true);
    expect(refused.content.errors.map((error) => error.code)).toEqual(["upstream_rejection"]);
    expect(refused.content.outcome).toBeUndefined();

    instances = await createActivityInstances();
    instances.intercept((request) => {
      if (request.method === "DELETE") {
        throw new TypeError("fetch failed");
      }
      return undefined;
    });
    const unknown = await remove({ kind: "movie", id: 200_001 });
    expect(unknown.content.errors.map((error) => error.code)).toEqual(["unavailable_application"]);
  });
});
