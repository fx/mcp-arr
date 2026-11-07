import { beforeEach, describe, expect, it } from "vitest";
import { readQueueForMedia, sonarrProfile } from "../src/adapters/activity/media.js";
import type { QueueItem } from "../src/adapters/activity/model.js";
import { type ApplicationAdapter, createAdapterRegistry } from "../src/adapters/registry.js";
import { parseEnvironment } from "../src/config/environment.js";
import {
  classifyDownload,
  type Download,
  downloadReasons,
  episodesLabel,
  groupDownloads,
  type ImportGuard,
  judgeDownload,
  targetKey,
} from "../src/tools/media/downloads.js";
import { activityFixture } from "./support/activity.js";
import { jsonResponse, libraryHarness } from "./support/library.js";
import { type ActivityInstances, createActivityInstances } from "./support/media-activity.js";
import { allApplicationsEnvironment } from "./support/tool-context.js";

/**
 * The one classifier `media_status` and `media_fix` share, row by row of the
 * Media Toolset specification's download-state and remedy tables.
 *
 * Every row is built over the recorded Sonarr `queue/details` rows: 501 is a
 * download in progress and 502 a completed download whose import is blocked.
 */

type QueueRow = Record<string, unknown>;

let recorded: QueueRow[];

beforeEach(async () => {
  recorded = await activityFixture<QueueRow[]>("sonarr", "queue/details");
});

function base(id: 501 | 502): QueueRow {
  const row = recorded.find((candidate) => candidate.id === id);
  if (row === undefined) {
    throw new Error(`No recorded queue row ${id}`);
  }
  return structuredClone(row);
}

/** Maps raw rows exactly as the adapter does. */
async function mapped(rows: readonly QueueRow[]): Promise<QueueItem[]> {
  const { client } = libraryHarness("sonarr", () => jsonResponse(rows));
  return [...(await readQueueForMedia(client, 12, sonarrProfile, "summary")).items];
}

async function download(...rows: QueueRow[]): Promise<Download> {
  const [group] = groupDownloads(await mapped(rows));
  if (group === undefined) {
    throw new Error("No download");
  }
  return group;
}

/** A row in the given state, sharing one download identity unless told otherwise. */
function row(fields: QueueRow, id = 900): QueueRow {
  const { trackedDownloadState: _state, trackedDownloadStatus: _status, ...rest } = base(501);
  return { ...rest, id, ...fields };
}

const tableRows: readonly {
  readonly name: string;
  readonly fields: QueueRow;
  readonly state: string;
  readonly remedy?: string;
  readonly reason?: string;
}[] = [
  { name: "a delayed release", fields: { status: "delay" }, state: "waiting" },
  { name: "a fallback release", fields: { status: "fallback" }, state: "waiting" },
  {
    name: "a queued download",
    fields: { status: "queued", trackedDownloadState: "downloading", trackedDownloadStatus: "ok" },
    state: "queued",
  },
  {
    name: "a paused download",
    fields: { status: "paused", trackedDownloadState: "downloading", trackedDownloadStatus: "ok" },
    state: "queued",
  },
  {
    name: "a download in progress",
    fields: {
      status: "downloading",
      trackedDownloadState: "downloading",
      trackedDownloadStatus: "ok",
    },
    state: "downloading",
  },
  {
    name: "a download being imported",
    fields: { status: "completed", trackedDownloadState: "importing", trackedDownloadStatus: "ok" },
    state: "importing",
  },
  {
    name: "a download pending import with no warning",
    fields: {
      status: "completed",
      trackedDownloadState: "importPending",
      trackedDownloadStatus: "ok",
    },
    state: "importing",
  },
  {
    name: "a completed download with no tracked state",
    fields: { status: "completed" },
    state: "importing",
  },
  {
    name: "a failed download",
    fields: { status: "failed", trackedDownloadState: "failed", trackedDownloadStatus: "error" },
    state: "stuck",
    remedy: "replace",
    reason: downloadReasons.failed,
  },
  {
    name: "a download failing",
    fields: {
      status: "completed",
      trackedDownloadState: "failedPending",
      trackedDownloadStatus: "warning",
    },
    state: "stuck",
    remedy: "replace",
    reason: downloadReasons.failed,
  },
  {
    name: "a stalled download",
    fields: { status: "warning", trackedDownloadState: "downloading", trackedDownloadStatus: "ok" },
    state: "stuck",
    remedy: "replace",
    reason: downloadReasons.stalled,
  },
  {
    name: "a download the downloader warns about",
    fields: {
      status: "downloading",
      trackedDownloadState: "downloading",
      trackedDownloadStatus: "warning",
    },
    state: "stuck",
    remedy: "replace",
    reason: downloadReasons.stalled,
  },
  {
    name: "a download whose downloader is unavailable",
    fields: {
      status: "downloadClientUnavailable",
      trackedDownloadState: "downloading",
      trackedDownloadStatus: "ok",
    },
    state: "stuck",
    remedy: "none",
    reason: downloadReasons.unavailable,
  },
  {
    name: "a download in a state nobody named",
    fields: { status: "somethingNew", trackedDownloadState: "downloading" },
    state: "stuck",
    remedy: "none",
    reason: downloadReasons.unrecognized,
  },
];

