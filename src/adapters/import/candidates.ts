import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { UpstreamBody, UpstreamClient, UpstreamQuery } from "../../http/client.js";
import { isUpstreamError } from "../../http/errors.js";
import { createToolError, type ToolError } from "../../tools/errors.js";
import { safeLabelList, safeReason, safeTaxonomyList, scrubLabel } from "../acquisition/parse.js";
import { safeText } from "../activity/parse.js";
import { type MediaApplication, mediaRef } from "../library/model.js";
import { type AdapterPage, type PageWindow, projectPage } from "../library/paging.js";
import {
  count,
  customFormatList,
  flag,
  indexerFlagStrings,
  indexerFlagValue,
  optionalUpstreamId,
  parseUpstream,
  present,
  text,
  upstreamId,
  upstreamText,
} from "../library/parse.js";
import {
  type ImportCandidate,
  type ImportQuality,
  type ImportRejection,
  type ImportRejectionType,
  type ImportSourceKind,
  isFileSize,
  isRecordIdentifier,
  isRetainedLabel,
  isSeasonNumber,
} from "./model.js";

/**
 * The Sonarr and Radarr manual-import candidate scanners.
 *
 * This module is the only place in the project that reads a canonical
 * filesystem path on purpose, and the discipline that makes that safe is worth
 * stating plainly: a path enters here, is used to build one upstream query, and
 * leaves as a digest. The same is true of the download-client identifier a
 * tracked scan is keyed by. Neither is returned, neither is retained on a
 * reference, and the mapped candidate has no field either could occupy.
 *
 * The scan itself is a read. Nothing here submits a command, and the upstream
 * endpoint it calls only proposes a mapping — the import is a later change's
 * work.
 */

const manualImportRoute = "manualimport";
const seriesRoute = "series";
const movieRoute = "movie";
const queueDetailsRoute = "queue/details";

/**
 * Salts the file-identity digest for this process only.
 *
 * Regenerated per process, exactly as the activity adapter salts its
 * download-identity digest, so a digest cannot be compared against one from
 * another process or precomputed from a guessed path.
 */
const identitySalt = randomBytes(32);

/** How many hexadecimal characters of the digest are kept. */
export const fileIdentityLength = 16;

/**
 * A non-reversible stand-in for the file's canonical path.
 *
 * A caller needs to know that two scans found the same file, and that the file
 * underneath a candidate has not been swapped for another — and neither
 * question requires knowing where the file is. This answers both without
 * answering that.
 */
export function fileIdentity(path: string): string {
  return createHash("sha256")
    .update(identitySalt)
    .update(path)
    .digest("hex")
    .slice(0, fileIdentityLength);
}

/**
 * The file's own name, with every directory above it removed.
 *
 * Both separators are cut, not just the platform's own: the instance may well
 * run on a different platform than this server does, and a Windows path read on
 * Linux would otherwise keep its whole directory chain as part of the "name".
 * What survives goes through the sanitizer afterwards, so a name that still
 * carries a separator is redacted rather than disclosed.
 */
export function fileNameOf(
  path: string | null | undefined,
  known: readonly string[] = [],
): string | undefined {
  const raw = text(path);
  if (raw === undefined) {
    return undefined;
  }
  const cut = Math.max(raw.lastIndexOf("/"), raw.lastIndexOf("\\"));
  return scrubLabel(cut < 0 ? raw : raw.slice(cut + 1), known);
}

const rejectionSchema = z.object({
  reason: upstreamText,
  message: upstreamText,
  type: upstreamText,
});

/**
 * One manual-import candidate as the instance reports it.
 *
 * `path`, `relativePath`, and `folderName` are read because the digest and the
 * file name are derived from them; none of the three is mapped onto the model.
 */
const candidateSchema = z.object({
  id: optionalUpstreamId,
  path: upstreamText,
  relativePath: upstreamText,
  folderName: upstreamText,
  name: upstreamText,
  size: z.number().nullish(),
  seasonNumber: optionalUpstreamId,
  releaseGroup: upstreamText,
  releaseType: upstreamText,
  qualityWeight: z.number().nullish(),
  customFormatScore: z.number().nullish(),
  customFormats: customFormatList,
  indexerFlags: indexerFlagValue,
  languages: z.array(z.object({ name: upstreamText })).nullish(),
  quality: z
    .object({
      quality: z
        .object({
          name: upstreamText,
          source: upstreamText,
          resolution: z.number().nullish(),
        })
        .nullish(),
      revision: z
        .object({ version: z.number().nullish(), isRepack: z.boolean().nullish() })
        .nullish(),
    })
    .nullish(),
  series: z.object({ id: optionalUpstreamId }).nullish(),
  movie: z.object({ id: optionalUpstreamId }).nullish(),
  // The flat identifier a reprocess *answer* names its media by. A scan row
  // carries the nested object above and never these, so reading both is what
  // lets one schema describe both answers rather than two schemas that would
  // then have to be kept in step.
  seriesId: optionalUpstreamId,
  movieId: optionalUpstreamId,
  episodes: z.array(z.object({ id: optionalUpstreamId })).nullish(),
  episodeFileId: optionalUpstreamId,
  movieFileId: optionalUpstreamId,
  rejections: z.array(rejectionSchema).nullish(),
});

