import { type ApplicationId, applicationIds } from "../../applications.js";
import type { UpstreamQuery } from "../../http/client.js";
import { createToolError, type ToolError } from "../../tools/errors.js";
import type { Effect } from "../../tools/results.js";
import { isMediaApplication, type MediaApplication } from "../library/model.js";
import { meetsMinimumVersion } from "../version.js";
import type { QueueItemKind, QueueStatus, TrackedDownloadState } from "./model.js";
import {
  queueItemKindForStatus,
  queueItemKinds,
  queueStatuses,
  trackedDownloadStates,
} from "./model.js";

/**
 * The queue state machine, compiled.
 *
 * This module turns one typed intent plus the state actually observed on a
 * queue row into the single upstream request that carries it out — and into
 * nothing else. It sends no request, records no receipt, and reads no upstream
 * state: dispatch, plan freshness, and reconciliation are the next task's, and
 * keeping compilation pure is what lets every intent's exact request shape be
 * asserted without an instance in the loop.
 *
 * Three rules hold throughout.
 *
 * **Named effects, never flags.** The upstream queue-delete endpoint encodes
 * removal, data deletion, blocklisting, category change, and replacement search
 * in four independent query flags whose precedence surprises people. No caller
 * ever supplies one: each declared intent maps to exactly one reviewed
 * combination below, so a combination this project has not reviewed is not
 * merely rejected, it is unreachable.
 *
 * **The item kind decides first.** Five intents apply only to a tracked
 * download-client item and three only to a pending delayed or fallback release,
 * and a mismatch is refused before anything else is considered — the kind comes
 * from the opaque reference the caller already holds, so the refusal costs no
 * upstream request.
 *
 * **Nothing upstream-authored gets in or out.** Compilation reads a row's kind,
 * status, tracked state, and identifiers, and every effect and warning it
 * produces is written here. No release title, status message, canonical path,
 * or download-client identifier is an input or an output.
 */

/** The intents that act on a tracked download-client item. */
export const trackedQueueIntents = [
  "ignore_tracking",
  "remove_from_client_and_delete_data",
  "blocklist_and_remove",
  "change_category_mark_imported",
  "route_to_manual_import",
] as const;

/** The intents that act on a pending delayed or fallback release. */
export const pendingQueueIntents = [
  "force_pending_grab",
  "remove_pending",
  "blocklist_pending",
] as const;

/**
 * Every queue-resolution intent `arr_queue_resolve` declares.
 *
 * The list is closed and is assembled from the two kind-specific lists rather
 * than written out again, so an intent cannot exist without belonging to
 * exactly one item kind. The bounded diagnosis names these same values when it
 * suggests a next step, and a test feeds every member to the published input
 * schema, so a name that drifted from the tool would fail rather than reach a
 * caller as advice for an intent nothing accepts.
 */
export const queueResolveIntents = [...trackedQueueIntents, ...pendingQueueIntents] as const;

export type QueueResolveIntent = (typeof queueResolveIntents)[number];

/**
 * The item kind each intent is valid for.
 *
 * Derived from the two lists above, so the pairing is stated once. It is what
 * the validation below branches on, and what a tool schema can publish to say
 * which reference kind each variant accepts.
 */
export function queueIntentItemKind(intent: QueueResolveIntent): QueueItemKind {
  return (trackedQueueIntents as readonly string[]).includes(intent)
    ? "tracked_download"
    : "pending_release";
}

/**
 * Whether a blocklisting intent asks the application to look for a replacement.
 *
 * The choice is explicit and required rather than defaulted, because both
 * answers are consequential in opposite directions: allowing it starts an
 * indexer search the caller did not separately ask for, and suppressing it
 * leaves the media unmonitored-for until someone searches again.
 */
export const replacementSearchChoices = ["allow", "suppress"] as const;

export type ReplacementSearch = (typeof replacementSearchChoices)[number];

/**
 * What compilation is allowed to know about the row it acts on.
 *
 * This is deliberately the exact shape a resolved queue reference produces, so
 * the tool layer hands one straight to this module: the kind, the row's status
 * and tracked state, the queue identifier, and the media association. There is
 * no field for a download-client identifier, a canonical path, or a title,
 * because a transition needs none of them and a compiler that accepted one
 * could leak it into a request.
 */
