import { z } from "zod";
import { toolResultSchema } from "../results.js";
import {
  configurationReferenceSchema,
  isoDateSchema,
  maxBulkItems,
  mediaApplicationSchema,
  mediaFileReferenceSchema,
  mediaReferenceSchema,
  mutationBaseShape,
  planApplySchema,
  queryBaseShape,
  searchTermSchema,
} from "./common.js";
import { libraryViewResultSchema } from "./library-results.js";
import { variantUnion } from "./publish.js";

const monitoredFilter = z.boolean().optional();

const mediaSelection = z.array(mediaReferenceSchema).min(1).max(maxBulkItems);

const seasonNumberSchema = z.int().min(0).max(1000);

/**
 * The widest calendar window one call may ask for.
 *
 * Neither application pages its calendar endpoint, so the width of the window
 * decides how much an instance is asked to assemble and send. A year covers
 * every scheduling question this view exists to answer, and reaching further is
 * a different query rather than a wider one.
 */
export const maxCalendarWindowDays = 366;

const dayMs = 86_400_000;

/**
 * Reads one calendar bound, refusing a date that does not exist.
 *
 * The date schema fixes only the shape, and `Date.parse` answers a day that is
 * shaped correctly but absent from its month by rolling it forward:
 * `2026-02-30` becomes `2026-03-02`, and `2027-02-29` becomes `2027-03-01`.
 * Accepting that would send the instance a different window than the caller
 * asked for and report nothing, which is worse than refusing the input — so the
 * parsed instant is formatted back and kept only when it is byte-identical to
 * what arrived. Every real date round-trips unchanged.
 */
function readCalendarBound(value: string): number | undefined {
  const parsed = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed)) {
    return undefined;
  }
  return new Date(parsed).toISOString().slice(0, 10) === value ? parsed : undefined;
}

/** Whether a calendar window names two real dates, in order, and is bounded. */
function isUsableCalendarWindow(start: string, end: string): boolean {
  const from = readCalendarBound(start);
  const to = readCalendarBound(end);
  if (from === undefined || to === undefined || to < from) {
    return false;
  }
  return to - from <= (maxCalendarWindowDays - 1) * dayMs;
}

/**
 * The typed library views. A view names a normalized concept rather than an
 * upstream route, and a view that the selected application does not model is
 * reported as an unsupported capability rather than silently skipped.
 *
 * Later library changes add per-view filters and result payloads; the view set
 * itself is fixed by the Library Management specification.
 */
export const libraryQueryInputSchema = variantUnion(
  z.discriminatedUnion("view", [
    z.strictObject({
      view: z.literal("series"),
      ...queryBaseShape,
      monitored: monitoredFilter,
      media: mediaSelection.optional(),
    }),
    z.strictObject({
      view: z.literal("seasons"),
      ...queryBaseShape,
      series: mediaReferenceSchema,
      monitored: monitoredFilter,
    }),
    z.strictObject({
      view: z.literal("episodes"),
      ...queryBaseShape,
      series: mediaReferenceSchema,
      seasonNumber: seasonNumberSchema.optional(),
      monitored: monitoredFilter,
    }),
    z.strictObject({
      view: z.literal("episode_files"),
      ...queryBaseShape,
      series: mediaReferenceSchema,
      seasonNumber: seasonNumberSchema.optional(),
    }),
    z.strictObject({
      view: z.literal("missing_episodes"),
      ...queryBaseShape,
      monitored: monitoredFilter,
    }),
    z.strictObject({
      view: z.literal("cutoff_unmet_episodes"),
      ...queryBaseShape,
      monitored: monitoredFilter,
    }),
    z.strictObject({
      view: z.literal("movies"),
      ...queryBaseShape,
      monitored: monitoredFilter,
      media: mediaSelection.optional(),
    }),
    z.strictObject({
      view: z.literal("collections"),
      ...queryBaseShape,
      monitored: monitoredFilter,
    }),
    z.strictObject({
      view: z.literal("movie_files"),
      ...queryBaseShape,
      movie: mediaReferenceSchema,
    }),
    z.strictObject({
      view: z.literal("missing_movies"),
      ...queryBaseShape,
      monitored: monitoredFilter,
    }),
    z.strictObject({
      view: z.literal("cutoff_unmet_movies"),
      ...queryBaseShape,
      monitored: monitoredFilter,
    }),
    z
      .strictObject({
        view: z.literal("calendar"),
        ...queryBaseShape,
        /** An inclusive date window, bounded by {@link maxCalendarWindowDays}. */
        start: isoDateSchema,
        end: isoDateSchema,
        monitored: monitoredFilter,
      })
      .refine((value) => isUsableCalendarWindow(value.start, value.end), {
        error: `start and end must be real dates, in order, and cover at most ${maxCalendarWindowDays} days including both bounds`,
      }),
    z.strictObject({
      /** Metadata lookup. Reading a lookup result never adds it to a library. */
      view: z.literal("lookup"),
      ...queryBaseShape,
      term: searchTermSchema,
    }),
  ]),
);

/**
 * How much of a newly added record is monitored. The normalized selections
 * cover both applications; change 0009 adds the application-specific
 * selections its adapters can prove are supported.
 */
