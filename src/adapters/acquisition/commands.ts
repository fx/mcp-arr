import { z } from "zod";
import type { ApplicationId } from "../../applications.js";
import type { UpstreamBody, UpstreamClient } from "../../http/client.js";
import type { UpstreamCommandObservation } from "../../state/jobs.js";
import { safeText } from "../activity/parse.js";
import {
  flag,
  parseUpstream,
  text,
  upstreamFlag,
  upstreamId,
  upstreamText,
} from "../library/parse.js";
import { safeReason } from "./parse.js";
import type { SearchStartRequest, SearchStartTarget } from "./requests.js";

/**
 * The automatic-search command adapter.
 *
 * Sonarr and Radarr start background work by accepting a named command on one
 * shared endpoint, which is exactly the generic command dispatcher the tool
 * contract forbids exposing. So the name never comes from a caller: this module
 * holds a closed table from the published search targets to the command names
 * this server is willing to send, and the payload beside each name is built
 * from identifiers the tool layer already resolved out of opaque references.
 * A target with no entry for the selected application cannot be sent at all.
 */

export const searchCommandRoutes = { command: "command" } as const;

/**
 * The upstream command each target compiles to, per application.
 *
 * This table is the allowlist. `missing` and `cutoff_unmet` are the two targets
 * both applications model, and they compile to different names on each, which
 * is the whole reason the table is keyed by both.
 */
const commandNames: Readonly<
  Record<SearchStartTarget, Readonly<Partial<Record<ApplicationId, string>>>>
> = {
  sonarr_episode: { sonarr: "EpisodeSearch" },
  sonarr_season: { sonarr: "SeasonSearch" },
  sonarr_series: { sonarr: "SeriesSearch" },
  radarr_movie: { radarr: "MoviesSearch" },
  missing: { sonarr: "MissingEpisodeSearch", radarr: "MissingMoviesSearch" },
  cutoff_unmet: { sonarr: "CutoffUnmetEpisodeSearch", radarr: "CutoffUnmetMoviesSearch" },
};

/** The command one target would send to one application, if it may send one. */
export function searchCommandName(
  application: ApplicationId,
  target: SearchStartTarget,
): string | undefined {
  return commandNames[target][application];
}

/**
 * Narrows a wanted-list search to the monitored items, or leaves its scope
 * alone.
 *
 * The filter is only ever added, never inverted. `filterKey`/`filterValue` is a
 * selection rather than a switch, so `monitored`/`false` would ask for the
 * strictly *unmonitored* wanted items — the opposite of relaxing the
 * restriction, and a search of media the caller never asked about. So
 * `monitoredOnly: false` sends no filter at all and the command runs at the
 * application's own default wanted scope, which the handler discloses as a
 * warning rather than describing as something wider than it is.
 *
 * The remaining asymmetry is deliberate too: an instance that ignores the
 * filter runs the broader default rather than a search this server narrowed to
 * something unintended.
 */
function monitoredFilter(monitoredOnly: boolean): UpstreamBody {
  return monitoredOnly ? { filterKey: "monitored", filterValue: "true" } : {};
}

/**
 * Builds the body one search command carries.
 *
 * The switch is exhaustive over the closed target set, so a target added to the
 * published schema without a payload here fails to compile rather than being
 * sent as a bare command name that would search something else.
 */
function commandBody(name: string, request: SearchStartRequest): UpstreamBody {
  switch (request.target) {
    case "sonarr_episode":
      return { name, episodeIds: [...request.episodeIds] };
    case "sonarr_season":
      return { name, seriesId: request.seriesId, seasonNumber: request.seasonNumber };
    case "sonarr_series":
      return { name, seriesId: request.seriesId };
    case "radarr_movie":
      return { name, movieIds: [...request.movieIds] };
    case "missing":
    case "cutoff_unmet":
      return { name, ...monitoredFilter(request.monitoredOnly) };
  }
}

/**
 * The half of an accepted command this server reads back.
 *
 * Only the identity and the state are declared. Everything else an instance
 * echoes — the command's own body, its trigger, the client that sent it — is
 * not asked for, so zod drops it and no later layer has to remember to.
 */
const acceptedCommandSchema = z.object({
  id: upstreamId,
  status: upstreamText,
  result: upstreamText,
  message: upstreamText,
});

/**
 * Sanitizes the sentence an instance writes about a command it accepted.
 *
 * Both existing redactors run, because each closes a class the other leaves
 * open. `safeText` owns hidden-character normalization, whitespace collapsing,
 * URLs, paths, and long opaque identifiers; `safeReason` owns the `key=value`
 * credential shape a command message can carry and that a run of fewer than
 * thirty-two characters would otherwise slip through. Composing two audited
 * redactors is deliberate — neither is widened here, and no third denylist is
 * invented.
 */
function commandMessage(value: string | null | undefined): string | undefined {
  return safeReason(safeText(value));
}

/**
 * The route each application answers one record of a searchable kind on.
 *
 * These are the reads the precondition check makes, and they exist for exactly
 * that: the command endpoint accepts a search for a record that no longer
 * exists without complaint, so the record itself has to be looked at before the
 * command is sent.
 */