export type UpstreamCandidate = z.infer<typeof candidateSchema>;

const queueRowSchema = z.object({
  id: upstreamId,
  downloadId: upstreamText,
  outputPath: upstreamText,
  seriesId: optionalUpstreamId,
  movieId: optionalUpstreamId,
});

const libraryRecordSchema = z.object({ id: upstreamId, path: upstreamText });

/**
 * What one scan needs to reach the upstream endpoint, and nobody else needs.
 *
 * It exists for the length of a single call, and it is deliberately **not
 * exported**. The folder is a canonical path and the download identifier is the
 * download client's own, so a type a caller could construct would be a way to
 * point a scan at any directory on the server — which is exactly what the
 * specification forbids this surface from accepting. The only things that build
 * one are the two resolvers below, and both take their values from upstream
 * state rather than from an argument.
 */
export interface ImportScanContext {
  readonly application: MediaApplication;
  readonly sourceKind: ImportSourceKind;
  readonly folder?: string | undefined;
  readonly downloadId?: string | undefined;
  readonly mediaId?: number | undefined;
  readonly seasonNumber?: number | undefined;
  readonly queueItemId?: number | undefined;
}

type ScanResolution =
  | { readonly ok: true; readonly context: ImportScanContext }
  | { readonly ok: false; readonly reason: "absent" | "unmapped" };

/**
 * The typed answer a scan gives when its target is not there.
 *
 * A target that has gone is a domain answer with a remedy the caller can act
 * on — read the query that produced the reference again — so it is that error
 * rather than a transport failure handed upwards. Every other upstream failure
 * keeps its own shape: a timeout, an authentication failure and a 5xx are not
 * domain answers, and collapsing them into this one would tell a caller to
 * re-read a query when the instance is simply unreachable.
 */
function scanRefusal(application: MediaApplication, reason: "absent" | "unmapped"): ToolError {
  return reason === "absent"
    ? createToolError({
        code: "stale_reference",
        message: `${application}: that record is no longer on this instance`,
        application,
      })
    : createToolError({
        code: "conflict",
        message: `${application}: that record names no location on this instance, so there is nothing to scan`,
        application,
      });
}

/**
 * Reads one upstream record, treating "it is not there" as an answer.
 *
 * A `404` on a single-record route means the record has gone, which this
 * surface has a word for. Anything else is rethrown untouched, so the failure a
 * caller sees is the failure that happened.
 */
async function readRecord<TValue>(
  read: () => Promise<TValue>,
): Promise<{ ok: true; value: TValue } | { ok: false }> {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    if (isUpstreamError(error) && error.kind === "not-found") {
      return { ok: false };
    }
    throw error;
  }
}

/**
 * Resolves the scan context of a tracked download from its queue row.
 *
 * The queue reference a caller holds names a row, not a location, so the
 * location is looked up here — from the same focused `queue/details` read the
 * queue surface uses, scoped by the media association the reference retained.
 * The download identifier and the output path are read straight off the raw
 * payload rather than off the mapped queue model, because the mapped model
 * deliberately drops both, and both are needed to ask the instance what is
 * importable.
 *
 * `unmapped` is a distinct answer from `absent`: a row that exists but reports
 * neither an output path nor a download identifier cannot be scanned, and
 * saying so is more useful than reporting the row as gone.
 */
async function readTrackedScanContext(
  client: UpstreamClient,
  application: MediaApplication,
  request: { readonly queueItemId: number; readonly mediaId?: number | undefined },
): Promise<ScanResolution> {
  // Held to the same rule every other retained identifier is, so a scan cannot
  // start from a row number that could never be stored on a reference — which
  // would yield candidates that each fail to be named for the same reason,
  // silently.
  if (!isRecordIdentifier(request.queueItemId)) {
    return { ok: false, reason: "absent" };
  }

  const parameter = application === "sonarr" ? "seriesId" : "movieId";
  const query: UpstreamQuery =
    request.mediaId === undefined ? {} : { [parameter]: request.mediaId };
  const rows = parseUpstream(
    z.array(queueRowSchema),
    await client.get(queueDetailsRoute, query),
    application,
    queueDetailsRoute,
  );

  const row = rows.find((candidate) => candidate.id === request.queueItemId);
  if (row === undefined) {
    return { ok: false, reason: "absent" };
  }

  const folder = text(row.outputPath);
  const downloadId = text(row.downloadId);
  if (folder === undefined && downloadId === undefined) {
    return { ok: false, reason: "unmapped" };
  }

  return {
    ok: true,
    context: {
      application,
      sourceKind: "tracked_download",
      folder,
      downloadId,
      mediaId: count(application === "sonarr" ? row.seriesId : row.movieId) ?? request.mediaId,
      queueItemId: request.queueItemId,
    },
  };
}

/**
 * Resolves the scan context of a library record from its own path.
 *
 * The caller supplies a media reference and never a path, which is the whole
 * point: the folder comes from the record the application already holds, so
 * this surface cannot be steered at a directory the application does not
 * manage. A record reporting no path is `unmapped` rather than absent — it
 * exists, and there is simply nothing under it to scan.
 */
