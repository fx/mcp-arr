import { z } from "zod";
import { fileIdentityLength } from "../adapters/import/candidates.js";
import type { ImportCandidate, ImportCandidateContext } from "../adapters/import/model.js";
import {
  importSourceKinds,
  isFileSize,
  isRecordIdentifier,
  isRetainedLabel,
  isSeasonNumber,
} from "../adapters/import/model.js";
import type { MediaApplication, MediaRef } from "../adapters/library/model.js";
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
 * Two invariants hold across this file and the adapter that feeds it, and both
 * were learned by breaking them.
 *
 * **One rule per value, read by everyone who applies it.** The numeric
 * predicates below come from the adapter's own model, so the adapter cannot
 * normalize to something this schema would refuse, and this schema cannot admit
 * something the adapter would never build. Two statements of one rule drift, and
 * a drift here is either a reference that mints and can never resolve, or one
 * that resolves into something nothing produced.
 *
 * **What is fingerprinted and what is stored are the same value**, not two
 * values that happen to agree. The detail is derived once, validated once, and
 * then both hashed and written — see {@link mintCandidateReference}. Deriving
 * it twice would leave the fingerprint describing a candidate other than the one
 * beside it, which is exactly the corruption resolution refuses.
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
// Built on the same predicates the adapter normalizes with, so the two cannot
// disagree about what a retained value may be. Zod 4's `.int()` already means
// safe integer — verified against the pinned version — and the predicates say
// so explicitly anyway, because that is the property being relied on.
const recordIdSchema = z.number().refine(isRecordIdentifier);
const seasonNumberSchema = z.number().refine(isSeasonNumber);
const sizeSchema = z.number().refine(isFileSize);
const labelSchema = z.string().refine(isRetainedLabel);

const candidateDetailSchema = z
  .strictObject({
    kind: z.literal(detailKind),
    sourceKind: z.enum(importSourceKinds),
    candidateId: recordIdSchema.optional(),
    queueItemId: recordIdSchema.optional(),
    /** The media the proposed mapping names, which an unmapped file lacks. */
    mediaId: recordIdSchema.optional(),
    /** The record a library-context scan was scoped to. */
    scanMediaId: recordIdSchema.optional(),
    /** The media the queue row is filed under, which a correction cannot move. */
    queueMediaId: recordIdSchema.optional(),
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
    /**
     * Whether the application would import the file as mapped.
     *
     * Retained rather than recomputed because the fingerprint covers it: a
     * candidate that was importable when it was inspected and is not now is a
     * different candidate, and a digest that did not say so would call the two
     * the same. It is also what makes the fingerprint checkable at all — every
     * part of it has to be here, or resolution could never recompute it.
     */
    importable: z.boolean(),
    /**
     * The corrected mapping fields the record carries as text rather than as an
     * identifier.
     *
     * Retained because the requirement is that a fingerprint cover every
     * selected mapping field, and these three are the ones no number stands
     * for. A candidate corrected to one quality and imported as another would
     * be exactly the mismatch the fingerprint exists to catch.
     */
    selected: z
      .strictObject({
        quality: labelSchema.optional(),
        languages: z.array(labelSchema).optional(),
        releaseGroup: labelSchema.optional(),
      })
      .optional(),
  })
  .refine(
    (detail) =>
      detail.sourceKind === "tracked_download"
        ? detail.queueItemId !== undefined
        : detail.scanMediaId !== undefined,
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
  })
  .refine((snapshot) => snapshot.fingerprint === fingerprintFor(snapshot.detail), {
    // The fingerprint is checked by value and not merely by shape. It is a
    // digest of the detail beside it, so it can be recomputed here — and one
    // that does not match means the two describe different candidates, which is
    // corruption whatever either of them says on its own.
    error: "the retained fingerprint does not describe the candidate beside it",
  });

export type CandidateDetail = z.infer<typeof candidateDetailSchema>;

