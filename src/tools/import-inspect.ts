import {
  type CandidateScanResult,
  reprocessCandidate,
  scanLibraryContext,
  scanTrackedDownload,
} from "../adapters/import/candidates.js";
import { compileCorrections } from "../adapters/import/corrections.js";
import type { ImportCandidate } from "../adapters/import/model.js";
import type { MediaApplication } from "../adapters/library/model.js";
import { isMediaApplication } from "../adapters/library/model.js";
import { decodePageCursor, encodePageCursor, queryDigest } from "../adapters/library/paging.js";
import { resolveQueueReference } from "./activity-references.js";
import { createToolError, type ToolError, toolErrorForReferenceFailure } from "./errors.js";
import { mintCandidateReference, resolveCandidateReference } from "./import-references.js";
import type { OperationHandler, OperationInvocation } from "./operations.js";
import { importInspectInputSchema } from "./schemas/acquisition.js";
import type { Continuation } from "./schemas/common.js";

/**
 * The `arr_import_inspect` handler.
 *
 * It is the only way a candidate reference comes into existence, which makes it
 * the boundary the whole manual-import surface rests on: a caller reaches a file
 * by asking about a queue row or a library record, never by naming a location,
 * and what comes back names each file by a token and a bare file name. The
 * adapter has already decided what may leave; this mints the references and
 * pages the answer.
 *
 * Reprocessing lives here rather than beside the import because it changes
 * nothing: it asks the application to re-decide a mapping and returns what it
 * said, which is a read however much it looks like a correction.
 */

const contextKind = "import-inspect";

function invalid(invocation: OperationInvocation, message: string): ToolError {
  return createToolError({
    code: "invalid_input",
    message: `${invocation.application}: ${message}`,
    application: invocation.application,
  });
}

type Resolved<TValue> =
  | { readonly ok: true; readonly value: TValue }
  | { readonly ok: false; readonly error: ToolError };

interface PublishedCandidate {
  readonly reference: string;
  readonly fileName?: string | undefined;
  readonly sizeBytes?: number | undefined;
  readonly seasonNumber?: number | undefined;
  readonly quality?: ImportCandidate["quality"];
  readonly languages?: readonly string[] | undefined;
  readonly releaseGroup?: string | undefined;
  readonly releaseType?: string | undefined;
  readonly customFormats?: readonly string[] | undefined;
  readonly customFormatScore?: number | undefined;
  readonly indexerFlags?: readonly string[] | undefined;
  readonly decision: ImportCandidate["decision"];
  readonly existingLibraryFile: boolean;
  readonly sourceKind: ImportCandidate["sourceKind"];
}

/**
 * Publishes one candidate, named by a reference this call mints.
 *
 * Built one property at a time, like every other model-facing mapping in this
 * project: the adapter's candidate carries a retained context that must not
 * leave, and a spread would take it with it.
 */
function publishCandidate(
  invocation: OperationInvocation,
  candidate: ImportCandidate,
): PublishedCandidate | undefined {
  const reference = mintCandidateReference(invocation.state.references, candidate);
  if (reference === undefined) {
    return undefined;
  }
  return {
    reference,
    fileName: candidate.fileName,
    sizeBytes: candidate.sizeBytes,
    seasonNumber: candidate.seasonNumber,
    quality: candidate.quality,
    languages: candidate.languages,
    releaseGroup: candidate.releaseGroup,
    releaseType: candidate.releaseType,
    customFormats: candidate.customFormats,
    customFormatScore: candidate.customFormatScore,
    indexerFlags: candidate.indexerFlags,
    decision: candidate.decision,
    existingLibraryFile: candidate.existingLibraryFile,
    sourceKind: candidate.sourceKind,
  };
}

function mediaIdOf(invocation: OperationInvocation, token: string): Resolved<number> {
  const resolution = invocation.state.references.resolve(token, "media");
  if (!resolution.ok) {
    return {
      ok: false,
      error: toolErrorForReferenceFailure(resolution.reason, "media", invocation.application),
    };
  }
  const entry = resolution.entry;
  if (!entry.applications.includes(invocation.application)) {
    return { ok: false, error: invalid(invocation, "media names a different application") };
  }
  if (entry.payload.kind !== "domain") {
    return { ok: false, error: invalid(invocation, "media does not name a library record") };
  }
  const upstreamId = entry.payload.snapshot.upstreamId;
  const id = /^\d+$/u.test(upstreamId) ? Number(upstreamId) : Number.NaN;
  return Number.isSafeInteger(id)
    ? { ok: true, value: id }
    : { ok: false, error: invalid(invocation, "media does not name a single record") };
}

