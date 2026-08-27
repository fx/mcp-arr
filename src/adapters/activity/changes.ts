import { z } from "zod";
import type { UpstreamClient } from "../../http/client.js";
import type { Effect } from "../../tools/results.js";
import { maxPageSize } from "../../tools/schemas/common.js";
import type { MediaApplication } from "../library/model.js";
import { count, flag, pagedEnvelope, upstreamFlag } from "../library/parse.js";
import {
  type BlocklistUpstream,
  blocklistRecordSchema,
  type MediaProfile,
  mapBlocklistRecord,
  mapMediaHistoryRecord,
  mediaRoutes,
} from "./media.js";
import type { BlocklistRecord, HistoryRecord } from "./model.js";
import { parseActivity } from "./parse.js";
import { type HistoryUpstream, historyRecordSchema, sharedRoutes } from "./shared.js";

/**
 * The Sonarr and Radarr history and blocklist write adapters.
 *
 * Two mutations live here and nothing else. Marking a grab failed is deliberately
 * not the same operation as resolving an active queue item: it acts on what the
 * instance recorded, it is the action that re-opens an acquisition, and change
 * 0006 owns the queue state machine. Removing a blocklist record re-allows a
 * release and touches no media file, no download-client payload, and no queue
 * row — which is why the only removal reachable from here is by a single record
 * identifier, and why neither application's clear-all route is named anywhere in
 * this file.
 *
 * The same division of labour the library write adapters follow holds here:
 * nothing in this module decides whether a mutation may run. It reads the record
 * a mutation names, reports what that record is, and sends exactly one request
 * when it is told to. Reference validation, plan freshness, and receipts belong
 * to the tool layer above it.
 */

export const activityChangeRoutes = {
  /** `history/failed/{id}`; the identifier is a history record, never a queue row. */
  historyFailed: "history/failed",
  blocklist: mediaRoutes.blocklist,
  /**
   * The instance's own failure handling. It is read, never written: this server
   * discloses whether a replacement search will follow, and does not decide it.
   */
  downloadClientConfig: "config/downloadclient",
} as const;

/**
 * How far back a record is looked for when it has to be found by paging.
 *
 * Neither application filters history or the blocklist by record identifier, so
 * a record that cannot be reached through a scoped route is found by walking
 * pages — and a walk with no bound is how one mutation turns into a hundred
 * upstream requests against a large instance. The bound is stated rather than
 * implied, and running into it is reported as its own answer, because "this
 * record is further back than this server will page" and "this record is gone"
 * are different facts with different remedies.
 */
export const maxRecordScanPages = 10;

/**
 * What looking for one record answered.
 *
 * The three cases stay apart for the reason above. Only `found` may be mutated;
 * `absent` is a reference whose record no longer exists, and `beyond_scan` is a
 * record this server declined to keep paging for.
 */
export type RecordLookup<TRecord> =
  | { readonly status: "found"; readonly record: TRecord }
  | { readonly status: "absent" }
  | { readonly status: "beyond_scan" };

interface PagedRecord {
  readonly id: number;
}

/**
 * Walks a server-paged collection for one record, under {@link maxRecordScanPages}.
 *
 * The walk stops as soon as the instance says there is nothing further — a short
 * page, or a running count that has reached the total it reported — so a small
 * collection costs one request. Exhausting the collection answers `absent`;
 * exhausting the bound first answers `beyond_scan`, and the two are never
 * collapsed.
 */
async function scanForRecord<TRecord extends PagedRecord>(
  client: UpstreamClient,
  application: MediaApplication,
  route: string,
  schema: z.ZodType<TRecord>,
  recordId: number,
): Promise<RecordLookup<TRecord>> {
  const found = await scanForPage(client, application, route, schema, recordId);
  return found.status === "found"
    ? { status: "found", record: found.record }
    : { status: found.status };
}

