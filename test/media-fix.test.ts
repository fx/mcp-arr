import { beforeEach, describe, expect, it } from "vitest";
import { createManualClock, type ManualClock } from "../src/state/clock.js";
import { createDownloadClaims, type DownloadClaims } from "../src/state/download-claims.js";
import { downloadReasons } from "../src/tools/media/downloads.js";
import { fixReasons } from "../src/tools/media/fix.js";
import type { FixResult, StatusResult } from "../src/tools/media/schemas.js";
import {
  callMediaTool,
  createMediaContext,
  forbiddenTermsIn,
  noMediaDefaults,
} from "./support/media.js";
import {
  type ActivityInstances,
  type ActivityRequest,
  createActivityInstances,
} from "./support/media-activity.js";
import { allApplicationsEnvironment } from "./support/tool-context.js";

/**
 * `media_fix` over the recorded library and queue.
 *
 * Series 100001 is library record 12, and the tests give it whichever queue
 * rows they need, built over the recorded blocked-import row 502. Where an
 * import has to be finishable, the import scan is given one file matched to
 * that row's episode, S02E01, which the recorded library holds no file for.
 */

type UpstreamRecord = Record<string, unknown>;

let instances: ActivityInstances;
let claims: DownloadClaims;
let clock: ManualClock;
let blocked: UpstreamRecord;

beforeEach(async () => {
  instances = await createActivityInstances();
  claims = createDownloadClaims();
  clock = createManualClock(Date.parse("2026-11-07T00:00:00Z"));
  const row = instances.state("sonarr").queue.find((candidate) => candidate.id === 502);
  blocked = structuredClone(row ?? {});
});

function context(shared: DownloadClaims = claims) {
  return createMediaContext(instances, noMediaDefaults, allApplicationsEnvironment, {
    claims: shared,
    clock,
  });
}

function fix(input: unknown = { kind: "series", id: 100_001 }, shared: DownloadClaims = claims) {
  return callMediaTool<FixResult>("media_fix", context(shared), input);
}

function status(input: unknown = { kind: "series", id: 100_001 }) {
  return callMediaTool<StatusResult>("media_status", context(), input);
}

function makeImportable(): void {
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
}

function setEpisodeFile(id: number, hasFile: boolean | undefined): void {
  const episode = instances.state("sonarr").episodes.find((candidate) => candidate.id === id);
  if (episode === undefined) {
    throw new Error(`No episode ${id}`);
  }
  if (hasFile === undefined) {
    delete episode.hasFile;
  } else {
    episode.hasFile = hasFile;
  }
}

function failedRow(id: number, downloadId: string): UpstreamRecord {
  return {
    ...blocked,
    id,
    status: "failed",
    trackedDownloadState: "failed",
    trackedDownloadStatus: "error",
    downloadId,
  };
}

function describeRequest(request: ActivityRequest): string {
  return `${request.method} ${request.route}`;
}

const replacementFlags = {
  removeFromClient: "true",
  blocklist: "true",
  skipRedownload: "false",
  changeCategory: "false",
};

