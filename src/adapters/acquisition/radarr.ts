import { z } from "zod";
import type { UpstreamClient } from "../../http/client.js";
import { type AdapterPage, type PageWindow, projectPage } from "../library/paging.js";
import {
  count,
  parseUpstream,
  text,
  textList,
  upstreamNumber,
  upstreamText,
} from "../library/parse.js";
import type { ReleaseCandidate, ReleaseSearchItem } from "./model.js";
import { cacheIdentity, mapReleaseBase, releaseSchema } from "./parse.js";
import type { ReleaseDetailLevel, ReleaseRequestFor } from "./requests.js";

/**
 * The Radarr interactive release-search adapter.
 *
 * It is the Sonarr adapter's counterpart: `GET release` for one movie, mapped
 * through the shared release parsing, with only Radarr's own fields added. No
 * grab path is reachable from this module.
 */

const application = "radarr" as const;

export const radarrReleaseRoutes = { release: "release" } as const;

/**
 * Radarr has reported the matched movie as a single title and as a list across
 * releases, so both are read and normalized into one list; a release that
 * matched several alternate titles keeps all of them.
 */
const radarrReleaseSchema = releaseSchema.extend({
  movieTitles: z.array(upstreamText).nullish(),
  movieTitle: upstreamText,
  year: upstreamNumber,
  edition: upstreamText,
});

type RadarrRelease = z.infer<typeof radarrReleaseSchema>;

function movieTitles(record: RadarrRelease): readonly string[] | undefined {
  return textList([...(record.movieTitles ?? []), record.movieTitle]);
}

function mapRelease(record: RadarrRelease, detail: ReleaseDetailLevel): ReleaseCandidate {
  return {
    ...mapReleaseBase(record, { detail, decided: true }),
    application,
    radarr: {
      movieTitles: movieTitles(record),
      year: count(record.year),
      edition: text(record.edition),
    },
  };
}

/** Releases Radarr found for one movie. */
export async function searchMovie(
  client: UpstreamClient,
  window: PageWindow,
  request: ReleaseRequestFor<"radarr_movie">,
): Promise<AdapterPage<ReleaseSearchItem>> {
  const route = radarrReleaseRoutes.release;
  const body = await client.get(route, { movieId: request.movieId });
  const releases = parseUpstream(z.array(radarrReleaseSchema), body, application, route);

  return projectPage({
    source: releases,
    window,
    map: (record): ReleaseSearchItem => ({
      release: mapRelease(record, request.detail),
      identity: cacheIdentity(application, record),
    }),
  });
}