async function readLibraryScanContext(
  client: UpstreamClient,
  application: MediaApplication,
  request: { readonly mediaId: number; readonly seasonNumber?: number | undefined },
): Promise<ScanResolution> {
  const route = `${application === "sonarr" ? seriesRoute : movieRoute}/${String(request.mediaId)}`;
  const read = await readRecord(async () =>
    parseUpstream(libraryRecordSchema, await client.get(route), application, route),
  );
  if (!read.ok) {
    return { ok: false, reason: "absent" };
  }
  const record = read.value;

  const folder = text(record.path);
  // A record reporting no path has nothing under it to scan, and one whose
  // identifier is not a real identifier cannot scope a scan at all — saying so
  // here is clearer than returning candidates that would each be refused a
  // reference for the same reason.
  if (folder === undefined || !isRecordIdentifier(record.id)) {
    return { ok: false, reason: "unmapped" };
  }

  return {
    ok: true,
    context: {
      application,
      sourceKind: "library_context",
      folder,
      mediaId: record.id,
      seasonNumber: request.seasonNumber,
    },
  };
}

/**
 * The query one scan sends.
 *
 * A tracked scan prefers the download identifier, because that is what ties the
 * result to the download rather than to whatever else happens to sit in the
 * same folder; the folder is sent alongside where the instance reported one, as
 * both applications accept either. `filterExistingFiles` is deliberately false:
 * the specification requires existing library files to be *distinguishable*,
 * which means they have to come back at all.
 */
function scanQuery(context: ImportScanContext): UpstreamQuery {
  return {
    ...(context.folder === undefined ? {} : { folder: context.folder }),
    ...(context.downloadId === undefined ? {} : { downloadId: context.downloadId }),
    ...(context.sourceKind === "library_context" && context.mediaId !== undefined
      ? { [context.application === "sonarr" ? "seriesId" : "movieId"]: context.mediaId }
      : {}),
    ...(context.seasonNumber === undefined ? {} : { seasonNumber: context.seasonNumber }),
    filterExistingFiles: false,
  };
}

function rejectionType(value: string | null | undefined): ImportRejectionType {
  const word = text(value)?.toLowerCase();
  if (word === "permanent") {
    return "permanent";
  }
  return word === "temporary" ? "temporary" : "unknown";
}

/**
 * The rejections one candidate carries, scrubbed.
 *
 * A rejection is the field most likely to quote the very thing this module
 * refuses to disclose — "file already exists at …" names a path, and an
 * existing-file rejection names it every time — so each reason goes through the
 * activity sanitizer, which redacts anything carrying a path separator. A
 * rejection whose reason is entirely redacted is kept with a stated placeholder
 * rather than dropped: that a file was rejected is itself the evidence, and a
 * silently shorter list would understate why a candidate cannot be imported.
 */
function candidateRejections(
  context: ImportScanContext,
  record: UpstreamCandidate,
): readonly ImportRejection[] {
  const known = knownLiterals(context, record);

  const scrub = (value: string | null | undefined): string | undefined =>
    safeText(safeReason(value, known));

  return (record.rejections ?? []).map((rejection) => ({
    reason:
      scrub(rejection.reason) ??
      scrub(rejection.message) ??
      "this instance rejected the file without a readable reason",
    type: rejectionType(rejection.type),
  }));
}

