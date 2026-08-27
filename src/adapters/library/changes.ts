import { z } from "zod";
import type { UpstreamBody, UpstreamClient } from "../../http/client.js";
import type {
  ConfigurationPointerKind,
  MediaApplication,
  MediaLookupKind,
  MediaRecordKind,
} from "./model.js";
import {
  count,
  optionalUpstreamId,
  parseUpstream,
  text,
  upstreamId,
  upstreamText,
} from "./parse.js";

/**
 * The Sonarr and Radarr library write adapters.
 *
 * Two rules hold throughout. Nothing here decides whether a mutation may run —
 * the tool layer validates references, current state, and plan freshness, and
 * this module is reached only once it has. And every write is a read-modify-
 * write over the resource the instance itself returned: the fields a validated
 * intent changes are written over that resource and everything else is sent
 * back untouched, because these APIs replace a whole resource and a
 * hand-assembled payload would erase whatever this project does not model.
 */

const recordRoutes: Readonly<Record<MediaRecordKind, string>> = {
  series: "series",
  // A season is not its own upstream resource; it is a member of its series.
  season: "series",
  episode: "episode",
  movie: "movie",
  collection: "collection",
};

const lookupRoutes: Readonly<Record<MediaLookupKind, string>> = {
  series_lookup: "series/lookup",
  movie_lookup: "movie/lookup",
};

const configurationRoutes: Readonly<Record<ConfigurationPointerKind, string>> = {
  quality_profile: "qualityprofile",
  root_folder: "rootfolder",
  tag: "tag",
};

/**
 * The metadata-identifier search term each application answers a candidate
 * lookup for. Both accept a prefixed identifier in place of a title, which is
 * what lets an add intent re-read exactly the candidate its reference names
 * rather than searching for the title again and hoping for the same result.
 */
const lookupTerms: Readonly<Record<MediaLookupKind, (metadataId: number) => string>> = {
  series_lookup: (metadataId) => `tvdb:${metadataId}`,
  movie_lookup: (metadataId) => `tmdb:${metadataId}`,
};

/**
 * One upstream resource, kept whole.
 *
 * Only `id` is modelled, because only `id` is read: everything else travels
 * back to the instance exactly as it arrived. A loose object is what makes that
 * possible — a strict one would drop every field this project does not know
 * about, and the write would then erase them.
 */
const resourceSchema = z.looseObject({ id: upstreamId });

export type UpstreamResource = z.infer<typeof resourceSchema>;

const candidateSchema = z.looseObject({
  id: optionalUpstreamId,
  title: z.string(),
  tvdbId: optionalUpstreamId,
  tmdbId: optionalUpstreamId,
});

const configurationSchema = z.looseObject({
  id: upstreamId,
  name: upstreamText,
  label: upstreamText,
  path: upstreamText,
});

const seasonMemberSchema = z.looseObject({ seasonNumber: upstreamId });

/** One configuration object a mutation depends on, reduced to its identity. */
export interface ConfigurationRecord {
  readonly id: number;
  /** A profile's name, a tag's label, or a root folder's path. */
  readonly name?: string | undefined;
}

/** A metadata candidate an add intent may create a library record from. */
export interface LookupCandidate {
  readonly metadataId: number;
  readonly title: string;
  /** The library record this candidate already is, when the instance says so. */
  readonly existingId?: number | undefined;
  readonly resource: UpstreamResource;
}

export interface AddMediaRequest {
  readonly rootFolderPath: string;
  readonly qualityProfileId: number;
  readonly tagIds: readonly number[];
  /** The normalized monitor selection, already checked against the application. */
  readonly monitor: string;
  readonly searchOnAdd: boolean;
}

/** The typed edits one record-level mutation may carry. */
export interface RecordChanges {
  readonly monitored?: boolean | undefined;
  readonly qualityProfileId?: number | undefined;
  readonly rootFolderPath?: string | undefined;
  readonly seriesType?: string | undefined;
  readonly minimumAvailability?: string | undefined;
  readonly tagIds?: readonly number[] | undefined;
}

