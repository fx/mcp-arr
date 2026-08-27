import { z } from "zod";
import type { UpstreamClient, UpstreamQuery } from "../../http/client.js";
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
 * The Sonarr and Radarr media-file and deletion write adapters.
 *
 * These are the operations that touch the filesystem rather than the database,
 * so two rules hold on top of the ones the record adapters already keep.
 *
 * Nothing here decides whether a mutation may run: the tool layer resolves
 * references, groups a selection into what upstream can process safely, and
 * reads current state, and this module is reached only once it has.
 *
 * And a file edit is a read-modify-write over the resource the instance
 * returned, for the same reason a record edit is — these APIs replace a whole
 * resource, and a payload assembled here would erase the fields this project
 * does not model.
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
 * The state one file's read set is built from.
 *
 * Everything a file mutation depends on is listed, and nothing else is: the
 * fingerprint has to move when the file's parent, location, quality, languages,
 * or release group moves, so a plan that proposed to rename or replace the
 * metadata of one file cannot be applied against another. The parts are named
 * in a fixed order authored here.
 */
export function fileState(
  kind: MediaFileKind,
  resource: FileResource,
): Readonly<Record<string, unknown>> {
  return {
    id: resource.id,
    parent: fileParentId(kind, resource),
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
 * A deletion plan discloses which record it removes and how much data goes with
 * it, so both are fingerprinted: applying a plan must not delete a record that
 * has since become a different title, and must not silently take files that
 * arrived after the plan reported none.
 */
export function recordDeletionState(resource: UpstreamResource): Readonly<Record<string, unknown>> {
  const statistics =
    typeof resource.statistics === "object" &&
    resource.statistics !== null &&
    !Array.isArray(resource.statistics)
      ? (resource.statistics as Record<string, unknown>)
      : undefined;
  return {
    id: resource.id,
    title: resource.title,
    path: resource.path,
    hasFile: resource.hasFile,
    fileCount: statistics?.episodeFileCount ?? statistics?.movieFileCount,
    sizeOnDisk: statistics?.sizeOnDisk,
  };
}