/** The last segment of a folder path, which is what upstream calls it. */
function folderNameOf(folder: string): string | undefined {
  const trimmed = folder.replace(/[\\/]+$/u, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  const name = cut < 0 ? trimmed : trimmed.slice(cut + 1);
  return name === "" ? undefined : name;
}

/**
 * An upstream number reduced to what this project will retain.
 *
 * Upstream's own schemas are looser than the values this project stores: a size
 * is any number, and an identifier or season is any safe integer including zero
 * and negatives. Normalizing here rather than passing them through is what stops
 * the adapter producing a candidate the reference boundary would then refuse —
 * which would be a candidate that looks fine and can never be named.
 */
function retained<TValue>(
  value: TValue | undefined,
  accepts: (candidate: TValue) => boolean,
): TValue | undefined {
  return value !== undefined && accepts(value) ? value : undefined;
}

/** An upstream record identifier, where zero means the instance named none. */
function recordId(value: number | undefined): number | undefined {
  return retained(value, isRecordIdentifier);
}

function proper(version: number | undefined): boolean | undefined {
  return version === undefined ? undefined : version > 1;
}

function candidateQuality(
  record: UpstreamCandidate,
  known: readonly string[],
): ImportQuality | undefined {
  const quality = record.quality?.quality;
  const revision = record.quality?.revision;
  return present({
    name: scrubLabel(quality?.name, known),
    source: scrubLabel(quality?.source, known),
    resolution: count(quality?.resolution),
    // A revision above the first is what both applications call a proper. The
    // count is read once and tested for absence rather than for falsiness,
    // because revision 0 is a real answer.
    proper: proper(count(revision?.version)),
    repack: flag(revision?.isRepack),
  });
}

/**
 * The literals this scan knows and the generic sanitizer cannot.
 *
 * The sanitizer recognizes separators and long identifiers, which is all it can
 * know on its own. What it cannot know is that *this* scan's folder is called
 * "example-series" or that its download identifier is six characters long — so
 * those are removed literally, and every upstream-derived text on a candidate
 * goes through the same removal rather than only the rejections, which is where
 * this started and where it would have stopped if the fix had been applied to
 * the field that was demonstrated instead of to the class.
 */
function knownLiterals(context: ImportScanContext, record: UpstreamCandidate): readonly string[] {
  return [
    context.downloadId,
    context.folder,
    context.folder === undefined ? undefined : folderNameOf(context.folder),
    text(record.folderName),
  ].filter((value): value is string => value !== undefined);
}

/**
 * Maps one upstream candidate onto the model.
 *
 * The path is read exactly twice — once for the digest and once for the file
 * name — and neither result carries it. Where the instance reported no path at
 * all the candidate is still mapped, with the digest derived from the relative
 * path it did report, because a candidate without a fingerprint could not be
 * validated against later.
 */
/**
 * The path a candidate is fingerprinted from, if the instance reported one.
 *
 * Read on its own as well as inside the mapping, because whether a row can be
 * identified at all decides whether it is a candidate — and that question has
 * to be answerable without doing the mapping work, so the bounded traversal can
 * skip a row rather than map it and throw the result away.
 */
function identifiablePath(record: UpstreamCandidate): string | undefined {
  return text(record.path) ?? text(record.relativePath);
}

export function mapCandidate(
  context: ImportScanContext,
  record: UpstreamCandidate,
): ImportCandidate | undefined {
  const application = context.application;
  const path = identifiablePath(record);
  if (path === undefined) {
    return undefined;
  }

  // Every value below is derived exactly once and then used wherever it is
  // needed, including by the context. Deriving the same thing twice is how two
  // copies of one fact come to disagree — and a candidate whose context said
  // something different from what it displayed would bind a reference to a
  // mapping nobody was shown.
  //
  // Zero is how both applications report "no record", so it becomes absence
  // rather than travelling as an identifier that names nothing.
  const identity = fileIdentity(path);
  const mediaId = recordId(count(application === "sonarr" ? record.series?.id : record.movie?.id));
  const episodeIds =
    application === "sonarr"
      ? (record.episodes ?? [])
          .map((episode) => recordId(count(episode.id)))
          .filter((id): id is number => id !== undefined)
      : [];
  const existingFileId = recordId(
    count(application === "sonarr" ? record.episodeFileId : record.movieFileId),
  );
  const candidateId = recordId(count(record.id));
  const sizeBytes = retained(count(record.size), isFileSize);
  const seasonNumber =
    retained(count(record.seasonNumber), isSeasonNumber) ??
    retained(context.seasonNumber, isSeasonNumber);
  const known = knownLiterals(context, record);
  const rejections = candidateRejections(context, record);
  const importable = rejections.length === 0;
  // Derived once and used by both the candidate and its context, for the reason
  // every other value here is: two derivations of one fact are two things that
  // can disagree, and a context disagreeing with what was displayed would bind
  // a reference to a mapping nobody was shown.
  const quality = candidateQuality(record, known);
  const languages = safeLabelList(
    (record.languages ?? []).map((language) => language.name),
    known,
  );
  const releaseGroup = scrubLabel(record.releaseGroup, known);

  return {
    application,
    sourceKind: context.sourceKind,
    fileName:
      fileNameOf(record.relativePath, known) ??
      fileNameOf(record.path, known) ??
      scrubLabel(record.name, known),
    fileIdentity: identity,
    sizeBytes,
    media:
      mediaId === undefined
        ? undefined
        : mediaRef(application, application === "sonarr" ? "series" : "movie", mediaId),
    seasonNumber,
    episodes:
      episodeIds.length === 0
        ? undefined
        : episodeIds.map((id) => mediaRef("sonarr", "episode", id)),
    quality,
    languages,
    releaseGroup,
    releaseType: scrubLabel(record.releaseType, known),
    // The same concept the acquisition surface publishes, and held to the same
    // rule: a custom format is the one operator-authored name whose values carry
    // a separator by design, so scrubbing it strictly here while publishing it
    // there would be the divergence this adapter exists to avoid.
    customFormats: safeTaxonomyList(
      (record.customFormats ?? []).map((format) => format.name),
      known,
    ),
    customFormatScore: count(record.customFormatScore),
    indexerFlags: safeLabelList(indexerFlagStrings(record.indexerFlags), known),
    decision: { importable, rejections },
    // A candidate the instance already associates with a library file is a file
    // the library holds, not a new import, and a positive file identifier on
    // the row is what says so.
    //
    // Neither application sends that identifier at the recorded versions —
    // Sonarr 4.0.19.2979 and Radarr 6.3.0.10514 both omit it on every
    // manual-import row, which change 0021's sweep established against both
    // instances — so this reads false against them today and the rejection is
    // what reports an already-held file instead. The field stays declared and
    // read: it is the shape the resource documents, an older or newer release
    // may send it, and reading it costs nothing. Closing the gap it leaves
    // needs its own change.
    existingLibraryFile: existingFileId !== undefined,
    context: {
      application,
      sourceKind: context.sourceKind,
      candidateId,
      queueItemId: context.queueItemId,
      mediaId,
      scanMediaId: context.sourceKind === "library_context" ? context.mediaId : undefined,
      // The scan context's own media is the queue row's association, because
      // that is where it came from; the mapping's media is the one above, and a
      // correction moves only that one.
      queueMediaId:
        context.sourceKind === "tracked_download" ? recordId(context.mediaId) : undefined,
      seasonNumber,
      episodeIds: episodeIds.length === 0 ? undefined : episodeIds,
      fileIdentity: identity,
      sizeBytes,
      existingFileId,
      importable,
      // Held to the retained-label rule the reference schema enforces, so the
      // adapter cannot produce a selection the boundary would refuse. The
      // mappers above already turn a blank upstream string into absence; this
      // is what makes that a stated rule rather than a coincidence.
      selected: present({
        quality: retained(quality?.name, isRetainedLabel),
        languages:
          languages === undefined
            ? undefined
            : languages.filter((language) => isRetainedLabel(language)),
        releaseGroup: retained(releaseGroup, isRetainedLabel),
      }),
    },
  };
}

/**
 * One bounded page of the candidates a scan found.
 *
 * The upstream endpoint is unpaged and answers a whole folder, which is not a
 * bound: a library context can hold arbitrarily many files, and "one folder" is
 * a description of the request rather than a limit on the answer. So the rows
 * it returns are projected into a page here, under the same scan ceiling every
 * other unpaged route in this project is read through, and a page that stopped
 * early says so rather than looking like the end of the folder.
 *
 * A row this server cannot fingerprint is dropped rather than returned
 * unusable, and the count of dropped rows is reported so a short answer is
 * never silently short.
 */
export interface CandidateScan extends AdapterPage<ImportCandidate> {
  /** Rows the instance returned that carried no path to fingerprint. */
  readonly unmappable: number;
}

async function readCandidates(
  client: UpstreamClient,
  context: ImportScanContext,
  window: PageWindow,
): Promise<CandidateScan> {
  const records = parseUpstream(
    z.array(candidateSchema),
    await client.get(manualImportRoute, scanQuery(context)),
    context.application,
    manualImportRoute,
  );

  // Projected over the rows the instance returned rather than over an
  // already-mapped array of them. Mapping first would do unbounded work before
  // the ceiling could apply — a folder of a hundred thousand files would be
  // mapped in full and then paged — so the traversal itself is what is bounded,
  // and the mapping happens inside it.
  //
  // A row carrying no path cannot be fingerprinted, so it is not a candidate at
  // all: it is excluded rather than mapped, which also keeps it from occupying
  // a slot the caller asked to be filled.
  const page = projectPage({
    source: records,
    window,
    include: (record) => identifiablePath(record) !== undefined,
    map: (record) => mapCandidate(context, record) as ImportCandidate,
  });

  // Counted over everything the instance returned, and worded as such. An
  // earlier version claimed to count only what the projection examined, which
  // it did not: the projection stops as soon as it has filled the page and seen
  // one row past it, so a narrow page would have reported rows it never looked
  // at. The parsing has already visited every row, so counting them costs
  // nothing beyond what was spent.
  const unmappable = records.filter((record) => identifiablePath(record) === undefined).length;
  return {
    ...page,
    unmappable,
    warnings: [
      ...(page.warnings ?? []),
      ...(unmappable === 0
        ? []
        : [
            `${String(unmappable)} of the file(s) this instance returned carry no path to identify them and are not candidates`,
          ]),
    ],
  };
}

/** What a scan answers, whichever reference it started from. */
export type CandidateScanResult =
  | { readonly status: "ok"; readonly scan: CandidateScan }
  /** The queue row or library record the scan was to start from is gone. */
  | { readonly status: "absent"; readonly error: ToolError }
  /** It exists but names no location, so there is nothing to scan. */
  | { readonly status: "unmapped"; readonly error: ToolError };

/**
 * Scans the download a queue reference names.
 *
 * This and {@link scanLibraryContext} are the only ways into a candidate scan,
 * and that is the design rather than a convenience. Both derive the folder and
 * the download identity from upstream state — the queue row, the library record
 * — so no caller-supplied value decides where the instance looks. A scan
 * entry point that accepted a folder would be a filesystem browser wearing a
 * manual-import name.
 */
export async function scanTrackedDownload(
  client: UpstreamClient,
  application: MediaApplication,
  request: { readonly queueItemId: number; readonly mediaId?: number | undefined },
  window: PageWindow,
): Promise<CandidateScanResult> {
  const resolved = await readTrackedScanContext(client, application, request);
  if (!resolved.ok) {
    return { status: resolved.reason, error: scanRefusal(application, resolved.reason) };
  }
  return { status: "ok", scan: await readCandidates(client, resolved.context, window) };
}

/** Scans the folder the application itself holds for a series or a movie. */
export async function scanLibraryContext(
  client: UpstreamClient,
  application: MediaApplication,
  request: { readonly mediaId: number; readonly seasonNumber?: number | undefined },
  window: PageWindow,
): Promise<CandidateScanResult> {
  const resolved = await readLibraryScanContext(client, application, request);
  if (!resolved.ok) {
    return { status: resolved.reason, error: scanRefusal(application, resolved.reason) };
  }
  return { status: "ok", scan: await readCandidates(client, resolved.context, window) };
}

/**
 * Where a candidate was found, in the terms a reference retained.
 *
 * It carries no path and no download identifier, which is what makes it safe to
 * accept from outside this module: every location it leads to is re-derived
 * from upstream state by the same two resolvers a first scan uses. A correction
 * therefore reaches exactly the folder the original scan reached, and reaches it
 * because the queue row or the library record still says so.
 */
export interface CandidateOrigin {
  readonly sourceKind: ImportSourceKind;
  /** The queue row a tracked scan started from. */
  readonly queueItemId?: number | undefined;
  /** The library record a library-context scan was scoped to. */
  readonly scanMediaId?: number | undefined;
  readonly seasonNumber?: number | undefined;
  /** The media association the tracked queue read is scoped by, where there is one. */
  readonly mediaId?: number | undefined;
}

/**
 * The corrected mapping one reprocess sends, already resolved.
 *
 * Every member is an upstream identifier or an object read from the instance's
 * own definitions — never a string a caller wrote, and never a path. What a
 * caller may correct is decided by the published schema and compiled by
 * {@link ../../adapters/import/corrections.js}; this is what that compilation
 * produces, and this type is the reason nothing else can reach the payload.
 */
export interface UpstreamMappingPatch {
  readonly mediaId?: number | undefined;
  readonly episodeIds?: readonly number[] | undefined;
  readonly quality?: unknown;
  readonly languages?: readonly unknown[] | undefined;
  readonly releaseGroup?: string | undefined;
}

export type ReprocessResult =
  | { readonly status: "ok"; readonly candidate: ImportCandidate }
  /**
   * The queue row, the library record, or the file itself is gone.
   *
   * Carries the same typed error a scan gives for the same thing, for the same
   * reason: a target that has gone is a domain answer with a remedy — read the
   * query the reference came from again — while a timeout, an authentication
   * failure and a 5xx stay what they are and are thrown.
   */
  | { readonly status: "absent"; readonly error: ToolError }
  /** The origin exists but names no location, so there is nothing to reprocess. */
  | { readonly status: "unmapped"; readonly error: ToolError };

/**
 * Re-decides one candidate with a corrected mapping.
 *
 * The path is recovered rather than remembered. The scan is re-run from the
 * origin, the row whose file digest matches the one the reference retained is
 * the row this is about, and its path goes straight into the request — so the
 * canonical path enters here, builds exactly one upstream request, and leaves
 * as the digest it arrived as. A file that is no longer there has no matching
 * digest and is reported absent, which is the same answer a caller needs before
 * an import as after one.
 *
 * The endpoint re-runs the application's own decision engine and answers with
 * the re-decided row. It imports nothing: the import is a command, and this is
 * not it.
 */
/**
 * The folder an application holds for one library record.
 *
 * It is the destination an import would write into, which is what the
 * free-space precondition is about. Read from the record itself rather than
 * composed here: the path is the instance's own, it never leaves this adapter,
 * and a record that reports none has no destination to check.
 */
export async function readMediaFolder(
  client: UpstreamClient,
  application: MediaApplication,
  mediaId: number,
): Promise<string | undefined> {
  const route = `${application === "sonarr" ? seriesRoute : movieRoute}/${String(mediaId)}`;
  const record = parseUpstream(libraryRecordSchema, await client.get(route), application, route);
  return text(record.path);
}

/**
 * The row one retained candidate stands for, found again from its origin.
 *
 * This is the recovery half of a reprocess, and it is shared with the import
 * itself for one reason: both need the file's path, and neither may remember
 * it. The scan is re-run from the origin, the row whose digest matches the one
 * the reference retained is the row in question, and the path travels no
 * further than the request being built from it. A file that is no longer under
 * the folder has no matching digest and is absent, which is the answer a caller
 * needs whether it is about to correct a mapping or import one.
 */
export interface RecoveredCandidateRow {
  readonly context: ImportScanContext;
  readonly row: UpstreamCandidate;
  /** The canonical path, for building one upstream request and nothing else. */
  readonly path: string;
}

export type RecoverResult =
  | { readonly status: "ok"; readonly recovered: RecoveredCandidateRow }
  | { readonly status: "absent"; readonly error: ToolError }
  | { readonly status: "unmapped"; readonly error: ToolError };

export async function recoverCandidateRow(
  client: UpstreamClient,
  application: MediaApplication,
  origin: CandidateOrigin,
  identity: string,
): Promise<RecoverResult> {
  // An origin whose own identifier is missing names nothing, and there is no
  // number that stands in for one: substituting a default would turn an absent
  // identifier into a real-looking one and send it to the instance, where it
  // would either read an unrelated record or come back as "gone" — reporting a
  // malformed reference as a target that used to exist. It is refused here,
  // where it is discovered, before any upstream read, and it guards the import
  // as well as the reprocess because both reach the instance through this.
  const anchor = origin.sourceKind === "tracked_download" ? origin.queueItemId : origin.scanMediaId;
  if (anchor === undefined || !isRecordIdentifier(anchor)) {
    return { status: "unmapped", error: scanRefusal(application, "unmapped") };
  }

  const resolved =
    origin.sourceKind === "tracked_download"
      ? await readTrackedScanContext(client, application, {
          queueItemId: anchor,
          mediaId: origin.mediaId,
        })
      : await readLibraryScanContext(client, application, {
          mediaId: anchor,
          seasonNumber: origin.seasonNumber,
        });
  if (!resolved.ok) {
    return { status: resolved.reason, error: scanRefusal(application, resolved.reason) };
  }
  const context = resolved.context;

  const rows = parseUpstream(
    z.array(candidateSchema),
    await client.get(manualImportRoute, scanQuery(context)),
    application,
    manualImportRoute,
  );
  for (const row of rows) {
    const path = identifiablePath(row);
    if (path !== undefined && fileIdentity(path) === identity) {
      return { status: "ok", recovered: { context, row, path } };
    }
  }
  // The folder still answers and this file is not in it, which is the file
  // having gone rather than the scan having failed.
  return { status: "absent", error: scanRefusal(application, "absent") };
}

export async function reprocessCandidate(
  client: UpstreamClient,
  application: MediaApplication,
  origin: CandidateOrigin,
  identity: string,
  patch: UpstreamMappingPatch,
): Promise<ReprocessResult> {
  const found = await recoverCandidateRow(client, application, origin, identity);
  if (found.status !== "ok") {
    return found;
  }
  const { context, row, path } = found.recovered;

  const answered = parseUpstream(
    z.array(candidateSchema),
    // The list itself, not an object holding one. Both applications declare this
    // payload as the collection and answer an object wrapping it with a `400`
    // naming the type they wanted, so the wrapper made every reprocess — and
    // therefore every import, which revalidates through this — fail outright.
    await client.post(manualImportRoute, [reprocessRow(context, row, path, patch)]),
    application,
    manualImportRoute,
  );
  const decided = answered[0];
  if (decided === undefined) {
    return { status: "absent", error: scanRefusal(application, "absent") };
  }
  const candidate = mapCandidate(context, decidedRow(row, decided));
  return candidate === undefined
    ? { status: "absent", error: scanRefusal(application, "absent") }
    : { status: "ok", candidate };
}

/**
 * The re-decided row, read over the scan row it re-decides.
 *
 * The answer is a narrower resource than a scan row: it restates the
 * *decision* — the mapping, the quality, the languages, the rejections — and
 * says nothing about the file itself. It carries no size, no row identifier, no
 * relative path and no existing-file identity, and Sonarr names its media flat
 * where a scan names it nested.
 *
 * So the scan this same call just re-ran is the base, and only what the answer
 * actually decided is written over it. That direction is the point: a field the
 * answer does not state keeps the value the instance reported for it moments
 * ago, rather than becoming absent because this list forgot to name it. The
 * decision's own fields are closed by what the resource declares, and a
 * decision the answer does state — including an empty rejection list — wins
 * over the scan's, which is the whole reason for asking.
 *
 * Four fields the answer does state are deliberately not taken from it, because
 * what it states for them is a default rather than a decision. Sonarr answers
 * `releaseType: "unknown"` for a file its own scan called a single episode or a
 * season pack, so that one is left out of the list below entirely; both
 * applications answer `indexerFlags` as a numeric bitfield naming nothing a
 * caller can read, so that one is listed but guarded, and only a list of names
 * is taken from it. Either way the scan's value stands, because taking the
 * answer's would replace something this server knows with something it does
 * not — and reporting "unknown" for a value already in hand is exactly the
 * untrue answer this surface must not give.
 *
 * `customFormats` and `customFormatScore` are the other two, held to the same
 * rule and also left out of the list. Here the reason is a limit rather than a
 * recording: on the instances this was verified against, no file matches any
 * format either application defines, so both the scan and the answer report an
 * empty list and a zero score, and whether the answer recomputes them or
 * defaults them could not be established. The scan is preferred because the
 * two readings are not equally costly — a default would blank the formats of
 * every re-decided candidate, unconditionally, while a recomputation differs
 * from the scan only where a correction changed it, and the scan's value is
 * still one this instance reported for this file moments ago rather than one
 * nobody gave.
 *
 * Nothing is weakened by this: the fingerprint comparison still runs against a
 * scan performed now rather than against anything a reference remembered.
 */
function decidedRow(scanned: UpstreamCandidate, decided: UpstreamCandidate): UpstreamCandidate {
  return {
    ...scanned,
    ...stated({
      // The media the answer may name flat, put back in the shape the mapping
      // reads. Sonarr sends only the flat identifier; Radarr sends both.
      series: decided.series ?? identified(decided.seriesId),
      movie: decided.movie ?? identified(decided.movieId),
      seasonNumber: decided.seasonNumber,
      episodes: decided.episodes,
      quality: decided.quality,
      languages: decided.languages,
      releaseGroup: decided.releaseGroup,
      rejections: decided.rejections,
      // Both applications restate these as a numeric bitfield here, which names
      // nothing a caller can read, so an answer that is not a list of names
      // leaves the scan's names in place.
      indexerFlags: Array.isArray(decided.indexerFlags) ? decided.indexerFlags : undefined,
    }),
  };
}

/** The members an answer actually stated, where `undefined` is "did not say". */
function stated<TFields extends Record<string, unknown>>(fields: TFields): Partial<TFields> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  ) as Partial<TFields>;
}

