import type { MediaApplication, MediaRef } from "../library/model.js";

/**
 * The normalized manual-import model.
 *
 * One rule governs this file, and it is stricter than anywhere else in the
 * project: **a candidate is a file on the operator's disk, and nothing here may
 * say where it is.** Manual import is the one surface whose whole subject is
 * the filesystem, so the canonical path, the folder it sits in, and the
 * download-client identifier that led to it are read by the adapter, used to
 * build the upstream request, and never mapped onto anything a caller can see.
 * What a caller gets instead is a file *name*, a non-reversible fingerprint,
 * and an opaque reference.
 *
 * Optional properties are declared `?: T | undefined` rather than omitted, for
 * the reason the library and activity models give: a mapping reads an upstream
 * field that may legitimately be absent, and an absent value disappears when
 * the envelope is serialized.
 */

/**
 * What each retained value is allowed to be.
 *
 * These live here, beside the model, because two layers depend on them and
 * neither owns them: the adapter normalizes what upstream reported so it cannot
 * produce a candidate the reference boundary would refuse, and the reference
 * schema validates what is stored. Stating them once is what keeps the two from
 * drifting — an adapter laxer than the schema silently produces candidates that
 * can never be named, and a schema laxer than the adapter admits values nothing
 * downstream expects.
 *
 * The distinctions are real rather than stylistic. A record identifier is
 * positive because zero is how both applications report "none". A season may be
 * zero because specials are season 0. A size may be zero because an empty file
 * has one.
 */