export interface ObservedQueueItem {
  readonly application: MediaApplication;
  readonly queueItemId: number;
  readonly itemKind: QueueItemKind;
  readonly status: QueueStatus;
  readonly trackedState?: TrackedDownloadState | undefined;
  readonly mediaId?: number | undefined;
}

export interface QueueTransitionRequest {
  /**
   * The application being acted on, as an unnarrowed identifier. Prowlarr has
   * no managed-download queue at all, and refusing it here rather than relying
   * on the type is what makes the refusal survive a caller that reached this
   * module through an untyped boundary.
   */
  readonly application: ApplicationId;
  /** The instance version observed by the adapter registry. */
  readonly version: string;
  readonly intent: QueueResolveIntent;
  readonly observed: ObservedQueueItem;
  /** Required by `blocklist_and_remove`, and refused for every other intent. */
  readonly replacementSearch?: ReplacementSearch | undefined;
}

/**
 * The one upstream call a transition compiles to, or the inspection it routes
 * to instead.
 *
 * `route_to_manual_import` is the second of those: it changes nothing upstream
 * and answers with the import inspection a caller should perform next, which is
 * why it is a distinct shape rather than a request with an empty body. Manual
 * import execution belongs to the acquisition and import surface, and no path
 * from here reaches it.
 */
export type QueueTransitionAction =
  | {
      readonly kind: "upstream";
      readonly method: "DELETE" | "POST";
      readonly path: string;
      readonly query: UpstreamQuery;
    }
  | {
      readonly kind: "inspect";
      readonly tool: "arr_import_inspect";
      readonly variant: "queue_item";
      readonly queueItemId: number;
      readonly mediaId?: number | undefined;
    };

export interface QueueTransition {
  readonly intent: QueueResolveIntent;
  readonly application: MediaApplication;
  readonly itemKind: QueueItemKind;
  readonly action: QueueTransitionAction;
  /** Everything applying this transition asks the application to do. */
  readonly effects: readonly Effect[];
  /** What the caller should know that is not itself a requested effect. */
  readonly warnings: readonly string[];
}

export type QueueTransitionCompilation =
  | { readonly status: "compiled"; readonly transition: QueueTransition }
  | { readonly status: "rejected"; readonly error: ToolError };

/* -------------------------------------------------------------------------- */
/* The reviewed request shapes                                                 */
/* -------------------------------------------------------------------------- */

const queueRoute = "queue";

function queuePath(queueItemId: number): string {
  return `${queueRoute}/${String(queueItemId)}`;
}

function grabPath(queueItemId: number): string {
  return `${queueRoute}/grab/${String(queueItemId)}`;
}

/**
 * The four flags the queue-delete endpoint accepts.
 *
 * Every one of them is sent on every delete, explicitly, rather than letting an
 * omitted flag fall to whatever the instance defaults it to. The default is the
 * part that is easy to be wrong about and impossible to see in a request that
 * does not carry it, and a reviewed request shape that depends on an unstated
 * default is not reviewed.
 */
interface QueueDeleteFlags {
  readonly removeFromClient: boolean;
  readonly blocklist: boolean;
  readonly skipRedownload: boolean;
  readonly changeCategory: boolean;
}

/**
 * The release each flag has been reviewed against, per application.
 *
 * The recorded application minimums are already newer than all of these, so
 * nothing an instance reaches this module with is refused by the table today.
 * It is here so that stays true by check rather than by luck: a lowered
 * minimum, or an instance whose reported version is older than this project
 * vouches for, refuses the intent instead of sending a flag whose behavior on
 * that release nobody looked at. A flag with no entry is one both applications
 * have always accepted.
 */
interface FlagSupport {
  readonly flag: keyof QueueDeleteFlags;
  readonly minimums: Readonly<Record<MediaApplication, string>>;
}

const flagMinimumVersions: readonly FlagSupport[] = [
  // Both applications renamed the blocklist flag from its former spelling, and
  // an instance older than the rename would silently ignore the one sent here.
  { flag: "blocklist", minimums: { sonarr: "4.0.0", radarr: "5.0.0" } },
  { flag: "skipRedownload", minimums: { sonarr: "4.0.0", radarr: "5.0.0" } },
  { flag: "changeCategory", minimums: { sonarr: "4.0.0", radarr: "5.0.0" } },
];