/** The nested media object a flat identifier stands for, where there is one. */
function identified(id: number | null | undefined): { id: number } | undefined {
  const value = count(id);
  return value === undefined ? undefined : { id: value };
}

/**
 * The one element a reprocess sends.
 *
 * It is the request-side half of {@link importFileFields}, and it carries the
 * two things a validation needs beyond the mapping: which folder the file was
 * found under, and which season it is being decided for.
 *
 * The season is the row's own, except where the correction moves the file to
 * another media record without saying which episodes it lands on — see
 * {@link movesMediaUnnamed}. A season number counts within one series, so
 * sending the scanned one against a different series states a mapping the
 * caller did not select, exactly as the scanned episodes would.
 */
function reprocessRow(
  context: ImportScanContext,
  row: UpstreamCandidate,
  path: string,
  patch: UpstreamMappingPatch,
): UpstreamBody {
  const folderName = text(row.folderName) ?? scannedFolderName(context);
  const seasonNumber = movesMediaUnnamed(row, patch)
    ? undefined
    : (count(row.seasonNumber) ?? context.seasonNumber);
  return {
    ...importFileFields(context, row, path, patch),
    ...(folderName === undefined ? {} : { folderName }),
    ...(seasonNumber === undefined ? {} : { seasonNumber }),
  };
}

