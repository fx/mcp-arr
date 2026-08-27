import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { UpstreamClient, UpstreamQuery } from "../../http/client.js";
import { safeReason } from "../acquisition/parse.js";
import { safeLabel, safeText } from "../activity/parse.js";
import { type MediaApplication, mediaRef } from "../library/model.js";
import { type AdapterPage, type PageWindow, projectPage } from "../library/paging.js";
import {
  count,
  customFormatList,
  flag,
  optionalUpstreamId,
  parseUpstream,
  present,
  text,
  upstreamId,
  upstreamText,
} from "../library/parse.js";
import {
  type ImportCandidate,
  type ImportDecision,
  type ImportQuality,
  type ImportRejection,
  type ImportRejectionType,
  type ImportSourceKind,
  isFileSize,
  isRecordIdentifier,
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
  indexerFlags: z.unknown().nullish(),
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
  episodes: z.array(z.object({ id: optionalUpstreamId })).nullish(),
  episodeFileId: optionalUpstreamId,
  movieFileId: optionalUpstreamId,
  rejections: z.array(rejectionSchema).nullish(),
});

type UpstreamCandidate = z.infer<typeof candidateSchema>;

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
interface ImportScanContext {
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
  const record = parseUpstream(libraryRecordSchema, await client.get(route), application, route);

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
function retained(
  value: number | undefined,
  accepts: (candidate: number) => boolean,
): number | undefined {
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

/** One upstream label, with this scan's own literals removed before the rest. */
function scrubLabel(
  value: string | null | undefined,
  known: readonly string[],
): string | undefined {
  return safeLabel(safeReason(value, known));
}

/**
 * A list of upstream labels, each sanitized rather than merely trimmed.
 *
 * `textList` normalizes; it does not scrub. Every member of these lists is a
 * name an operator or an indexer chose — a custom format, a language, an
 * indexer flag — so any of them can carry a path, a URL, or an identifier, and
 * on this surface that is the one thing that must not travel. A member that is
 * entirely redacted is dropped rather than returned as a marker, because a
 * label that says only "[redacted path]" names nothing a caller can use.
 */
function safeLabelList(
  values: readonly (string | null | undefined)[] | null | undefined,
  known: readonly string[],
): readonly string[] | undefined {
  if (!Array.isArray(values)) {
    return undefined;
  }
  const cleaned = values
    .map((value) => scrubLabel(value, known))
    .filter((value): value is string => value !== undefined && !value.startsWith("[redacted"));
  return cleaned.length === 0 ? undefined : cleaned;
}

function indexerFlagNames(value: unknown, known: readonly string[]): readonly string[] | undefined {
  return Array.isArray(value)
    ? safeLabelList(
        value.filter((flagName): flagName is string => typeof flagName === "string"),
        known,
      )
    : undefined;
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

  // Zero is how both applications report "no record", so it becomes absence
  // here rather than travelling as an identifier that names nothing.
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
  const known = knownLiterals(context, record);
  const rejections = candidateRejections(context, record);

  return {
    application,
    sourceKind: context.sourceKind,
    fileName:
      fileNameOf(record.relativePath, known) ??
      fileNameOf(record.path, known) ??
      scrubLabel(record.name, known),
    fileIdentity: fileIdentity(path),
    sizeBytes: retained(count(record.size), isFileSize),
    media:
      mediaId === undefined
        ? undefined
        : mediaRef(application, application === "sonarr" ? "series" : "movie", mediaId),
    seasonNumber: retained(count(record.seasonNumber), isSeasonNumber),
    episodes:
      episodeIds.length === 0
        ? undefined
        : episodeIds.map((id) => mediaRef("sonarr", "episode", id)),
    quality: candidateQuality(record, known),
    languages: safeLabelList(
      (record.languages ?? []).map((language) => language.name),
      known,
    ),
    releaseGroup: scrubLabel(record.releaseGroup, known),
    releaseType: scrubLabel(record.releaseType, known),
    customFormats: safeLabelList(
      (record.customFormats ?? []).map((format) => format.name),
      known,
    ),
    customFormatScore: count(record.customFormatScore),
    indexerFlags: indexerFlagNames(record.indexerFlags, known),
    decision: decisionFor(rejections),
    // A candidate the instance already associates with a library file is a file
    // the library holds, not a new import. Both applications report that as the
    // file identifier on the row, and a positive one is the only signal either
    // gives.
    existingLibraryFile: existingFileId !== undefined,
    context: {
      application,
      sourceKind: context.sourceKind,
      candidateId: recordId(count(record.id)),
      queueItemId: context.queueItemId,
      mediaId,
      scanMediaId: context.sourceKind === "library_context" ? context.mediaId : undefined,
      seasonNumber:
        retained(count(record.seasonNumber), isSeasonNumber) ??
        retained(context.seasonNumber, isSeasonNumber),
      episodeIds: episodeIds.length === 0 ? undefined : episodeIds,
      fileIdentity: fileIdentity(path),
      sizeBytes: count(record.size),
      existingFileId:
        existingFileId !== undefined && existingFileId > 0 ? existingFileId : undefined,
    },
  };
}

/**
 * Whether the file can be imported as mapped.
 *
 * Any rejection at all makes it unimportable. The applications distinguish
 * permanent from temporary, but the specification does not: a candidate that
 * carries a blocking rejection must not be executed, and treating a temporary
 * one as importable would be this server deciding that upstream's objection did
 * not count.
 */
function decisionFor(rejections: readonly ImportRejection[]): ImportDecision {
  return { importable: rejections.length === 0, rejections };
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
  | { readonly status: "absent" }
  /** It exists but names no location, so there is nothing to scan. */
  | { readonly status: "unmapped" };

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
    return { status: resolved.reason };
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
    return { status: resolved.reason };
  }
  return { status: "ok", scan: await readCandidates(client, resolved.context, window) };
}
