import { profileFor, readQueueForMedia } from "../../adapters/activity/media.js";
import { compileQueueTransition } from "../../adapters/activity/transitions.js";
import { submitManualImport } from "../../adapters/import/execute.js";
import { readEpisodeStates } from "../../adapters/library/titles.js";
import type { ApplicationAdapter } from "../../adapters/registry.js";
import type { MediaContext } from "./context.js";
import {
  classifyDownload,
  type Download,
  downloadEpisodes,
  downloadReasons,
  type EpisodeNumbers,
  episodeNumbersOf,
  groupDownloads,
  importClaimed,
  judgeDownload,
  refreshImports,
} from "./downloads.js";
import {
  distinctErrors,
  type MediaError,
  mediaErrorFor,
  mediaErrorForCode,
  notInLibraryError,
} from "./errors.js";
import { kindRoutes, type TitleKind } from "./kinds.js";
import { type FixedDownload, type FixResult, maxListedEntries } from "./schemas.js";
import { resolveTitle } from "./titles.js";

/** The one sentence each outcome of a fix that did nothing is explained with. */
export const fixReasons = {
  alreadyFixing: "It is already being fixed.",
  tooManyFixes: "Too many fixes are in progress; try again later.",
  noLongerStuck: "It is no longer stuck.",
  notReplaceable: "It cannot be replaced by this server.",
  requestFailed: "The change could not be made because a request failed.",
} as const;

export interface FixRequest {
  readonly kind: TitleKind;
  readonly id: number;
}

interface FixScope {
  readonly context: MediaContext;
  readonly adapter: ApplicationAdapter;
  readonly version: string;
  readonly kind: TitleKind;
  /** The library record's own identifier. */
  readonly mediaId: number;
  readonly errors: MediaError[];
}

type Outcome = Pick<FixedDownload, "action" | "reason">;

function none(reason: string): Outcome {
  return { action: "none", reason };
}

/**
 * Acts on one download, holding its claim for exactly as long as the remedy
 * needs it.
 *
 * The download is re-read once the claim is held and judged from that
 * reading, so a download that recovered, left the queue, or changed in any way
 * since the call began is decided as it is now. A replacement's claim is
 * released when its request returns; an import's is kept, with the command it
 * started, until a later call sees that command finish. Any failure releases
 * the claim and is reported as this download's outcome.
 */
async function fixOne(scope: FixScope, download: Download): Promise<Outcome> {
  const { context, adapter, kind, mediaId } = scope;
  const claims = context.claims;
  const key = download.key;
  if (importClaimed(context, key)) {
    return none(fixReasons.alreadyFixing);
  }
  const attempt = claims.tryClaim(key);
  if (attempt === "held") {
    return none(fixReasons.alreadyFixing);
  }
  if (attempt === "full") {
    return none(fixReasons.tooManyFixes);
  }

  const application = kindRoutes[kind].application;
  try {
    const fresh = await readQueueForMedia(
      adapter.client,
      mediaId,
      profileFor(application),
      "summary",
    );
    const current = groupDownloads(fresh.items).find((candidate) => candidate.key === key);
    if (current === undefined) {
      claims.release(key);
      return none(fixReasons.noLongerStuck);
    }
    const judgement = await judgeDownload(adapter, kind, mediaId, current, false);
    if (judgement.state !== "stuck") {
      claims.release(key);
      return none(fixReasons.noLongerStuck);
    }

    if (judgement.remedy === "replace") {
      const first = current.rows[0];
      const compiled =
        first === undefined
          ? undefined
          : compileQueueTransition({
              application,
              version: scope.version,
              intent: "blocklist_and_remove",
              replacementSearch: "allow",
              observed: {
                application,
                queueItemId: first.context.queueItemId,
                itemKind: first.kind,
                status: first.evidence.status,
                trackedState: first.evidence.trackedState,
                mediaId: first.context.mediaId,
              },
            });
      if (compiled?.status !== "compiled" || compiled.transition.action.kind !== "upstream") {
        claims.release(key);
        if (compiled?.status === "rejected") {
          scope.errors.push(mediaErrorForCode(kind, compiled.error.code));
        }
        return none(fixReasons.notReplaceable);
      }
      const action = compiled.transition.action;
      await adapter.client.delete(action.path, action.query);
      claims.release(key);
      return { action: "replaced" };
    }

    if (judgement.remedy === "import") {
      const submission = await submitManualImport(
        adapter.client,
        application,
        judgement.files,
        "auto",
      );
      if (submission.status !== "ok") {
        claims.release(key);
        return none(downloadReasons.changed);
      }
      claims.markImporting(key, { application, commandId: submission.command.upstreamId });
      return { action: "import_started" };
    }

    claims.release(key);
    return none(judgement.reason);
  } catch (error) {
    claims.release(key);
    scope.errors.push(mediaErrorFor(kind, error));
    return none(fixReasons.requestFailed);
  }
}

/**
 * Fixes the stuck downloads of one title, at most ten per call, in the order
 * the queue lists them, one at a time.
 *
 * Which downloads are considered is decided from a first reading, without
 * regard to claims, so a download another call is already fixing is reported
 * as such rather than silently skipped. Everything that decides what is done
 * to a download comes from the reading {@link fixOne} takes once it holds the
 * claim.
 */
export async function fixTitle(context: MediaContext, request: FixRequest): Promise<FixResult> {
  const { kind, id } = request;
  const resolved = await resolveTitle(context, kind, id);
  if (!resolved.ok) {
    return { warnings: [], errors: [resolved.error] };
  }
  const named = { kind, id, ...(resolved.title === undefined ? {} : { title: resolved.title }) };
  const record = resolved.record;
  if (record === undefined) {
    return { ...named, warnings: [], errors: [notInLibraryError(kind)] };
  }
  const adapter = resolved.adapter;
  const application = kindRoutes[kind].application;
  await refreshImports(context, adapter);

  let downloads: Download[];
  try {
    const rows = await readQueueForMedia(
      adapter.client,
      record.id,
      profileFor(application),
      "summary",
    );
    downloads = groupDownloads(rows.items);
  } catch (error) {
    return { ...named, warnings: [], errors: [mediaErrorFor(kind, error)] };
  }
  const stuck = downloads.filter((download) => classifyDownload(download, false).state === "stuck");
  const considered = stuck.slice(0, maxListedEntries);

  const warnings: string[] = [];
  let numbers: EpisodeNumbers | undefined;
  if (kind === "series" && considered.length > 0) {
    try {
      numbers = episodeNumbersOf(await readEpisodeStates(adapter.client, record.id));
    } catch {
      numbers = undefined;
    }
  }

  const scope: FixScope = {
    context,
    adapter,
    version: resolved.version,
    kind,
    mediaId: record.id,
    errors: [],
  };
  const outcomes: FixedDownload[] = [];
  for (const download of considered) {
    const episodes = kind === "series" ? downloadEpisodes(download, numbers, warnings) : undefined;
    const outcome = await fixOne(scope, download);
    outcomes.push({
      ...(resolved.title === undefined ? {} : { title: resolved.title }),
      ...(episodes === undefined ? {} : { episodes }),
      ...outcome,
    });
  }

  return {
    ...named,
    downloads: outcomes,
    remaining: Math.max(0, stuck.length - maxListedEntries),
    warnings,
    errors: distinctErrors(scope.errors),
  };
}
