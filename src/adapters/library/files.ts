import { z } from "zod";
import type { UpstreamBody, UpstreamClient, UpstreamQuery } from "../../http/client.js";
import type { ResourceRewrite, UpstreamResource } from "./changes.js";
import type { MediaApplication, MediaFileKind, MediaRecordKind } from "./model.js";
import {
  count,
  optionalUpstreamId,
  parseUpstream,
  text,
  upstreamId,
  upstreamText,
} from "./parse.js";

/**
 * The Sonarr and Radarr file and path write adapters.
 *
 * These are the operations that touch the filesystem rather than the database,
 * so three rules hold on top of the ones the record adapters already keep.
 *
 * Nothing here decides whether a mutation may run: the tool layer resolves
 * references, groups a selection into what upstream can process safely, and
 * reads current state, and this module is reached only once it has.
 *
 * A file edit is a read-modify-write over the resource the instance returned,
 * for the same reason a record edit is — these APIs replace a whole resource,
 * and a payload assembled here would erase the fields this project does not
 * model.
 *
 * And a rename or a move runs as a *named* command from the allowlist below,
 * never as a name a caller or a payload supplied. The allowlist is what keeps
 * the command endpoint — which can start anything an instance knows how to do —
 * reachable for exactly two workflows and nothing else.
 */

const fileRoutes: Readonly<Record<MediaFileKind, string>> = {
  episode_file: "episodefile",
  movie_file: "moviefile",
};

/** Which application models which file kind, stated once rather than probed. */
export const fileApplications: Readonly<Record<MediaFileKind, MediaApplication>> = {
  episode_file: "sonarr",
  movie_file: "radarr",
};

/**
 * The record a file hangs off.
 *
 * A bulk file operation is grouped by this, because it is the boundary upstream
 * itself organizes files by: the rename endpoints are asked about one series or
 * one movie, and a request that spanned two of them would ask a handler for
 * something it has no single answer to.
 */
export const fileParentKinds: Readonly<Record<MediaFileKind, MediaRecordKind>> = {
  episode_file: "series",
  movie_file: "movie",
};

const qualityWrapperSchema = z.looseObject({
  quality: z.looseObject({ id: optionalUpstreamId, name: upstreamText }).nullish(),
});

/**
 * One upstream media file, kept whole.
 *
 * Only the fields a mutation reads are modelled — the parent it belongs to, the
 * path it is at, and the metadata an edit replaces. Everything else travels
 * back to the instance exactly as it arrived, which is what a loose object is
 * for.
 */
const fileResourceSchema = z.looseObject({
  id: upstreamId,
  seriesId: optionalUpstreamId,
  movieId: optionalUpstreamId,
  seasonNumber: optionalUpstreamId,
  relativePath: upstreamText,
  releaseGroup: upstreamText,
  quality: qualityWrapperSchema.nullish(),
  languages: z.array(z.looseObject({ id: optionalUpstreamId, name: upstreamText })).nullish(),
});

export type FileResource = z.infer<typeof fileResourceSchema>;

export function fileResourcePath(kind: MediaFileKind, id: number): string {
  return `${fileRoutes[kind]}/${id}`;
}

export async function readFileResource(
  client: UpstreamClient,
  application: MediaApplication,
  kind: MediaFileKind,
  id: number,
): Promise<FileResource> {
  const route = fileResourcePath(kind, id);
  return parseUpstream(fileResourceSchema, await client.get(route), application, route);
}

/**
 * The library record one file belongs to, as the instance itself reports it.
 *
 * It is read from the file rather than carried on the reference, so a file that
 * was moved to another record between the query that published it and the call
 * that names it groups under where it actually is now.
 */
export function fileParentId(kind: MediaFileKind, resource: FileResource): number | undefined {
  const parent = kind === "episode_file" ? resource.seriesId : resource.movieId;
  const id = count(parent);
  return id === undefined || id <= 0 ? undefined : id;
}

/** Deletes one media file, and with it the data on disk it stands for. */
export function deleteFileResource(
  client: UpstreamClient,
  kind: MediaFileKind,
  id: number,
): Promise<unknown> {
  return client.delete(fileResourcePath(kind, id));
}

/**
 * What one file mutation depends on, and so what its read set observes.
 *
 * The distinction is load-bearing rather than tidy. A read set that observes
 * more than the mutation depends on does not make a plan safer — it makes it go
 * stale for reasons the plan never disclosed, and a caller who is told a
 * deletion plan expired because someone corrected a release group learns to
 * re-plan reflexively rather than to read why.
 */
export type FileDependency =
  /** A deletion: the file is still that file, under the parent it was grouped by. */
  | "identity"
  /** A metadata edit: every field it may rewrite, because it compares them. */
  | "metadata";

