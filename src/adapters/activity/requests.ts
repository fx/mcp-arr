import type { ApplicationId } from "../../applications.js";
import type { DetailLevel } from "../library/requests.js";

/**
 * The adapter-facing activity request.
 *
 * As with the library adapters, this is deliberately not the published tool
 * input. The tool layer validates the caller's arguments and resolves every
 * opaque reference into the upstream identifier it stands for before building
 * one of these, so an adapter never sees a process-local token and a caller
 * never names an upstream identifier.
 */

export const activityViews = [
  "queue_status",
  "queue",
  "queue_details",
  "history",
  "blocklist",
  "health",
  "commands",
  "disk_space",
] as const;

export type ActivityView = (typeof activityViews)[number];

const media = ["sonarr", "radarr"] as const;
const every = ["sonarr", "radarr", "prowlarr"] as const;

/**
 * Which applications model each view.
 *
 * This mirrors the application support the internal operation registry declares
 * for the `arr_activity_query` variants, and a test holds the two lists to each
 * other so a view can never be advertised in one place and refused in the
 * other. Prowlarr has no queue, blocklist, or media library, so it appears only
 * against the three views it genuinely answers.
 *
 * The registry also declares `indexer_status` and `indexer_statistics` for
 * Prowlarr. Those are the third task of change 0004 and are deliberately absent
 * here rather than declared and unimplemented; the parity test names them, so
 * the gap is stated rather than silent.
 */
export const activityViewApplications: Readonly<Record<ActivityView, readonly ApplicationId[]>> = {
  queue_status: media,
  queue: media,
  queue_details: media,
  history: every,
  blocklist: media,
  health: every,
  commands: every,
  disk_space: media,
};

export interface ActivityPaging {
  readonly pageSize: number;
  /** A continuation minted by a previous page of this same query. */
  readonly cursor?: string | undefined;
}

interface ActivityQueryBase {
  readonly detail: DetailLevel;
  readonly paging: ActivityPaging;
}

/**
 * An inclusive date window, as ISO-8601 instants the tool schema already
 * validated. Both ends are optional: a window open at one end is a legitimate
 * question, and an absent end simply adds no bound.
 */
interface DateWindow {
  readonly since?: string | undefined;
  readonly until?: string | undefined;
}

export type ActivityQueryRequest =
  | (ActivityQueryBase & { readonly view: "queue_status" })
  | (ActivityQueryBase & {
      readonly view: "queue";
      /** Upstream series or movie identifiers, already resolved from media references. */
      readonly mediaIds?: readonly number[] | undefined;
    })
  | (ActivityQueryBase & {
      readonly view: "queue_details";
      readonly queueItemId: number;
      /**
       * The media association the queue reference retained, when it had one.
       * It is what keeps this read bounded: the focused detail is fetched
       * scoped to that series or movie rather than by scanning the queue.
       */
      readonly mediaId?: number | undefined;
    })
  | (ActivityQueryBase & {
      readonly view: "history";
      readonly mediaIds?: readonly number[] | undefined;
    } & DateWindow)
  | (ActivityQueryBase & {
      readonly view: "blocklist";
      readonly mediaIds?: readonly number[] | undefined;
    } & DateWindow)
  | (ActivityQueryBase & { readonly view: "health" })
  | (ActivityQueryBase & { readonly view: "commands" })
  | (ActivityQueryBase & { readonly view: "disk_space" });

export type ActivityRequestFor<TView extends ActivityView> = Extract<
  ActivityQueryRequest,
  { readonly view: TView }
>;

/**
 * The ordered parts a cursor's query digest is built from.
 *
 * The order is fixed here, per view, rather than derived from the object's own
 * property order, and the identifier filter is sorted before it is digested —
 * so naming the same three series in a different order continues the same page
 * rather than minting an incompatible cursor.
 */
export function digestPartsFor(
  application: ApplicationId,
  request: ActivityQueryRequest,
): readonly (string | number | boolean | undefined)[] {
  const shared = [application, request.view, request.detail, request.paging.pageSize] as const;
  switch (request.view) {
    case "queue_status":
    case "health":
    case "commands":
    case "disk_space":
      return shared;
    case "queue":
      return [...shared, ...[...(request.mediaIds ?? [])].sort((a, b) => a - b)];
    case "queue_details":
      return [...shared, request.queueItemId, request.mediaId];
    case "history":
    case "blocklist":
      return [
        ...shared,
        request.since,
        request.until,
        ...[...(request.mediaIds ?? [])].sort((a, b) => a - b),
      ];
  }
}

/**
 * Whether an upstream instant falls inside the requested window.
 *
 * An unparsable or absent instant is kept rather than dropped: a record the
 * instance dated in a form this server cannot read is still evidence, and
 * silently removing it from a bounded page would understate the activity.
 */
export function withinWindow(value: string | undefined, window: DateWindow): boolean {
  if (window.since === undefined && window.until === undefined) {
    return true;
  }
  if (value === undefined) {
    return true;
  }
  const at = Date.parse(value);
  if (Number.isNaN(at)) {
    return true;
  }
  const since = window.since === undefined ? undefined : Date.parse(window.since);
  const until = window.until === undefined ? undefined : Date.parse(window.until);
  if (since !== undefined && !Number.isNaN(since) && at < since) {
    return false;
  }
  return !(until !== undefined && !Number.isNaN(until) && at > until);
}
