import { profileFor, readQueueForMedia } from "../../adapters/activity/media.js";
import type { QueueItem } from "../../adapters/activity/model.js";
import { readCommands } from "../../adapters/activity/shared.js";
import {
  type CandidateOrigin,
  readMediaFolder,
  scanTrackedDownload,
} from "../../adapters/import/candidates.js";
import {
  checkFreeSpace,
  type ImportRefusal,
  isImportable,
  validateForImport,
} from "../../adapters/import/corrections.js";
import { type ImportFileRequest, manualImportCommandName } from "../../adapters/import/execute.js";
import type { ImportCandidate } from "../../adapters/import/model.js";
import { commandGoneWarning, readCommandRecord } from "../../adapters/jobs.js";
import type { MediaApplication } from "../../adapters/library/model.js";
import { defaultScanLimit } from "../../adapters/library/paging.js";
import {
  type EpisodeState,
  readEpisodeStates,
  readLibraryTitleById,
} from "../../adapters/library/titles.js";
import type { ApplicationAdapter } from "../../adapters/registry.js";
import type { ClaimedImport } from "../../state/download-claims.js";
import type { UpstreamCommandObservation } from "../../state/jobs.js";
import type { MediaContext } from "./context.js";
import { kindRoutes, type TitleKind } from "./kinds.js";
import { type Resolution, resolutionOf } from "./resolution.js";
import type { DownloadState, ReportedDownload } from "./schemas.js";

/**
 * Downloads, as the `media` toolset talks about them.
 *
 * The applications list a download once per episode it covers, so a season
 * pack is several queue rows. Everything here works on the download instead:
 * rows are grouped by the download identity they share, a download is
 * classified once from all of its rows, and both `media_status` and
 * `media_fix` call the same {@link judgeDownload}, so the remedy one reports
 * is the remedy the other applies.
 */

/** One download: the queue rows that share its identity, in the order upstream listed them. */
export interface Download {
  /** The download's claim key: its application and identity, or its one row. */
  readonly key: string;
  /**
   * Whether the rows carry a download identity. Rows that do not cannot be
   * told apart from the other rows of the same download, so each is its own
   * download and never given the `import` remedy.
   */
  readonly identified: boolean;
  /** Never empty. The first row is the one an action is sent through. */
  readonly rows: readonly QueueItem[];
}

function keyOf(item: QueueItem): { readonly key: string; readonly identified: boolean } {
  const identity = item.origin?.downloadIdentity;
  return identity === undefined
    ? { key: `${item.application}\u0000row:${item.context.queueItemId}`, identified: false }
    : { key: `${item.application}\u0000id:${identity}`, identified: true };
}

/**
 * Groups queue rows into downloads, each placed where its first row was.
 */
export function groupDownloads(items: readonly QueueItem[]): Download[] {
  const groups = new Map<string, { identified: boolean; rows: QueueItem[] }>();
  for (const item of items) {
    const { key, identified } = keyOf(item);
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, { identified, rows: [item] });
    } else {
      group.rows.push(item);
    }
  }
  return [...groups].map(([key, group]) => ({
    key,
    identified: group.identified,
    rows: group.rows,
  }));
}

/** Why a row is stuck, as the remedy table distinguishes it. */
type StuckCause = "unavailable" | "failed" | "stalled" | "import_blocked" | "unrecognized";

type RowVerdict =
  | { readonly state: Exclude<DownloadState, "stuck"> }
  | { readonly state: "stuck"; readonly cause: StuckCause };

/**
 * The one sentence each outcome is explained with.
 *
 * A closed table, so no reason ever carries text an instance wrote: an
 * upstream status message names release titles and paths verbatim, and the
 * one-sentence reason is what a caller reads.
 */
