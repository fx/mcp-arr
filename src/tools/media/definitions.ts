import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import type { MediaToolName } from "../names.js";
import { addTitle } from "./add.js";
import type { MediaContext } from "./context.js";
import { callError, type MediaError } from "./errors.js";
import { findTitles, maxFoundTitlesPerKind } from "./find.js";
import { fixTitle } from "./fix.js";
import { titleKinds } from "./kinds.js";
import { removeTitle } from "./remove.js";
import {
  type AddResult,
  addInputSchema,
  addOutputSchema,
  addPublishedOutputSchema,
  type FindResult,
  type FixResult,
  findInputSchema,
  findOutputSchema,
  findPublishedOutputSchema,
  fixInputSchema,
  fixOutputSchema,
  fixPublishedOutputSchema,
  maxListedEntries,
  type RemoveResult,
  removeInputSchema,
  removeOutputSchema,
  removePublishedOutputSchema,
  type SearchAgainResult,
  type StatusResult,
  searchAgainInputSchema,
  searchAgainOutputSchema,
  searchAgainPublishedOutputSchema,
  statusInputSchema,
  statusOutputSchema,
  statusPublishedOutputSchema,
} from "./schemas.js";
import { searchAgain } from "./search-again.js";
import { readStatus } from "./status.js";

/** What every `media` result carries beside its own fields. */
export interface MediaResult {
  readonly warnings: readonly string[];
  readonly errors: readonly MediaError[];
}

export interface MediaToolDefinition {
  readonly name: MediaToolName;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: z.ZodType;
  /** Validates every result before it leaves the process. */
  readonly outputSchema: z.ZodType;
  /** What the listing publishes in its place. */
  readonly publishedOutputSchema: z.ZodType;
  readonly annotations: ToolAnnotations;
  handle(context: MediaContext, input: unknown): Promise<MediaResult>;
  /** The result carrying only this failure, which every result shape admits. */
  failure(error: MediaError): MediaResult;
  /** The one-line text summary, built only from values the result carries. */
  summarize(result: MediaResult): string;
  /**
   * Whether nothing succeeded, which is what marks an MCP result as an error.
   * A result that carries an error beside what did succeed — one kind that
   * could not be read, one download that could not be fixed — is not one.
   */
  failed(result: MediaResult): boolean;
}

/**
 * Names a failure by its stable code and its remediation, as the error
 * contract requires of a summary. Both come from closed tables, so neither can
 * carry upstream text.
 */
function describeErrors(errors: readonly MediaError[]): string {
  const seen = new Map<string, MediaError>();
  for (const error of errors) {
    const key = `${error.code}\u0000${error.remediation}`;
    if (!seen.has(key)) {
      seen.set(key, error);
    }
  }
  return [...seen.values()].map((error) => `${error.code} (${error.remediation})`).join(", ");
}

function describeWarnings(result: MediaResult): string {
  return result.warnings.length === 0 ? "" : `; ${result.warnings.length} warning(s)`;
}

function invalidInput(): MediaError {
  return callError("invalid_input", "the arguments were not accepted");
}

function isFindResult(result: MediaResult): result is FindResult {
  return "titles" in result && "unavailable" in result;
}

/**
 * Counts per kind, never titles: a title is text an upstream source wrote, and
 * the summary is a line a host may print where nobody expects one.
 */
function summarizeFind(result: MediaResult): string {
  if (!isFindResult(result) || result.errors.length > 0) {
    return `media_find: error; errors: ${describeErrors(result.errors)}${describeWarnings(result)}`;
  }
  const counts = titleKinds
    .map((kind) => [kind, result.titles.filter((title) => title.kind === kind).length] as const)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => `${kind} ${count}`);
  const parts = [
    `media_find: found ${result.titles.length} title(s)${counts.length === 0 ? "" : ` (${counts.join(", ")})`}`,
  ];
  for (const { kind, error } of result.unavailable) {
    parts.push(`${kind} unavailable: ${describeErrors([error])}`);
  }
  return `${parts.join("; ")}${describeWarnings(result)}`;
}

function isAddResult(result: MediaResult): result is AddResult {
  return !("titles" in result);
}

function summarizeAdd(result: MediaResult): string {
  if (!isAddResult(result) || result.errors.length > 0 || result.outcome === undefined) {
    return `media_add: error; errors: ${describeErrors(result.errors)}${describeWarnings(result)}`;
  }
  const at = result.resolution === undefined ? "" : ` at ${result.resolution}`;
  return `media_add: ${result.outcome} ${result.kind ?? ""} ${result.id ?? ""}${at}${describeWarnings(result)}`;
}

function findFailure(error: MediaError): FindResult {
  return { titles: [], unavailable: [], warnings: [], errors: [error] };
}

function addFailure(error: MediaError): AddResult {
  return { warnings: [], errors: [error] };
}