/** The row fields of every row of the download-state and remedy tables. */
const tableRows: readonly {
  readonly name: string;
  readonly fields: UpstreamRecord;
  readonly setup?: () => void;
}[] = [
  {
    name: "waiting",
    fields: { status: "delay", trackedDownloadState: null, trackedDownloadStatus: null },
  },
  {
    name: "queued",
    fields: { status: "queued", trackedDownloadState: "downloading", trackedDownloadStatus: "ok" },
  },
  {
    name: "paused",
    fields: { status: "paused", trackedDownloadState: "downloading", trackedDownloadStatus: "ok" },
  },
  {
    name: "downloading",
    fields: {
      status: "downloading",
      trackedDownloadState: "downloading",
      trackedDownloadStatus: "ok",
    },
  },
  {
    name: "importing",
    fields: { status: "completed", trackedDownloadState: "importing", trackedDownloadStatus: "ok" },
  },
  {
    name: "pending import with no warning",
    fields: {
      status: "completed",
      trackedDownloadState: "importPending",
      trackedDownloadStatus: "ok",
    },
  },
  {
    name: "failed",
    fields: { status: "failed", trackedDownloadState: "failed", trackedDownloadStatus: "error" },
  },
  {
    name: "failed pending",
    fields: {
      status: "completed",
      trackedDownloadState: "failedPending",
      trackedDownloadStatus: "warning",
    },
  },
  {
    name: "stalled",
    fields: {
      status: "warning",
      trackedDownloadState: "downloading",
      trackedDownloadStatus: "warning",
    },
  },
  {
    name: "downloader unavailable",
    fields: { status: "downloadClientUnavailable", trackedDownloadState: "downloading" },
  },
  { name: "import blocked and finishable", fields: {}, setup: makeImportable },
  {
    name: "pending import with a warning and finishable",
    fields: { trackedDownloadState: "importPending" },
    setup: makeImportable,
  },
  {
    name: "import blocked while the library has the file",
    fields: {},
    setup: () => {
      makeImportable();
      setEpisodeFile(1003, true);
    },
  },
  {
    name: "import blocked while the library cannot say",
    fields: {},
    setup: () => {
      makeImportable();
      setEpisodeFile(1003, undefined);
    },
  },
  { name: "import blocked with an unmatched file", fields: {} },
  {
    name: "import blocked with no download identity",
    fields: { downloadId: null },
    setup: makeImportable,
  },
  {
    name: "in a state nobody named",
    fields: { status: "somethingNew", trackedDownloadState: "downloading" },
  },
];

describe("media_fix applies the remedy media_status reports", () => {
  for (const entry of tableRows) {
    it(`agrees for a download that is ${entry.name}`, async () => {
      instances.state("sonarr").queue = [{ ...blocked, ...entry.fields }];
      entry.setup?.();

      const reported = (await status()).content.downloads?.[0];
      expect(reported).toBeDefined();
      const before = instances.mutations().length;
      const { content, result } = await fix();
      const sent = instances.mutations().slice(before);

      expect(result.isError).toBe(false);
      if (reported?.state !== "stuck") {
        expect(content.downloads).toEqual([]);
        expect(sent).toEqual([]);
        return;
      }
      expect(content.downloads).toHaveLength(1);
      const done = content.downloads?.[0];
      expect(done?.episodes).toBe(reported.episodes);
      switch (reported.remedy) {
        case "replace":
          expect(done?.action).toBe("replaced");
          expect(sent.map(describeRequest)).toEqual(["DELETE queue/502"]);
          expect(sent[0]?.query).toEqual(replacementFlags);
          break;
        case "import":
          expect(done?.action).toBe("import_started");
          expect(sent.map(describeRequest)).toEqual(["POST command"]);
          expect(sent[0]?.body).toMatchObject({ name: "ManualImport", importMode: "auto" });
          break;
        default:
          expect(done).toMatchObject({ action: "none", reason: reported.reason });
          expect(sent).toEqual([]);
      }
    });
  }

  it("covers every remedy among the table rows", async () => {
    const remedies = new Set<string>();
    for (const entry of tableRows) {
      instances = await createActivityInstances();
      instances.state("sonarr").queue = [{ ...blocked, ...entry.fields }];
      entry.setup?.();
      const reported = (await status()).content.downloads?.[0];
      remedies.add(reported?.state === "stuck" ? (reported.remedy ?? "") : (reported?.state ?? ""));
    }
    expect([...remedies].sort()).toEqual(
      ["downloading", "import", "importing", "none", "queued", "replace", "waiting"].sort(),
    );
  });
});