/**
 * The state one file's read set is built from, for the mutation about to run.
 *
 * Everything that mutation depends on is listed, and nothing else is. The parts
 * are named in a fixed order authored here.
 */
export function fileState(
  kind: MediaFileKind,
  resource: FileResource,
  depends: FileDependency,
): Readonly<Record<string, unknown>> {
  const identity = {
    id: resource.id,
    parent: fileParentId(kind, resource),
  };
  return depends === "identity"
    ? identity
    : {
        ...identity,
        seasonNumber: count(resource.seasonNumber),
        relativePath: text(resource.relativePath),
        quality: text(resource.quality?.quality?.name),
        languages: fileLanguageIds(resource),
        releaseGroup: text(resource.releaseGroup),
      };
}

/** The language identifiers a file currently carries, in the order it lists them. */
function fileLanguageIds(resource: FileResource): readonly (number | undefined)[] | undefined {
  const languages = resource.languages;
  return Array.isArray(languages) ? languages.map((language) => count(language.id)) : undefined;
}

/** One value an instance offers for a field a file edit can set. */
export interface NamedOption {
  readonly id: number;
  readonly name: string;
  /**
   * The upstream object this option was read from, sent back verbatim when the
   * edit writes it. A quality is a nested object with a source and a resolution
   * the instance decides, so rebuilding one from a name would write a quality
   * the instance did not describe that way.
   */
  readonly resource: UpstreamResource;
}

const qualityDefinitionSchema = z.looseObject({
  quality: z.looseObject({ id: upstreamId, name: upstreamText }).nullish(),
});

const languageSchema = z.looseObject({ id: upstreamId, name: upstreamText });

/**
 * The qualities this instance actually defines.
 *
 * A file edit names a quality in the caller's own words, and this is what turns
 * that word into the instance's own object. Reading the list is also the
 * validation: a name the instance does not define is refused rather than
 * written as a quality nothing will recognize.
 */
export async function readQualityOptions(
  client: UpstreamClient,
  application: MediaApplication,
): Promise<readonly NamedOption[]> {
  const route = "qualitydefinition";
  const definitions = parseUpstream(
    z.array(qualityDefinitionSchema),
    await client.get(route),
    application,
    route,
  );
  return definitions.flatMap((definition) => {
    const quality = definition.quality;
    const name = text(quality?.name);
    return quality === null || quality === undefined || name === undefined
      ? []
      : [{ id: quality.id, name, resource: quality }];
  });
}

/** The languages this instance defines, read and validated the same way. */
export async function readLanguageOptions(
  client: UpstreamClient,
  application: MediaApplication,
): Promise<readonly NamedOption[]> {
  const route = "language";
  const languages = parseUpstream(
    z.array(languageSchema),
    await client.get(route),
    application,
    route,
  );
  return languages.flatMap((language) => {
    const name = text(language.name);
    return name === undefined ? [] : [{ id: language.id, name, resource: language }];
  });
}

/**
 * Finds the option one caller-supplied name stands for.
 *
 * The comparison is case-insensitive and trimmed, because a caller writing
 * "bluray-1080p" means the quality the instance spells `Bluray-1080p`. It is
 * still an exact name match: nothing here guesses a nearest value, so an
 * unrecognized name is reported rather than silently resolved to something
 * adjacent.
 */
export function matchOption(
  options: readonly NamedOption[],
  name: string,
): NamedOption | undefined {
  const wanted = name.trim().toLowerCase();
  return options.find((option) => option.name.trim().toLowerCase() === wanted);
}

/** The typed edits one file-metadata mutation may carry, already validated. */
export interface FileChanges {
  readonly quality?: NamedOption | undefined;
  readonly languages?: readonly NamedOption[] | undefined;
  readonly releaseGroup?: string | undefined;
}

function sameLanguages(resource: FileResource, wanted: readonly NamedOption[]): boolean {
  const current = fileLanguageIds(resource);
  if (current === undefined || current.length !== wanted.length) {
    return false;
  }
  return wanted.every((option, index) => current[index] === option.id);
}

/**
 * Writes the typed changes over the file resource the instance returned.
 *
 * A field the intent did not name is not touched, and the answer says whether
 * anything actually differs — a file already carrying the requested quality is
 * worth reporting as such rather than sending an identical resource back and
 * calling it a change. The quality wrapper keeps its existing revision, because
 * a revision describes the release the file came from and is not what a
 * metadata correction is changing.
 */