export const downloadReasons = {
  unavailable: "The downloader holding it cannot be reached, so nothing can be changed.",
  failed: "The download failed.",
  stalled: "The downloader reports a problem with it, such as nothing to download it from.",
  unrecognized: "It is in a state this server does not recognize.",
  importable: "It finished downloading but its files were not moved into the library.",
  unidentified:
    "Its parts cannot be told apart from other downloads, so its files cannot be matched safely.",
  filesNotFound: "Its files could not be found.",
  noFiles: "No files were found in it.",
  tooManyFiles: "It holds more files than can be checked in one call.",
  unidentifiedFiles: "Some of its files could not be identified.",
  unmatched: "A file could not be matched to a movie or episode.",
  otherTitle: "A file is matched to a different title than this one.",
  refused: "A file was refused for import and needs a person to look at it.",
  libraryHasFile: "The library already has a file for a movie or episode it would import.",
  libraryCannotSay:
    "The library could not confirm it has no file for a movie or episode it would import.",
  noFolder: "The library has no folder to move its files into.",
  noSpace: "There is not enough free space to move its files into the library.",
  unverifiedSpace: "Free space for its files could not be confirmed.",
  changed: "Its files changed while they were being checked.",
  checkFailed: "Its files could not be checked because a request failed.",
  targetBeingFixed: "Another download for the same movie or episode is being fixed.",
  targetImporting: "Another download for the same movie or episode is being imported.",
} as const;

const failedStates = new Set(["failed", "failed_pending"]);

/**
 * One row's state, from the download-state table.
 *
 * The order is the table's precedence: a pending release is waiting whatever
 * else it says; an unreachable downloader, a failure, and a blocked import are
 * stuck before anything reads as progress; a warning on a download that is
 * still downloading is the stalled case. Anything the table does not name is
 * stuck with no remedy, because a state nobody wrote a rule for is not one to
 * act on.
 */
function rowVerdict(item: QueueItem): RowVerdict {
  const { status, trackedState, trackedStatus } = item.evidence;
  const troubled = trackedStatus === "warning" || trackedStatus === "error";
  if (item.kind === "pending_release") {
    return { state: "waiting" };
  }
  if (status === "download_client_unavailable") {
    return { state: "stuck", cause: "unavailable" };
  }
  if (status === "failed" || (trackedState !== undefined && failedStates.has(trackedState))) {
    return { state: "stuck", cause: "failed" };
  }
  if (trackedState === "import_blocked" || (trackedState === "import_pending" && troubled)) {
    return { state: "stuck", cause: "import_blocked" };
  }
  if (
    trackedState === "importing" ||
    trackedState === "imported" ||
    trackedState === "import_pending" ||
    (status === "completed" && trackedState === undefined)
  ) {
    return { state: "importing" };
  }
  if (status === "queued" || status === "paused") {
    return { state: "queued" };
  }
  const downloading = trackedState === undefined || trackedState === "downloading";
  if (downloading && (status === "warning" || troubled)) {
    return { state: "stuck", cause: "stalled" };
  }
  if (status === "downloading" && downloading) {
    return { state: "downloading" };
  }
  return { state: "stuck", cause: "unrecognized" };
}

/**
 * A download's state and remedy, from the evidence alone.
 *
 * The `import` remedy is provisional here: it says the rows look like an
 * import the server could finish, and only {@link judgeDownload} — which
 * scans the files and asks the library — turns that into a remedy anybody
 * reports or applies.
 */
export type Classification =
  | { readonly state: Exclude<DownloadState, "stuck"> }
  | { readonly state: "stuck"; readonly remedy: "replace" | "none"; readonly reason: string }
  | { readonly state: "stuck"; readonly remedy: "import"; readonly provisional: true };

const statePrecedence: readonly DownloadState[] = [
  "stuck",
  "importing",
  "downloading",
  "queued",
  "waiting",
];

/**
 * Classifies one download from every row it has.
 *
 * A download this process has started an import for is `importing` until that
 * import is seen to finish, whatever its rows say: until it runs, the rows
 * still look stuck. Otherwise the most pressing row decides the state, and a
 * stuck download's remedy is decided over all of its stuck rows — an
 * unreachable downloader blocks everything, a failed or stalled row means the
 * release is replaced, and only a download whose every stuck row is a blocked
 * import, and whose rows are identified, may be imported.
 */