/**
 * The same walk, keeping the page the record was found on.
 *
 * A caller that has to reason about what else the instance recorded alongside
 * the record — the history reconciliation baseline — needs that page, and
 * re-reading it afterwards would be both an extra request and a second, later
 * view of state that may have moved.
 */
async function scanForPage<TRecord extends PagedRecord>(
  client: UpstreamClient,
  application: MediaApplication,
  route: string,
  schema: z.ZodType<TRecord>,
  recordId: number,
): Promise<
  | { readonly status: "found"; readonly record: TRecord; readonly page: readonly TRecord[] }
  | { readonly status: "absent" }
  | { readonly status: "beyond_scan" }
> {
  let seen = 0;
  for (let page = 1; page <= maxRecordScanPages; page += 1) {
    const body = await client.get(route, {
      page,
      pageSize: maxPageSize,
      sortKey: "date",
      sortDirection: "descending",
    });
    const envelope = parseActivity(pagedEnvelope(schema), body, application, route);
    const match = envelope.records.find((record) => record.id === recordId);
    if (match !== undefined) {
      return { status: "found", record: match, page: envelope.records };
    }

    seen += envelope.records.length;
    const total = count(envelope.totalRecords);
    if (envelope.records.length < maxPageSize || (total !== undefined && seen >= total)) {
      return { status: "absent" };
    }
  }
  return { status: "beyond_scan" };
}

/**
 * What a history re-read establishes.
 *
 * The prior failures are the half that makes reconciliation sound. A successful
 * mark-failed records a *new* `download_failed` event against the same
 * download, so "an event exists" proves nothing on its own — the instance may
 * have recorded one before this call, or another actor may have failed the same
 * download meanwhile. What proves this call applied is an event that was not
 * there when the mutation was validated, which is why the baseline is captured
 * from the very read that validated it rather than looked up afterwards.
 */
export type HistoryRecordLookup =
  | {
      readonly status: "found";
      readonly record: HistoryRecord;
      readonly priorFailureIds: readonly number[];
    }
  | { readonly status: "absent" }
  | { readonly status: "beyond_scan" };

export interface HistoryRecordLookupRequest {
  readonly historyRecordId: number;
  /**
   * The series or movie the reference retained, when it had one. Supplying it
   * is what turns this read into a single scoped request.
   */
  readonly mediaId?: number | undefined;
}

/**
 * Re-reads the history record a mark-failed names.
 *
 * A record associated with a media item is read through that item's own history
 * route, which both applications answer in full and unpaged; anything else falls
 * back to the bounded walk. Either way this is the state the mutation is
 * validated against and the state a plan is fingerprinted from, so it is read
 * immediately before the write rather than carried over from the query that
 * produced the reference.
 */
export async function readHistoryRecord(
  client: UpstreamClient,
  profile: MediaProfile,
  request: HistoryRecordLookupRequest,
): Promise<HistoryRecordLookup> {
  const application = profile.application;
  if (request.mediaId === undefined) {
    const found = await scanForPage(
      client,
      application,
      sharedRoutes.history,
      historyRecordSchema,
      request.historyRecordId,
    );
    return found.status === "found"
      ? foundHistory(profile, found.record, found.page)
      : { status: found.status };
  }

  const route = profile.history.route;
  const body = await client.get(route, { [profile.history.parameter]: request.mediaId });
  const records = parseActivity(z.array(historyRecordSchema), body, application, route);
  const match = records.find((record) => record.id === request.historyRecordId);
  return match === undefined ? { status: "absent" } : foundHistory(profile, match, records);
}

/**
 * Pairs the record with the failures already recorded against its download.
 *
 * Both are taken from the same response, so the baseline costs no extra request
 * and cannot drift from the state the mutation was validated against.
 */
