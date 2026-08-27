import { z } from "zod";
import { fileIdentityLength } from "../adapters/import/candidates.js";
import type { ImportCandidate, ImportCandidateContext } from "../adapters/import/model.js";
import { importSourceKinds } from "../adapters/import/model.js";
import type { MediaApplication } from "../adapters/library/model.js";
import { queryDigest } from "../adapters/library/paging.js";
import type { ReferenceStore } from "../state/references.js";
import { createToolError, type ToolError, toolErrorForReferenceFailure } from "./errors.js";

/**
 * The opaque references import candidates are named by.
 *
 * A candidate is a file on the operator's disk, and this module is the boundary
 * that keeps a caller from ever learning where. The reference retains what a
 * correction or an execution will need — which row the instance offered, which
 * queue item or library record the scan started from, the proposed mapping, and
 * the file's fingerprint — and retains no canonical path and no download-client
 * identifier, because those are re-derived from the queue row or library record
 * at the moment they are needed rather than carried for a reference's lifetime.
 *
 * The token itself is random, carries only a kind prefix and this process's
 * lifetime segment, and is resolved by lookup rather than by decoding.
 */

/** What a resolved candidate reference tells a later step. */
export interface CandidateReferenceContext extends ImportCandidateContext {
  readonly application: MediaApplication;
}

export type ReferenceResolved<TValue> =
  | { readonly ok: true; readonly value: TValue }
  | { readonly ok: false; readonly error: ToolError };

const detailKind = "import_candidate";

/**
 * The one definition of what a candidate reference may hold.
 *
 * Everything about this boundary is checked against this schema and nothing
 * else: minting parses the detail it is about to store, and resolving parses
 * the snapshot it just read back. A rule stated once cannot be enforced on the
 * way in and skipped on the way out, which is exactly how a reference came to
 * be minted here that could never be resolved — and how a corrupt snapshot
 * could resolve as valid because a hand-written walk happened not to look at
 * the field that was wrong.
 *
 * It is strict, so a key nothing here writes is corruption rather than a field
 * to ignore, and the numeric rules say what each identifier actually is: a
 * record identifier is positive because zero is how the applications report
 * "none", while a season may be zero because specials are season 0 and a size
 * may be zero because an empty file has one.
 */
const recordIdSchema = z.number().int().positive();
const seasonNumberSchema = z.number().int().nonnegative();
const sizeSchema = z.number().int().nonnegative();

const candidateDetailSchema = z
  .strictObject({
    kind: z.literal(detailKind),
    sourceKind: z.enum(importSourceKinds),
    candidateId: recordIdSchema.optional(),
    queueItemId: recordIdSchema.optional(),
    mediaId: recordIdSchema.optional(),
    seasonNumber: seasonNumberSchema.optional(),
    episodeIds: z.array(recordIdSchema).optional(),
    /**
     * The digest {@link fileIdentity} produces, held to that exact shape. A
     * bare "some string" would accept a canonical path or a download-client
     * identifier, and a reference that stored one would have defeated this
     * boundary at its last step.
     */
    fileIdentity: z.string().regex(new RegExp(`^[0-9a-f]{${String(fileIdentityLength)}}$`, "u")),
    sizeBytes: sizeSchema.optional(),
    existingFileId: recordIdSchema.optional(),
  })
  .refine(
    (detail) =>
      detail.sourceKind === "tracked_download"
        ? detail.queueItemId !== undefined
        : detail.mediaId !== undefined,
    {
      // Whatever this kind of scan is re-read through has to be there at all: a
      // tracked candidate without its queue row, or a library candidate without
      // its media record, could not be revalidated against current state, which
      // is what the later tasks of this change do before importing anything.
      error: "an import candidate must carry the record its own scan is re-read through",
    },
  );

/**
 * The whole stored snapshot, including the two fields the reference store owns.
 *
 * They are validated too, rather than trusted because this module wrote them: a
 * corrupt payload carrying a path where the upstream identifier belongs would
 * otherwise resolve as valid on the strength of a plausible detail. The
 * identifier is also required to agree with the detail it was derived from, so
 * the two cannot drift into describing different rows.
 */
const candidateSnapshotSchema = z
  .strictObject({
    upstreamId: z.string().regex(/^\d+$/u),
    fingerprint: z.string().regex(/^[0-9a-f]{8,}$/u),
    detail: candidateDetailSchema,
  })
  .refine((snapshot) => snapshot.upstreamId === String(snapshot.detail.candidateId ?? 0), {
    error: "the retained upstream identifier does not match the candidate it names",
  });

type CandidateDetail = z.infer<typeof candidateDetailSchema>;

/** The detail one candidate would be stored as, before anything stores it. */
function detailFor(candidate: ImportCandidate): Record<string, unknown> {
  return {
    kind: detailKind,
    sourceKind: candidate.sourceKind,
    candidateId: candidate.context.candidateId,
    queueItemId: candidate.context.queueItemId,
    mediaId: candidate.context.mediaId,
    seasonNumber: candidate.context.seasonNumber,
    episodeIds: candidate.context.episodeIds,
    fileIdentity: candidate.fileIdentity,
    sizeBytes: candidate.sizeBytes,
    existingFileId: candidate.context.existingFileId,
  };
}