function scanRefusal(invocation: OperationInvocation, status: "absent" | "unmapped"): ToolError {
  return status === "absent"
    ? createToolError({
        code: "stale_reference",
        message: `${invocation.application}: that download or record is no longer there; repeat the query the reference came from`,
        application: invocation.application,
      })
    : invalid(
        invocation,
        "that download or record names no location on this application, so there is nothing to inspect",
      );
}

interface InspectInput {
  readonly source: "queue_item" | "library_context" | "candidate_reprocess";
  readonly queue?: string;
  readonly media?: string;
  readonly seasonNumber?: number;
  readonly candidate?: string;
  readonly mapping?: {
    readonly media?: string;
    readonly episodes?: readonly string[];
    readonly quality?: string;
    readonly languages?: readonly string[];
    readonly releaseGroup?: string;
  };
  readonly pageSize: number;
  readonly cursor?: string;
}

export const importInspectHandler: OperationHandler = async (invocation) => {
  const application = invocation.application;
  if (!isMediaApplication(application)) {
    return {
      status: "error",
      error: invalid(invocation, "manual import is a Sonarr and Radarr workflow"),
    };
  }
  const parsed = importInspectInputSchema.safeParse(invocation.input);
  if (!parsed.success) {
    return {
      status: "error",
      error: invalid(invocation, "the arguments do not match the arr_import_inspect input schema"),
    };
  }
  const input = parsed.data as InspectInput;

  return input.source === "candidate_reprocess"
    ? reprocess(invocation, application, input)
    : scan(invocation, application, input);
};

/**
 * The page window one scan answers within.
 *
 * The digest binds a continuation to the query that produced it, exactly as the
 * library and configuration readers do, so a cursor cannot carry a caller from
 * one scan into another's results.
 */
function windowFor(invocation: OperationInvocation, input: InspectInput) {
  const digest = queryDigest([
    invocation.application,
    input.source,
    input.queue ?? input.media ?? "",
    input.seasonNumber,
    input.pageSize,
  ]);
  if (input.cursor === undefined) {
    return { ok: true as const, digest, offset: 0 };
  }
  const decoded = decodePageCursor(input.cursor, digest);
  return decoded.ok
    ? { ok: true as const, digest, offset: decoded.offset }
    : { ok: false as const, digest, offset: 0 };
}

async function scan(
  invocation: OperationInvocation,
  application: MediaApplication,
  input: InspectInput,
): Promise<Awaited<ReturnType<OperationHandler>>> {
  const paging = windowFor(invocation, input);
  if (!paging.ok) {
    return {
      status: "error",
      error: invalid(
        invocation,
        "that continuation belongs to a different scan; repeat the first page with these arguments",
      ),
    };
  }
  const window = { offset: paging.offset, pageSize: input.pageSize };

  // The published schema pairs each source with the reference it requires, so a
  // missing one is a shape this handler was never given. It is refused rather
  // than stood in for: an empty token would be resolved, refused, and reported
  // as a reference the caller supplied, which is not what happened.
  const token = input.source === "queue_item" ? input.queue : input.media;
  if (token === undefined) {
    return {
      status: "error",
      error: invalid(invocation, "that source names no reference to inspect"),
    };
  }

  let result: CandidateScanResult;
  if (input.source === "queue_item") {
    const resolved = resolveQueueReference(invocation.state.references, token, application);
    if (!resolved.ok) {
      return { status: "error", error: resolved.error };
    }
    result = await scanTrackedDownload(
      invocation.adapter.client,
      application,
      { queueItemId: resolved.value.queueItemId, mediaId: resolved.value.mediaId },
      window,
    );
  } else {
    const media = mediaIdOf(invocation, token);
    if (!media.ok) {
      return { status: "error", error: media.error };
    }
    result = await scanLibraryContext(
      invocation.adapter.client,
      application,
      { mediaId: media.value, seasonNumber: input.seasonNumber },
      window,
    );
  }

  if (result.status !== "ok") {
    return { status: "error", error: scanRefusal(invocation, result.status) };
  }

  const published = result.scan.items.flatMap((candidate) => {
    const entry = publishCandidate(invocation, candidate);
    return entry === undefined ? [] : [entry];
  });
  const continuation: Continuation = {
    pageSize: input.pageSize,
    returned: published.length,
    hasMore: result.scan.hasMore,
    ...(result.scan.hasMore
      ? { cursor: encodePageCursor(paging.digest, paging.offset + input.pageSize) }
      : {}),
  };

  return {
    status: "ok",
    data: { source: input.source, candidates: published },
    continuation,
    warnings: [
      ...(result.scan.warnings ?? []),
      ...(published.length === result.scan.items.length
        ? []
        : [
            `${String(result.scan.items.length - published.length)} of the file(s) this instance returned cannot be named by a reference and are not shown`,
          ]),
    ],
  };
}