export function classifyDownload(download: Download, importClaimed: boolean): Classification {
  if (importClaimed) {
    return { state: "importing" };
  }
  const verdicts = download.rows.map(rowVerdict);
  const state =
    statePrecedence.find((candidate) => verdicts.some((verdict) => verdict.state === candidate)) ??
    "stuck";
  if (state !== "stuck") {
    return { state };
  }
  const causes = new Set(
    verdicts.flatMap((verdict) => (verdict.state === "stuck" ? [verdict.cause] : [])),
  );
  if (causes.has("unavailable")) {
    return { state, remedy: "none", reason: downloadReasons.unavailable };
  }
  if (causes.has("failed")) {
    return { state, remedy: "replace", reason: downloadReasons.failed };
  }
  if (causes.has("stalled")) {
    return { state, remedy: "replace", reason: downloadReasons.stalled };
  }
  if (causes.has("unrecognized")) {
    return { state, remedy: "none", reason: downloadReasons.unrecognized };
  }
  if (!download.identified) {
    return { state, remedy: "none", reason: downloadReasons.unidentified };
  }
  return { state, remedy: "import", provisional: true };
}

/** A download's state and remedy, once an `import` has been confirmed or refused. */
export type Judgement =
  | { readonly state: Exclude<DownloadState, "stuck"> }
  | { readonly state: "stuck"; readonly remedy: "replace" | "none"; readonly reason: string }
  | {
      readonly state: "stuck";
      readonly remedy: "import";
      readonly reason: string;
      /** Every file the import would submit, as the validation just approved it. */
      readonly files: readonly ImportFileRequest[];
    };

type Confirmation =
  | { readonly ok: true; readonly files: readonly ImportFileRequest[] }
  | { readonly ok: false; readonly reason: string };

/** How many files one download may hold and still be checked. */
const maxCheckedFiles = 100;

function refusalReason(refusal: ImportRefusal): string {
  switch (refusal.kind) {
    case "existing_file":
      return downloadReasons.libraryHasFile;
    case "rejected":
      return downloadReasons.refused;
    case "no_space":
      return downloadReasons.noSpace;
    case "unverified_space":
      return downloadReasons.unverifiedSpace;
    case "absent":
    case "unmapped":
    case "stale":
      return downloadReasons.changed;
  }
}

/** The episodes, or the one movie, a candidate is matched to. */
function matchedTo(
  application: MediaApplication,
  candidate: ImportCandidate,
): readonly number[] | undefined {
  if (candidate.context.mediaId === undefined) {
    return undefined;
  }
  if (application === "radarr") {
    return [candidate.context.mediaId];
  }
  const episodes = candidate.context.episodeIds ?? [];
  return episodes.length === 0 ? undefined : episodes;
}

/**
 * Whether the library's own records show no file for anything the files map
 * to. Read from the movie or episode records themselves, never from the scan:
 * the scan's existing-file marker is derived from fields neither supported
 * version sends. Only a record that says `hasFile: false` counts; one that
 * says nothing is a record that cannot confirm it.
 */
export async function libraryFileProblem(
  adapter: ApplicationAdapter,
  application: MediaApplication,
  mediaId: number,
  mapped: readonly number[],
): Promise<string | undefined> {
  if (application === "radarr") {
    const record = await readLibraryTitleById(adapter.client, application, mediaId);
    if (record?.hasFile === true) {
      return downloadReasons.libraryHasFile;
    }
    return record?.hasFile === false ? undefined : downloadReasons.libraryCannotSay;
  }
  const episodes = new Map(
    (await readEpisodeStates(adapter.client, mediaId)).map((episode) => [episode.id, episode]),
  );
  let cannotSay = false;
  for (const id of mapped) {
    const hasFile = episodes.get(id)?.hasFile;
    if (hasFile === true) {
      return downloadReasons.libraryHasFile;
    }
    if (hasFile !== false) {
      cannotSay = true;
    }
  }
  return cannotSay ? downloadReasons.libraryCannotSay : undefined;
}

/**
 * The file as an import submits it: the instance's own decision, with no
 * correction, pinned to what that decision mapped it to when it was approved.
 */