const recordRoutes: Readonly<Record<"series" | "episode" | "movie", string>> = {
  series: "series",
  episode: "episode",
  movie: "movie",
};

/** The half of a searched record whose change or disappearance matters. */
const searchedRecordSchema = z.object({
  id: upstreamId,
  monitored: upstreamFlag,
});

/**
 * How many record reads one precondition check runs at once. The published
 * schema already bounds the selection; this bounds how hard checking it hits an
 * instance at a moment, matching the grab adapter's own ceiling.
 */
export const recordReadConcurrency = 4;

/** One record's current state, as a string the read set can compare. */
function recordState(kind: string, record: z.infer<typeof searchedRecordSchema>): string {
  return `${kind}:${record.id}:monitored=${String(flag(record.monitored) ?? "unknown")}`;
}

async function readRecord(
  client: UpstreamClient,
  application: ApplicationId,
  kind: "series" | "episode" | "movie",
  id: number,
): Promise<string> {
  const route = `${recordRoutes[kind]}/${id}`;
  const record = parseUpstream(
    searchedRecordSchema,
    await client.get(route),
    application,
    recordRoutes[kind],
  );
  return recordState(kind, record);
}

/** The records one request names, and the kind each of them is. */
function searchedRecords(
  request: SearchStartRequest,
): readonly { readonly kind: "series" | "episode" | "movie"; readonly id: number }[] {
  switch (request.target) {
    case "sonarr_episode":
      return request.episodeIds.map((id) => ({ kind: "episode" as const, id }));
    case "sonarr_season":
    case "sonarr_series":
      return [{ kind: "series", id: request.seriesId }];
    case "radarr_movie":
      return request.movieIds.map((id) => ({ kind: "movie" as const, id }));
    case "missing":
    case "cutoff_unmet":
      // A wanted-list search names no record. Its scope is the whole library,
      // which no read of this shape could fingerprint, so there is nothing here
      // to validate and the command's own filter is the entire contract.
      return [];
  }
}

/**
 * Reads the current state of every record an automatic search would search for.
 *
 * This is the immediate current-state validation a mutation owes: a record that
 * has been deleted since its reference was minted answers `404`, which the
 * shared boundary normalizes into the `stale_reference` a caller recovers from
 * by re-reading the library, and a record whose monitoring changed produces a
 * different read set so a plan built against the old one is stale. Neither is
 * knowable from the process-local reference alone.
 */
export async function readSearchTargets(
  client: UpstreamClient,
  application: ApplicationId,
  request: SearchStartRequest,
): Promise<readonly string[]> {
  const records = searchedRecords(request);
  const states: string[] = [];
  for (let index = 0; index < records.length; index += recordReadConcurrency) {
    const batch = records.slice(index, index + recordReadConcurrency);
    states.push(
      ...(await Promise.all(
        batch.map((record) => readRecord(client, application, record.kind, record.id)),
      )),
    );
  }
  return states;
}

export interface StartedCommand {
  /** The upstream command id, as a string so the job store can hold it as-is. */
  readonly upstreamId: string;
  /**
   * The command name this server sent, not the instance's echo of it. The name
   * is one of this module's own constants, so the published job identity can
   * never carry text an instance composed.
   */
  readonly name: string;
  readonly observation: UpstreamCommandObservation;
}

/**
 * Starts one allowlisted search command.
 *
 * The answer is the command record upstream created, which is what makes the
 * job projectable: its identity comes back on the same response that accepted
 * the request, so nothing has to be polled to learn what was started. A
 * response this server cannot read is a failure rather than a silent success,
 * because a command whose id was lost is one no caller could ever follow.
 */
/**
 * Reads the record an accepted command answers with.
 *
 * Shared by every command this server starts, so the identity a job is built
 * from and the sanitization applied to the instance's own message are decided
 * once. What comes back is the upstream id and an observation; the command
 * *name* is deliberately not among them, because the name a job publishes is
 * the constant this project sent rather than the instance's echo of it.
 */
export function readAcceptedCommand(
  body: unknown,
  application: ApplicationId,
  route: string,
): { readonly upstreamId: string; readonly observation: UpstreamCommandObservation } {
  const accepted = parseUpstream(acceptedCommandSchema, body, application, route);
  return {
    upstreamId: String(accepted.id),
    observation: {
      state: text(accepted.status),
      result: text(accepted.result),
      // Sanitized rather than passed through: the message is the one field on
      // this response an instance composes for itself, so it is the one place
      // the values kept off the model-facing contract can still appear.
      warnings: [commandMessage(accepted.message)].filter(
        (warning): warning is string => warning !== undefined,
      ),
    },
  };
}

export async function startSearchCommand(
  client: UpstreamClient,
  application: ApplicationId,
  request: SearchStartRequest,
  name: string,
): Promise<StartedCommand> {
  const route = searchCommandRoutes.command;
  const accepted = readAcceptedCommand(
    await client.post(route, commandBody(name, request)),
    application,
    route,
  );
  return { upstreamId: accepted.upstreamId, name, observation: accepted.observation };
}