/**
 * The detail one candidate would be stored as, before anything stores it.
 *
 * Every field a caller was shown is read from the field the caller was shown —
 * the proposed media from `media`, the episodes from `episodes`, the decision
 * from `decision` — rather than from the context's copy of the same fact. A
 * candidate carries several of these twice, and only one copy is stored, so
 * reading the stored one would let a reference be bound to a mapping other than
 * the one presented. Deriving from what was presented makes the two agree by
 * construction instead of by a check that has to remember every field.
 */
function detailFor(candidate: ImportCandidate): Record<string, unknown> | undefined {
  const context = candidate.context;
  // Derived once and checked here rather than computed again by a separate
  // storability test: two derivations of the same identifier are two things
  // that can disagree, and the disagreement would be invisible.
  const mediaId = mappedId(candidate.media, candidate.application, [mediaKindFor(candidate)]);
  const episodeIds = (candidate.episodes ?? []).map((episode) =>
    mappedId(episode, candidate.application, ["episode"]),
  );

  // A reference that names another application or another kind of record is not
  // this candidate's mapping, and dropping it quietly would be worse than
  // refusing: the stored mapping would claim less than the candidate presented,
  // so a later step would import against a mapping the caller never saw.
  if (candidate.media !== undefined && mediaId === undefined) {
    return undefined;
  }
  if (episodeIds.some((id) => id === undefined)) {
    return undefined;
  }

  return {
    kind: detailKind,
    sourceKind: candidate.sourceKind,
    candidateId: context.candidateId,
    queueItemId: context.queueItemId,
    mediaId,
    scanMediaId: context.scanMediaId,
    queueMediaId: context.queueMediaId,
    seasonNumber: candidate.seasonNumber,
    episodeIds: candidate.episodes === undefined ? undefined : episodeIds,
    fileIdentity: candidate.fileIdentity,
    // Read off the candidate rather than off its context, for the same reason
    // the mapping identifiers above are: what is stored has to be what was
    // displayed, or a reference would bind a mapping nobody was shown.
    selected: presentSelection(candidate),
    sizeBytes: candidate.sizeBytes,
    // The boolean the caller saw decides whether the identifier is stored at
    // all, so a candidate presented as a new import cannot be bound to a
    // library file.
    existingFileId: candidate.existingLibraryFile ? context.existingFileId : undefined,
    importable: candidate.decision.importable,
  };
}

/**
 * A media reference's identifier as the number the detail retains.
 *
 * References carry it as a string because that is the published shape; a value
 * that is not a plain identifier answers `undefined`, which the schema then
 * refuses where one was required.
 */
function numericId(value: string | undefined): number | undefined {
  return value !== undefined && /^\d+$/u.test(value) ? Number(value) : undefined;
}

/**
 * The identifier of a media reference that is the right one for this candidate.
 *
 * A reference carries the application and the kind it names, and both have to
 * match: a Sonarr candidate holding a Radarr movie reference, or a Radarr one
 * holding episode references, would otherwise be stored as a plain number and
 * resolve later as a mapping onto whatever record happens to have that number
 * on the other application. Identity is not a number on its own.
 */
function mappedId(
  reference: MediaRef | undefined,
  application: MediaApplication,
  kinds: readonly string[],
): number | undefined {
  if (reference === undefined) {
    return undefined;
  }
  return reference.application === application && kinds.includes(reference.kind)
    ? numericId(reference.id)
    : undefined;
}

/**
 * Digests the state a candidate's validity depends on.
 *
 * It is computed from the retained detail and from nothing else, which is what
 * makes it verifiable: resolution can recompute it and require the exact value,
 * so a fingerprint is checked by what it says rather than by looking like a
 * digest. A part that lived outside the detail would break that — the digest
 * could never be recomputed, and the field would be decoration.
 *
 * The parts are listed in a fixed, code-authored order, and each is either a
 * value this server derived or an identifier the instance assigned — never
 * upstream free text, whose sanitization would otherwise decide whether two
 * scans of the same file fingerprint alike. The file identity is already a
 * digest of the path, so including it makes a file swapped underneath a
 * validated candidate detectable without either digest disclosing the path.
 *
 * The application is not among the parts because it is not the detail's to
 * carry: a reference is bound to exactly one application by the store, and that
 * binding is checked before this is.
 */