function errorSummary(name: string, result: MediaResult): string {
  return `${name}: error; errors: ${describeErrors(result.errors)}${describeWarnings(result)}`;
}

/** The errors beside a result that otherwise succeeded, for its summary. */
function describeSideErrors(result: MediaResult): string {
  return result.errors.length === 0 ? "" : `; errors: ${describeErrors(result.errors)}`;
}

const hasErrors = (result: MediaResult): boolean => result.errors.length > 0;

/** Failed when it carries no title and no downloads: nothing was read. */
function statusFailed(result: MediaResult): boolean {
  const status = result as StatusResult;
  return (
    result.errors.length > 0 && status.in_library === undefined && status.downloads === undefined
  );
}

function summarizeStatus(result: MediaResult): string {
  const status = result as StatusResult;
  if (statusFailed(result)) {
    return errorSummary("media_status", result);
  }
  const downloads = status.downloads ?? [];
  const stuck = downloads.filter((download) => download.state === "stuck").length;
  const shown = `${downloads.length} download(s) shown (${stuck} stuck)`;
  const tail = `${describeSideErrors(result)}${describeWarnings(result)}`;
  if (status.kinds !== undefined) {
    return (
      `media_status: ${shown}, ${(status.imported ?? []).length} imported, ` +
      `${(status.upcoming ?? []).length} upcoming${tail}`
    );
  }
  if (status.in_library === false) {
    return `media_status: ${status.kind ?? ""} ${status.id ?? ""} not in library${tail}`;
  }
  return (
    `media_status: ${status.kind ?? ""} ${status.id ?? ""} in library, ` +
    `${status.have ?? 0} had, ${status.missing ?? 0} missing, ${shown}${tail}`
  );
}

function fixFailed(result: MediaResult): boolean {
  const fix = result as FixResult;
  return (
    result.errors.length > 0 &&
    !(fix.downloads ?? []).some((download) => download.action !== "none")
  );
}

function summarizeFix(result: MediaResult): string {
  const fix = result as FixResult;
  if (fix.downloads === undefined) {
    return errorSummary("media_fix", result);
  }
  const count = (action: string) =>
    fix.downloads?.filter((download) => download.action === action).length ?? 0;
  return (
    `media_fix: ${fix.kind ?? ""} ${fix.id ?? ""}: ${count("replaced")} replaced, ` +
    `${count("import_started")} import(s) started, ${count("none")} left alone, ` +
    `${fix.remaining ?? 0} remaining${describeSideErrors(result)}${describeWarnings(result)}`
  );
}

function summarizeSearchAgain(result: MediaResult): string {
  const search = result as SearchAgainResult;
  if (result.errors.length > 0 || search.searched === undefined) {
    return errorSummary("media_search_again", result);
  }
  const scope =
    search.season === undefined
      ? ""
      : ` season ${search.season}${search.episode === undefined ? "" : ` episode ${search.episode}`}`;
  return `media_search_again: searched for ${search.searched} in ${search.kind ?? ""} ${search.id ?? ""}${scope}${describeWarnings(result)}`;
}

function summarizeRemove(result: MediaResult): string {
  const removal = result as RemoveResult;
  if (result.errors.length > 0 || removal.outcome === undefined) {
    return errorSummary("media_remove", result);
  }
  const files =
    removal.outcome === "removed"
      ? removal.files_deleted
        ? ", files deleted"
        : ", files kept"
      : "";
  return `media_remove: ${removal.outcome} ${removal.kind ?? ""} ${removal.id ?? ""}${files}${describeWarnings(result)}`;
}

function bareFailure(error: MediaError): MediaResult {
  return { warnings: [], errors: [error] };
}

/**
 * No annotation repeats the tool's title: a host shows the tool's own title
 * first, and the listing the specification caps would carry it twice.
 */
const readOnly: ToolAnnotations = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: false,
};

