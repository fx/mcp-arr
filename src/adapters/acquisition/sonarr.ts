import { z } from "zod";
import type { UpstreamClient } from "../../http/client.js";
import { type AdapterPage, type PageWindow, projectPage } from "../library/paging.js";
import {
  count,
  flag,
  optionalUpstreamId,
  parseUpstream,
  text,
  upstreamFlag,
  upstreamText,
} from "../library/parse.js";
import type { ReleaseCandidate, ReleaseSearchItem } from "./model.js";
import { cacheIdentity, mapReleaseBase, releaseSchema } from "./parse.js";
import type { ReleaseDetailLevel, ReleaseRequestFor } from "./requests.js";

/**
 * The Sonarr interactive release-search adapter.
 *
 * Interactive search is a read: `GET release` asks Sonarr to query its indexers
 * and returns what they offered, together with the decision Sonarr's own
 * profile and custom-format rules reached about each one. Nothing here grabs
 * anything — the endpoint's POST form is not reachable from this module.
 */

const application = "sonarr" as const;

export const sonarrReleaseRoutes = { release: "release" } as const;

const sonarrReleaseSchema = releaseSchema.extend({
  seriesTitle: upstreamText,
  seasonNumber: optionalUpstreamId,
  episodeNumbers: z.array(optionalUpstreamId).nullish(),
  absoluteEpisodeNumbers: z.array(optionalUpstreamId).nullish(),
  fullSeason: upstreamFlag,
});

type SonarrRelease = z.infer<typeof sonarrReleaseSchema>;

/** Keeps the whole numbers upstream reported, dropping any it nulled out. */
function numbers(values: readonly (number | null | undefined)[] | null | undefined) {
  const kept = (values ?? []).map(count).filter((value): value is number => value !== undefined);
  return kept.length === 0 ? undefined : kept;
}

function mapRelease(record: SonarrRelease, detail: ReleaseDetailLevel): ReleaseCandidate {
  return {
    ...mapReleaseBase(record, { detail, decided: true }),
    application,
    sonarr: {
      seriesTitle: text(record.seriesTitle),
      seasonNumber: count(record.seasonNumber),
      episodeNumbers: numbers(record.episodeNumbers),
      absoluteEpisodeNumbers: numbers(record.absoluteEpisodeNumbers),
      fullSeason: flag(record.fullSeason),
    },
  };
}

async function search(
  client: UpstreamClient,
  window: PageWindow,
  detail: ReleaseDetailLevel,
  query: {
    readonly episodeId?: number;
    readonly seriesId?: number;
    readonly seasonNumber?: number;
  },
): Promise<AdapterPage<ReleaseSearchItem>> {
  const route = sonarrReleaseRoutes.release;
  const body = await client.get(route, query);
  const releases = parseUpstream(z.array(sonarrReleaseSchema), body, application, route);

  return projectPage({
    source: releases,
    window,
    map: (record): ReleaseSearchItem => ({
      release: mapRelease(record, detail),
      identity: cacheIdentity(application, record),
    }),
  });
}

/** Releases Sonarr found for one episode. */
export function searchEpisode(
  client: UpstreamClient,
  window: PageWindow,
  request: ReleaseRequestFor<"sonarr_episode">,
): Promise<AdapterPage<ReleaseSearchItem>> {
  return search(client, window, request.detail, { episodeId: request.episodeId });
}

/** Releases Sonarr found for one season, season packs included. */
export function searchSeason(
  client: UpstreamClient,
  window: PageWindow,
  request: ReleaseRequestFor<"sonarr_season">,
): Promise<AdapterPage<ReleaseSearchItem>> {
  return search(client, window, request.detail, {
    seriesId: request.seriesId,
    seasonNumber: request.seasonNumber,
  });
}