describe("classifyDownload", () => {
  for (const entry of tableRows) {
    it(`classifies ${entry.name}`, async () => {
      const classified = classifyDownload(await download(row(entry.fields)), false);

      expect(classified.state).toBe(entry.state);
      if (classified.state === "stuck") {
        expect(classified.remedy).toBe(entry.remedy);
        expect("reason" in classified ? classified.reason : undefined).toBe(entry.reason);
      }
    });
  }

  it("gives a blocked import a provisional import remedy", async () => {
    expect(classifyDownload(await download(base(502)), false)).toEqual({
      state: "stuck",
      remedy: "import",
      provisional: true,
    });
    const pendingWithWarning = row({
      status: "completed",
      trackedDownloadState: "importPending",
      trackedDownloadStatus: "warning",
    });
    expect(classifyDownload(await download(pendingWithWarning), false)).toMatchObject({
      remedy: "import",
    });
  });

  it("never gives a row with no download identity the import remedy", async () => {
    const { downloadId: _dropped, ...unidentified } = base(502);
    expect(classifyDownload(await download(unidentified), false)).toEqual({
      state: "stuck",
      remedy: "none",
      reason: downloadReasons.unidentified,
    });
  });

  it("reports a download this process is importing as importing, whatever its rows say", async () => {
    expect(classifyDownload(await download(base(502)), true)).toEqual({ state: "importing" });
  });

  it("decides a download's state from its most pressing row", async () => {
    const progressing = {
      status: "downloading",
      trackedDownloadState: "downloading",
      trackedDownloadStatus: "ok",
    };
    const cases: readonly [readonly QueueRow[], string][] = [
      [
        [row(progressing, 1), row({ status: "failed", trackedDownloadState: "failed" }, 2)],
        "stuck",
      ],
      [
        [row({ status: "completed", trackedDownloadState: "importing" }, 1), row(progressing, 2)],
        "importing",
      ],
      [[row({ status: "queued" }, 1), row(progressing, 2)], "downloading"],
      [[row({ status: "queued" }, 1)], "queued"],
    ];
    for (const [rows, state] of cases) {
      expect(classifyDownload(await download(...rows), false).state).toBe(state);
    }
  });

  it("lets an unavailable downloader outrank a failure, and a failure outrank a blocked import", async () => {
    const unavailable = row(
      { status: "downloadClientUnavailable", trackedDownloadState: "downloading" },
      1,
    );
    const failed = row({ status: "failed", trackedDownloadState: "failed" }, 2);
    const blocked = row(
      {
        status: "completed",
        trackedDownloadState: "importBlocked",
        trackedDownloadStatus: "warning",
      },
      3,
    );

    expect(classifyDownload(await download(unavailable, failed), false)).toMatchObject({
      remedy: "none",
      reason: downloadReasons.unavailable,
    });
    expect(classifyDownload(await download(failed, blocked), false)).toMatchObject({
      remedy: "replace",
    });
  });
});

describe("groupDownloads", () => {
  it("groups a season pack's rows into one download placed where its first row was", async () => {
    const pack = [1003, 1004].map((episodeId, index) => ({
      ...base(502),
      id: 700 + index,
      episodeId,
    }));
    const items = await mapped([base(501), ...pack]);

    const groups = groupDownloads(items);

    expect(groups.map((group) => group.rows.map((item) => item.context.queueItemId))).toEqual([
      [501],
      [700, 701],
    ]);
    expect(groups.every((group) => group.identified)).toBe(true);
  });

  it("keeps each row with no download identity a download of its own", async () => {
    const { downloadId: _dropped, ...unidentified } = base(502);
    const items = await mapped([unidentified, { ...unidentified, id: 777 }]);

    const groups = groupDownloads(items);

    expect(groups).toHaveLength(2);
    expect(groups.some((group) => group.identified)).toBe(false);
  });
});

describe("episodesLabel", () => {
  it("names episodes as runs within a season", () => {
    const episodes = (season: number, ...numbers: number[]) =>
      numbers.map((episodeNumber) => ({ seasonNumber: season, episodeNumber }));

    expect(episodesLabel(episodes(2, 3))).toBe("S02E03");
    expect(episodesLabel(episodes(2, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10))).toBe("S02E01–E10");
    expect(episodesLabel([...episodes(2, 1), ...episodes(1, 10, 9)])).toBe("S01E09–E10, S02E01");
    expect(episodesLabel(episodes(1, 1, 3, 4))).toBe("S01E01, S01E03–E04");
    expect(episodesLabel(episodes(1, 2, 2))).toBe("S01E02");
    expect(episodesLabel(episodes(10, 100))).toBe("S10E100");
    expect(episodesLabel([])).toBeUndefined();
  });
});