/**
 * The flag combination each deleting intent compiles to.
 *
 * This table is the whole of the mapping, and reading it top to bottom is how a
 * reviewer checks it:
 *
 * - `ignore_tracking` removes nothing and blocks nothing. The row leaves the
 *   queue and the download client keeps both the download and its data.
 * - `remove_from_client_and_delete_data` asks the client to drop the download
 *   and the payload it downloaded, and blocks nothing.
 * - `blocklist_and_remove` does the same removal *and* blocks the release. It
 *   deletes client data for exactly the same reason the intent above does —
 *   `removeFromClient` is one flag, not two — which is why its disclosed
 *   effects say so rather than mentioning only the blocklist.
 * - `change_category_mark_imported` moves the download to the client's
 *   post-import category and never sets `removeFromClient`: the point of the
 *   intent is to stop the application tracking a download the client keeps.
 *
 * `skipRedownload` is true everywhere except a blocklisting the caller has
 * explicitly asked to allow a replacement for. It has no effect upstream
 * without `blocklist`, and sending it anyway is what makes each shape a
 * complete statement of what was requested rather than three flags and a
 * silence.
 */
const deleteFlags: Readonly<Partial<Record<QueueResolveIntent, QueueDeleteFlags>>> = {
  ignore_tracking: {
    removeFromClient: false,
    blocklist: false,
    skipRedownload: true,
    changeCategory: false,
  },
  remove_from_client_and_delete_data: {
    removeFromClient: true,
    blocklist: false,
    skipRedownload: true,
    changeCategory: false,
  },
  change_category_mark_imported: {
    removeFromClient: false,
    blocklist: false,
    skipRedownload: true,
    changeCategory: true,
  },
  remove_pending: {
    removeFromClient: false,
    blocklist: false,
    skipRedownload: true,
    changeCategory: false,
  },
  blocklist_pending: {
    removeFromClient: false,
    blocklist: true,
    skipRedownload: true,
    changeCategory: false,
  },
};

/**
 * The blocklisting removal, whose replacement-search half the caller chooses.
 *
 * It is built rather than tabulated because it is the one intent with two
 * reviewed shapes, and they differ in exactly one flag. Writing both out would
 * invite them to differ in a second one by accident.
 */
function blocklistAndRemoveFlags(replacementSearch: ReplacementSearch): QueueDeleteFlags {
  return {
    removeFromClient: true,
    blocklist: true,
    skipRedownload: replacementSearch === "suppress",
    changeCategory: false,
  };
}

