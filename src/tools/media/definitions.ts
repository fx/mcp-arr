import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import type { MediaToolName } from "../names.js";
import { addTitle } from "./add.js";
import type { MediaContext } from "./context.js";
import { callError, type MediaError } from "./errors.js";
import { findTitles, maxFoundTitlesPerKind } from "./find.js";
import { titleKinds } from "./kinds.js";
import {
  type AddResult,
  addInputSchema,
  addOutputSchema,
  addPublishedOutputSchema,
  type FindResult,
  findInputSchema,
  findOutputSchema,
  findPublishedOutputSchema,
} from "./schemas.js";

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
      `Search for movies and TV series by name. Returns up to ${maxFoundTitlesPerKind} matches ` +
      "per kind, best first, each with the kind and id every other media tool takes, its year " +
      "when known, and whether it is already in the library. Searches every kind this server " +
      "serves unless kind is given; a kind that cannot be searched is listed as unavailable " +
      "beside the matches of the others. Changes nothing.",
    inputSchema: findInputSchema,
    outputSchema: findOutputSchema,
    publishedOutputSchema: findPublishedOutputSchema,
    annotations: { title: "Find movies and TV series", ...readOnly },

    async handle(context: MediaContext, input: unknown): Promise<MediaResult> {
      const parsed = findInputSchema.safeParse(input);
      if (!parsed.success) {
        return findFailure(invalidInput());
      }
      return findTitles(context, parsed.data);
    },
    failure: findFailure,
    summarize: summarizeFind,
  },
  {
    name: "media_add",
    title: "Add a movie or TV series",
    description:
      "Add a movie or series by the kind and id media_find returned, monitored, and start a " +
      "search for it. resolution asks for a target picture size; the nearest this server " +
      "offers is used, the lower one on a tie, and the result reports it. For a series, " +
      "episodes chooses all of them or only those not yet aired. A title already in the " +
      "library is left exactly as it is and reported as already_in_library.",
    inputSchema: addInputSchema,
    outputSchema: addOutputSchema,
    publishedOutputSchema: addPublishedOutputSchema,
    annotations: {
      title: "Add a movie or TV series",
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
  },
];