/**
 * Re-decides one candidate with an explicit correction.
 *
 * It imports nothing, which is why it is a read: the application re-runs its
 * own decision engine and answers with what it would do, and the caller gets a
 * new reference bound to the mapping it just saw.
 */
async function reprocess(
  invocation: OperationInvocation,
  application: MediaApplication,
  input: InspectInput,
): Promise<Awaited<ReturnType<OperationHandler>>> {
  if (input.candidate === undefined) {
    return {
      status: "error",
      error: invalid(invocation, "reprocessing names no candidate to re-decide"),
    };
  }
  const resolved = resolveCandidateReference(
    invocation.state.references,
    input.candidate,
    application,
    "candidate",
  );
  if (!resolved.ok) {
    return { status: "error", error: resolved.error };
  }
  const retained = resolved.value;

  const mapping = input.mapping ?? {};
  const mediaId = mapping.media === undefined ? undefined : mediaIdOf(invocation, mapping.media);
  if (mediaId !== undefined && !mediaId.ok) {
    return { status: "error", error: mediaId.error };
  }
  const episodeIds: number[] = [];
  for (const token of mapping.episodes ?? []) {
    const episode = mediaIdOf(invocation, token);
    if (!episode.ok) {
      return { status: "error", error: episode.error };
    }
    episodeIds.push(episode.value);
  }

  // The retained episodes belong to the media this reference was bound to, so a
  // correction that moves the file to a different one leaves them behind rather
  // than taking them along: a caller who selected another series did not select
  // this series' episode, and an element saying otherwise is one both this
  // server and the instance would approve. Where the caller named episodes,
  // those are the mapping; where it named none against a moved media, the
  // element names none and the application answers with its own rejection.
  const movedMedia = mediaId !== undefined && mediaId.value !== retained.mediaId;
  const carriedEpisodeIds = movedMedia ? undefined : retained.episodeIds;

  const compiled = await compileCorrections(invocation.adapter.client, application, {
    mediaId: mediaId?.value ?? retained.mediaId,
    episodeIds: episodeIds.length > 0 ? episodeIds : carriedEpisodeIds,
    quality: mapping.quality ?? retained.selected?.quality,
    languages: mapping.languages ?? retained.selected?.languages,
    releaseGroup: mapping.releaseGroup ?? retained.selected?.releaseGroup,
  });
  if (compiled.status !== "ok") {
    return { status: "error", error: invalid(invocation, compiled.reason) };
  }

  const decided = await reprocessCandidate(
    invocation.adapter.client,
    application,
    {
      sourceKind: retained.sourceKind,
      queueItemId: retained.queueItemId,
      scanMediaId: retained.scanMediaId,
      seasonNumber: retained.seasonNumber,
      mediaId: retained.queueMediaId,
    },
    retained.fileIdentity,
    compiled.compiled.patch,
  );
  if (decided.status !== "ok") {
    return { status: "error", error: decided.error };
  }

  const published = publishCandidate(invocation, decided.candidate);
  if (published === undefined) {
    return {
      status: "error",
      error: invalid(invocation, "that candidate can no longer be named by a reference"),
    };
  }

  return {
    status: "ok",
    data: { source: input.source, candidates: [published] },
    warnings:
      compiled.compiled.corrected.length === 0
        ? []
        : [`corrected ${compiled.compiled.corrected.join(", ")}`],
  };
}

export const importInspectContextKind = contextKind;
