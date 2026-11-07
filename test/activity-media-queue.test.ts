import { describe, expect, it } from "vitest";
import { radarrProfile, readQueueForMedia, sonarrProfile } from "../src/adapters/activity/media.js";
import { defaultScanLimit } from "../src/adapters/library/paging.js";
import { activityFixture } from "./support/activity.js";
import { jsonResponse, libraryHarness } from "./support/library.js";

/**
 * Every queue row of one series or movie, read through the scoped
 * `queue/details` request. The recorded fixtures hold one series with two rows
 * and one movie with one each; a season pack and a row with no download
 * identity have no recording of their own, so they are built inline over a
 * recorded row.
 */

type QueueRow = Record<string, unknown>;

async function recorded(application: "sonarr" | "radarr"): Promise<QueueRow[]> {
  return activityFixture<QueueRow[]>(application, "queue/details");
}

describe("readQueueForMedia", () => {
  it("asks for one series' rows and maps every one of them, in upstream order", async () => {
    const rows = await recorded("sonarr");
    const { client, calls } = libraryHarness("sonarr", () => jsonResponse(rows));

    const read = await readQueueForMedia(client, 12, sonarrProfile, "summary");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.pathname).toMatch(/\/api\/v3\/queue\/details$/u);
    expect(Object.fromEntries(calls[0]?.url.searchParams ?? [])).toEqual({
      includeUnknownSeriesItems: "true",
      includeSeries: "true",
      includeEpisode: "true",
      seriesId: "12",
    });
    // Row 503 belongs to series 13 and is left out even though the answer
    // carried it.
    expect(read.items.map((item) => item.context.queueItemId)).toEqual([502, 501]);
    expect(read.items.map((item) => item.resolution)).toEqual([1080, 1080]);
    expect(read.items[0]?.evidence.trackedState).toBe("import_blocked");
    expect(read.items[0]?.origin?.downloadIdentity).toMatch(/^[0-9a-f]{16}$/u);
    expect(read.truncated).toBe(false);
  });

  it("asks for one movie's rows and maps them", async () => {
    const rows = await recorded("radarr");
    const { client, calls } = libraryHarness("radarr", () => jsonResponse(rows));

    const read = await readQueueForMedia(client, 9, radarrProfile, "summary");

    expect(calls[0]?.url.searchParams.get("movieId")).toBe("9");
    expect(read.items.map((item) => item.context.queueItemId)).toEqual([602]);
    expect(read.items[0]?.resolution).toBe(2160);
    expect(read.items[0]?.evidence).toMatchObject({
      trackedState: "import_pending",
      trackedStatus: "warning",
    });
  });

  it("maps every row of a season pack, each carrying the same download identity", async () => {
    const [blocked] = await recorded("sonarr");
    const pack = [1003, 1004, 1005].map((episodeId, index) => ({
      ...blocked,
      id: 700 + index,
      episodeId,
    }));
    const { client } = libraryHarness("sonarr", () => jsonResponse(pack));

    const read = await readQueueForMedia(client, 12, sonarrProfile, "summary");

    expect(read.items.map((item) => item.episode?.id)).toEqual(["1003", "1004", "1005"]);
    expect(new Set(read.items.map((item) => item.origin?.downloadIdentity)).size).toBe(1);
  });

  it("maps a row with no download identity without inventing one", async () => {
    const [blocked] = await recorded("sonarr");
    const { downloadId: _dropped, ...unidentified } = blocked as QueueRow;
    const { client } = libraryHarness("sonarr", () => jsonResponse([unidentified]));

    const read = await readQueueForMedia(client, 12, sonarrProfile, "summary");

    expect(read.items).toHaveLength(1);
    expect(read.items[0]?.origin?.downloadIdentity).toBeUndefined();
  });

  it("matches rows to the title locally when the scope is not honoured", async () => {
    const rows = await recorded("sonarr");
    const { client } = libraryHarness("sonarr", () => jsonResponse(rows));

    const read = await readQueueForMedia(client, 13, sonarrProfile, "summary");

    expect(read.items.map((item) => item.context.queueItemId)).toEqual([503]);
  });

  it("says when the scan bound stopped the read", async () => {
    const [blocked] = await recorded("sonarr");
    const many = Array.from({ length: defaultScanLimit + 1 }, (_, index) => ({
      ...blocked,
      id: 10_000 + index,
    }));
    const { client } = libraryHarness("sonarr", () => jsonResponse(many));

    const read = await readQueueForMedia(client, 12, sonarrProfile, "summary");

    expect(read.items).toHaveLength(defaultScanLimit);
    expect(read.truncated).toBe(true);
  });

  it("fails as an unexpected response on an answer that is not a list of rows", async () => {
    const { client } = libraryHarness("sonarr", () => jsonResponse({ records: [] }));

    await expect(readQueueForMedia(client, 12, sonarrProfile, "summary")).rejects.toMatchObject({
      kind: "unexpected-response",
    });
  });
});