export function rewriteFileResource(resource: FileResource, changes: FileChanges): ResourceRewrite {
  const rewritten: UpstreamResource = { ...resource };
  let changed = false;

  if (changes.quality !== undefined) {
    const current = resource.quality;
    if (count(current?.quality?.id) !== changes.quality.id) {
      changed = true;
    }
    rewritten.quality = { ...(current ?? {}), quality: changes.quality.resource };
  }
  if (changes.languages !== undefined) {
    if (!sameLanguages(resource, changes.languages)) {
      changed = true;
    }
    rewritten.languages = changes.languages.map((option) => option.resource);
  }
  if (changes.releaseGroup !== undefined) {
    if (text(resource.releaseGroup) !== changes.releaseGroup) {
      changed = true;
    }
    rewritten.releaseGroup = changes.releaseGroup;
  }

  return { status: "ok", changed, resource: rewritten };
}

/** The follow-on removals a record deletion may explicitly request. */
export interface DeletionChoices {
  readonly deleteFiles: boolean;
  readonly addImportListExclusion: boolean;
}

/**
 * The query one record deletion is sent with.
 *
 * Both applications offer the same two choices under different names, so the
 * spelling is translated here rather than assumed to be shared. Both parameters
 * are always sent explicitly, including when they are false: leaving one out
 * would let an instance's own default decide something this server requires the
 * caller to have decided.
 */
export function recordDeletionQuery(
  application: MediaApplication,
  choices: DeletionChoices,
): UpstreamQuery {
  return application === "sonarr"
    ? {
        deleteFiles: choices.deleteFiles,
        addImportListExclusion: choices.addImportListExclusion,
      }
    : { deleteFiles: choices.deleteFiles, addImportExclusion: choices.addImportListExclusion };
}

/** Removes one library record, with whatever the query explicitly asked for. */
export function deleteRecordResource(
  client: UpstreamClient,
  path: string,
  query: UpstreamQuery,
): Promise<unknown> {
  return client.delete(path, query);
}

/**
 * The state a deletion's read set is built from.
 *
 * Which record is removed is settled by the reference, not by this: what is
 * observed is that the record is still there to remove. A title, a path, or a
 * profile is deliberately not observed — none of them is disclosed by a
 * deletion plan, and all of them move on a live instance for reasons that have
 * nothing to do with the deletion.
 *
 * How much data goes with it is observed only when the caller asked for the
 * files too. Then it is the scope of what the plan disclosed destroying, and a
 * record that grew files since must not be taken silently; when the files stay
 * on disk, the same numbers are just an instance doing its job.
 */
export function recordDeletionState(
  resource: UpstreamResource,
  choices: DeletionChoices,
): Readonly<Record<string, unknown>> {
  if (!choices.deleteFiles) {
    return { id: resource.id };
  }
  const statistics =
    typeof resource.statistics === "object" &&
    resource.statistics !== null &&
    !Array.isArray(resource.statistics)
      ? (resource.statistics as Record<string, unknown>)
      : undefined;
  return {
    id: resource.id,
    hasFile: resource.hasFile,
    fileCount: statistics?.episodeFileCount ?? statistics?.movieFileCount,
    sizeOnDisk: statistics?.sizeOnDisk,
  };
}

/**
 * The state a rename or a move depends on.
 *
 * Deliberately narrower than the state a metadata edit depends on: a rename
 * turns on where the record is and what it is called, and nothing else. Folding
 * in monitoring, tags, or a profile would make a plan go stale because
 * something unrelated to the filesystem moved, and a caller would learn to
 * re-plan rather than to read why.
 */
export function recordPathState(resource: UpstreamResource): Readonly<Record<string, unknown>> {
  return {
    id: resource.id,
    title: resource.title,
    path: resource.path,
    rootFolderPath: resource.rootFolderPath,
  };
}

/** The record a rename preview is read for. A season narrows it to one season. */
export interface RenameTarget {
  readonly kind: MediaRecordKind;
  readonly id: number;
  readonly seasonNumber?: number | undefined;
}

/** One file the instance proposes to rename, and where it proposes to put it. */
export interface RenameProposal {
  readonly fileId: number;
  readonly existingPath?: string | undefined;
  readonly newPath?: string | undefined;
}

const renameProposalSchema = z.looseObject({
  episodeFileId: optionalUpstreamId,
  movieFileId: optionalUpstreamId,
  existingPath: upstreamText,
  newPath: upstreamText,
});

/**
 * Reads what the instance would rename, without renaming anything.
 *
 * This is the preview, and it is also the whole of what an apply then acts on:
 * the file identifiers the command is given come from here, so a rename can
 * never reach a file the preview did not name. Only proposals carrying a real
 * file identifier are kept — one without it names nothing that could be
 * renamed.
 */
