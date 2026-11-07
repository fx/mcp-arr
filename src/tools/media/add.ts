import {
  addMediaPayload,
  type ConfigurationRecord,
  createMedia,
  type LookupCandidate,
  type QualityProfileRecord,
  readConfigurationRecords,
  readLookupCandidate,
  readQualityProfiles,
  readRecordResource,
} from "../../adapters/library/changes.js";
import type { ApplicationAdapter } from "../../adapters/registry.js";
import { toolErrorProvesNoEffect } from "../errors.js";
import type { MediaContext } from "./context.js";
import {
  type DeploymentProblem,
  deploymentError,
  type MediaError,
  mediaError,
  mediaErrorFor,
} from "./errors.js";
import { kindRoutes, type TitleKind } from "./kinds.js";
import { kindAdapter } from "./probe.js";
import {
  chooseProfile,
  profileResolution,
  type RatedProfile,
  type Resolution,
  rateProfile,
} from "./resolution.js";
import type { AddOutcome, AddResult, EpisodeChoice } from "./schemas.js";

export interface AddRequest {
  readonly kind: TitleKind;
  readonly id: number;
  readonly resolution?: Resolution | undefined;
  /** Series only; the schema refuses it for a movie. */
  readonly episodes?: EpisodeChoice | undefined;
}

/** Warned when an existing title's target resolution could not be read. */
const unreadResolutionWarning =
  "the resolution this title already targets could not be read, so none is reported";

function failed(...errors: readonly MediaError[]): AddResult {
  return { warnings: [], errors: [...errors] };
}

function succeeded(
  request: AddRequest,
  candidate: LookupCandidate,
  outcome: AddOutcome,
  resolution: Resolution | undefined,
  warnings: readonly string[] = [],
): AddResult {
  return {
    kind: request.kind,
    id: request.id,
    title: candidate.title,
    outcome,
    ...(resolution === undefined ? {} : { resolution }),
    warnings: [...warnings],
    errors: [],
  };
}

type Read<TValue> =
  | { readonly ok: true; readonly value: TValue }
  | { readonly ok: false; readonly error: MediaError };

async function attempt<TValue>(
  kind: TitleKind,
  read: () => Promise<TValue>,
): Promise<Read<TValue>> {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    return { ok: false, error: mediaErrorFor(kind, error) };
  }
}

function readCandidate(
  adapter: ApplicationAdapter,
  kind: TitleKind,
  id: number,
): Promise<Read<LookupCandidate | undefined>> {
  const route = kindRoutes[kind];
  return attempt(kind, () =>
    readLookupCandidate(adapter.client, route.application, route.lookup, id),
  );
}

function profileIdOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/**
 * The resolution the profile an existing title has targets.
 *
 * The lookup already carries the library record's profile for a title in the
 * library; the record itself is read only where it does not. Any failure here
 * costs the result its resolution and nothing else, because the outcome —
 * already in the library — is known regardless.
 */
async function existingResolution(
  adapter: ApplicationAdapter,
  kind: TitleKind,
  candidate: LookupCandidate,
  profiles: readonly QualityProfileRecord[] | undefined,
): Promise<{ readonly resolution: Resolution | undefined; readonly warnings: readonly string[] }> {
  const route = kindRoutes[kind];
  try {
    let profileId = profileIdOf(candidate.resource.qualityProfileId);
    if (profileId === undefined && candidate.existingId !== undefined) {
      const record = await readRecordResource(
        adapter.client,
        route.application,
        route.record,
        candidate.existingId,
      );
      profileId = profileIdOf(record.qualityProfileId);
    }
    const known = profiles ?? (await readQualityProfiles(adapter.client, route.application));
    const profile = known.find((candidateProfile) => candidateProfile.id === profileId);
    const resolution = profile === undefined ? undefined : profileResolution(profile);
    return {
      resolution,
      warnings: profile === undefined ? [unreadResolutionWarning] : [],
    };
  } catch {
    return { resolution: undefined, warnings: [unreadResolutionWarning] };
  }
}

interface ChosenDefaults {
  readonly rootFolderPath: string;
  readonly profile: RatedProfile;
}

/**
 * Picks the root folder and quality profile a new title is added with.
 *
 * Names and paths are matched exactly as the operator wrote them; a default
 * that names nothing on the instance is reported rather than replaced, whether
 * or not the call asked for a resolution, so a stale setting is never silently
 * bypassed. Every problem is collected, so one call tells the operator
 * everything that has to change.
 */