/** The name of the folder this scan reached, where it reached one. */
function scannedFolderName(context: ImportScanContext): string | undefined {
  return context.folder === undefined ? undefined : folderNameOf(context.folder);
}

/**
 * What a manual-import request says about one file, field by named field.
 *
 * Shared by the reprocess that validates a mapping and by the command that
 * imports it, because the two have to agree: a validation that approved one
 * mapping while the import submitted another would be a guarantee about
 * something nobody sent. Both applications declare a flat media identifier on
 * these resources rather than the nested object a scan answers with, and
 * spreading the scan row is what put the nested one into a request that wanted
 * the identifier — so every field here is named, and a property an instance
 * adds to a scan answer cannot travel back by existing.
 *
 * The caller's corrections win where there are any and the instance's own
 * decision fills the rest, which is what makes the mapping that is imported the
 * mapping that was validated.
 */
export function importFileFields(
  context: ImportScanContext,
  row: UpstreamCandidate,
  path: string,
  patch: UpstreamMappingPatch,
): UpstreamBody {
  const mediaId = patch.mediaId ?? count(row.series?.id) ?? count(row.movie?.id);
  const episodeIds = movesMediaUnnamed(row, patch)
    ? []
    : (patch.episodeIds ??
      (row.episodes ?? []).flatMap((episode) => {
        const id = count(episode.id);
        return id === undefined ? [] : [id];
      }));
  const quality =
    patch.quality === undefined
      ? row.quality
      : { ...(isRecord(row.quality) ? row.quality : {}), quality: patch.quality };
  const languages = patch.languages ?? row.languages;
  const releaseGroup = patch.releaseGroup ?? row.releaseGroup ?? undefined;

  return {
    path,
    ...(mediaId === undefined
      ? {}
      : context.application === "sonarr"
        ? { seriesId: mediaId }
        : { movieId: mediaId }),
    ...(episodeIds.length === 0 ? {} : { episodeIds: [...episodeIds] }),
    ...(quality === undefined || quality === null ? {} : { quality }),
    ...(languages === undefined || languages === null ? {} : { languages: [...languages] }),
    ...(releaseGroup === undefined ? {} : { releaseGroup }),
    // The download identity is what ties an imported file back to the queue row
    // it came from, and a scan answer drops it, so it comes from the context
    // this call re-derived rather than from the row.
    ...(context.downloadId === undefined ? {} : { downloadId: context.downloadId }),
  };
}