export type ResourceRewrite =
  /**
   * The rewritten resource is itself a resource, not merely a body, so a second
   * change to the same record can be applied on top of it rather than on top of
   * a copy that predates the first.
   */
  | { readonly status: "ok"; readonly resource: UpstreamResource; readonly changed: boolean }
  | { readonly status: "blocked"; readonly reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Which applications model which record kind.
 *
 * A season and an episode belong to Sonarr and a collection to Radarr, so the
 * pairing is stated once here rather than being rediscovered by whichever
 * upstream route happened to answer with a 404.
 */
export const recordApplications: Readonly<Record<MediaRecordKind, MediaApplication>> = {
  series: "sonarr",
  season: "sonarr",
  episode: "sonarr",
  movie: "radarr",
  collection: "radarr",
};

/**
 * The monitor selections each application actually models.
 *
 * Sonarr monitors a series at season granularity and names each of these
 * selections itself. Radarr has no equivalent: a movie is monitored or it is
 * not, so the selections that describe part of a series are refused rather than
 * quietly collapsed into "monitored", which would add a record under a rule the
 * caller did not ask for.
 */
export const monitorSelections: Readonly<Record<MediaApplication, readonly string[]>> = {
  sonarr: ["none", "all", "future", "missing", "existing"],
  radarr: ["none", "all"],
};

export function supportsMonitorSelection(application: MediaApplication, monitor: string): boolean {
  return monitorSelections[application].includes(monitor);
}

async function readResource(
  client: UpstreamClient,
  application: MediaApplication,
  route: string,
): Promise<UpstreamResource> {
  return parseUpstream(resourceSchema, await client.get(route), application, route);
}

/**
 * The route of the resource one record lives in.
 *
 * A season resolves to its series, because that is the resource the instance
 * stores it in. Several record kinds therefore share a path, which is exactly
 * why a caller that has to group records by the resource they belong to must
 * group them by this and not by their kind.
 */
export function recordResourcePath(kind: MediaRecordKind, id: number): string {
  return `${recordRoutes[kind]}/${id}`;
}

export function readRecordResource(
  client: UpstreamClient,
  application: MediaApplication,
  kind: MediaRecordKind,
  id: number,
): Promise<UpstreamResource> {
  return readResource(client, application, recordResourcePath(kind, id));
}

/** Sends one whole resource back to the route it was read from. */
export function writeResource(
  client: UpstreamClient,
  path: string,
  resource: UpstreamBody,
): Promise<unknown> {
  return client.put(path, resource);
}

/** Every configuration object of one kind, reduced to identity and name. */
export async function readConfigurationRecords(
  client: UpstreamClient,
  application: MediaApplication,
  kind: ConfigurationPointerKind,
): Promise<readonly ConfigurationRecord[]> {
  const route = configurationRoutes[kind];
  const records = parseUpstream(
    z.array(configurationSchema),
    await client.get(route),
    application,
    route,
  );
  return records.map((record) => ({
    id: record.id,
    name: text(record.name) ?? text(record.label) ?? text(record.path),
  }));
}

/**
 * Re-reads the candidate an add reference names.
 *
 * The lookup is repeated by metadata identifier rather than by the term the
 * caller originally searched for, so the candidate that comes back is the one
 * the reference stands for. Its `id` is what makes duplicate detection possible
 * without a second pass over the whole library: the instance itself reports the
 * library record a candidate already is.
 */
export async function readLookupCandidate(
  client: UpstreamClient,
  application: MediaApplication,
  kind: MediaLookupKind,
  metadataId: number,
): Promise<LookupCandidate | undefined> {
  const route = lookupRoutes[kind];
  const body = await client.get(route, { term: lookupTerms[kind](metadataId) });
  const results = parseUpstream(z.array(candidateSchema), body, application, route);
  const match = results.find(
    (result) => count(kind === "series_lookup" ? result.tvdbId : result.tmdbId) === metadataId,
  );
  if (match === undefined) {
    return undefined;
  }
  const existingId = count(match.id);
  return {
    metadataId,
    title: match.title,
    existingId: existingId !== undefined && existingId > 0 ? existingId : undefined,
    resource: { ...match, id: existingId ?? 0 },
  };
}

/**
 * Builds the create payload for one candidate.
 *
 * The candidate resource the instance returned is the base, so an add sends
 * back the metadata the application itself produced; only the caller's explicit
 * choices are written over it. Search-on-add is passed through exactly as
 * supplied and is never defaulted to true here or anywhere below.
 */
export function addMediaPayload(
  application: MediaApplication,
  candidate: LookupCandidate,
  request: AddMediaRequest,
): UpstreamBody {
  const monitored = request.monitor !== "none";
  const shared = {
    ...candidate.resource,
    id: 0,
    rootFolderPath: request.rootFolderPath,
    qualityProfileId: request.qualityProfileId,
    monitored,
    tags: [...request.tagIds],
  };

  return application === "sonarr"
    ? {
        ...shared,
        addOptions: {
          monitor: request.monitor,
          searchForMissingEpisodes: request.searchOnAdd,
          searchForCutoffUnmetEpisodes: false,
        },
      }
    : {
        ...shared,
        addOptions: {
          monitor: monitored ? "movieOnly" : "none",
          searchForMovie: request.searchOnAdd,
        },
      };
}

/**
 * Creates one library record and confirms what came back.
 *
 * A create is confirmed by the record the instance returns, so the answer is
 * held to actually being one: an empty body is reported as unconfirmed, and a
 * body that is not a record with a real identifier is an unexpected response
 * rather than a success. Neither is treated as a failure, because the request
 * was sent and may well have been accepted.
 */
export async function createMedia(
  client: UpstreamClient,
  application: MediaApplication,
  payload: UpstreamBody,
): Promise<UpstreamResource | undefined> {
  const route = application === "sonarr" ? recordRoutes.series : recordRoutes.movie;
  const body = await client.post(route, payload);
  if (body === undefined) {
    return undefined;
  }
  const created = parseUpstream(resourceSchema, body, application, route);
  return created.id > 0 ? created : undefined;
}

/**
 * Radarr's own spelling of each normalized availability value.
 *
 * The published surface names these concepts in its own vocabulary, so the one
 * that is two words upstream has to be translated on the way out; sending the
 * normalized spelling would either be rejected or set an availability the
 * caller did not ask for. Every other value this project writes — the series
 * types, the monitor selections — is already spelled identically upstream and
 * needs no table of its own.
 */
const radarrAvailabilityValues: Readonly<Record<string, string>> = {
  tba: "tba",
  announced: "announced",
  in_cinemas: "inCinemas",
  released: "released",
};

function radarrAvailability(value: string): string {
  return radarrAvailabilityValues[value] ?? value;
}

/** The folder a path ends in, which is what a record keeps when its root moves. */
function folderName(path: string): string | undefined {
  const trimmed = path.replace(/[\\/]+$/u, "");
  const separator = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  const name = separator < 0 ? trimmed : trimmed.slice(separator + 1);
  return name === "" ? undefined : name;
}

/**
 * Places a record's own folder under a different root.
 *
 * The separator is taken from the root the instance reported rather than from
 * this process, because the instance may well run on a different platform than
 * the server does. Neither half is caller-authored: the root comes from the
 * instance's own root-folder list and the folder name from the record's current
 * path, so no supplied string can steer where a record points.
 *
 * Exported because a move has to arrive at the same answer this does. Re-pointing
 * a record without touching the disk and asking the application to move it are
 * two requests about one destination, and computing that destination twice is
 * how they would come to disagree about where the record ends up.
 */
export function relocatePath(currentPath: string, rootFolderPath: string): string | undefined {
  const name = folderName(currentPath);
  if (name === undefined) {
    return undefined;
  }
  const root = rootFolderPath.replace(/[\\/]+$/u, "");
  const separator = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  return `${root}${separator}${name}`;
}

function seasonMembers(resource: UpstreamResource): readonly unknown[] {
  const seasons = resource.seasons;
  return Array.isArray(seasons) ? seasons : [];
}

/**
 * Rewrites one season's monitored flag inside its series resource.
 *
 * The rest of the season list is carried through untouched, so a change to one
 * season cannot silently re-state the monitoring of the others.
 */
function rewriteSeason(
  resource: UpstreamResource,
  seasonNumber: number,
  monitored: boolean,
): ResourceRewrite {
  const members = seasonMembers(resource);
  const parsed = members.map((member) => seasonMemberSchema.safeParse(member));
  const index = parsed.findIndex(
    (member) => member.success && member.data.seasonNumber === seasonNumber,
  );
  const current = parsed[index];
  if (index < 0 || current === undefined || !current.success) {
    return { status: "blocked", reason: "that season is no longer part of this series" };
  }

  const changed = current.data.monitored !== monitored;
  return {
    status: "ok",
    changed,
    resource: {
      ...resource,
      seasons: members.map((member, position) =>
        position === index && isRecord(member) ? { ...member, monitored } : member,
      ),
    },
  };
}

export interface RewriteOptions {
  readonly kind: MediaRecordKind;
  /** Set when the change targets one season of the series resource in hand. */
  readonly seasonNumber?: number | undefined;
  readonly changes: RecordChanges;
}

/**
 * Writes the typed changes over the resource the instance returned.
 *
 * A field the intent did not name is not touched, and the answer says whether
 * anything actually differs — an item already in the requested state is worth
 * reporting as such rather than sending an identical resource back and calling
 * it a change.
 */
export function rewriteResource(
  resource: UpstreamResource,
  options: RewriteOptions,
): ResourceRewrite {
  const changes = options.changes;
  if (options.seasonNumber !== undefined) {
    if (changes.monitored === undefined) {
      return { status: "blocked", reason: "a season accepts only a monitoring change" };
    }
    return rewriteSeason(resource, options.seasonNumber, changes.monitored);
  }

  const rewritten: UpstreamResource = { ...resource };
  let changed = false;
  const set = (property: string, value: unknown): void => {
    if (rewritten[property] !== value) {
      changed = true;
    }
    rewritten[property] = value;
  };

  if (changes.monitored !== undefined) {
    set("monitored", changes.monitored);
  }
  if (changes.qualityProfileId !== undefined) {
    set("qualityProfileId", changes.qualityProfileId);
  }
  if (changes.seriesType !== undefined) {
    set("seriesType", changes.seriesType);
  }
  if (changes.minimumAvailability !== undefined) {
    set("minimumAvailability", radarrAvailability(changes.minimumAvailability));
  }
  if (changes.tagIds !== undefined) {
    const current = Array.isArray(resource.tags) ? resource.tags : [];
    const wanted = [...changes.tagIds];
    if (current.length !== wanted.length || wanted.some((tag, index) => current[index] !== tag)) {
      changed = true;
    }
    rewritten.tags = wanted;
  }
  if (changes.rootFolderPath !== undefined) {
    const currentPath = text(typeof resource.path === "string" ? resource.path : undefined);
    if (currentPath === undefined) {
      return {
        status: "blocked",
        reason: "this record reports no current path, so its root folder cannot be changed",
      };
    }
    const relocated = relocatePath(currentPath, changes.rootFolderPath);
    if (relocated === undefined) {
      return { status: "blocked", reason: "this record's current path names no folder to move" };
    }
    set("rootFolderPath", changes.rootFolderPath);
    set("path", relocated);
  }

  return { status: "ok", changed, resource: rewritten };
}

/**
 * The state one record's read set is built from.
 *
 * Everything a change here depends on is listed, and nothing else is: the
 * fingerprint has to move when the record's monitoring, profile, tags, type, or
 * location moves, and must not move because an unrelated field of a large
 * resource did. The parts are named in a fixed order authored here.
 */
export function recordState(
  resource: UpstreamResource,
  seasonNumber?: number,
): Readonly<Record<string, unknown>> {
  if (seasonNumber !== undefined) {
    const member = seasonMembers(resource)
      .map((season) => seasonMemberSchema.safeParse(season))
      .find((season) => season.success && season.data.seasonNumber === seasonNumber);
    return {
      id: resource.id,
      seasonNumber,
      present: member?.success === true,
      monitored: member?.success === true ? member.data.monitored : undefined,
    };
  }

  return {
    id: resource.id,
    monitored: resource.monitored,
    qualityProfileId: resource.qualityProfileId,
    path: resource.path,
    rootFolderPath: resource.rootFolderPath,
    seriesType: resource.seriesType,
    minimumAvailability: resource.minimumAvailability,
    tags: Array.isArray(resource.tags) ? resource.tags : undefined,
  };
}

/** The current tag list of a record, as the identifiers an edit works from. */
export function currentTagIds(resource: UpstreamResource): readonly number[] {
  const tags = resource.tags;
  return Array.isArray(tags) ? tags.filter((tag): tag is number => typeof tag === "number") : [];
}