function flagsFor(
  intent: QueueResolveIntent,
  replacementSearch: ReplacementSearch | undefined,
): QueueDeleteFlags | undefined {
  if (intent === "blocklist_and_remove") {
    return replacementSearch === undefined ? undefined : blocklistAndRemoveFlags(replacementSearch);
  }
  return deleteFlags[intent];
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

function error(code: "invalid_input" | "unsupported_capability" | "conflict") {
  return (application: ApplicationId, message: string): QueueTransitionCompilation => ({
    status: "rejected",
    error: createToolError({ code, message: `${application}: ${message}`, application }),
  });
}

const invalid = error("invalid_input");
const unsupported = error("unsupported_capability");
const conflict = error("conflict");

function describeKind(kind: QueueItemKind): string {
  return kind === "tracked_download" ? "tracked download" : "pending release";
}

/**
 * The refusal for a value that is not one of the words it had to be.
 *
 * It names no application and interpolates nothing, and both of those are the
 * point. A value this module does not recognize is a value nothing has
 * validated, so repeating it — in the message, or in the structured
 * `application` field a caller reads it from — would return whatever was
 * supplied, and what was supplied could be anything at all.
 */
function unrecognized(message: string): QueueTransitionCompilation {
  return { status: "rejected", error: createToolError({ code: "invalid_input", message }) };
}

function isWord<TWord extends string>(value: unknown, allowed: readonly TWord[]): value is TWord {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

function isRecordId(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * Holds every enumerated value in one request to the closed set it belongs to.
 *
 * This runs before anything else, because every check after it either branches
 * on one of these words or names one in a message, and both are unsafe on a
 * word this module does not know. An unrecognized value is not merely
 * unhelpful: an intent outside the declared set would be classified as a
 * pending one by elimination, an unknown status would be read as a finished
 * tracked download, and a replacement-search choice that is neither `allow` nor
 * `suppress` would compile as `allow` — starting the replacement search the
 * caller may have been trying to suppress. Answering `undefined` means every
 * word held.
 */
function checkRequestWords(
  request: QueueTransitionRequest,
): QueueTransitionCompilation | undefined {
  if (!isWord(request.application, applicationIds)) {
    return unrecognized("the target application is not one this server is configured for");
  }
  if (!isWord(request.observed.application, applicationIds)) {
    return unrecognized("the observed queue item names no application this server knows");
  }
  if (!isWord(request.intent, queueResolveIntents)) {
    return unrecognized("that is not a declared queue-resolution intent");
  }
  if (!isWord(request.observed.itemKind, queueItemKinds)) {
    return unrecognized("the observed queue item reports no queue item kind this server knows");
  }
  if (!isWord(request.observed.status, queueStatuses)) {
    return unrecognized("the observed queue item reports no queue status this server knows");
  }
  if (
    request.observed.trackedState !== undefined &&
    !isWord(request.observed.trackedState, trackedDownloadStates)
  ) {
    return unrecognized("the observed queue item reports no tracked state this server knows");
  }
  if (
    request.replacementSearch !== undefined &&
    !isWord(request.replacementSearch, replacementSearchChoices)
  ) {
    return unrecognized("the replacement-search choice must be allow or suppress");
  }
  return undefined;
}

/**
 * The statuses in which a download has produced nothing to act on yet.
 *
 * Two intents depend on the payload already being there — routing to a manual
 * import, and handing the download to the client's post-import category — and
 * both are refused in these states rather than sent and left to fail upstream
 * in a way that would be much harder to explain.
 */
const unfinishedStatuses: readonly QueueStatus[] = ["queued", "downloading", "paused"];

/**
 * Whether the observed row is internally consistent.
 *
 * The kind is a function of the status, and both arrive together from a
 * resolved reference that derives one from the other. A pair that disagrees is
 * therefore a defect in this process rather than a caller error — and it is
 * exactly the pair that would let a pending-only intent through the check meant
 * to stop it, so it is refused rather than trusted on one half.
 */
function isConsistent(observed: ObservedQueueItem): boolean {
  return queueItemKindForStatus(observed.status) === observed.itemKind;
}

function checkVersion(
  application: MediaApplication,
  version: string,
  flags: QueueDeleteFlags,
): string | undefined {
  for (const support of flagMinimumVersions) {
    const minimum = support.minimums[application];
    if (flags[support.flag] && !meetsMinimumVersion(version, minimum)) {
      return `this intent needs ${application} ${minimum} or newer`;
    }
  }
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* Effects                                                                     */
/* -------------------------------------------------------------------------- */

function effect(
  application: MediaApplication,
  severity: Effect["severity"],
  summary: string,
): Effect {
  return { application, severity, summary };
}

/**
 * What each intent asks the application to do, in this project's own words.
 *
 * Every summary is authored here. None of them interpolates a release title, a
 * status message, or any other upstream text, so a plan built from a compiled
 * transition discloses this server's understanding of the request rather than
 * repeating something an indexer wrote.
 */
function effectsFor(
  application: MediaApplication,
  intent: QueueResolveIntent,
  replacementSearch: ReplacementSearch | undefined,
): readonly Effect[] {
  const removal = effect(
    application,
    "destructive",
    "remove this download from the queue and from the download client",
  );
  // Disclosed for every intent that sets `removeFromClient`, not only for the
  // one named after it: the flag is what asks the client to delete the payload,
  // and an intent that sets it while disclosing only its blocklist would
  // understate what it does.
  const dataDeletion = effect(
    application,
    "destructive",
    "ask the download client to delete the data it downloaded",
  );

  switch (intent) {
    case "ignore_tracking":
      return [
        effect(
          application,
          "consequential",
          "stop tracking this download, leaving it and its data in the download client",
        ),
      ];
    case "remove_from_client_and_delete_data":
      return [removal, dataDeletion];
    case "blocklist_and_remove":
      return [
        removal,
        dataDeletion,
        effect(application, "consequential", "block this release so it is not grabbed again"),
        replacementSearch === "allow"
          ? effect(application, "consequential", "let the application search for a replacement")
          : effect(
              application,
              "informational",
              "no replacement search is requested for this release",
            ),
      ];
    case "change_category_mark_imported":
      return [
        effect(
          application,
          "consequential",
          "move this download to the download client's post-import category and stop tracking it",
        ),
      ];
    case "route_to_manual_import":
      return [
        effect(
          application,
          "informational",
          "nothing is changed; this download is routed to manual import inspection",
        ),
      ];
    case "force_pending_grab":
      return [
        effect(application, "consequential", "grab this pending release now instead of waiting"),
      ];
    case "remove_pending":
      return [effect(application, "consequential", "discard this pending release")];
    case "blocklist_pending":
      return [
        effect(application, "consequential", "discard this pending release"),
        effect(application, "consequential", "block this release so it is not offered again"),
      ];
  }
}

/**
 * The pending-release note that keeps a discard from overstating itself.
 *
 * A pending release is one the application is holding; there is no
 * download-client item behind it, so nothing is removed from a client and no
 * data is deleted. Saying so is a requirement of the specification rather than
 * a courtesy.
 */
const noClientItem =
  "a pending release has no download-client item, so nothing is removed from a download client and no data is deleted";

function warningsFor(intent: QueueResolveIntent): readonly string[] {
  switch (intent) {
    case "ignore_tracking":
      return [
        "the download client keeps this download and its data; the application simply stops tracking it",
      ];
    case "change_category_mark_imported":
      return [
        "the download and its data stay in the download client under the new category; nothing is deleted",
      ];
    case "route_to_manual_import":
      return [
        "this transition sends nothing upstream; inspect the import candidates and execute the import separately",
      ];
    case "remove_pending":
    case "blocklist_pending":
      return [noClientItem];
    case "force_pending_grab":
      return ["grabbing a held release skips the delay the application was waiting out"];
    default:
      return [];
  }
}

/* -------------------------------------------------------------------------- */
/* Compilation                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Compiles one intent against one observed queue row.
 *
 * The order of the checks is the contract. Every value that crossed into this
 * module is first held to the closed set it belongs to, because this compiler
 * is exported and reachable from anything holding an observed row rather than
 * only from a caller the published schema already validated. Then the
 * application, the observed row's own consistency, and the item kind, because
 * those refusals hold for every intent; then the replacement-search choice,
 * which is an argument error; then the row's current state, which is a
 * conflict; then the instance's version, which is a capability. Every one of
 * them happens without an upstream request, and a compiled transition is a
 * statement of what a later apply would send, not a permission to send it.
 */
export function compileQueueTransition(
  request: QueueTransitionRequest,
): QueueTransitionCompilation {
  const checked = checkRequestWords(request);
  if (checked !== undefined) {
    return checked;
  }

  const application = request.application;
  if (!isMediaApplication(application)) {
    return unsupported(application, "this application has no managed-download queue");
  }

  const observed = request.observed;
  if (observed.application !== application) {
    return invalid(application, "the observed queue item belongs to a different application");
  }
  if (!isRecordId(observed.queueItemId)) {
    return invalid(application, "the observed queue item names no single queue record");
  }
  if (observed.mediaId !== undefined && !isRecordId(observed.mediaId)) {
    return invalid(application, "the observed queue item names no single media record");
  }
  if (!isConsistent(observed)) {
    return invalid(
      application,
      "the observed queue item reports a kind its status does not support",
    );
  }

  const intent = request.intent;
  const required = queueIntentItemKind(intent);
  if (observed.itemKind !== required) {
    return invalid(
      application,
      `${intent} applies to a ${describeKind(required)}, and this queue item is a ${describeKind(observed.itemKind)}`,
    );
  }

  // The published input schema already declares the replacement-search choice
  // on `blocklist_and_remove` alone, so a caller cannot supply one elsewhere.
  // It is checked again here because a choice that was silently ignored would
  // be a caller believing it suppressed a search that was never at issue.
  if (intent !== "blocklist_and_remove" && request.replacementSearch !== undefined) {
    return invalid(
      application,
      `${intent} requests no replacement search, so it takes no replacement-search choice`,
    );
  }

  const transition = (action: QueueTransitionAction): QueueTransitionCompilation => ({
    status: "compiled",
    transition: {
      intent,
      application,
      itemKind: observed.itemKind,
      action,
      effects: effectsFor(application, intent, request.replacementSearch),
      warnings: warningsFor(intent),
    },
  });

  if (intent === "route_to_manual_import") {
    if (unfinishedStatuses.includes(observed.status)) {
      return conflict(
        application,
        "this download has not finished, so there is nothing to import from it yet",
      );
    }
    if (observed.status === "download_client_unavailable") {
      return conflict(
        application,
        "the download client is unreachable, so nothing can be imported from it yet",
      );
    }
    return transition({
      kind: "inspect",
      tool: "arr_import_inspect",
      variant: "queue_item",
      queueItemId: observed.queueItemId,
      mediaId: observed.mediaId,
    });
  }

  if (intent === "force_pending_grab") {
    return transition({
      kind: "upstream",
      method: "POST",
      path: grabPath(observed.queueItemId),
      query: {},
    });
  }

  if (intent === "change_category_mark_imported" && unfinishedStatuses.includes(observed.status)) {
    return conflict(
      application,
      "this download has not finished, so it cannot be handed to the post-import category",
    );
  }

  const flags = flagsFor(intent, request.replacementSearch);
  if (flags === undefined) {
    return invalid(
      application,
      "blocklist_and_remove requires an explicit replacement-search choice of allow or suppress",
    );
  }

  const versionProblem = checkVersion(application, request.version, flags);
  if (versionProblem !== undefined) {
    return unsupported(application, versionProblem);
  }

  return transition({
    kind: "upstream",
    method: "DELETE",
    path: queuePath(observed.queueItemId),
    query: { ...flags },
  });
}

/** One selected queue row, named by the opaque reference it arrived as. */
export interface QueueTransitionSelection {
  readonly reference: string;
  readonly observed: ObservedQueueItem;
}

export interface QueueTransitionItem {
  readonly reference: string;
  readonly compilation: QueueTransitionCompilation;
}

export interface QueueTransitionBatch {
  readonly application: ApplicationId;
  readonly version: string;
  readonly intent: QueueResolveIntent;
  readonly items: readonly QueueTransitionSelection[];
  readonly replacementSearch?: ReplacementSearch | undefined;
}

export type QueueBatchCompilation =
  | { readonly status: "compiled"; readonly items: readonly QueueTransitionItem[] }
  | { readonly status: "rejected"; readonly error: ToolError };

/**
 * Compiles one intent against every selected row, independently.
 *
 * Independence is the point rather than a simplification. The upstream bulk
 * actions are not transactional and skip stale identifiers without saying so,
 * so this project never compiles a selection into one request: each row gets
 * its own transition, and a row this server refuses is refused on its own
 * without deciding anything about the others. A selection whose every row is
 * rejected still answers per row, because those reasons can differ and
 * collapsing them into one would report whichever came first as the reason for
 * all of them.
 *
 * The empty selection is the one whole-call refusal, because there is no row
 * whose outcome could carry it. Its message names the application only once
 * that application has been recognized, for the reason {@link unrecognized}
 * gives: an empty selection is no excuse to echo an unvalidated value back.
 */
export function compileQueueTransitions(batch: QueueTransitionBatch): QueueBatchCompilation {
  if (batch.items.length === 0) {
    const known = isWord(batch.application, applicationIds);
    return {
      status: "rejected",
      error: createToolError({
        code: "invalid_input",
        message: known
          ? `${batch.application}: name at least one queue item to resolve`
          : "name at least one queue item to resolve",
        ...(known ? { application: batch.application } : {}),
      }),
    };
  }

  return {
    status: "compiled",
    items: batch.items.map((item) => ({
      reference: item.reference,
      compilation: compileQueueTransition({
        application: batch.application,
        version: batch.version,
        intent: batch.intent,
        observed: item.observed,
        replacementSearch: batch.replacementSearch,
      }),
    })),
  };
}