export const monitorSelectionSchema = z.enum(["none", "all", "future", "missing", "existing"]);

const tagSelection = z.array(configurationReferenceSchema).max(maxBulkItems);

/**
 * Typed metadata edits. Every field names a normalized concept and is
 * optional; an omitted field is left as the application currently has it.
 */
const mediaChangesSchema = z.strictObject({
  qualityProfile: configurationReferenceSchema.optional(),
  rootFolder: configurationReferenceSchema.optional(),
  monitored: z.boolean().optional(),
  seriesType: z.enum(["standard", "daily", "anime"]).optional(),
  minimumAvailability: z.enum(["tba", "announced", "in_cinemas", "released"]).optional(),
  tags: z
    .strictObject({
      add: tagSelection.optional(),
      remove: tagSelection.optional(),
    })
    .optional(),
});

/**
 * Typed file-metadata edits. Each field names the value in the instance's own
 * vocabulary — a quality it defines, languages it knows — and a name it does
 * not offer is refused rather than resolved to something adjacent. Supplying
 * none of them asks for no change at all, so at least one is required.
 */
const fileChangesSchema = z
  .strictObject({
    quality: z.string().min(1).max(120).optional(),
    languages: z.array(z.string().min(1).max(60)).min(1).max(20).optional(),
    releaseGroup: z.string().min(1).max(120).optional(),
  })
  .refine(
    (value) =>
      value.quality !== undefined ||
      value.languages !== undefined ||
      value.releaseGroup !== undefined,
    { error: "at least one file metadata field must be supplied" },
  );

const fileSelection = z.array(mediaFileReferenceSchema).min(1).max(maxBulkItems);

/**
 * The typed library mutations.
 *
 * `delete_media` removes a library record, which is a separate question from
 * removing the media itself, so it requires an explicit `deleteFiles` and
 * `addImportListExclusion` — neither has a default, and removing a record can
 * therefore never remove files by omission. `delete_file` is itself the
 * physical-deletion intent, so it has nothing left to decide and carries no
 * such field. `rename` in plan mode is the rename preview — it returns the
 * proposed paths without starting a rename command.
 */
export const libraryChangeIntentSchema = z.discriminatedUnion("intent", [
  z.strictObject({
    intent: z.literal("add_media"),
    ...mutationBaseShape,
    application: mediaApplicationSchema,
    /** A reference returned by the `lookup` view, never a raw upstream payload. */
    lookup: mediaReferenceSchema,
    rootFolder: configurationReferenceSchema,
    qualityProfile: configurationReferenceSchema,
    monitor: monitorSelectionSchema,
    /** Explicit: adding a record never launches an acquisition search by default. */
    searchOnAdd: z.boolean(),
    tags: tagSelection.optional(),
  }),
  z.strictObject({
    intent: z.literal("set_monitoring"),
    ...mutationBaseShape,
    items: mediaSelection,
    monitored: z.boolean(),
  }),
  z.strictObject({
    intent: z.literal("edit_media"),
    ...mutationBaseShape,
    items: mediaSelection,
    changes: mediaChangesSchema,
  }),
  z.strictObject({
    intent: z.literal("delete_media"),
    ...mutationBaseShape,
    items: mediaSelection,
    deleteFiles: z.boolean(),
    addImportListExclusion: z.boolean(),
  }),
  z.strictObject({
    intent: z.literal("update_file_metadata"),
    ...mutationBaseShape,
    /** Every file must belong to the same series or movie; see `rename`. */
    files: fileSelection,
    changes: fileChangesSchema,
  }),
  z.strictObject({
    intent: z.literal("delete_file"),
    ...mutationBaseShape,
    files: fileSelection,
  }),
  z.strictObject({
    /**
     * Renames the files of one series, season, or movie. It names a single
     * record rather than a bulk selection because a rename is one upstream
     * command per record, and the preview an apply acts on is read for that one
     * record: every file the command is given comes from that preview, so a
     * rename can never reach a file the plan did not disclose.
     */
    intent: z.literal("rename"),
    ...mutationBaseShape,
    media: mediaReferenceSchema,
  }),
  z.strictObject({
    /**
     * Moves one record's files to another root folder. Distinct from
     * `edit_media`'s `rootFolder`, which re-points a record without touching
     * the data on disk; this one asks the application to move it.
     */
    intent: z.literal("move_media"),
    ...mutationBaseShape,
    media: mediaReferenceSchema,
    rootFolder: configurationReferenceSchema,
  }),
]);

export const libraryChangeInputSchema = variantUnion(
  z.union([libraryChangeIntentSchema, planApplySchema]),
);

export type LibraryQueryInput = z.infer<typeof libraryQueryInputSchema>;

/**
 * One direct mutation intent, as opposed to the plan-reference form the public
 * input also accepts. A handler works on this: applying a recorded plan replays
 * the intent it retained, so both apply forms reach a handler as the same shape.
 */
export type LibraryChangeIntent = z.infer<typeof libraryChangeIntentSchema>;

export const libraryQueryOutputSchema = toolResultSchema({ data: libraryViewResultSchema });
export const libraryChangeOutputSchema = toolResultSchema({ mutation: true });
