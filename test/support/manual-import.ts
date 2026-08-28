/**
 * The answer a manual-import reprocess gives, in the shape both applications
 * actually give it.
 *
 * It is a narrower resource than the scan row this project reads elsewhere: it
 * restates the *decision* and says nothing about the file, so there is no size,
 * no row identifier, no relative path, no folder name and no existing-file
 * identity in it; the media is named flat; and the indexer flags come back as
 * the numeric bitfield the resource declares rather than as a list of names.
 * Recorded from Sonarr 4.0.19.2979 and Radarr 6.3.0.10514.
 *
 * It lives here because both the instance double and the adapter's own tests
 * depend on it, and two restatements of one upstream shape are two things that
 * drift: correcting either alone would leave the other quietly asserting
 * against a resource no instance sends.
 */

/** The fields a reprocess element carries into the answer unchanged. */
const echoed = [
  "seriesId",
  "movieId",
  "seasonNumber",
  "quality",
  "languages",
  "releaseGroup",
] as const;

export function reprocessAnswer(
  sent: Record<string, unknown>,
  rejections: readonly unknown[] = [],
): Record<string, unknown> {
  const episodeIds = Array.isArray(sent.episodeIds) ? sent.episodeIds : [];
  return {
    path: sent.path,
    ...Object.fromEntries(
      echoed.filter((field) => sent[field] !== undefined).map((field) => [field, sent[field]]),
    ),
    // Full episode records rather than the identifiers the request named.
    episodes: episodeIds.map((id) => ({ id })),
    downloadId: sent.downloadId ?? null,
    indexerFlags: 0,
    customFormats: [],
    customFormatScore: 0,
    releaseType: "unknown",
    rejections,
  };
}