/**
 * Whether this patch moves the file to a media record the row is not mapped to
 * without saying which episodes it lands on.
 *
 * The row's episodes and season describe the media the *scan* filed this file
 * under, and a correction that names a different series does not carry them
 * with it: an episode belongs to the series it is an episode of, whatever the
 * mapping around it is renamed to. Sending them anyway builds an element that
 * reads as coherent and is not — a file mapped to one series carrying another
 * series' episode — and Sonarr accepts it: verified against 4.0.19.2979, the
 * corrected series with the scanned series' episode returns `200` with no
 * rejections at all, so nothing later in this path would stop the import.
 *
 * Carrying nothing instead is what lets the application answer for itself.
 * Against the same instance, the same file and the same corrected series with
 * neither episodes nor a season returns a **permanent** rejection, which the
 * rejection guard already refuses an import on — and the episodes it names in
 * that answer belong to the corrected series, so what a caller is shown is a
 * mapping that is at least about the media it asked for.
 *
 * Where the caller did name episodes there is nothing to infer: that mapping is
 * theirs, it is what the reference is fingerprinted from, and this stays out of
 * the way of it. Radarr reaches this with no episodes and no season to drop, so
 * it needs no case of its own and has none.
 */
function movesMediaUnnamed(row: UpstreamCandidate, patch: UpstreamMappingPatch): boolean {
  if (patch.mediaId === undefined || patch.episodeIds !== undefined) {
    return false;
  }
  return patch.mediaId !== (count(row.series?.id) ?? count(row.movie?.id));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
