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
 * The exact shape a file identity may take.
 *
 * Checked rather than assumed, and the reason is the whole point of this
 * module: a bare "non-empty string" test would accept a canonical path or a
 * download-client identifier, and a reference that stored one would have
 * defeated the boundary at the last step. Only the digest
 * {@link fileIdentity} produces matches this.
 */
const identityPattern = new RegExp(`^[0-9a-f]{${String(fileIdentityLength)}}$`, "u");

function isFileIdentity(value: unknown): value is string {
  return typeof value === "string" && identityPattern.test(value);
}

/**
 * Whether a candidate is one this module will name.
 *
 * Checked *before* anything is minted, and that ordering is the point: a store
 * that had already issued a token for a candidate this server cannot describe
 * would hold an entry nothing can safely resolve, and the refusal would arrive
 * after the damage.
 *
 * Three things have to hold. The candidate belongs to an application that has a
 * library. Its file identity is a digest and not something that merely stands
 * where one should. And it carries whatever its own kind of scan will need to
 * be re-read later: a tracked candidate without its queue row, or a library
 * candidate without its media record, could not be revalidated against current
 * state at all — which is exactly what the later tasks of this change do before
 * importing anything.
 */
export function isNameableCandidate(candidate: ImportCandidate): boolean {
  if (candidate.application !== "sonarr" && candidate.application !== "radarr") {
    return false;
  }
  if (!(importSourceKinds as readonly string[]).includes(candidate.sourceKind)) {
    return false;
  }
  // The kind is recorded in two places on a candidate, and only one of them is
  // stored on the reference. They have to agree, or a candidate could be minted
  // as one kind and validated as the other — which is a reference that mints
  // and then refuses to resolve.
  if (candidate.sourceKind !== candidate.context.sourceKind) {
    return false;
  }
  if (!fieldRules.identity(candidate.fileIdentity)) {
    return false;
  }

  // Every optional field is held to exactly the rule the resolver will hold it
  // to. Checking them only for presence here is how a reference comes to be
  // minted that can never be resolved: upstream reports "none" as zero, and a
  // zero stored where a record identifier belongs passes an
  // is-it-defined test and fails an is-it-a-record test.
  const context = candidate.context;
  const optional: readonly [unknown, (value: unknown) => boolean][] = [
    [context.candidateId, fieldRules.recordId],
    [context.queueItemId, fieldRules.recordId],
    [context.mediaId, fieldRules.recordId],
    [context.seasonNumber, fieldRules.seasonNumber],
    [context.episodeIds, isRecordIdList],
    [candidate.sizeBytes, fieldRules.sizeBytes],
    [context.existingFileId, fieldRules.recordId],
  ];
  if (optional.some(([value, accepts]) => value !== undefined && !accepts(value))) {
    return false;
  }

  // And whatever this kind of scan is re-read through has to be there at all: a
  // tracked candidate without its queue row, or a library candidate without its
  // media record, could not be revalidated against current state.
  return candidate.sourceKind === "tracked_download"
    ? fieldRules.recordId(context.queueItemId)
    : fieldRules.recordId(context.mediaId);
}

/**
 * Mints the reference one candidate is named by, or refuses to.
 *
 * `undefined` means the candidate was not nameable and nothing was written to
 * the store. A caller reports such a row as unmappable rather than handing back
 * a reference that cannot be resolved into anything.
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
        detail: {
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
        },
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
 * What each retained field is allowed to be.
 *
 * These are the whole of the rule, and both sides of the boundary read them:
 * {@link isNameableCandidate} refuses to mint a candidate whose fields would
 * fail them, and the readers below refuse to resolve a payload that does. Two
 * copies of this rule is how a reference comes to exist that can never be
 * resolved — minted under a lax test and rejected under a strict one — so there
 * is one.
 */