function fileRequest(candidate: ImportCandidate, mediaId: number): ImportFileRequest {
  const context = candidate.context;
  const origin: CandidateOrigin = {
    sourceKind: context.sourceKind,
    queueItemId: context.queueItemId,
    scanMediaId: context.scanMediaId,
    seasonNumber: context.seasonNumber,
    mediaId: context.queueMediaId,
  };
  // No correction: an `import` remedy imports exactly what the instance
  // itself decided, so the patch is empty. What it decided is pinned, so the
  // submission refuses a file the instance has since mapped elsewhere.
  return {
    origin,
    identity: context.fileIdentity,
    patch: {},
    approved: { mediaId, episodeIds: [...(context.episodeIds ?? [])] },
  };
}

/**
 * What keeps two imports out of one movie or episode.
 *
 * `others` are the title's other downloads that are being imported, upstream
 * or by this process. `reserve` claims the import's targets for this download:
 * `media_fix` takes them, all or none, and `media_status`, which acts on
 * nothing, only asks whether another download holds one.
 */
export interface ImportGuard {
  readonly others: readonly Download[];
  reserve(targets: readonly string[]): boolean;
}

/** The claim key of one movie or episode an import is for. */
export function targetKey(application: MediaApplication, id: number): string {
  return `${application}\u0000${application === "radarr" ? "movie" : "episode"}:${id}`;
}

/** Whether another download being imported covers any of these movies or episodes. */
function coveredByOthers(
  application: MediaApplication,
  mediaId: number,
  mapped: readonly number[],
  others: readonly Download[],
): boolean {
  return others.some((other) =>
    other.rows.some((row) =>
      application === "radarr"
        ? row.context.mediaId === mediaId
        : row.episode !== undefined && mapped.includes(Number(row.episode.id)),
    ),
  );
}

/**
 * The downloads among these that are being imported, other than this one.
 * A download this process is importing counts whatever its rows say.
 */
export function importingOthers(
  context: MediaContext,
  downloads: readonly Download[],
  download: Download,
): Download[] {
  return downloads.filter(
    (other) =>
      other.key !== download.key &&
      classifyDownload(other, importClaimed(context, other.key)).state === "importing",
  );
}

/**
 * Confirms that a blocked import can be finished with no correction, or says
 * why not.
 *
 * Every check refuses rather than guesses, and the first refusal ends it: the
 * download's files are scanned through its first row; every file must be
 * matched to this title and importable as matched; no other download being
 * imported may cover what they map to, and no other fix may hold it; the
 * library's records must show no file for anything they map to; and each file
 * is re-decided by the
 * instance, which imports nothing, then checked for room together with the
 * others. Only then are the files an import would submit returned.
 */
async function confirmImport(
  adapter: ApplicationAdapter,
  kind: TitleKind,
  mediaId: number,
  download: Download,
  guard: ImportGuard,
): Promise<Confirmation> {
  const application = kindRoutes[kind].application;
  const first = download.rows[0];
  if (first === undefined) {
    return { ok: false, reason: downloadReasons.filesNotFound };
  }
  const scanned = await scanTrackedDownload(
    adapter.client,
    application,
    { queueItemId: first.context.queueItemId, mediaId: first.context.mediaId },
    { offset: 0, pageSize: maxCheckedFiles },
  );
  if (scanned.status !== "ok") {
    return { ok: false, reason: downloadReasons.filesNotFound };
  }
  const scan = scanned.scan;
  if (scan.unmappable > 0) {
    return { ok: false, reason: downloadReasons.unidentifiedFiles };
  }
  // With every row identifiable, the only warning a scan carries is that it
  // stopped at its bound.
  if (scan.hasMore || (scan.warnings?.length ?? 0) > 0) {
    return { ok: false, reason: downloadReasons.tooManyFiles };
  }
  if (scan.items.length === 0) {
    return { ok: false, reason: downloadReasons.noFiles };
  }

  const mapped: number[] = [];
  for (const candidate of scan.items) {
    const targets = matchedTo(application, candidate);
    if (targets === undefined) {
      return { ok: false, reason: downloadReasons.unmatched };
    }
    if (candidate.context.mediaId !== mediaId) {
      return { ok: false, reason: downloadReasons.otherTitle };
    }
    if (!isImportable(candidate)) {
      return { ok: false, reason: downloadReasons.refused };
    }
    mapped.push(...targets);
  }

  if (coveredByOthers(application, mediaId, mapped, guard.others)) {
    return { ok: false, reason: downloadReasons.targetImporting };
  }
  if (!guard.reserve(mapped.map((id) => targetKey(application, id)))) {
    return { ok: false, reason: downloadReasons.targetBeingFixed };
  }

  const held = await libraryFileProblem(adapter, application, mediaId, mapped);
  if (held !== undefined) {
    return { ok: false, reason: held };
  }

  const destination = await readMediaFolder(adapter.client, application, mediaId);
  if (destination === undefined) {
    return { ok: false, reason: downloadReasons.noFolder };
  }

  let total = 0;
  const approved: ImportFileRequest[] = [];
  for (const candidate of scan.items) {
    const validated = await validateForImport(adapter.client, application, {
      retained: candidate.context,
      patch: {},
      destination,
    });
    if (validated.status !== "ok") {
      return { ok: false, reason: refusalReason(validated.refusal) };
    }
    // Pinned as the instance re-decided it just now, which the validation
    // has already held equal to what the scan mapped it to.
    approved.push(fileRequest(validated.validation.candidate, mediaId));
    const size = validated.validation.candidate.sizeBytes;
    if (size === undefined) {
      return { ok: false, reason: downloadReasons.unverifiedSpace };
    }
    total += size;
  }
  // Each file fits on its own; the import moves them together.
  const room = await checkFreeSpace(adapter.client, application, destination, total);
  if (room.status !== "sufficient") {
    return {
      ok: false,
      reason:
        room.status === "insufficient" ? downloadReasons.noSpace : downloadReasons.unverifiedSpace,
    };
  }
  return { ok: true, files: approved };
}

