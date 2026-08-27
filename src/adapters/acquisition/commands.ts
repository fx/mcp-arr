import { z } from "zod";
import type { ApplicationId } from "../../applications.js";
import type { UpstreamBody, UpstreamClient } from "../../http/client.js";
import type { UpstreamCommandObservation } from "../../state/jobs.js";
import { safeText } from "../activity/parse.js";
import { parseUpstream, text, upstreamId, upstreamText } from "../library/parse.js";
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
 * Narrows a wanted-list search to the monitored items only.
 *
 * Both applications' wanted searches take this pair, and both already default
 * to the monitored set, so an instance that ignores the filter runs the
 * narrower search rather than a broader one. That asymmetry is deliberate:
 * where this server cannot be certain the filter took effect, the failure it
 * accepts is searching too little, never searching media the caller excluded.
 */
function monitoredFilter(monitoredOnly: boolean): UpstreamBody {
  return { filterKey: "monitored", filterValue: monitoredOnly ? "true" : "false" };
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
export async function startSearchCommand(
  client: UpstreamClient,
  application: ApplicationId,
  request: SearchStartRequest,
  name: string,
): Promise<StartedCommand> {
  const route = searchCommandRoutes.command;
  const body = await client.post(route, commandBody(name, request));
  const accepted = parseUpstream(acceptedCommandSchema, body, application, route);

  return {
    upstreamId: String(accepted.id),
    name,
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
