import { z } from "zod";
import { toolResultSchema } from "../results.js";
import { activityViewResultSchema } from "./activity-results.js";
import {
  blocklistReferenceSchema,
  bulkReferences,
  historyReferenceSchema,
  isoDateTimeSchema,
  maxBulkItems,
  mediaReferenceSchema,
  mutationBaseShape,
  planApplySchema,
  queryBaseShape,
  queueReferenceSchema,
  variantUnion,
} from "./common.js";

const mediaFilter = z.array(mediaReferenceSchema).min(1).max(maxBulkItems).optional();

const windowShape = {
  since: isoDateTimeSchema.optional(),
  until: isoDateTimeSchema.optional(),
} as const;

/**
 * The typed activity views. Paging is bounded upstream: a view never fetches a
 * whole queue or history in order to emulate a page.
 */
export const activityQueryInputSchema = variantUnion(
  z.discriminatedUnion("view", [
    z.strictObject({ view: z.literal("queue_status"), ...queryBaseShape }),
    z.strictObject({ view: z.literal("queue"), ...queryBaseShape, media: mediaFilter }),
    z.strictObject({
      /** Focused detail for one tracked download or pending release. */
      view: z.literal("queue_details"),
      ...queryBaseShape,
      queue: queueReferenceSchema,
    }),
    z.strictObject({
      view: z.literal("history"),
      ...queryBaseShape,
      media: mediaFilter,
      ...windowShape,
    }),
    z.strictObject({
      view: z.literal("blocklist"),
      ...queryBaseShape,
      media: mediaFilter,
      ...windowShape,
    }),
    z.strictObject({ view: z.literal("health"), ...queryBaseShape }),
    z.strictObject({ view: z.literal("commands"), ...queryBaseShape }),
    z.strictObject({ view: z.literal("disk_space"), ...queryBaseShape }),
    z.strictObject({ view: z.literal("indexer_status"), ...queryBaseShape }),
    z.strictObject({
      /** Sanitized aggregates only: no caller hosts and no user-agent breakdowns. */
      view: z.literal("indexer_statistics"),
      ...queryBaseShape,
      ...windowShape,
    }),
  ]),
);

const queueSelection = bulkReferences(queueReferenceSchema);

/**
 * Queue resolution as typed state transitions.
 *
 * The intents are split by queue item kind: the first five apply to tracked
 * download-client items and the last three to pending delayed or fallback
 * releases. Validating the intent against the item's kind happens before any
 * upstream request, so an intent that is only valid for a pending release can
 * never reach a tracked download.
 *
 * There is deliberately no generic "delete queue item" intent: the upstream
 * delete flags have consequential precedence, and each intent compiles to
 * exactly one valid flag combination.
 */
export const queueResolveIntentSchema = z.discriminatedUnion("intent", [
  z.strictObject({
    /** Stops tracking without removal, blocklist, or category change. */
    intent: z.literal("ignore_tracking"),
    ...mutationBaseShape,
    items: queueSelection,
  }),
  z.strictObject({
    /** Requests deletion of the download client's payload data. */
    intent: z.literal("remove_from_client_and_delete_data"),
    ...mutationBaseShape,
    items: queueSelection,
  }),
  z.strictObject({
    intent: z.literal("blocklist_and_remove"),
    ...mutationBaseShape,
    items: queueSelection,
    /** Explicit choice: there is no default replacement-search behavior. */
    replacementSearch: z.enum(["allow", "suppress"]),
  }),
  z.strictObject({
    /** Marks the item imported by category change, never by client removal. */
    intent: z.literal("change_category_mark_imported"),
    ...mutationBaseShape,
    items: queueSelection,
  }),
  z.strictObject({
    intent: z.literal("route_to_manual_import"),
    ...mutationBaseShape,
    items: queueSelection,
  }),
  z.strictObject({
    intent: z.literal("force_pending_grab"),
    ...mutationBaseShape,
    items: queueSelection,
  }),
  z.strictObject({
    intent: z.literal("remove_pending"),
    ...mutationBaseShape,
    items: queueSelection,
  }),
  z.strictObject({
    intent: z.literal("blocklist_pending"),
    ...mutationBaseShape,
    items: queueSelection,
  }),
]);

export const queueResolveInputSchema = variantUnion(
  z.union([queueResolveIntentSchema, planApplySchema]),
);

/**
 * One direct queue-resolution intent, as the handler narrows it.
 *
 * The published input above also accepts a plan reference; this is the other
 * arm, and it is the type a handler works from, because by the time one runs
 * the dispatcher has already replayed any plan into its recorded intent.
 */
export type QueueResolveIntentInput = z.infer<typeof queueResolveIntentSchema>;

/**
 * History and blocklist mutations.
 *
 * Marking history failed stays distinct from failing a queue item because the
 * two have different effects on active download-client state, and removing a
 * blocklist record only re-allows a release — it never deletes media. Clearing
 * every blocklist record is deliberately absent.
 */
export const activityChangeIntentSchema = z.discriminatedUnion("intent", [
  z.strictObject({
    intent: z.literal("mark_history_failed"),
    ...mutationBaseShape,
    records: bulkReferences(historyReferenceSchema),
  }),
  z.strictObject({
    intent: z.literal("remove_blocklist_record"),
    ...mutationBaseShape,
    records: bulkReferences(blocklistReferenceSchema),
  }),
]);

export const activityChangeInputSchema = variantUnion(
  z.union([activityChangeIntentSchema, planApplySchema]),
);

/**
 * The direct-intent half, as the handler's type authority.
 *
 * The published union also admits a plan reference, which the dispatcher has
 * already resolved back into a recorded intent before a handler runs — so what
 * reaches `arr_activity_change` is always one of these two variants, and the
 * handler narrows against this rather than re-deriving a shape of its own.
 */
export type ActivityChangeIntent = z.infer<typeof activityChangeIntentSchema>;

export type ActivityQueryInput = z.infer<typeof activityQueryInputSchema>;

export const activityQueryOutputSchema = toolResultSchema({ data: activityViewResultSchema });
export const queueResolveOutputSchema = toolResultSchema({ mutation: true });
export const activityChangeOutputSchema = toolResultSchema({ mutation: true });