/**
 * A download's state and remedy, decided the one way both `media_status` and
 * `media_fix` decide it.
 *
 * An `import` is never reported or applied on the classifier's word alone: it
 * is confirmed here against the files and the library first, and any refusal
 * makes the remedy `none` with the reason it was refused. An upstream failure
 * while confirming is thrown, so each caller decides what a failed check means
 * for its own result.
 */
export async function judgeDownload(
  adapter: ApplicationAdapter,
  kind: TitleKind,
  mediaId: number,
  download: Download,
  importClaimed: boolean,
  guard: ImportGuard,
): Promise<Judgement> {
  const classified = classifyDownload(download, importClaimed);
  if (classified.state !== "stuck" || classified.remedy !== "import") {
    return classified;
  }
  const confirmed = await confirmImport(adapter, kind, mediaId, download, guard);
  return confirmed.ok
    ? {
        state: "stuck",
        remedy: "import",
        reason: downloadReasons.importable,
        files: confirmed.files,
      }
    : { state: "stuck", remedy: "none", reason: confirmed.reason };
}

/** The command states after which an import will not move again. */
const endedCommandStates = new Set([
  "completed",
  "failed",
  "aborted",
  "cancelled",
  "canceled",
  "orphaned",
]);

function commandEnded(observation: UpstreamCommandObservation): boolean {
  const state = observation.state?.toLowerCase();
  if (state === undefined) {
    // An instance answers an aged-out command with a 404, which the refresh
    // reports as an observation with no state and this one warning.
    return (observation.warnings ?? []).includes(commandGoneWarning);
  }
  return endedCommandStates.has(state);
}

/** How many imports one refresh reads back at a time. */
const refreshConcurrency = 4;

/**
 * How long an import whose answer was lost is held with no evidence either
 * way, from when it was sent. Long enough for a queued import to run on an
 * instance working through its backlog; short enough that a lost answer
 * cannot hold a download, and a place in the bounded map, for the life of
 * the process.
 */
export const uncertainImportHoldMs = 30 * 60 * 1000;

/**
 * How long after an import whose answer was lost the instance's command list
 * is taken as evidence. Before that, a list with no unfinished import could
 * be one the request has not reached yet.
 */
export const uncertainCommandWindowMs = 2 * 60 * 1000;

