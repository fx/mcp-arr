import { z } from "zod";
import type { UpstreamClient } from "../../http/client.js";
import {
  matchOption,
  type NamedOption,
  readLanguageOptions,
  readQualityOptions,
} from "../library/files.js";
import type { MediaApplication } from "../library/model.js";
import { count, parseUpstream, upstreamNumber, upstreamText } from "../library/parse.js";
import {
  type CandidateOrigin,
  reprocessCandidate,
  type UpstreamMappingPatch,
} from "./candidates.js";
import type { ImportCandidate, ImportCandidateContext, ImportRejection } from "./model.js";
import { isRecordIdentifier } from "./model.js";

/**
 * Manual-import corrections and the validation an import runs before it starts.
 *
 * A correction is a caller telling this server that the instance guessed wrong
 * about one of its own files. Three rules follow, and they are what this module
 * is.
 *
 * **The accepted corrections are a closed set, named here.** Five things may be
 * corrected — which series or movie the file belongs to, which episodes, its
 * quality, its languages, its release group — and the compilation below names
 * each one. Nothing is copied from a caller's object into the upstream payload:
 * a media reference becomes an identifier this server resolved, and a quality
 * or a language becomes an object read from the instance's own definitions.
 * Manual import is the surface whose payload names files on disk, so a
 * passthrough here would be the worst place in the project to have one.
 *
 * **Reprocessing is not importing.** The endpoint re-runs the application's
 * decision engine and answers with what it would do; it moves nothing. What a
 * correction produces is a new candidate, still un-imported, whose rejections
 * are the current ones.
 *
 * **Validation before an import is validation.** It re-runs that same
 * reprocessing with the exact mapping the caller selected, and then checks that
 * the file, the queue row, the media record, and the free space are still what
 * the candidate was validated against. A blocking rejection or a moved
 * fingerprint stops it, and neither is inferred from the other.
 */

/**
 * The corrections a caller may make, as they arrive.
 *
 * This mirrors the published schema exactly, and deliberately: the schema
 * decides what may be *asked for*, and this decides what may be *sent*. Both
 * lists are five long and name the same five things, so a field added to one
 * without the other fails to compile rather than quietly widening the surface.
 * The media and episode identifiers are already resolved, because only the tool
 * layer can turn an opaque reference into one; the quality and language names
 * are still names, because only this layer can read what the instance defines.
 */
export interface MappingCorrections {
  readonly mediaId?: number | undefined;
  readonly episodeIds?: readonly number[] | undefined;
  readonly quality?: string | undefined;
  readonly languages?: readonly string[] | undefined;
  readonly releaseGroup?: string | undefined;
}

/** The corrected fields, once each has been resolved against the instance. */
export interface CompiledCorrections {
  readonly patch: UpstreamMappingPatch;
  /** What changed, named for the plan to disclose. Empty when nothing did. */
  readonly corrected: readonly string[];
}

export type CompileResult =
  | { readonly status: "ok"; readonly compiled: CompiledCorrections }
  | { readonly status: "invalid"; readonly reason: string };

/**
 * Turns the caller's corrections into the payload fields they stand for.
 *
 * Each list the instance defines is read at most once, and only where the
 * correction names something from it, so correcting a release group costs no
 * request at all. A name the instance does not define is refused rather than
 * sent: these applications would either reject it or store a value nothing
 * recognizes, and both are worse than saying which name was not found.
 */
export async function compileCorrections(
  client: UpstreamClient,
  application: MediaApplication,
  corrections: MappingCorrections,
): Promise<CompileResult> {
  const corrected: string[] = [];
  const patch: {
    mediaId?: number;
    episodeIds?: readonly number[];
    quality?: unknown;
    languages?: readonly unknown[];
    releaseGroup?: string;
  } = {};

  if (corrections.mediaId !== undefined) {
    // Held to the same rule every retained identifier is. A correction naming a
    // record number this project would refuse to store is refused here instead
    // of producing a candidate that can never be named.
    if (!isRecordIdentifier(corrections.mediaId)) {
      return { status: "invalid", reason: "that is not a media record this server can name" };
    }
    patch.mediaId = corrections.mediaId;
    corrected.push("media");
  }

  if (corrections.episodeIds !== undefined) {
    if (!corrections.episodeIds.every(isRecordIdentifier)) {
      return { status: "invalid", reason: "that is not an episode this server can name" };
    }
    if (application !== "sonarr") {
      return {
        status: "invalid",
        reason: "only a series application maps a file to episodes",
      };
    }
    patch.episodeIds = [...corrections.episodeIds];
    corrected.push("episodes");
  }

  if (corrections.quality !== undefined) {
    const matched = matchOption(await readQualityOptions(client, application), corrections.quality);
    if (matched === undefined) {
      return {
        status: "invalid",
        reason: `this instance defines no quality named “${corrections.quality}”`,
      };
    }
    patch.quality = matched.resource;
    corrected.push("quality");
  }

  if (corrections.languages !== undefined) {
    const options = await readLanguageOptions(client, application);
    const resolved: NamedOption[] = [];
    for (const name of corrections.languages) {
      const matched = matchOption(options, name);
      if (matched === undefined) {
        return { status: "invalid", reason: `this instance knows no language named “${name}”` };
      }
      resolved.push(matched);
    }
    patch.languages = resolved.map((option) => option.resource);
    corrected.push("languages");
  }

  if (corrections.releaseGroup !== undefined) {
    patch.releaseGroup = corrections.releaseGroup;
    corrected.push("release group");
  }

  return { status: "ok", compiled: { patch, corrected } };
}

