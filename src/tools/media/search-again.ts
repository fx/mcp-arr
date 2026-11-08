import { searchCommandName, startSearchCommand } from "../../adapters/acquisition/commands.js";
import { readEpisodeStates } from "../../adapters/library/titles.js";
import type { MediaContext } from "./context.js";
import { mediaError, mediaErrorFor, notInLibraryError } from "./errors.js";
import { kindRoutes, type TitleKind } from "./kinds.js";
import type { SearchAgainResult } from "./schemas.js";
import { namedTitle, resolveTitle } from "./titles.js";

export interface SearchAgainRequest {
  readonly kind: TitleKind;
  readonly id: number;
  /** Series only. */
  readonly season?: number | undefined;
  /** Series only, and only within a season. */
  readonly episode?: number | undefined;
}

const nothingInScopeWarning =
  "this series has no such season or episode, so nothing was searched for";

/**
 * Whether an instant has passed. A date that is absent or unreadable has not:
 * an episode nobody dated is not known to be released.
 */
function released(value: string | undefined, now: number): boolean {
  if (value === undefined) {
    return false;
  }
  const at = Date.parse(value);
  return !Number.isNaN(at) && at <= now;
}

/**
 * Searches again for exactly the released media in scope that the library
 * has no file for and monitors, and for nothing else.
 *
 * A whole-title search is never sent, because it also searches media the
 * library already has and can replace a file with an upgrade; the search is
 * for the movie, or for an explicit list of episodes, chosen here. A record
 * counts as missing only when it says `hasFile: false` — one that does not say
 * is not searched for — and when nothing qualifies, nothing is sent. A movie,
 * a series, or a season searches only what the library monitors — an episode
 * only where its series is monitored too — so a search never reaches media
 * the user stopped wanting; one episode named by its number is asked for
 * explicitly, and is searched for monitored or not. The search's own progress
 * is not returned: it is observed through `media_status`.
 */
export async function searchAgain(
  context: MediaContext,
  request: SearchAgainRequest,
): Promise<SearchAgainResult> {
  const { kind, id } = request;
  const application = kindRoutes[kind].application;
  const resolved = await resolveTitle(context, kind, id);
  if (!resolved.ok) {
    return { warnings: [], errors: [resolved.error] };
  }
  const named = {
    ...namedTitle(kind, id, resolved.title),
    ...(request.season === undefined ? {} : { season: request.season }),
    ...(request.episode === undefined ? {} : { episode: request.episode }),
  };
  const record = resolved.record;
  if (record === undefined) {
    return { ...named, warnings: [], errors: [notInLibraryError(kind)] };
  }
  const now = context.clock.now();
  const client = resolved.adapter.client;

  try {
    if (kind === "movie") {
      const missing =
        record.monitored === true && record.hasFile === false && record.isAvailable === true;
      if (!missing) {
        return { ...named, searched: 0, warnings: [], errors: [] };
      }
      const name = searchCommandName(application, "radarr_movie");
      if (name === undefined) {
        return { ...named, warnings: [], errors: [mediaError(kind, "unsupported_capability")] };
      }
      await startSearchCommand(
        client,
        application,
        { target: "radarr_movie", movieIds: [record.id] },
        name,
      );
      return { ...named, searched: 1, warnings: [], errors: [] };
    }

    const scoped = (await readEpisodeStates(client, record.id, request.season)).filter(
      (episode) => request.episode === undefined || episode.episodeNumber === request.episode,
    );
    if (scoped.length === 0 && (request.season !== undefined || request.episode !== undefined)) {
      return { ...named, searched: 0, warnings: [nothingInScopeWarning], errors: [] };
    }
    const asked = request.episode !== undefined;
    const episodeIds = scoped
      .filter(
        (episode) =>
          episode.hasFile === false &&
          released(episode.airDateUtc, now) &&
          (asked || (record.monitored === true && episode.monitored === true)),
      )
      .map((episode) => episode.id);
    if (episodeIds.length === 0) {
      return { ...named, searched: 0, warnings: [], errors: [] };
    }
    const name = searchCommandName(application, "sonarr_episode");
    if (name === undefined) {
      return { ...named, warnings: [], errors: [mediaError(kind, "unsupported_capability")] };
    }
    await startSearchCommand(client, application, { target: "sonarr_episode", episodeIds }, name);
    return { ...named, searched: episodeIds.length, warnings: [], errors: [] };
  } catch (error) {
    return { ...named, warnings: [], errors: [mediaErrorFor(kind, error)] };
  }
}