describe("media_fix leaves alone what is not stuck", () => {
  it("does nothing for a title with nothing stuck", async () => {
    instances.state("sonarr").queue = instances
      .state("sonarr")
      .queue.filter((row) => row.id === 501);

    const { content, summary } = await fix();

    expect(content).toEqual({
      kind: "series",
      id: 100_001,
      title: "Example Series",
      downloads: [],
      remaining: 0,
      warnings: [],
      errors: [],
    });
    expect(summary).toBe(
      "media_fix: series 100001: 0 replaced, 0 import(s) started, 0 left alone, 0 remaining",
    );
    expect(instances.mutations()).toEqual([]);
  });

  it("does not touch another title's download in the same queue", async () => {
    instances.state("sonarr").queue = [
      instances.state("sonarr").queue.find((row) => row.id === 501) ?? {},
      { ...failedRow(600, "another-title"), seriesId: 13, episodeId: 1002 },
    ];

    const { content } = await fix();

    expect(content.downloads).toEqual([]);
    expect(instances.mutations()).toEqual([]);
  });

  it("refuses a title that is not in the library, pointing to media_add", async () => {
    const { content, result } = await fix({ kind: "movie", id: 999_999 });

    expect(result.isError).toBe(true);
    expect(content.errors).toEqual([
      expect.objectContaining({ code: "conflict", remediation: "Add it with media_add first." }),
    ]);
    expect(instances.mutations()).toEqual([]);
  });
});

describe("media_fix judges from the reading it acts on", () => {
  it("acts on the state at fix time, not on an earlier status", async () => {
    instances.state("sonarr").queue = [failedRow(502, "one")];
    expect((await status()).content.downloads?.[0]).toMatchObject({ remedy: "replace" });

    instances.state("sonarr").queue = [
      {
        ...failedRow(502, "one"),
        status: "downloading",
        trackedDownloadState: "downloading",
        trackedDownloadStatus: "ok",
      },
    ];
    const { content } = await fix();

    expect(content.downloads).toEqual([]);
    expect(instances.mutations()).toEqual([]);
  });

  it("re-reads a download once it holds the claim, and leaves one that recovered", async () => {
    instances.state("sonarr").queue = [failedRow(502, "one")];
    let reads = 0;
    instances.intercept((request) => {
      if (request.route === "queue/details" && request.method === "GET") {
        reads += 1;
        if (reads === 2) {
          // Between the first reading and the one taken under the claim.
          instances.state("sonarr").queue = [];
        }
      }
      return undefined;
    });

    const { content } = await fix();

    expect(content.downloads).toEqual([
      {
        title: "Example Series",
        episodes: "S02E01",
        action: "none",
        reason: fixReasons.noLongerStuck,
      },
    ]);
    expect(instances.mutations()).toEqual([]);
  });
});