/** Whether the library's records show a file for every movie or episode an import is for. */
async function everyTargetHasFile(
  adapter: ApplicationAdapter,
  claimed: ClaimedImport,
): Promise<boolean> {
  if (claimed.application === "radarr") {
    const record = await readLibraryTitleById(adapter.client, "radarr", claimed.mediaId);
    return record?.hasFile === true;
  }
  const episodes = new Map(
    (await readEpisodeStates(adapter.client, claimed.mediaId)).map((episode) => [
      episode.id,
      episode,
    ]),
  );
  return (
    claimed.episodeIds.length > 0 &&
    claimed.episodeIds.every((id) => episodes.get(id)?.hasFile === true)
  );
}

/**
 * Whether there is evidence that an import whose answer was lost is over, or
 * never arrived: its download has left the queue, the library has a file for
 * everything it was for, or — once the request has had time to arrive — the
 * instance lists no unfinished import at all. Past the hold bound it is
 * released for want of evidence. A read that fails is no evidence.
 */
async function uncertainImportSettled(
  context: MediaContext,
  adapter: ApplicationAdapter,
  key: string,
  claimed: ClaimedImport,
): Promise<boolean> {
  const age = context.clock.now() - claimed.attemptedAt;
  if (age >= uncertainImportHoldMs) {
    return true;
  }
  if (claimed.application !== "sonarr" && claimed.application !== "radarr") {
    return false;
  }
  try {
    const rows = await readQueueForMedia(
      adapter.client,
      claimed.mediaId,
      profileFor(claimed.application),
      "summary",
    );
    if (!groupDownloads(rows.items).some((download) => download.key === key)) {
      return true;
    }
    if (await everyTargetHasFile(adapter, claimed)) {
      return true;
    }
    if (age < uncertainCommandWindowMs) {
      return false;
    }
    const commands = await readCommands(
      adapter.client,
      { offset: 0, pageSize: defaultScanLimit },
      claimed.application,
    );
    return !commands.items.some(
      (command) =>
        command.name === manualImportCommandName &&
        (command.status === "queued" || command.status === "started"),
    );
  } catch {
    return false;
  }
}

/** Whether one claimed import has ended, or is gone; doubt keeps it. */
async function importEnded(
  context: MediaContext,
  adapter: ApplicationAdapter,
  key: string,
  claimed: ClaimedImport,
): Promise<boolean> {
  if (claimed.commandId === undefined) {
    return uncertainImportSettled(context, adapter, key, claimed);
  }
  try {
    const refresh = await readCommandRecord(adapter.client, claimed.application, claimed.commandId);
    return refresh.status === "observed" && commandEnded(refresh.observation);
  } catch {
    return false;
  }
}

/**
 * Reads back every import this process started on one kind's instance, and
 * releases each claim whose import has ended, is gone, or — for one whose
 * answer was lost — is shown to be over or never to have arrived.
 *
 * It walks the claims themselves rather than the queue, because a finished
 * import's download normally leaves the queue, and a claim found only through
 * the queue would then never be released — the map would fill and refuse every
 * fix. Anything else — still queued or running, a state nobody recognizes, or a
 * read that failed — keeps its claim, because releasing one is what would let a
 * second import start; the map's bound, and the hold bound on an import whose
 * answer was lost, cap what doubt can hold. Both `media_status` and
 * `media_fix` run it before they judge anything, so within a call whether a
 * download is being imported is {@link importClaimed}.
 */
export async function refreshImports(
  context: MediaContext,
  adapter: ApplicationAdapter,
): Promise<void> {
  const pending = context.claims
    .imports()
    .filter(([, claimed]) => claimed.application === adapter.application);
  for (let index = 0; index < pending.length; index += refreshConcurrency) {
    await Promise.all(
      pending.slice(index, index + refreshConcurrency).map(async ([key, claimed]) => {
        if (await importEnded(context, adapter, key, claimed)) {
          context.claims.releaseImport(key, claimed);
        }
      }),
    );
  }
}

/** Whether this process has an unfinished import for a download, as last refreshed. */
export function importClaimed(context: MediaContext, key: string): boolean {
  return context.claims.importOf(key) !== undefined;
}

/** Season and episode numbers, by the episode's own identifier. */
export type EpisodeNumbers = ReadonlyMap<
  number,
  { readonly seasonNumber: number; readonly episodeNumber: number }
>;