function foundHistory(
  profile: MediaProfile,
  match: HistoryUpstream,
  alongside: readonly HistoryUpstream[],
): HistoryRecordLookup {
  const record = mapMediaHistoryRecord(profile, match, "full");
  return {
    status: "found",
    record,
    priorFailureIds: failureIdsFor(profile, alongside, record.downloadIdentity),
  };
}

/** The `download_failed` events in a read that name the same download. */
function failureIdsFor(
  profile: MediaProfile,
  records: readonly HistoryUpstream[],
  identity: string | undefined,
): readonly number[] {
  if (identity === undefined) {
    return [];
  }
  return records
    .map((entry) => mapMediaHistoryRecord(profile, entry, "summary"))
    .filter((entry) => entry.eventType === "download_failed" && entry.downloadIdentity === identity)
    .map((entry) => entry.context.historyRecordId);
}

/** Re-reads the blocked release a removal names, under the same scan bound. */
export async function readBlocklistRecord(
  client: UpstreamClient,
  profile: MediaProfile,
  blocklistRecordId: number,
): Promise<RecordLookup<BlocklistRecord>> {
  const found = await scanForRecord(
    client,
    profile.application,
    activityChangeRoutes.blocklist,
    blocklistRecordSchema,
    blocklistRecordId,
  );
  return mapLookup(found, (record: BlocklistUpstream) => mapBlocklistRecord(profile, record));
}

function mapLookup<TUpstream, TRecord>(
  lookup: RecordLookup<TUpstream>,
  map: (record: TUpstream) => TRecord,
): RecordLookup<TRecord> {
  return lookup.status === "found" ? { status: "found", record: map(lookup.record) } : lookup;
}

/**
 * What re-reading upstream state after a lost answer established.
 *
 * Only `confirmed` and `not_applied` are conclusions. `unconfirmed` is the
 * honest third answer and the default: a read that did not find the evidence it
 * was looking for has not shown the mutation failed, because it may simply have
 * arrived before the instance finished. Rounding that to "it did not happen"
 * would licence a retry of a mutation that already applied, which is the
 * direction a receipt must never round in.
 */
export type Reconciliation =
  | { readonly status: "confirmed" }
  | { readonly status: "not_applied" }
  | { readonly status: "unconfirmed" };

/**
 * Reconciles a mark-failed whose answer was lost.
 *
 * A successful mark-failed does not change the grabbed record it names — it
 * records a *new* `download_failed` event against the same download. So the
 * evidence is that event, matched on the download identity the grab carried,
 * which is a digest this process salts and can therefore compare without ever
 * handling the client's own identifier. Where the grab carried no identity
 * there is nothing to match on, and the answer stays unconfirmed rather than
 * being guessed from timing.
 */
export async function reconcileHistoryFailure(
  client: UpstreamClient,
  profile: MediaProfile,
  record: HistoryRecord,
  priorFailureIds: readonly number[],
): Promise<Reconciliation> {
  const identity = record.downloadIdentity;
  if (identity === undefined) {
    return { status: "unconfirmed" };
  }

  const route = profile.history.route;
  const mediaId = record.context.mediaId;
  const body =
    mediaId === undefined
      ? await client.get(sharedRoutes.history, {
          page: 1,
          pageSize: maxPageSize,
          sortKey: "date",
          sortDirection: "descending",
        })
      : await client.get(route, { [profile.history.parameter]: mediaId });
  const records =
    mediaId === undefined
      ? parseActivity(
          pagedEnvelope(historyRecordSchema),
          body,
          profile.application,
          sharedRoutes.history,
        ).records
      : parseActivity(z.array(historyRecordSchema), body, profile.application, route);

  // Only an event that was not there when this mutation was validated. An
  // instance that had already recorded a failure for this download — or another
  // actor that recorded one meanwhile — would otherwise make a write that never
  // landed look like one that did, which is the direction a receipt must never
  // round in.
  const known = new Set(priorFailureIds);
  const appeared = failureIdsFor(profile, records, identity).some((id) => !known.has(id));
  return appeared ? { status: "confirmed" } : { status: "unconfirmed" };
}