describe("media_fix replacing a download", () => {
  it("blocklists it, removes it and its data, and leaves the search to the instance", async () => {
    instances.state("sonarr").queue = [failedRow(502, "one")];

    const { content } = await fix();

    expect(content.downloads).toEqual([
      { title: "Example Series", episodes: "S02E01", action: "replaced" },
    ]);
    const sent = instances.mutations();
    expect(sent.map(describeRequest)).toEqual(["DELETE queue/502"]);
    expect(sent[0]?.query).toEqual(replacementFlags);
    // Nothing deletes or replaces a library file or record, and no search is started.
    for (const request of instances.requests) {
      expect(`${request.method} ${request.route}`).not.toMatch(
        /^(DELETE|PUT) (episodefile|moviefile|series|movie)\b/u,
      );
      expect(request.method === "POST" && request.route === "command").toBe(false);
    }
  });

  it("replaces once between sequential calls and between concurrent ones", async () => {
    instances.state("sonarr").queue = [failedRow(502, "one")];
    await fix();
    const second = await fix();
    expect(second.content.downloads).toEqual([]);

    instances.state("sonarr").queue = [failedRow(503, "two")];
    const [left, right] = await Promise.all([fix(), fix()]);
    const actions = [left, right]
      .flatMap((call) => call.content.downloads ?? [])
      .map((download) => download.action);
    expect(actions.filter((action) => action === "replaced")).toEqual(["replaced"]);
    expect(instances.mutations().map(describeRequest)).toEqual([
      "DELETE queue/502",
      "DELETE queue/503",
    ]);
  });

  it("replaces once across two contexts that share the process's claims, as HTTP requests do", async () => {
    instances.state("sonarr").queue = [failedRow(502, "one")];
    const shared = createDownloadClaims();

    await Promise.all([fix(undefined, shared), fix(undefined, shared)]);

    expect(instances.mutations().map(describeRequest)).toEqual(["DELETE queue/502"]);
  });

  it("acts on ten stuck downloads and reports how many are left", async () => {
    instances.state("sonarr").queue = Array.from({ length: 12 }, (_, index) =>
      failedRow(800 + index, `download-${index}`),
    );

    const { content, summary } = await fix();

    expect(content.downloads).toHaveLength(10);
    expect(content.downloads?.every((download) => download.action === "replaced")).toBe(true);
    expect(content.remaining).toBe(2);
    expect(instances.mutations().map(describeRequest)).toEqual(
      Array.from({ length: 10 }, (_, index) => `DELETE queue/${800 + index}`),
    );
    expect(summary).toBe(
      "media_fix: series 100001: 10 replaced, 0 import(s) started, 0 left alone, 2 remaining",
    );

    const next = await fix();
    expect(next.content.downloads).toHaveLength(2);
    expect(next.content.remaining).toBe(0);
  });

  it("replaces a season pack once, within one call and across concurrent calls", async () => {
    const pack = [1003, 1004].map((episodeId, index) => ({
      ...failedRow(700 + index, "pack"),
      episodeId,
    }));
    instances.state("sonarr").queue = [...pack];

    const { content } = await fix();
    expect(content.downloads).toEqual([
      { title: "Example Series", episodes: "S02E01–E02", action: "replaced" },
    ]);
    expect(instances.mutations().map(describeRequest)).toEqual(["DELETE queue/700"]);

    instances.state("sonarr").queue = pack.map((row) => ({ ...row, downloadId: "pack-two" }));
    await Promise.all([fix(), fix(), fix()]);
    expect(instances.mutations().map(describeRequest)).toEqual([
      "DELETE queue/700",
      "DELETE queue/700",
    ]);
  });

  it("releases the claim when the request fails, so a later call can act", async () => {
    instances.state("sonarr").queue = [failedRow(502, "one")];
    let failures = 1;
    instances.intercept((request) => {
      if (request.method === "DELETE" && failures > 0) {
        failures -= 1;
        return new Response(JSON.stringify({ message: "an instance-side failure" }), {
          status: 500,
        });
      }
      return undefined;
    });

    const failed = await fix();
    expect(failed.result.isError).toBe(true);
    expect(failed.content.downloads).toEqual([
      {
        title: "Example Series",
        episodes: "S02E01",
        action: "none",
        reason: fixReasons.requestFailed,
      },
    ]);
    expect(failed.content.errors.map((error) => error.code)).toEqual(["unexpected_response"]);
    expect(claims.size).toBe(0);

    const retried = await fix();
    expect(retried.content.downloads?.[0]?.action).toBe("replaced");
  });

  it("leaves a download alone when the downloader is unreachable", async () => {
    instances.state("sonarr").queue = [{ ...blocked, status: "downloadClientUnavailable" }];

    const { content } = await fix();

    expect(content.downloads?.[0]).toMatchObject({
      action: "none",
      reason: downloadReasons.unavailable,
    });
    expect(instances.mutations()).toEqual([]);
  });
});