/**
 * The rejections that stop an import, as opposed to those that only describe it.
 *
 * A permanent rejection will not pass however many times it is retried, so it
 * blocks. A temporary one may pass later but does not pass now, so it blocks
 * too — the question here is whether *this* import may start, not whether one
 * ever could. An unknown type blocks for the reason every unreadable answer in
 * this project does: it is not evidence that proceeding is safe.
 *
 * In other words every rejection blocks, and this function exists to say so in
 * one place rather than to have each caller decide. The specification is
 * unambiguous — a candidate carrying a blocking rejection is not eligible for
 * execution — and a classification with an exception in it would be the seam
 * where one gets through.
 */
export function blockingRejections(candidate: ImportCandidate): readonly ImportRejection[] {
  return candidate.decision.rejections;
}

/** Whether this candidate may be imported at all, as it currently stands. */
export function isImportable(candidate: ImportCandidate): boolean {
  return candidate.decision.importable && blockingRejections(candidate).length === 0;
}

/**
 * The retained facts a re-decided candidate has to still agree with.
 *
 * Each is compared because each decides something about the import: the file
 * digest says it is the same file, the size says the file did not change
 * underneath it, the media and episode mapping says it imports to where the
 * caller was shown, the existing-file identity says whether this is an import
 * at all, and the importability says the instance's own answer has not moved.
 *
 * The scan's own origin is deliberately not compared here: it is what the
 * reprocess was re-derived *from*, so it cannot disagree, and a check that
 * cannot fail is one that implies a guarantee nobody holds.
 */
export function staleFacts(
  retained: ImportCandidateContext,
  current: ImportCandidate,
): readonly string[] {
  const context = current.context;
  const moved: string[] = [];
  const compare = (name: string, before: unknown, after: unknown): void => {
    if (JSON.stringify(before ?? null) !== JSON.stringify(after ?? null)) {
      moved.push(name);
    }
  };

  compare("file", retained.fileIdentity, context.fileIdentity);
  compare("size", retained.sizeBytes, context.sizeBytes);
  compare("media", retained.mediaId, context.mediaId);
  compare("season", retained.seasonNumber, context.seasonNumber);
  compare(
    "episodes",
    [...(retained.episodeIds ?? [])].sort((left, right) => left - right),
    [...(context.episodeIds ?? [])].sort((left, right) => left - right),
  );
  compare("existing file", retained.existingFileId, context.existingFileId);
  compare("importable", retained.importable, context.importable);
  return moved;
}

const diskSpaceRoute = "diskspace";

const diskSpaceSchema = z.object({
  path: upstreamText,
  freeSpace: upstreamNumber,
  totalSpace: upstreamNumber,
});

/**
 * Whether the destination has room for the file, and by how much.
 *
 * The margin is bytes rather than a path: what a caller needs to know is
 * whether the import fits, and naming the mount it would land on would disclose
 * a server location for no gain. An instance that reports no disk space at all
 * yields `unknown` rather than a pass — this is a precondition, and a
 * precondition nobody checked has not been met.
 */
export interface FreeSpaceCheck {
  readonly status: "sufficient" | "insufficient" | "unknown";
  /** Free bytes on the mount the file would land on, where one was reported. */
  readonly freeBytes?: number | undefined;
  readonly requiredBytes?: number | undefined;
}

/**
 * Reads the free space on the mount a candidate would import to.
 *
 * The mount is chosen by the longest reported path that the destination starts
 * with, which is how a nested mount is distinguished from the root it sits
 * under. Both the destination and the mount paths stay inside this function:
 * what comes out is a verdict and two byte counts.
 */