export const mediaToolDefinitions: readonly MediaToolDefinition[] = [
  {
    name: "media_find",
    title: "Find movies and TV series",
    description:
      `Search movies and TV series by name: up to ${maxFoundTitlesPerKind} matches per kind, ` +
      "best first, each with the kind and id the other media tools take, its year when known, " +
      "and whether it is in the library. Searches every kind unless kind is given; one that " +
      "cannot be searched is listed as unavailable. Changes nothing.",
    inputSchema: findInputSchema,
    outputSchema: findOutputSchema,
    publishedOutputSchema: findPublishedOutputSchema,
    annotations: readOnly,

    async handle(context: MediaContext, input: unknown): Promise<MediaResult> {
      const parsed = findInputSchema.safeParse(input);
      if (!parsed.success) {
        return findFailure(invalidInput());
      }
      return findTitles(context, parsed.data);
    },
    failure: findFailure,
    summarize: summarizeFind,
    failed: hasErrors,
  },
  {
    name: "media_add",
    title: "Add a movie or TV series",
    description:
      "Add a movie or series by the kind and id media_find returned, monitored, and search " +
      "for it. resolution asks for a picture size; the nearest offered is used, the lower on " +
      "a tie, and reported. For a series, episodes picks all or only those not yet aired. A " +
      "title already in the library is left as it is and reported already_in_library.",
    inputSchema: addInputSchema,
    outputSchema: addOutputSchema,
    publishedOutputSchema: addPublishedOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      // Repeating an add finds the record the first call made and changes
      // nothing, so the call is idempotent in effect.
      idempotentHint: true,
      // A new title starts a search, which reaches outside this server.
      openWorldHint: true,
    },

    async handle(context: MediaContext, input: unknown): Promise<MediaResult> {
      const parsed = addInputSchema.safeParse(input);
      if (!parsed.success) {
        return addFailure(invalidInput());
      }
      const request = parsed.data;
      return addTitle(context, {
        kind: request.kind,
        id: request.id,
        resolution: request.resolution,
        episodes: request.kind === "series" ? request.episodes : undefined,
      });
    },
    failure: addFailure,
    summarize: summarizeAdd,
    failed: hasErrors,
  },
  {
    name: "media_status",
    title: "Status of downloads and titles",
    description:
      "Overview: downloads, imports of the last 7 days, what is due in 14. Or one title " +
      "and its downloads. A stuck one names media_fix's remedy. Lists hold " +
      `${maxListedEntries}, with *_total when cut.`,
    inputSchema: statusInputSchema,
    outputSchema: statusOutputSchema,
    publishedOutputSchema: statusPublishedOutputSchema,
    annotations: readOnly,

    async handle(context: MediaContext, input: unknown): Promise<MediaResult> {
      // The schema's two forms already refuse a kind without an id, and an
      // id without a kind.
      const parsed = statusInputSchema.safeParse(input);
      if (!parsed.success) {
        return bareFailure(invalidInput());
      }
      const request = parsed.data;
      return readStatus(
        context,
        "kind" in request ? { kind: request.kind, id: request.id } : undefined,
      );
    },
    failure: bareFailure,
    summarize: summarizeStatus,
    failed: statusFailed,
  },
  {
    name: "media_fix",
    title: "Fix stuck downloads",
    description:
      `Fix up to ${maxListedEntries} stuck downloads of one title: a failed or stalled one is ` +
      "removed with its data, its release blocked, another sought; a finished one is " +
      "imported if nothing needs correcting and the library lacks its files.",
    inputSchema: fixInputSchema,
    outputSchema: fixOutputSchema,
    publishedOutputSchema: fixPublishedOutputSchema,
    annotations: {
      readOnlyHint: false,
      // A replacement deletes a download's data from the downloader.
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },

    async handle(context: MediaContext, input: unknown): Promise<MediaResult> {
      const parsed = fixInputSchema.safeParse(input);
      if (!parsed.success) {
        return bareFailure(invalidInput());
      }
      return fixTitle(context, parsed.data);
    },
    failure: bareFailure,
    summarize: summarizeFix,
    failed: fixFailed,
  },
  {
    name: "media_search_again",
    title: "Search again for missing media",
    description:
      "Search again for the released, monitored movie or episodes in scope that the library " +
      "has no file for, and nothing else; one named episode is searched monitored or not. " +
      "Reports how many.",
    inputSchema: searchAgainInputSchema,
    outputSchema: searchAgainOutputSchema,
    publishedOutputSchema: searchAgainPublishedOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },

    async handle(context: MediaContext, input: unknown): Promise<MediaResult> {
      const parsed = searchAgainInputSchema.safeParse(input);
      if (!parsed.success) {
        return bareFailure(invalidInput());
      }
      // The schema's forms already refuse a season for a movie and an
      // episode without its season.
      return searchAgain(context, parsed.data);
    },
    failure: bareFailure,
    summarize: summarizeSearchAgain,
    failed: hasErrors,
  },
  {
    name: "media_remove",
    title: "Remove a title from the library",
    description:
      "Remove a movie or series from the library, deleting its files only if delete_files " +
      "is true. It can be added again later.",
    inputSchema: removeInputSchema,
    outputSchema: removeOutputSchema,
    publishedOutputSchema: removePublishedOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      // Removing again finds nothing to remove and changes nothing.
      idempotentHint: true,
      openWorldHint: false,
    },

    async handle(context: MediaContext, input: unknown): Promise<MediaResult> {
      const parsed = removeInputSchema.safeParse(input);
      if (!parsed.success) {
        return bareFailure(invalidInput());
      }
      return removeTitle(context, {
        kind: parsed.data.kind,
        id: parsed.data.id,
        deleteFiles: parsed.data.delete_files,
      });
    },
    failure: bareFailure,
    summarize: summarizeRemove,
    failed: hasErrors,
  },
];