function chooseDefaults(
  context: MediaContext,
  request: AddRequest,
  folders: readonly ConfigurationRecord[],
  profiles: readonly QualityProfileRecord[],
):
  | { readonly ok: true; readonly value: ChosenDefaults }
  | { readonly ok: false; readonly problems: readonly DeploymentProblem[] } {
  const defaults = context.defaults[request.kind];
  const problems: DeploymentProblem[] = [];

  let rootFolderPath: string | undefined;
  if (defaults.rootFolder !== undefined) {
    rootFolderPath = folders.find((folder) => folder.name === defaults.rootFolder)?.name;
    if (rootFolderPath === undefined) {
      problems.push({ setting: "rootFolder", reason: "unknown" });
    }
  } else if (folders.length === 1) {
    rootFolderPath = folders[0]?.name;
    if (rootFolderPath === undefined) {
      problems.push({ setting: "rootFolder", reason: "none" });
    }
  } else {
    problems.push({ setting: "rootFolder", reason: folders.length === 0 ? "none" : "ambiguous" });
  }

  const rated = profiles.map(rateProfile);
  const configured =
    defaults.qualityProfile === undefined
      ? undefined
      : rated.find((profile) => profile.profile.name === defaults.qualityProfile);
  if (defaults.qualityProfile !== undefined && configured === undefined) {
    problems.push({ setting: "qualityProfile", reason: "unknown" });
  }

  let profile: RatedProfile | undefined;
  if (request.resolution !== undefined) {
    profile = chooseProfile(rated, request.resolution, defaults.qualityProfile);
    if (profile === undefined) {
      problems.push({ setting: "resolution" });
    }
  } else if (defaults.qualityProfile !== undefined) {
    profile = configured;
  } else if (rated.length === 1) {
    profile = rated[0];
  } else {
    problems.push({
      setting: "qualityProfile",
      reason: rated.length === 0 ? "none" : "ambiguous",
    });
  }

  if (problems.length > 0 || rootFolderPath === undefined || profile === undefined) {
    return { ok: false, problems };
  }
  return { ok: true, value: { rootFolderPath, profile } };
}

/**
 * What became of a create the instance did not confirm.
 *
 * The candidate is read again: if it is now a library record, the outcome is
 * decided by whether the create can have acted. A refusal that proves nothing
 * happened means another call added the title in the meantime, so it was
 * already in the library; anything else — an answer that never arrived, or one
 * that confirmed nothing — leaves this call as the likeliest author, so it is
 * reported as added.
 */
async function settleUnconfirmed(
  adapter: ApplicationAdapter,
  request: AddRequest,
  chosen: ChosenDefaults,
  profiles: readonly QualityProfileRecord[],
  failure: MediaError | undefined,
): Promise<AddResult> {
  const reread = await readCandidate(adapter, request.kind, request.id);
  const candidate = reread.ok ? reread.value : undefined;
  if (candidate?.existingId === undefined) {
    return failed(failure ?? mediaError(request.kind, "unexpected_response"));
  }
  if (failure !== undefined && toolErrorProvesNoEffect(failure.code)) {
    const existing = await existingResolution(adapter, request.kind, candidate, profiles);
    return succeeded(
      request,
      candidate,
      "already_in_library",
      existing.resolution,
      existing.warnings,
    );
  }
  return succeeded(request, candidate, "added", chosen.profile.resolution);
}

/**
 * Adds one title, or reports that it is already in the library.
 *
 * The duplicate check runs first and on its own: a title already present is
 * reported without consulting any default and without sending anything, so
 * neither a stale default nor a resolution the title does not have can change
 * an existing record. Defaults are resolved against the instance only for a
 * title that is genuinely new, and a problem with them adds nothing.
 */
export async function addTitle(context: MediaContext, request: AddRequest): Promise<AddResult> {
  const kind = request.kind;
  const route = kindRoutes[kind];
  const served = await kindAdapter(context, kind);
  if (!served.ok) {
    return failed(served.error);
  }
  const adapter = served.adapter;

  const read = await readCandidate(adapter, kind, request.id);
  if (!read.ok) {
    return failed(read.error);
  }
  const candidate = read.value;
  if (candidate === undefined) {
    return failed(mediaError(kind, "not_found"));
  }
  if (candidate.existingId !== undefined) {
    const existing = await existingResolution(adapter, kind, candidate, undefined);
    return succeeded(
      request,
      candidate,
      "already_in_library",
      existing.resolution,
      existing.warnings,
    );
  }

  const [folders, profiles] = await Promise.all([
    attempt(kind, () => readConfigurationRecords(adapter.client, route.application, "root_folder")),
    attempt(kind, () => readQualityProfiles(adapter.client, route.application)),
  ]);
  if (!folders.ok) {
    return failed(folders.error);
  }
  if (!profiles.ok) {
    return failed(profiles.error);
  }
  const chosen = chooseDefaults(context, request, folders.value, profiles.value);
  if (!chosen.ok) {
    return failed(...chosen.problems.map((problem) => deploymentError(kind, problem)));
  }

  const payload = addMediaPayload(route.application, candidate, {
    rootFolderPath: chosen.value.rootFolderPath,
    qualityProfileId: chosen.value.profile.profile.id,
    tagIds: [],
    monitor: kind === "series" ? (request.episodes ?? "all") : "all",
    searchOnAdd: true,
  });
  let created: Awaited<ReturnType<typeof createMedia>>;
  try {
    created = await createMedia(adapter.client, route.application, payload);
  } catch (error) {
    const failure = mediaErrorFor(kind, error);
    return settleUnconfirmed(adapter, request, chosen.value, profiles.value, failure);
  }
  if (created === undefined) {
    return settleUnconfirmed(adapter, request, chosen.value, profiles.value, undefined);
  }
  return succeeded(request, candidate, "added", chosen.value.profile.resolution);
}