/**
 * Reconciles a blocklist removal whose answer was lost.
 *
 * This one is decidable both ways, which is why it is worth doing: the record
 * either is still there or it is not. A record that is gone confirms the
 * removal; one that is still present shows it did not apply, and that is the
 * rare case where a retry is provably safe rather than merely plausible. A scan
 * that ran past its bound establishes neither.
 */
export async function reconcileBlocklistRemoval(
  client: UpstreamClient,
  profile: MediaProfile,
  blocklistRecordId: number,
): Promise<Reconciliation> {
  const lookup = await readBlocklistRecord(client, profile, blocklistRecordId);
  switch (lookup.status) {
    case "absent":
      return { status: "confirmed" };
    case "found":
      return { status: "not_applied" };
    default:
      return { status: "unconfirmed" };
  }
}

/**
 * Whether a history record is one that can be marked failed.
 *
 * Only a grab can: the operation tells the instance that the release it fetched
 * did not work out, and an import, a deletion, or a rename has no release behind
 * it to fail. Refusing here costs no upstream request and produces a reason a
 * caller can act on, where sending it would produce an upstream rejection that
 * says considerably less.
 */
export type HistoryFailureCheck =
  | { readonly status: "ok" }
  | { readonly status: "blocked"; readonly reason: string };

export function checkHistoryFailure(record: HistoryRecord): HistoryFailureCheck {
  if (record.eventType === "grabbed") {
    return { status: "ok" };
  }
  return {
    status: "blocked",
    reason: `only a grabbed history record can be marked failed, and this one records a ${record.eventType.replaceAll("_", " ")} event`,
  };
}

const downloadClientConfigSchema = z.object({
  autoRedownloadFailed: upstreamFlag,
  autoRedownloadFailedFromInteractiveSearch: upstreamFlag,
});

/**
 * What the instance does after a grab is failed.
 *
 * This is the follow-on policy a plan has to disclose, and it belongs to the
 * instance rather than to the call: neither application accepts a per-request
 * "do not search again" flag on this route, so the honest answer is to read the
 * setting and say what will follow. An instance that reports nothing leaves it
 * `undefined`, which is a third answer and not a quiet `false` — predicting no
 * search where one may happen is the direction this must not round in.
 */
export interface FailureHandlingPolicy {
  readonly application: MediaApplication;
  readonly replacementSearch?: boolean | undefined;
  /**
   * Whether the same handling applies to a release that was grabbed from an
   * interactive search.
   *
   * Both applications settle this separately, and an instance that redownloads
   * failed grabs generally while excluding interactively grabbed ones is a
   * supported configuration. Nothing in a history record reliably says which
   * kind of grab it was, so this is retained rather than resolved: what it
   * buys is that the prediction says "may follow" instead of "will", which is
   * the only honest answer when the deciding fact is not in evidence.
   */
  readonly replacementSearchFromInteractiveSearch?: boolean | undefined;
}

export async function readFailureHandlingPolicy(
  client: UpstreamClient,
  application: MediaApplication,
): Promise<FailureHandlingPolicy> {
  const route = activityChangeRoutes.downloadClientConfig;
  const config = parseActivity(
    downloadClientConfigSchema,
    await client.get(route),
    application,
    route,
  );
  return {
    application,
    replacementSearch: flag(config.autoRedownloadFailed),
    replacementSearchFromInteractiveSearch: flag(config.autoRedownloadFailedFromInteractiveSearch),
  };
}

/** Sends the mark-failed for exactly one history record. */
export async function markHistoryFailed(
  client: UpstreamClient,
  historyRecordId: number,
): Promise<void> {
  await client.post(`${activityChangeRoutes.historyFailed}/${historyRecordId}`, {});
}

/**
 * Removes exactly one blocklist record.
 *
 * The route names a single identifier. The bulk and clear-all routes both
 * applications offer are outside this project's surface, so there is no path
 * from here that empties a blocklist.
 */