describe("media_fix importing a download", () => {
  beforeEach(() => {
    instances.state("sonarr").queue = [structuredClone(blocked)];
    makeImportable();
  });

  /** Changes what the scan says a file maps to, from the given scan onward. */
  function remapFrom(scan: number, episodes: readonly UpstreamRecord[]): void {
    let scans = 0;
    instances.intercept((request) => {
      if (request.method === "GET" && request.route === "manualimport") {
        scans += 1;
        if (scans === scan) {
          for (const row of instances.state("sonarr").manualimport) {
            row.episodes = [...episodes];
          }
        }
      }
      return undefined;
    });
  }

  it("sends no import when a file's mapping changed after it was approved", async () => {
    // The first two scans confirm the import; the third is the one the
    // submission recovers the file through, and by then the file is mapped to
    // an episode whose library record was never checked.
    remapFrom(3, [{ id: 1004, seasonNumber: 2, episodeNumber: 2 }]);

    const { content } = await fix();

    expect(content.downloads).toEqual([
      {
        title: "Example Series",
        episodes: "S02E01",
        action: "none",
        reason: downloadReasons.changed,
      },
    ]);
    expect(instances.mutations()).toEqual([]);
    expect(claims.size).toBe(0);
  });

  it("sends the import when the mapping is the one approved", async () => {
    remapFrom(3, [{ id: 1003, seasonNumber: 2, episodeNumber: 1 }]);

    const { content } = await fix();

    expect(content.downloads?.[0]?.action).toBe("import_started");
    expect(instances.mutations().map(describeRequest)).toEqual(["POST command"]);
  });

  it("starts the import with no correction and keeps the claim while the import is unfinished", async () => {
    const { content } = await fix();

    expect(content.downloads).toEqual([
      { title: "Example Series", episodes: "S02E01", action: "import_started" },
    ]);
    const [command] = instances.mutations();
    expect(command?.body).toMatchObject({
      name: "ManualImport",
      importMode: "auto",
      files: [expect.objectContaining({ seriesId: 12, episodeIds: [1003] })],
    });
    expect(claims.size).toBe(1);
    expect((await status()).content.downloads?.[0]).toMatchObject({ state: "importing" });
  });

  it("imports once between sequential and concurrent calls while the import is queued", async () => {
    await fix();
    const again = await fix();
    const [left, right] = await Promise.all([fix(), fix()]);

    for (const call of [again, left, right]) {
      expect(call.content.downloads).toEqual([
        {
          title: "Example Series",
          episodes: "S02E01",
          action: "none",
          reason: fixReasons.alreadyFixing,
        },
      ]);
    }
    expect(instances.mutations().map(describeRequest)).toEqual(["POST command"]);
  });

  it("imports once between concurrent first calls", async () => {
    await Promise.all([fix(), fix(), fix()]);

    expect(instances.mutations().map(describeRequest)).toEqual(["POST command"]);
  });

  it("releases the claim once the import is seen to finish", async () => {
    await fix();
    const [commandId] = instances.state("sonarr").commands.keys();
    instances.state("sonarr").commands.set(commandId ?? 0, {
      id: commandId,
      name: "ManualImport",
      status: "completed",
      result: "successful",
    });
    // The import put a file in the library.
    setEpisodeFile(1003, true);

    const after = await fix();

    expect(after.content.downloads?.[0]).toMatchObject({
      action: "none",
      reason: downloadReasons.libraryHasFile,
    });
    expect(claims.size).toBe(0);
    expect(instances.mutations().map(describeRequest)).toEqual(["POST command"]);
  });

  it("releases the claim when the instance no longer holds the import", async () => {
    await fix();
    instances.state("sonarr").commands.clear();
    setEpisodeFile(1003, true);

    await fix();

    expect(claims.size).toBe(0);
  });

  it("releases a finished import's claim once its download has left the queue", async () => {
    await fix();
    expect(claims.size).toBe(1);
    // The import ran: the download left the queue and its command completed.
    instances.state("sonarr").queue = [];
    for (const [id, command] of instances.state("sonarr").commands) {
      instances
        .state("sonarr")
        .commands.set(id, { ...command, status: "completed", result: "successful" });
    }

    // A status of any title of the kind, or the overview, reads it back.
    await status({ kind: "series", id: 100_002 });
    expect(claims.size).toBe(0);

    expect(claims.imports()).toEqual([]);
  });

  it("frees room in a full claim map once finished imports are read back", async () => {
    const small = createDownloadClaims(1);
    await fix(undefined, small);
    expect(small.size).toBe(1);

    // The import finished and left the queue; another download is stuck.
    instances.state("sonarr").queue = [failedRow(900, "another")];
    for (const [id, command] of instances.state("sonarr").commands) {
      instances
        .state("sonarr")
        .commands.set(id, { ...command, status: "completed", result: "successful" });
    }

    const { content } = await fix(undefined, small);

    expect(content.downloads?.[0]?.action).toBe("replaced");
    expect(small.size).toBe(0);
  });

  it("keeps a finished-looking claim whose command cannot be read, and refuses a new one while full", async () => {
    const small = createDownloadClaims(1);
    await fix(undefined, small);
    instances.state("sonarr").queue = [failedRow(900, "another")];
    instances.intercept((request) =>
      request.route.startsWith("command/") ? new Response("{}", { status: 503 }) : undefined,
    );

    const { content } = await fix(undefined, small);

    expect(content.downloads?.[0]).toMatchObject({
      action: "none",
      reason: fixReasons.tooManyFixes,
    });
    expect(small.size).toBe(1);
  });

  it("keeps the claim while the import cannot be read back", async () => {
    await fix();
    instances.intercept((request) =>
      request.route.startsWith("command/") ? new Response("{}", { status: 503 }) : undefined,
    );

    const again = await fix();

    expect(again.content.downloads?.[0]?.reason).toBe(fixReasons.alreadyFixing);
    expect(claims.size).toBe(1);
  });

  it("refuses the import when the library already has the file, or cannot say", async () => {
    setEpisodeFile(1003, true);
    expect((await fix()).content.downloads?.[0]).toMatchObject({
      action: "none",
      reason: downloadReasons.libraryHasFile,
    });

    setEpisodeFile(1003, undefined);
    expect((await fix()).content.downloads?.[0]).toMatchObject({
      action: "none",
      reason: downloadReasons.libraryCannotSay,
    });
    expect(instances.mutations()).toEqual([]);
    expect(claims.size).toBe(0);
  });

  it("refuses the import for a movie whose record has a file, or does not say", async () => {
    const movie = instances.state("radarr").titles.find((record) => record.id === 9) ?? {};
    const [scanned] = instances.state("radarr").manualimport;
    instances.state("radarr").manualimport = [
      { ...scanned, movie: { id: 9, title: "Example Awaited Movie" } },
    ];
    instances.state("radarr").queue = instances
      .state("radarr")
      .queue.filter((row) => row.id === 602);

    const confirmed = await fix({ kind: "movie", id: 200_002 });
    expect(confirmed.content.downloads?.[0]?.action).toBe("import_started");

    for (const hasFile of [true, undefined]) {
      instances = await createActivityInstances();
      claims = createDownloadClaims();
      instances.state("radarr").manualimport = [
        { ...scanned, movie: { id: 9, title: "Example Awaited Movie" } },
      ];
      instances.state("radarr").queue = instances
        .state("radarr")
        .queue.filter((row) => row.id === 602);
      const record =
        instances.state("radarr").titles.find((candidate) => candidate.id === movie.id) ?? {};
      if (hasFile === undefined) {
        delete record.hasFile;
      } else {
        record.hasFile = hasFile;
      }

      const refused = await fix({ kind: "movie", id: 200_002 });
      expect(refused.content.downloads?.[0]).toMatchObject({
        action: "none",
        reason:
          hasFile === true ? downloadReasons.libraryHasFile : downloadReasons.libraryCannotSay,
      });
      expect(instances.mutations()).toEqual([]);
    }
  });

  it("never imports a download with no identity", async () => {
    instances.state("sonarr").queue = [{ ...blocked, downloadId: null }];

    const { content } = await fix();

    expect(content.downloads?.[0]).toMatchObject({
      action: "none",
      reason: downloadReasons.unidentified,
    });
    expect(instances.mutations()).toEqual([]);
  });

  it("imports a season pack once", async () => {
    instances.state("sonarr").queue = [1003, 1004].map((episodeId, index) => ({
      ...blocked,
      id: 700 + index,
      episodeId,
    }));
    setEpisodeFile(1004, false);
    const [scanned] = instances.state("sonarr").manualimport;
    instances.state("sonarr").manualimport = [
      scanned ?? {},
      {
        ...scanned,
        path: "/media/example/downloads/complete/example-series/Example Series - S02E02.mkv",
        episodes: [{ id: 1004, seasonNumber: 2, episodeNumber: 2 }],
      },
    ];

    await Promise.all([fix(), fix()]);

    const commands = instances.mutations();
    expect(commands.map(describeRequest)).toEqual(["POST command"]);
    expect((commands[0]?.body as { files: unknown[] }).files).toHaveLength(2);
  });

  it("publishes no word a caller of this toolset was never told about", async () => {
    const { content, summary } = await fix();

    expect(forbiddenTermsIn(`${JSON.stringify(content)} ${summary}`)).toEqual([]);
  });
});