describe("judgeDownload", () => {
  let instances: ActivityInstances;
  let adapter: ApplicationAdapter;

  beforeEach(async () => {
    instances = await createActivityInstances();
    const found = createAdapterRegistry(parseEnvironment(allApplicationsEnvironment), {
      fetch: instances.fetch,
    }).adapter("sonarr");
    if (found === undefined) {
      throw new Error("The series adapter is not configured");
    }
    adapter = found;
    // One importable file, matched to the blocked row's episode.
    const [scanned] = instances.state("sonarr").manualimport;
    instances.state("sonarr").manualimport = [
      {
        ...scanned,
        path: "/media/example/downloads/complete/example-series/Example Series - S02E01.mkv",
        relativePath: "Example Series - S02E01.mkv",
        seasonNumber: 2,
        episodes: [{ id: 1003, seasonNumber: 2, episodeNumber: 1 }],
        rejections: [],
      },
    ];
    instances.state("sonarr").queue = [base(502)];
  });

  const open: ImportGuard = { others: [], reserve: () => true };

  async function judged(guard: ImportGuard = open) {
    return judgeDownload(adapter, "series", 12, await download(base(502)), false, guard);
  }

  it("refuses while another download being imported covers a mapped episode", async () => {
    const importing = await download({
      ...base(501),
      id: 950,
      episodeId: 1003,
      status: "completed",
      trackedDownloadState: "importing",
      trackedDownloadStatus: "ok",
    });

    expect(await judged({ others: [importing], reserve: () => true })).toMatchObject({
      remedy: "none",
      reason: downloadReasons.targetImporting,
    });
  });

  it("refuses while another fix holds a mapped episode, before asking the library", async () => {
    const reserved: string[][] = [];
    const judgement = await judged({
      others: [],
      reserve: (targets) => {
        reserved.push([...targets]);
        return false;
      },
    });

    expect(judgement).toMatchObject({ remedy: "none", reason: downloadReasons.targetBeingFixed });
    expect(reserved).toEqual([[targetKey("sonarr", 1003)]]);
    expect(instances.requests.some((request) => request.route === "episode")).toBe(false);
  });

  it("confirms an import whose files are importable and whose episodes have no file", async () => {
    const judgement = await judged();

    expect(judgement).toMatchObject({ state: "stuck", remedy: "import" });
    expect(
      judgement.state === "stuck" && judgement.remedy === "import" ? judgement.files : [],
    ).toHaveLength(1);
    expect(instances.mutations()).toEqual([]);
  });

  it("refuses when the library already has a file for a mapped episode, though the scan says importable", async () => {
    const episode = instances.state("sonarr").episodes.find((candidate) => candidate.id === 1003);
    if (episode !== undefined) {
      episode.hasFile = true;
    }

    expect(await judged()).toEqual({
      state: "stuck",
      remedy: "none",
      reason: downloadReasons.libraryHasFile,
    });
  });

  it("refuses when the library cannot say whether a mapped episode has a file", async () => {
    const episode = instances.state("sonarr").episodes.find((candidate) => candidate.id === 1003);
    if (episode !== undefined) {
      delete episode.hasFile;
    }

    expect(await judged()).toMatchObject({
      remedy: "none",
      reason: downloadReasons.libraryCannotSay,
    });
  });

  it("refuses a file matched to no episode", async () => {
    for (const scanned of instances.state("sonarr").manualimport) {
      scanned.episodes = [];
    }

    expect(await judged()).toMatchObject({ remedy: "none", reason: downloadReasons.unmatched });
  });

  it("refuses a file matched to another title", async () => {
    for (const scanned of instances.state("sonarr").manualimport) {
      scanned.series = { id: 13, title: "Example Anime" };
    }

    expect(await judged()).toMatchObject({ remedy: "none", reason: downloadReasons.otherTitle });
  });

  it("refuses a file the instance rejected", async () => {
    for (const scanned of instances.state("sonarr").manualimport) {
      scanned.rejections = [{ reason: "Not an upgrade", type: "permanent" }];
    }

    expect(await judged()).toMatchObject({ remedy: "none", reason: downloadReasons.refused });
  });

  it("refuses a download with no files in it", async () => {
    instances.state("sonarr").manualimport = [];

    expect(await judged()).toMatchObject({ remedy: "none", reason: downloadReasons.noFiles });
  });

  it("refuses when the files do not fit, or the room cannot be confirmed", async () => {
    for (const volume of instances.state("sonarr").diskspace) {
      volume.freeSpace = 1;
    }
    expect(await judged()).toMatchObject({ remedy: "none", reason: downloadReasons.noSpace });

    instances.state("sonarr").diskspace = [];
    expect(await judged()).toMatchObject({
      remedy: "none",
      reason: downloadReasons.unverifiedSpace,
    });
  });

  it("re-decides each file without importing anything", async () => {
    await judged();

    const writes = instances.requests.filter((request) => request.method !== "GET");
    expect(writes.map((request) => `${request.method} ${request.route}`)).toEqual([
      "POST manualimport",
    ]);
  });
});