export async function checkFreeSpace(
  client: UpstreamClient,
  application: MediaApplication,
  destination: string | undefined,
  requiredBytes: number | undefined,
): Promise<FreeSpaceCheck> {
  if (requiredBytes === undefined || destination === undefined) {
    return { status: "unknown" };
  }

  const mounts = parseUpstream(
    z.array(diskSpaceSchema),
    await client.get(diskSpaceRoute),
    application,
    diskSpaceRoute,
  );

  let best: { path: string; free: number } | undefined;
  for (const mount of mounts) {
    const path = mount.path ?? undefined;
    const free = count(mount.freeSpace);
    if (path === undefined || path === "" || free === undefined) {
      continue;
    }
    if (!destination.startsWith(path)) {
      continue;
    }
    if (best === undefined || path.length > best.path.length) {
      best = { path, free };
    }
  }

  if (best === undefined) {
    return { status: "unknown", requiredBytes };
  }
  return {
    status: best.free >= requiredBytes ? "sufficient" : "insufficient",
    freeBytes: best.free,
    requiredBytes,
  };
}

/** Why an import may not start, or nothing where it may. */
export type ImportRefusal =
  | { readonly kind: "absent" }
  | { readonly kind: "unmapped" }
  | { readonly kind: "existing_file" }
  | { readonly kind: "rejected"; readonly rejections: readonly ImportRejection[] }
  | { readonly kind: "stale"; readonly moved: readonly string[] }
  | { readonly kind: "no_space"; readonly space: FreeSpaceCheck };

export interface ImportValidation {
  /** The candidate as the instance decides it now, not as it was inspected. */
  readonly candidate: ImportCandidate;
  readonly space: FreeSpaceCheck;
  /** Set when this candidate may not be imported, and says which check refused. */
  readonly refusal?: ImportRefusal | undefined;
}

export type ImportValidationResult =
  | { readonly status: "ok"; readonly validation: ImportValidation }
  | { readonly status: "refused"; readonly refusal: ImportRefusal };

export interface ImportValidationRequest {
  readonly retained: ImportCandidateContext;
  /** The mapping the caller selected, re-sent exactly as it will be imported. */
  readonly patch: UpstreamMappingPatch;
  /** The path the file would import to, for the space check. Never published. */
  readonly destination?: string | undefined;
}

/**
 * Validates one candidate immediately before its import is submitted.
 *
 * The order is the contract. Reprocessing runs first, because every later check
 * is about what it returned rather than about what was inspected earlier — a
 * validation that trusted the retained candidate would be checking a memory. A
 * file that is gone stops here. Then the retained facts are compared, so a file
 * swapped underneath a validated candidate is stale rather than imported. Then
 * the instance's own decision is honoured: a candidate carrying any rejection
 * does not import, whatever the caller asked for. Then, and only for a
 * candidate that has passed all of that, the destination is checked for room.
 *
 * Nothing here submits anything. It is the gate an import passes through, and
 * the import itself is a later step.
 */
export async function validateForImport(
  client: UpstreamClient,
  application: MediaApplication,
  request: ImportValidationRequest,
): Promise<ImportValidationResult> {
  const retained = request.retained;
  const origin: CandidateOrigin = {
    sourceKind: retained.sourceKind,
    queueItemId: retained.queueItemId,
    scanMediaId: retained.scanMediaId,
    seasonNumber: retained.seasonNumber,
    mediaId: retained.mediaId,
  };

  const reprocessed = await reprocessCandidate(
    client,
    application,
    origin,
    retained.fileIdentity,
    request.patch,
  );
  if (reprocessed.status !== "ok") {
    return { status: "refused", refusal: { kind: reprocessed.status } };
  }
  const candidate = reprocessed.candidate;

  // Checked before the rejections, because a candidate that is not an import at
  // all has a different remedy than one the instance refused: the caller is
  // directed to the library-file workflow rather than told to fix a mapping.
  if (candidate.existingLibraryFile) {
    return { status: "refused", refusal: { kind: "existing_file" } };
  }

  const moved = staleFacts(retained, candidate);
  if (moved.length > 0) {
    return { status: "refused", refusal: { kind: "stale", moved } };
  }

  const rejections = blockingRejections(candidate);
  if (rejections.length > 0 || !candidate.decision.importable) {
    return { status: "refused", refusal: { kind: "rejected", rejections } };
  }

  const space = await checkFreeSpace(client, application, request.destination, candidate.sizeBytes);
  if (space.status === "insufficient") {
    return { status: "refused", refusal: { kind: "no_space", space } };
  }

  return { status: "ok", validation: { candidate, space } };
}