export async function removeBlocklistRecord(
  client: UpstreamClient,
  blocklistRecordId: number,
): Promise<void> {
  await client.delete(`${activityChangeRoutes.blocklist}/${blocklistRecordId}`);
}

/**
 * What one mutation asks for and what the state just read says will follow.
 *
 * `requested` is what the caller asked this server to do, `predicted` is what
 * the instance's own state says follows from it, and `warnings` are the parts
 * this server could not establish. They are three lists rather than one because
 * a plan discloses them separately: an effect that certainly follows and an
 * effect that follows only if a setting says so must not read alike.
 */
export interface MutationEffects {
  readonly requested: readonly Effect[];
  readonly predicted: readonly Effect[];
  readonly warnings: readonly string[];
}

function effect(
  application: MediaApplication,
  severity: Effect["severity"],
  summary: string,
): Effect {
  return { application, severity, summary };
}

/**
 * How a selection is named in an effect summary.
 *
 * One record is named, because a caller acting on a single release is owed the
 * title it is about to fail. Several are counted instead, and that is not
 * brevity: naming the first of five would say the mutation affects that release
 * while it silently acts on four others, which is a disclosure that is false
 * about the very thing a plan exists to describe.
 */
function describeSelection(
  titles: readonly (string | undefined)[],
  plural: string,
  fallback: string,
): string {
  const only = titles.length === 1 ? titles[0] : undefined;
  if (titles.length === 1) {
    return only === undefined ? fallback : `“${only}”`;
  }
  return `${titles.length} ${plural}`;
}

/**
 * The effects of marking one or more grabs failed.
 *
 * All three are *requested* rather than split across the two lists, and that is
 * the point of the shape: a caller that applies directly never reads a plan's
 * predictions, so an effect disclosed only as a prediction is disclosed only to
 * half the callers. Blocklisting is a certainty, and the replacement search is
 * disclosed with the certainty the instance's own settings actually support —
 * which is what varies, not whether it is mentioned at all.
 */
export function historyFailureEffects(
  records: readonly HistoryRecord[],
  policy: FailureHandlingPolicy,
): MutationEffects {
  const application = policy.application;
  const release = describeSelection(
    records.map((record) => record.title),
    "grabbed releases",
    "the grabbed release",
  );
  const them = records.length === 1 ? "it" : "them";
  const requested = [
    effect(application, "consequential", `mark the grab of ${release} failed`),
    effect(
      application,
      "consequential",
      `blocklist ${release} so this instance does not grab ${them} again`,
    ),
  ];

  // The search is certain only where both settings say so. An instance that
  // redownloads failed grabs while excluding interactively grabbed ones decides
  // this per release, and a history record does not say which kind of grab it
  // was; an instance that did not report the second setting has not established
  // it either. Both are the same answer — the certainty is withdrawn — because
  // disclosing a search as certain on a fact that was not read is favourable
  // beyond what the state supports, which is the one direction this must not
  // round in.
  if (policy.replacementSearch === true) {
    if (policy.replacementSearchFromInteractiveSearch === true) {
      const settled = [
        ...requested,
        effect(
          application,
          "consequential",
          `start a replacement search for ${release}, because this instance redownloads failed grabs automatically`,
        ),
      ];
      return { requested: settled, predicted: settled, warnings: [] };
    }

    const excluded = policy.replacementSearchFromInteractiveSearch === false;
    const uncertain = [
      ...requested,
      effect(
        application,
        "consequential",
        excluded
          ? `a replacement search for ${release} may follow, because this instance redownloads failed grabs except the ones grabbed from an interactive search`
          : `a replacement search for ${release} may follow, because this instance redownloads failed grabs and did not report how it treats interactively grabbed ones`,
      ),
    ];
    return {
      requested: uncertain,
      predicted: uncertain,
      warnings: [
        excluded
          ? "this instance excludes interactively grabbed releases from automatic redownload, and its history does not record which searches were interactive"
          : "this instance did not report how it treats interactively grabbed releases, so whether a replacement search follows is not established",
      ],
    };
  }

  if (policy.replacementSearch === false) {
    const none = [
      ...requested,
      effect(
        application,
        "informational",
        "no replacement search follows, because this instance does not redownload failed grabs automatically",
      ),
    ];
    return { requested: none, predicted: none, warnings: [] };
  }

  const unknown = [
    ...requested,
    effect(
      application,
      "consequential",
      `a replacement search for ${release} may follow, depending on this instance's failed-download handling`,
    ),
  ];
  return {
    requested: unknown,
    predicted: unknown,
    warnings: [
      "this instance did not report whether it redownloads failed grabs, so a replacement search may follow",
    ],
  };
}