export function isRecordIdentifier(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

export function isSeasonNumber(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function isFileSize(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Where a scan started.
 *
 * The two sources reach the same upstream endpoint by different routes — a
 * tracked download is scanned by its download identity, a library context by
 * the folder the application already holds for that series or movie — and they
 * differ in what a later step may do with the result. Only a tracked import can
 * consume its source, so the distinction is carried on every candidate rather
 * than being remembered by the caller.
 */
export const importSourceKinds = ["tracked_download", "library_context"] as const;

export type ImportSourceKind = (typeof importSourceKinds)[number];

/**
 * How final a rejection is.
 *
 * The vocabulary matches the release rejections in the acquisition model,
 * because it is the same upstream distinction: a permanent rejection will not
 * pass however many times it is retried, and a temporary one may.
 */
export const importRejectionTypes = ["permanent", "temporary", "unknown"] as const;

export type ImportRejectionType = (typeof importRejectionTypes)[number];

export interface ImportRejection {
  /**
   * The application's own sentence, scrubbed. Rejections are where an
   * application is most likely to quote the path it objected to — "file already
   * exists at …" — so this is sanitized rather than merely mapped.
   */
  readonly reason: string;
  readonly type: ImportRejectionType;
}

/** What the application decided about importing this file as mapped. */
export interface ImportDecision {
  /**
   * Whether the file can be imported as currently mapped. False whenever any
   * rejection is present: the specification forbids executing a candidate that
   * carries a blocking rejection, and this is the flag that says so before a
   * caller has to interpret the list.
   */
  readonly importable: boolean;
  readonly rejections: readonly ImportRejection[];
}

/** The quality an application parsed out of the file. */
export interface ImportQuality {
  readonly name?: string | undefined;
  readonly source?: string | undefined;
  readonly resolution?: number | undefined;
  readonly proper?: boolean | undefined;
  readonly repack?: boolean | undefined;
}

/**
 * The adapter context one candidate's opaque reference is minted from.
 *
 * Everything a later correction or execution needs is here, and it is the only
 * place the upstream row identifier and the scan's own origin are kept. It is
 * never part of a result: the tool layer mints a reference from it, and the
 * reference is what a caller holds.
 *
 * `folder` and `downloadId` are deliberately absent even here. A later step
 * re-derives them from the queue row or the library record the scan started
 * from, so they live for the duration of one call rather than for the lifetime
 * of a reference — and a reference that carried them could hand one back.
 */
export interface ImportCandidateContext {
  readonly application: MediaApplication;
  readonly sourceKind: ImportSourceKind;
  /** The row identifier the instance gave this candidate, where it gave one. */
  readonly candidateId?: number | undefined;
  /** The queue row a tracked scan started from, so a later step re-reads it. */
  readonly queueItemId?: number | undefined;
  /**
   * The series or movie the *proposed mapping* names, where it names one.
   *
   * Kept apart from {@link scanMediaId} deliberately: an unmapped file found
   * under a movie's own folder has a scan record and no mapping, and one number
   * standing for both would have said the file was mapped to the folder it
   * happened to sit in.
   */
  readonly mediaId?: number | undefined;
  /** The library record a library-context scan was scoped to. */
  readonly scanMediaId?: number | undefined;
  /**
   * The media the *queue row* is filed under, where a tracked scan found one.
   *
   * Kept apart from {@link mediaId} because a correction moves that one and
   * cannot move this one: re-reading the queue is how a later step finds the
   * download again, and scoping that read by a corrected mapping would look for
   * the row under a series it was never filed under. They are the same number
   * until somebody corrects the mapping, which is exactly when it matters.
   */
  readonly queueMediaId?: number | undefined;
  readonly seasonNumber?: number | undefined;
  /** The episodes the proposed mapping names, as upstream identifiers. */
  readonly episodeIds?: readonly number[] | undefined;
  /**
   * The non-reversible fingerprint of the file this candidate stands for.
   *
   * It is what a later step compares against to notice that the file underneath
   * a validated candidate changed, which is the difference between importing
   * what was inspected and importing whatever is there now.
   */
  readonly fileIdentity: string;
  readonly sizeBytes?: number | undefined;
  /** Set when this candidate is a file the library already holds. */
  readonly existingFileId?: number | undefined;
  /**
   * Whether the application would import the file as mapped when the candidate
   * was inspected.
   *
   * Retained because the reference's fingerprint covers it: a candidate that
   * was importable then and is not now is a different candidate, and a later
   * step has to be able to see that rather than infer it.
   */
  readonly importable?: boolean | undefined;
  /**
   * The mapping fields a caller corrected that the record itself does not carry
   * as an identifier.
   *
   * The media, the season, and the episodes are already here as identifiers, so
   * a correction to any of them moves a value above. These three are text the
   * instance echoes back rather than numbers it assigns, and the requirement is
   * that a fingerprint cover *every* selected mapping field — so a candidate
   * corrected to one quality must not be importable as another.
   */
  readonly selected?: SelectedMapping | undefined;
}

/** The corrected mapping fields a candidate reference carries with it. */
export interface SelectedMapping {
  readonly quality?: string | undefined;
  readonly languages?: readonly string[] | undefined;
  readonly releaseGroup?: string | undefined;
}

/**
 * One file a manual import could act on.
 *
 * The fields are the ones the specification requires a candidate to disclose —
 * the proposed media and episode mapping, size and fingerprint, quality,
 * languages, release group and type, custom formats, indexer flags, and
 * structured rejections — and stop exactly there.
 */
export interface ImportCandidate {
  readonly application: MediaApplication;
  readonly sourceKind: ImportSourceKind;
  /**
   * The file's own name, with every directory above it removed.
   *
   * A caller has to be able to tell one candidate from another, and in a season
   * pack the file name is the only thing that does. It is the last segment
   * alone, so what is disclosed is a name and never a location — and it is
   * sanitized afterwards, so a name that still carried a separator is redacted
   * rather than trusted.
   */
  readonly fileName?: string | undefined;
  /**
   * A salted digest of the file's canonical path.
   *
   * Two scans of the same file agree on it, which is what lets a caller — and a
   * later validation — recognize the same file across calls. The path it is
   * derived from never leaves the adapter, and the digest is not reversible
   * back to one.
   */
  readonly fileIdentity: string;
  readonly sizeBytes?: number | undefined;
  /** The series or movie the application proposes, where it proposes one. */
  readonly media?: MediaRef | undefined;
  readonly seasonNumber?: number | undefined;
  /** The episodes the proposed mapping covers; several for a season pack. */
  readonly episodes?: readonly MediaRef[] | undefined;
  readonly quality?: ImportQuality | undefined;
  readonly languages?: readonly string[] | undefined;
  readonly releaseGroup?: string | undefined;
  readonly releaseType?: string | undefined;
  readonly customFormats?: readonly string[] | undefined;
  readonly customFormatScore?: number | undefined;
  readonly indexerFlags?: readonly string[] | undefined;
  readonly decision: ImportDecision;
  /**
   * Whether this file is already a library file rather than a new import.
   *
   * The specification requires the two to be distinguishable, because they have
   * different remedies: importing a file the library already holds is not an
   * import at all, and the caller is directed to the typed library-file
   * workflow instead.
   */
  readonly existingLibraryFile: boolean;
  readonly context: ImportCandidateContext;
}