export async function readRenameProposals(
  client: UpstreamClient,
  application: MediaApplication,
  target: RenameTarget,
): Promise<readonly RenameProposal[]> {
  const route = "rename";
  const query: UpstreamQuery =
    application === "sonarr"
      ? { seriesId: target.id, seasonNumber: target.seasonNumber }
      : { movieId: target.id };
  const proposals = parseUpstream(
    z.array(renameProposalSchema),
    await client.get(route, query),
    application,
    route,
  );

  return proposals.flatMap((proposal) => {
    const fileId = count(application === "sonarr" ? proposal.episodeFileId : proposal.movieFileId);
    return fileId === undefined || fileId <= 0
      ? []
      : [
          {
            fileId,
            existingPath: text(proposal.existingPath),
            newPath: text(proposal.newPath),
          },
        ];
  });
}

/** The two normalized workflows this module may start a command for. */
export const commandWorkflows = ["rename_files", "move_record"] as const;

export type CommandWorkflow = (typeof commandWorkflows)[number];

/**
 * The upstream commands this server is allowed to start, by workflow.
 *
 * The command endpoint accepts any command an instance knows, so nothing but
 * this table decides which ones are reachable. A workflow names a normalized
 * intent and the table names the one command it may become — there is no
 * passthrough, no caller-supplied name, and no default, so a command this
 * project has not deliberately allowed cannot be started through it.
 */
const allowedCommands: Readonly<
  Record<MediaApplication, Readonly<Record<CommandWorkflow, string>>>
> = {
  sonarr: { rename_files: "RenameFiles", move_record: "MoveSeries" },
  radarr: { rename_files: "RenameFiles", move_record: "MoveMovie" },
};

export function upstreamCommandName(
  application: MediaApplication,
  workflow: CommandWorkflow,
): string {
  return allowedCommands[application][workflow];
}

/** Names every command this server can start, so a test can hold it to the set. */
export function allowedCommandNames(application: MediaApplication): readonly string[] {
  return commandWorkflows.map((workflow) => allowedCommands[application][workflow]);
}

/** The rename command's payload: one parent record and the files to rename. */
export function renameCommandPayload(
  application: MediaApplication,
  parentId: number,
  fileIds: readonly number[],
): UpstreamBody {
  return application === "sonarr"
    ? { seriesId: parentId, files: [...fileIds] }
    : { movieId: parentId, files: [...fileIds] };
}

export interface MoveRequest {
  readonly recordId: number;
  /** Where the record's files are now, as the instance itself reports it. */
  readonly sourcePath: string;
  /** A root folder from the instance's own list, never a caller-authored path. */
  readonly destinationRootFolder: string;
}

/** The move command's payload. Neither path is composed from caller input. */
export function moveCommandPayload(
  application: MediaApplication,
  request: MoveRequest,
): UpstreamBody {
  const shared = {
    sourcePath: request.sourcePath,
    destinationRootFolder: request.destinationRootFolder,
  };
  return application === "sonarr"
    ? { ...shared, seriesId: request.recordId, seriesIds: [request.recordId] }
    : { ...shared, movieId: request.recordId, movieIds: [request.recordId] };
}

/**
 * One accepted command, as the instance echoed it back.
 *
 * The echoed `name` is deliberately not modelled. It is unvalidated upstream
 * text, and the job projection built from this is published — so retaining it
 * would carry whatever an instance chose to answer with into a tool result,
 * through a boundary that otherwise lets nothing but this project's own
 * allowlisted vocabulary out. The name this server sent is already known here
 * and is the one that is kept.
 */
const commandSchema = z.looseObject({
  id: upstreamId,
  status: upstreamText,
  state: upstreamText,
});

/** One accepted command, as the instance acknowledged it. */
export interface CommandAcceptance {
  readonly upstreamId: number;
  /** The allowlisted name this server sent, never the one upstream echoed. */
  readonly name: string;
  readonly state?: string | undefined;
}

/**
 * Starts one allowlisted command and confirms what came back.
 *
 * The command name is written over the payload rather than under it, so the
 * allowlisted name is the one that is sent whatever the payload happens to
 * carry. As with a create, an empty answer is reported as unconfirmed rather
 * than as a failure: the request was sent and may well have been accepted.
 */
export async function startCommand(
  client: UpstreamClient,
  application: MediaApplication,
  workflow: CommandWorkflow,
  payload: UpstreamBody,
): Promise<CommandAcceptance | undefined> {
  const route = "command";
  const name = upstreamCommandName(application, workflow);
  const body = await client.post(route, { ...payload, name });
  if (body === undefined) {
    return undefined;
  }
  const accepted = parseUpstream(commandSchema, body, application, route);
  if (accepted.id <= 0) {
    return undefined;
  }
  return {
    upstreamId: accepted.id,
    name,
    state: text(accepted.status) ?? text(accepted.state),
  };
}