/**
 * The effects of removing one blocklist record.
 *
 * The non-effects are disclosed as an effect of their own rather than left
 * unsaid, because "remove" is the word a caller is most likely to read as
 * deletion: nothing on disk, in the download client, or in the queue is touched
 * by this, and the only thing that changes is that the release is eligible
 * again.
 */
export function blocklistRemovalEffects(
  application: MediaApplication,
  records: readonly BlocklistRecord[],
): MutationEffects {
  const release = describeSelection(
    records.map((record) => record.title),
    "blocked releases",
    "that blocked release",
  );
  // All three are *requested* rather than predicted, and that is deliberate.
  // Re-allowing the release is not a consequence of removing the record, it is
  // what removing the record means; and the non-effect has to be disclosed in
  // apply mode too, because a caller that applies directly never reads a plan's
  // predictions and "remove" is the word most easily read as deletion. Nothing
  // here is conditional, so the two lists are the same.
  const requested = [
    effect(
      application,
      "consequential",
      `remove the blocklist record${records.length === 1 ? "" : "s"} for ${release}`,
    ),
    effect(
      application,
      "consequential",
      `allow ${release} to be considered and grabbed again by search and by automatic acquisition`,
    ),
    effect(
      application,
      "informational",
      "no media file, download-client payload, or queue item is removed by this change",
    ),
  ];
  return { requested, predicted: requested, warnings: [] };
}

/**
 * The state one history-failure depends on.
 *
 * Everything listed is something that changes what the mutation would do, and
 * nothing else is: the record's event decides whether it may run at all, its
 * date and success flag say it is still the record the reference named, and the
 * media association is what the re-read is scoped by. The order is authored
 * here rather than taken from an object's own property order.
 */
export function historyRecordState(record: HistoryRecord): Readonly<Record<string, unknown>> {
  return {
    id: record.context.historyRecordId,
    eventType: record.eventType,
    date: record.date,
    successful: record.successful,
    mediaId: record.context.mediaId,
  };
}

/** The state one blocklist removal depends on, on the same terms. */
export function blocklistRecordState(record: BlocklistRecord): Readonly<Record<string, unknown>> {
  return {
    id: record.context.blocklistRecordId,
    date: record.date,
    protocol: record.protocol,
    mediaId: record.media?.id,
  };
}

/**
 * The follow-on policy, as a read-set value.
 *
 * A plan that predicted no replacement search must not apply unchanged once the
 * instance has been reconfigured to redownload failed grabs, so the setting is
 * part of what makes such a plan stale.
 */
export function failurePolicyState(
  policy: FailureHandlingPolicy,
): Readonly<Record<string, unknown>> {
  return {
    replacementSearch: policy.replacementSearch ?? null,
    // Retained here for the same reason it is retained at all: it changes the
    // prediction, so a plan made while interactively grabbed releases were
    // excluded must not apply unchanged once they are not.
    replacementSearchFromInteractiveSearch: policy.replacementSearchFromInteractiveSearch ?? null,
  };
}
