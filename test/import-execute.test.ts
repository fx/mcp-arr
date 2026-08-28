import { beforeAll, describe, expect, it } from "vitest";
import { fileIdentity } from "../src/adapters/import/candidates.js";
import {
  type ImportFileRequest,
  manualImportCommandName,
  submitManualImport,
} from "../src/adapters/import/execute.js";
import { activityFixture } from "./support/activity.js";
import { jsonResponse, libraryHarness, type UpstreamCall } from "./support/library.js";

/**
 * Manual-import execution, which is where this project asks an application to
 * move files on the operator's disk.
 *
 * Three claims are worth testing here and nothing much else is. That the
 * command carries the name this module holds as a constant rather than anything
 * an instance or a caller supplied; that every field in it was assembled from
 * validated values rather than forwarded from the row the instance returned;
 * and that the file's canonical path — which the command genuinely needs — goes
 * into the request and into nothing that comes back.
 */

const recordedFolder = "/media/example/downloads/complete/example-series";
const cleanFile = `${recordedFolder}/Example Series - S01E01 - Example Pilot Bluray-1080p.mkv`;
const secondFile = `${recordedFolder}/Season 02/Example Series - S02E05 - Example Second WEBDL-720p.mkv`;

let candidates: Record<string, unknown>[];
let queue: unknown[];

beforeAll(async () => {
  [candidates, queue] = await Promise.all([
    activityFixture<Record<string, unknown>[]>("sonarr", "manualimport"),
    activityFixture<unknown[]>("sonarr", "queue/details"),
  ]);
});

interface Instance {
  readonly calls: UpstreamCall[];
  readonly commands: Record<string, unknown>[];
  readonly client: Parameters<typeof submitManualImport>[0];
}

function instance(options: { scan?: Record<string, unknown>[] } = {}): Instance {
  const commands: Record<string, unknown>[] = [];
  const harness = libraryHarness("sonarr", (call) => {
    const path = call.url.pathname;
    const method = call.init.method ?? "GET";

    if (path.endsWith("/manualimport")) {
      return jsonResponse(options.scan ?? candidates);
    }
    if (path.endsWith("/queue/details")) {
      return jsonResponse(queue);
    }
    if (path.endsWith("/command") && method === "POST") {
      commands.push(JSON.parse(String(call.init.body)) as Record<string, unknown>);
      // The accepted record, with the instance echoing a name of its own.
      return jsonResponse({
        id: 7701,
        name: "ManualImportEchoedByTheInstance",
        status: "queued",
        message: `importing from ${recordedFolder}`,
      });
    }
    return jsonResponse({ message: "unexpected route" }, 404);
  });
  return { calls: harness.calls, commands, client: harness.client };
}

function fileRequest(path: string, overrides: Partial<ImportFileRequest> = {}): ImportFileRequest {
  return {
    origin: { sourceKind: "tracked_download", queueItemId: 502, mediaId: 12, seasonNumber: 1 },
    identity: fileIdentity(path),
    patch: {},
    ...overrides,
  };
}

function commandFiles(command: Record<string, unknown>): Record<string, unknown>[] {
  return (command.files ?? []) as Record<string, unknown>[];
}