const fieldRules = {
  /** An upstream record identifier. Zero is upstream's "none", never a row. */
  recordId: (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value > 0,
  /** A season number, where zero is real: specials are season 0. */
  seasonNumber: (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0,
  /** A size in bytes, where zero is real: an empty file has one. */
  sizeBytes: (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0,
  identity: isFileIdentity,
} as const;

function isRecordIdList(value: unknown): value is readonly number[] {
  return Array.isArray(value) && value.every((entry) => fieldRules.recordId(entry));
}

/**
 * A field read back out of a stored snapshot.
 *
 * The three answers are kept apart for the reason the activity resolver gives:
 * collapsing them is how corruption becomes silence. A field this module never
 * wrote is legitimately absent, one it wrote is present, and one holding
 * something it would never have written is invalid — and that last has to be
 * refused rather than coerced, or a later import would act on a plausible
 * mapping that nothing vouches for.
 */
type StoredField<TValue> =
  | { readonly state: "present"; readonly value: TValue }
  | { readonly state: "absent" }
  | { readonly state: "invalid" };

function stored<TValue>(
  value: unknown,
  accepts: (candidate: unknown) => candidate is TValue,
): StoredField<TValue> {
  if (value === undefined || value === null) {
    return { state: "absent" };
  }
  return accepts(value) ? { state: "present", value } : { state: "invalid" };
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
  if (payload.kind !== "domain" || payload.snapshot.detail?.kind !== detailKind) {
    return {
      ok: false,
      error: invalid(application, `${property} does not name an import candidate`),
    };
  }

  const detail = payload.snapshot.detail;
  const sourceKind = detail.sourceKind;
  if (
    typeof sourceKind !== "string" ||
    !(importSourceKinds as readonly string[]).includes(sourceKind)
  ) {
    return {
      ok: false,
      error: invalid(application, `${property} does not name an import candidate`),
    };
  }

  const fileIdentity = stored(detail.fileIdentity, fieldRules.identity);
  const candidateId = stored(detail.candidateId, fieldRules.recordId);
  const queueItemId = stored(detail.queueItemId, fieldRules.recordId);
  const mediaId = stored(detail.mediaId, fieldRules.recordId);
  const seasonNumber = stored(detail.seasonNumber, fieldRules.seasonNumber);
  const episodeIds = stored(detail.episodeIds, isRecordIdList);
  const sizeBytes = stored(detail.sizeBytes, fieldRules.sizeBytes);
  const existingFileId = stored(detail.existingFileId, fieldRules.recordId);

  // The file identity is the one field always written, so absent is as wrong as
  // malformed for it. The rest are legitimately absent: a scan of a library
  // context has no queue item, a movie has no season or episodes, and a
  // candidate the library does not already hold has no existing file.
  if (
    fileIdentity.state !== "present" ||
    candidateId.state === "invalid" ||
    queueItemId.state === "invalid" ||
    mediaId.state === "invalid" ||
    seasonNumber.state === "invalid" ||
    episodeIds.state === "invalid" ||
    sizeBytes.state === "invalid" ||
    existingFileId.state === "invalid"
  ) {
    return {
      ok: false,
      error: invalid(application, `${property} does not name an import candidate`),
    };
  }

  // The same requirement the mint enforced, checked again on the way out: a
  // payload that lost the queue row a tracked candidate is re-read through
  // would resolve into a context no later step could revalidate.
  const required =
    sourceKind === "tracked_download"
      ? queueItemId.state === "present"
      : mediaId.state === "present";
  if (!required) {
    return {
      ok: false,
      error: invalid(application, `${property} does not name an import candidate`),
    };
  }

  return {
    ok: true,
    value: {
      application,
      sourceKind: sourceKind as CandidateReferenceContext["sourceKind"],
      candidateId: candidateId.state === "present" ? candidateId.value : undefined,
      queueItemId: queueItemId.state === "present" ? queueItemId.value : undefined,
      mediaId: mediaId.state === "present" ? mediaId.value : undefined,
      seasonNumber: seasonNumber.state === "present" ? seasonNumber.value : undefined,
      episodeIds: episodeIds.state === "present" ? episodeIds.value : undefined,
      fileIdentity: fileIdentity.value,
      sizeBytes: sizeBytes.state === "present" ? sizeBytes.value : undefined,
      existingFileId: existingFileId.state === "present" ? existingFileId.value : undefined,
    },
  };
}
