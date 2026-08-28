import type { UpstreamBody, UpstreamClient } from "../../http/client.js";
import type { ToolError } from "../../tools/errors.js";
import { readAcceptedCommand, type StartedCommand } from "../acquisition/commands.js";
import type { MediaApplication } from "../library/model.js";
import {
  type CandidateOrigin,
  type ImportScanContext,
  recoverCandidateRow,
  type UpstreamCandidate,
  type UpstreamMappingPatch,
} from "./candidates.js";

/**
 * Manual-import execution.
 *
 * This is the one place in the project that asks an application to move a file
 * on the operator's disk, and three rules shape it.
 *
 * **One command name, and it is this module's own constant.** The upstream
 * command endpoint takes any name a caller writes; nothing here forwards one.
 * `ManualImport` is a literal below, so no published input, and no field of any
 * reference, can reach the `name` an instance is asked to run.
 *
 * **Every field is assembled, never forwarded.** The scan row the instance
 * returned is read for the values this project models — the mapping, the
 * quality it parsed, the languages, the release group, the indexer flags — and
 * each is written into the request by name. The row is not spread in, so a
 * property an instance adds cannot arrive in a command payload by existing, and
 * a caller has no channel into it at all.
 *
 * **The path is recovered and never remembered.** A file's canonical path is
 * re-derived from the instance immediately before the command is built, by the
 * same digest match a correction uses, and it goes straight into the request.
 * No reference, no plan, and no result holds one.
 */

/** The workflow this server may submit, and the only one. */
export const manualImportCommandName = "ManualImport";

const commandRoute = "command";

/**
 * How the source file is treated. `auto` lets the application decide from the
 * download client's own configuration, which is what a caller usually wants and
 * is still explicit: the published schema has no default, so a caller states
 * one every time.
 */
export const importModes = ["auto", "move", "copy"] as const;

export type ImportMode = (typeof importModes)[number];

/** One file an import will act on, named by what a reference retained. */
export interface ImportFileRequest {
  readonly origin: CandidateOrigin;
  /** The digest of the file this reference stands for. */
  readonly identity: string;
  /** The mapping the caller selected, as the validation just re-sent it. */
  readonly patch: UpstreamMappingPatch;
}

/**
 * One file's entry in the command, and what a caller is told it stands for.
 *
 * The entry is what goes upstream and the identity is what comes back to the
 * caller, so a result can name a file without either naming its location.
 */
interface PreparedFile {
  readonly identity: string;
  readonly entry: UpstreamBody;
}

export type ImportSubmission =
  | { readonly status: "ok"; readonly command: StartedCommand }
  /**
   * One file could not be found again between validation and submission.
   *
   * It carries the identity so the caller learns which file, and the typed
   * error the rest of this surface gives for a target that has gone. Nothing is
   * submitted: a partial import of the files that were still there would act on
   * a selection the caller never approved.
   */
  | { readonly status: "absent"; readonly identity: string; readonly error: ToolError }
  | { readonly status: "unmapped"; readonly identity: string; readonly error: ToolError };

function mediaEntry(
  context: ImportScanContext,
  row: UpstreamCandidate,
  patch: UpstreamMappingPatch,
) {
  const mediaId = patch.mediaId ?? row.series?.id ?? row.movie?.id;
  if (mediaId === undefined) {
    return {};
  }
  return context.application === "sonarr" ? { seriesId: mediaId } : { movieId: mediaId };
}

function episodeEntry(row: UpstreamCandidate, patch: UpstreamMappingPatch) {
  const episodeIds =
    patch.episodeIds ??
    (row.episodes ?? []).flatMap((episode) => (episode.id === undefined ? [] : [episode.id]));
  return episodeIds.length === 0 ? {} : { episodeIds: [...episodeIds] };
}

/**
 * Builds one file's entry, field by named field.
 *
 * The corrected values win where the caller supplied them and the instance's
 * own decision fills the rest, which is the same precedence the reprocess that
 * validated this file used — so what is imported is what the validation
 * approved rather than a second assembly of it.
 */
function prepareFile(
  context: ImportScanContext,
  row: UpstreamCandidate,
  path: string,
  patch: UpstreamMappingPatch,
  identity: string,
): PreparedFile {
  const quality =
    patch.quality === undefined
      ? row.quality
      : { ...(isRecord(row.quality) ? row.quality : {}), quality: patch.quality };
  const languages = patch.languages ?? row.languages;
  const releaseGroup = patch.releaseGroup ?? row.releaseGroup ?? undefined;

  return {
    identity,
    entry: {
      path,
      ...mediaEntry(context, row, patch),
      ...episodeEntry(row, patch),
      ...(quality === undefined || quality === null ? {} : { quality }),
      ...(languages === undefined || languages === null ? {} : { languages: [...languages] }),
      ...(releaseGroup === undefined ? {} : { releaseGroup }),
      // The download identity is what ties an imported file back to the queue
      // row it came from, and a scan answer drops it, so it comes from the
      // context this submission re-derived rather than from the row.
      ...(context.downloadId === undefined ? {} : { downloadId: context.downloadId }),
      ...(row.indexerFlags === undefined || row.indexerFlags === null
        ? {}
        : { indexerFlags: row.indexerFlags }),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Submits one manual import.
 *
 * Every file is recovered first and the command is sent once, for all of them
 * together: the applications accept a single `ManualImport` carrying many
 * files, and one command is what makes the result one job a caller can follow
 * rather than several that would have to be correlated. A file that cannot be
 * found again stops the whole submission before anything is sent, because the
 * alternative is importing a subset nobody approved.
 */
export async function submitManualImport(
  client: UpstreamClient,
  application: MediaApplication,
  files: readonly ImportFileRequest[],
  importMode: ImportMode,
): Promise<ImportSubmission> {
  const prepared: PreparedFile[] = [];
  for (const file of files) {
    const found = await recoverCandidateRow(client, application, file.origin, file.identity);
    if (found.status !== "ok") {
      return { status: found.status, identity: file.identity, error: found.error };
    }
    const { context, row, path } = found.recovered;
    prepared.push(prepareFile(context, row, path, file.patch, file.identity));
  }

  const body: UpstreamBody = {
    name: manualImportCommandName,
    importMode,
    files: prepared.map((file) => file.entry),
  };
  const accepted = readAcceptedCommand(
    await client.post(commandRoute, body),
    application,
    commandRoute,
  );

  return {
    status: "ok",
    command: {
      upstreamId: accepted.upstreamId,
      // This module's own constant, never the instance's echo of it: the job
      // identity a caller reads is this project's vocabulary throughout.
      name: manualImportCommandName,
      observation: accepted.observation,
      message: accepted.message,
    },
  };
}

/** The identities a submission carried, in the order the command lists them. */
export function submittedIdentities(files: readonly ImportFileRequest[]): readonly string[] {
  return files.map((file) => file.identity);
}