describe("submitting a manual import", () => {
  it("sends one allowlisted command carrying the recovered path", async () => {
    const sonarr = instance();

    const submission = await submitManualImport(
      sonarr.client,
      "sonarr",
      [fileRequest(cleanFile)],
      "move",
    );
    if (submission.status !== "ok") {
      throw new Error(`Expected a submission, got ${submission.status}`);
    }

    expect(sonarr.commands).toHaveLength(1);
    const command = sonarr.commands[0] ?? {};
    expect(command.name).toBe(manualImportCommandName);
    expect(command.importMode).toBe("move");
    const [file] = commandFiles(command);
    // The path the command needs, recovered from the instance rather than from
    // anything the reference retained.
    expect(file?.path).toBe(cleanFile);
    expect(file?.seriesId).toBe(12);
    expect(file?.episodeIds).toEqual([1001]);
    // The download identity ties the imported file back to its queue row.
    expect(file?.downloadId).toBeTruthy();
  });

  it("names the command this server sent, never the instance's echo of it", async () => {
    const sonarr = instance();
    const submission = await submitManualImport(
      sonarr.client,
      "sonarr",
      [fileRequest(cleanFile)],
      "auto",
    );
    if (submission.status !== "ok") {
      throw new Error("Expected a submission");
    }

    expect(submission.command.name).toBe("ManualImport");
    expect(submission.command.upstreamId).toBe("7701");
    // The instance composed both a name and a message; neither reaches the job
    // identity, and the message is sanitized before it becomes a warning.
    expect(JSON.stringify(submission.command)).not.toContain("EchoedByTheInstance");
    expect(JSON.stringify(submission.command)).not.toContain(recordedFolder);
  });

  it("assembles each entry rather than forwarding the row the instance returned", async () => {
    const sonarr = instance({
      scan: [
        {
          ...(candidates[0] as Record<string, unknown>),
          // Two properties this project does not model. A payload built by
          // spreading the row would carry them upstream.
          instanceOnlyField: "not-modelled",
          folderName: "example-series",
        },
      ],
    });

    await submitManualImport(sonarr.client, "sonarr", [fileRequest(cleanFile)], "auto");

    const [file] = commandFiles(sonarr.commands[0] ?? {});
    expect(file).toBeDefined();
    expect(file?.instanceOnlyField).toBeUndefined();
    expect(file?.folderName).toBeUndefined();
    // Only the named fields, and the ones that carry a decision are there.
    expect(Object.keys(file ?? {}).sort()).toEqual(
      [
        "downloadId",
        "episodeIds",
        "indexerFlags",
        "languages",
        "path",
        "quality",
        "releaseGroup",
        "seriesId",
      ].sort(),
    );
  });

  it("carries the corrected mapping where one was selected", async () => {
    const sonarr = instance();

    await submitManualImport(
      sonarr.client,
      "sonarr",
      [
        fileRequest(cleanFile, {
          patch: { mediaId: 33, episodeIds: [2002, 2003], releaseGroup: "CorrectedGroup" },
        }),
      ],
      "copy",
    );

    const [file] = commandFiles(sonarr.commands[0] ?? {});
    expect(file?.seriesId).toBe(33);
    expect(file?.episodeIds).toEqual([2002, 2003]);
    expect(file?.releaseGroup).toBe("CorrectedGroup");
  });

  it("leaves the scan's episodes behind where the mapping moved to another media", async () => {
    const sonarr = instance();

    // The command is assembled from the recovered scan row a second time, so
    // the mapping the validation approved has to survive that assembly. The row
    // still maps this file to series 12 and episode 1001; the reference stands
    // for series 33 and no episodes, and 1001 is not an episode of series 33.
    await submitManualImport(
      sonarr.client,
      "sonarr",
      [fileRequest(cleanFile, { patch: { mediaId: 33 } })],
      "auto",
    );

    const [file] = commandFiles(sonarr.commands[0] ?? {});
    expect(file?.seriesId).toBe(33);
    expect(file).not.toHaveProperty("episodeIds");
  });

  it("sends one command for several files rather than one command each", async () => {
    const sonarr = instance();

    await submitManualImport(
      sonarr.client,
      "sonarr",
      [fileRequest(cleanFile), fileRequest(secondFile)],
      "auto",
    );

    expect(sonarr.commands).toHaveLength(1);
    expect(commandFiles(sonarr.commands[0] ?? {})).toHaveLength(2);
  });

  it("submits nothing at all when one file can no longer be found", async () => {
    // The folder still answers and the second file is not in it. Importing the
    // one that remains would act on a selection the caller never approved.
    const sonarr = instance({ scan: [candidates[0] as Record<string, unknown>] });

    const submission = await submitManualImport(
      sonarr.client,
      "sonarr",
      [fileRequest(cleanFile), fileRequest(secondFile)],
      "auto",
    );

    expect(submission.status).toBe("absent");
    if (submission.status === "absent") {
      expect(submission.identity).toBe(fileIdentity(secondFile));
      expect(submission.error.code).toBe("stale_reference");
    }
    expect(sonarr.commands).toEqual([]);
  });

  it("keeps the path out of everything the submission answers with", async () => {
    const sonarr = instance();

    const submission = await submitManualImport(
      sonarr.client,
      "sonarr",
      [fileRequest(cleanFile)],
      "move",
    );

    expect(JSON.stringify(submission)).not.toContain(recordedFolder);
    expect(JSON.stringify(submission)).not.toContain(".mkv");
    // And it did go upstream, which is the half that makes the other half
    // meaningful rather than vacuous.
    expect(JSON.stringify(sonarr.commands)).toContain(cleanFile);
  });
});