/** The numbers of every episode that states both of them. */
export function episodeNumbersOf(episodes: readonly EpisodeState[]): EpisodeNumbers {
  const numbers = new Map<number, { seasonNumber: number; episodeNumber: number }>();
  for (const episode of episodes) {
    if (episode.seasonNumber !== undefined && episode.episodeNumber !== undefined) {
      numbers.set(episode.id, {
        seasonNumber: episode.seasonNumber,
        episodeNumber: episode.episodeNumber,
      });
    }
  }
  return numbers;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * Names episodes as comma-separated runs: `S02E03`, `S02E01–E10`,
 * `S01E09–E10, S02E01`. A run is consecutive episodes of one season.
 */
export function episodesLabel(
  episodes: readonly { readonly seasonNumber: number; readonly episodeNumber: number }[],
): string | undefined {
  const unique = new Map<
    string,
    { readonly seasonNumber: number; readonly episodeNumber: number }
  >();
  for (const episode of episodes) {
    unique.set(`${episode.seasonNumber}:${episode.episodeNumber}`, episode);
  }
  const sorted = [...unique.values()].sort(
    (left, right) =>
      left.seasonNumber - right.seasonNumber || left.episodeNumber - right.episodeNumber,
  );
  const runs: string[] = [];
  let index = 0;
  while (index < sorted.length) {
    const start = sorted[index];
    if (start === undefined) {
      break;
    }
    let end = start;
    while (
      sorted[index + 1]?.seasonNumber === start.seasonNumber &&
      sorted[index + 1]?.episodeNumber === end.episodeNumber + 1
    ) {
      index += 1;
      end = sorted[index] ?? end;
    }
    const opening = `S${pad(start.seasonNumber)}E${pad(start.episodeNumber)}`;
    runs.push(end === start ? opening : `${opening}–E${pad(end.episodeNumber)}`);
    index += 1;
  }
  return runs.length === 0 ? undefined : runs.join(", ");
}

/** Warned when a series download's episodes could not all be named. */
export const unnamedEpisodesWarning =
  "the episodes of a download could not all be named, so it carries no episodes label";

/**
 * The `episodes` label of a series download, or `undefined` with a warning
 * where any of its rows names an episode the numbers do not cover.
 */
export function downloadEpisodes(
  download: Download,
  numbers: EpisodeNumbers | undefined,
  warnings: string[],
): string | undefined {
  const named: { seasonNumber: number; episodeNumber: number }[] = [];
  for (const row of download.rows) {
    const id = row.episode === undefined ? undefined : Number(row.episode.id);
    const found = id === undefined ? undefined : numbers?.get(id);
    if (found === undefined) {
      if (!warnings.includes(unnamedEpisodesWarning)) {
        warnings.push(unnamedEpisodesWarning);
      }
      return undefined;
    }
    named.push(found);
  }
  return episodesLabel(named);
}

/** A whole percentage of a download's bytes that have arrived, where the sizes say. */
function progressOf(row: QueueItem | undefined): number | undefined {
  const size = row?.progress?.sizeBytes;
  const remaining = row?.progress?.remainingBytes;
  if (size === undefined || remaining === undefined || size <= 0 || remaining < 0) {
    return undefined;
  }
  return Math.min(100, Math.max(0, Math.floor(((size - remaining) / size) * 100)));
}

function resolutionOfDownload(download: Download): Resolution | undefined {
  return resolutionOf(download.rows[0]?.resolution);
}

/** One download as `media_status` reports it. */
export function reportDownload(
  title: { readonly kind: TitleKind; readonly id: number; readonly title?: string | undefined },
  download: Download,
  judgement: Judgement,
  episodes: string | undefined,
): ReportedDownload {
  const resolution = resolutionOfDownload(download);
  const progress = judgement.state === "downloading" ? progressOf(download.rows[0]) : undefined;
  return {
    kind: title.kind,
    id: title.id,
    ...(title.title === undefined ? {} : { title: title.title }),
    ...(episodes === undefined ? {} : { episodes }),
    state: judgement.state,
    ...(resolution === undefined ? {} : { resolution }),
    ...(progress === undefined ? {} : { progress }),
    ...(judgement.state === "stuck" ? { reason: judgement.reason, remedy: judgement.remedy } : {}),
  };
}