export function fingerprintFor(detail: CandidateDetail): string {
  return queryDigest([
    detail.sourceKind,
    detail.candidateId,
    // The queue row a tracked scan came from is effect-relevant source state:
    // it is what a later step re-reads, and what decides whether importing can
    // consume the download. Omitting it while including the library scan's own
    // record would have been an asymmetry with no reason behind it.
    detail.queueItemId,
    // The queue row's own association, because a later step re-reads the row
    // through it: a plan made when the download sat under one series must not
    // apply after it was refiled under another.
    detail.queueMediaId,
    detail.fileIdentity,
    detail.sizeBytes,
    detail.mediaId,
    detail.scanMediaId,
    detail.seasonNumber,
    ...[...(detail.episodeIds ?? [])].sort((left, right) => left - right),
    detail.existingFileId,
    detail.importable,
    // The selected mapping's text fields, in a fixed order. Every field a
    // caller may correct is now covered: the media, the season and the episodes
    // by the identifiers above, and these three by name.
    detail.selected?.quality,
    // Sorted, and sorted the same way the validation compares them: a digest
    // and a comparison that disagreed about what "the same languages" means
    // would expire plans the other called equal.
    ...[...(detail.selected?.languages ?? [])].sort(),
    detail.selected?.releaseGroup,
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
  return storableDetail(candidate) !== undefined;
}

/**
 * The detail this candidate would be stored as, or nothing.
 *
 * One function answers both questions a mint asks — may this be named, and what
 * exactly is written — because they are the same question. Answering them
 * separately is what produced two computations of one value on this path, and
 * two computations are two things that can drift.
 */
function storableDetail(candidate: ImportCandidate): CandidateDetail | undefined {
  if (candidate.application !== "sonarr" && candidate.application !== "radarr") {
    return undefined;
  }
  // The kind is recorded twice on a candidate and stored once, so the two have
  // to agree or a candidate could be minted as one kind and validated as the
  // other.
  if (candidate.sourceKind !== candidate.context.sourceKind) {
    return undefined;
  }
  const detail = detailFor(candidate);
  if (detail === undefined) {
    return undefined;
  }
  const parsed = candidateDetailSchema.safeParse(detail);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The corrected mapping fields worth storing, or nothing where none were shown.
 *
 * An object with every member absent is not stored at all: it would fingerprint
 * identically to its absence, and a field that cannot change a digest is
 * decoration in a structure whose whole point is that every part of it can.
 */
function presentSelection(candidate: ImportCandidate): Record<string, unknown> | undefined {
  const selection = {
    ...(candidate.quality?.name === undefined ? {} : { quality: candidate.quality.name }),
    ...(candidate.languages === undefined ? {} : { languages: [...candidate.languages] }),
    ...(candidate.releaseGroup === undefined ? {} : { releaseGroup: candidate.releaseGroup }),
  };
  return Object.keys(selection).length === 0 ? undefined : selection;
}

function mediaKindFor(candidate: ImportCandidate): string {
  return candidate.application === "sonarr" ? "series" : "movie";
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
  const detail = storableDetail(candidate);
  if (detail === undefined) {
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
        upstreamId: String(detail.candidateId ?? 0),
        // The invariant this whole path exists to keep: what is fingerprinted
        // and what is stored are the *same value*, not two values that happen
        // to agree. Both read `detail`, which was derived and validated once.
        fingerprint: fingerprintFor(detail),
        detail,
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
    scanMediaId: detail.scanMediaId,
    seasonNumber: detail.seasonNumber,
    episodeIds: detail.episodeIds,
    fileIdentity: detail.fileIdentity,
    sizeBytes: detail.sizeBytes,
    existingFileId: detail.existingFileId,
    importable: detail.importable,
    queueMediaId: detail.queueMediaId,
    selected: detail.selected,
  };
}