/**
 * Digests the state a candidate's validity depends on.
 *
 * The parts are listed in a fixed, code-authored order, and each is either a
 * value this server derived or an identifier the instance assigned — never
 * upstream free text, whose sanitization would otherwise decide whether two
 * scans of the same file fingerprint alike. The file identity is already a
 * digest of the path; including it here is what makes a file swapped underneath
 * a validated candidate detectable without either digest disclosing the path.
 */
function candidateFingerprint(candidate: ImportCandidate): string {
  return queryDigest([
    candidate.application,
    candidate.sourceKind,
    candidate.context.candidateId,
    candidate.fileIdentity,
    candidate.sizeBytes,
    candidate.context.mediaId,
    candidate.context.seasonNumber,
    ...[...(candidate.context.episodeIds ?? [])].sort((left, right) => left - right),
    candidate.context.existingFileId,
    candidate.decision.importable,
  ]);
}

/**
 * Whether a candidate is one this module will name.
 *
 * Answered by parsing the very detail a mint would store, so the test a
 * candidate passes here is the test its stored payload will face on the way
 * back out — not a second, looser reading of the same rules. The application is
 * checked separately because it is bound on the reference rather than stored in
 * the detail, and the candidate's two records of its own scan kind have to
 * agree because only one of them is stored.
 */
export function isNameableCandidate(candidate: ImportCandidate): boolean {
  return (
    (candidate.application === "sonarr" || candidate.application === "radarr") &&
    candidate.sourceKind === candidate.context.sourceKind &&
    candidateDetailSchema.safeParse(detailFor(candidate)).success
  );
}

/**
 * Mints the reference one candidate is named by, or refuses to.
 *
 * `undefined` means the candidate was not nameable and nothing was written to
 * the store. Checking before minting is the point: a store that had already
 * issued a token for a candidate this server cannot describe would hold an
 * entry nothing can safely resolve, and the refusal would arrive after the
 * damage.
 */
export function mintCandidateReference(
  references: ReferenceStore,
  candidate: ImportCandidate,
): string | undefined {
  if (!isNameableCandidate(candidate)) {
    return undefined;
  }

  return references.mint({
    kind: "import_candidate",
    applications: [candidate.application],
    payload: () => ({
      kind: "domain",
      snapshot: {
        // The row identifier the instance assigned, where it assigned one. A
        // scan of a folder the instance has not indexed answers without one,
        // and such a candidate is still nameable: what identifies the file is
        // its fingerprint, not a row number that may not exist.
        upstreamId: String(candidate.context.candidateId ?? 0),
        fingerprint: candidateFingerprint(candidate),
        detail: detailFor(candidate),
      },
    }),
  }).reference;
}

function invalid(application: MediaApplication, message: string): ToolError {
  return createToolError({
    code: "invalid_input",
    message: `${application}: ${message}`,
    application,
  });
}

/**
 * Turns one candidate reference back into the context a later step needs.
 *
 * The checks run in a deliberate order: the store first, so a forged, expired,
 * previous-lifetime, or wrong-kind token is refused without this module reading
 * anything; then the application binding, so a candidate found on Sonarr cannot
 * be imported into Radarr; then the payload shape; then each retained field.
 * Every one of them happens before any upstream request.
 */
export function resolveCandidateReference(
  references: ReferenceStore,
  token: string,
  application: MediaApplication,
  property = "candidates",
): ReferenceResolved<CandidateReferenceContext> {
  const resolution = references.resolve(token, "import_candidate");
  if (!resolution.ok) {
    return {
      ok: false,
      error: toolErrorForReferenceFailure(resolution.reason, "import_candidate", application),
    };
  }

  const entry = resolution.entry;
  if (!entry.applications.includes(application)) {
    return { ok: false, error: invalid(application, `${property} names a different application`) };
  }

  const payload = entry.payload;
  if (payload.kind !== "domain") {
    return {
      ok: false,
      error: invalid(application, `${property} does not name an import candidate`),
    };
  }

  // One parse, against the same schema the mint was checked with. A field this
  // module would never have written — a path where the digest belongs, a zero
  // where a record identifier belongs, a key nothing here writes at all — is
  // corruption, and corruption is refused rather than read around.
  const parsed = candidateSnapshotSchema.safeParse(payload.snapshot);
  if (!parsed.success) {
    return {
      ok: false,
      error: invalid(application, `${property} does not name an import candidate`),
    };
  }

  return { ok: true, value: contextFrom(application, parsed.data.detail) };
}

function contextFrom(
  application: MediaApplication,
  detail: CandidateDetail,
): CandidateReferenceContext {
  return {
    application,
    sourceKind: detail.sourceKind,
    candidateId: detail.candidateId,
    queueItemId: detail.queueItemId,
    mediaId: detail.mediaId,
    seasonNumber: detail.seasonNumber,
    episodeIds: detail.episodeIds,
    fileIdentity: detail.fileIdentity,
    sizeBytes: detail.sizeBytes,
    existingFileId: detail.existingFileId,
  };
}
