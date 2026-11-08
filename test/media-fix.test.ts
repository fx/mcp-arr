import { beforeEach, describe, expect, it } from "vitest";
import { defaultScanLimit } from "../src/adapters/library/paging.js";
import { createManualClock, type ManualClock } from "../src/state/clock.js";
import { createDownloadClaims, type DownloadClaims } from "../src/state/download-claims.js";
import { downloadReasons, targetKey, uncertainHoldMs } from "../src/tools/media/downloads.js";
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

  it("releases the claim when the instance refused the replacement outright", async () => {
    instances.state("sonarr").queue = [failedRow(502, "one")];
    let refusals = 1;
    instances.intercept((request) => {
      if (request.method === "DELETE" && refusals > 0) {
        refusals -= 1;
        return new Response(JSON.stringify([{ errorMessage: "refused" }]), { status: 400 });
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
    expect(failed.content.errors.map((error) => error.code)).toEqual(["upstream_rejection"]);
    expect(claims.size).toBe(0);

    const retried = await fix();
    expect(retried.content.downloads?.[0]?.action).toBe("replaced");
  });

  it("sends no second replacement after one whose answer was lost took effect", async () => {
    instances.state("sonarr").queue = [failedRow(502, "one")];
    instances.intercept((request) => {
      if (request.method === "DELETE") {
        instances.state("sonarr").queue = [];
        throw new TypeError("fetch failed");
      }
      return undefined;
    });

    const lost = await fix();
    const again = await fix();

    expect(lost.content.downloads?.[0]?.reason).toBe(fixReasons.replaceUncertain);
    expect(again.content.downloads).toEqual([]);
    expect(claims.size).toBe(0);
    expect(instances.mutations().map(describeRequest)).toEqual(["DELETE queue/502"]);
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

    expect(claims.pending()).toEqual([]);
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

describe("media_fix keeping two imports out of one episode", () => {
  beforeEach(() => {
    instances.state("sonarr").queue = [structuredClone(blocked)];
    makeImportable();
  });

  function commandPosts(): number {
    return instances.mutations().filter((request) => request.route === "command").length;
  }

  it("refuses while another fix holds the episode, and status says the same", async () => {
    claims.tryClaim("another download");
    claims.tryClaimTargets("another download", [targetKey("sonarr", 1003)]);

    const reported = (await status()).content.downloads?.[0];
    const { content } = await fix();

    expect(reported).toMatchObject({ remedy: "none", reason: downloadReasons.targetBeingFixed });
    expect(content.downloads?.[0]).toMatchObject({
      action: "none",
      reason: downloadReasons.targetBeingFixed,
    });
    expect(commandPosts()).toBe(0);
  });

  it("refuses while another download for the episode is being imported", async () => {
    instances.state("sonarr").queue.push({
      ...blocked,
      id: 950,
      downloadId: "another-release",
      trackedDownloadState: "importing",
      trackedDownloadStatus: "ok",
    });

    const reported = (await status()).content.downloads?.[0];
    const { content } = await fix();

    expect(reported).toMatchObject({ remedy: "none", reason: downloadReasons.targetImporting });
    expect(content.downloads?.[0]).toMatchObject({
      action: "none",
      reason: downloadReasons.targetImporting,
    });
    expect(commandPosts()).toBe(0);
  });

  it("imports one of two downloads for the same episode, however the calls overlap", async () => {
    instances.state("sonarr").queue.push({ ...blocked, id: 951, downloadId: "another-release" });

    await Promise.all([fix(), fix()]);

    expect(commandPosts()).toBe(1);
  });

  it("withholds the import when the library gains a file just before it is sent", async () => {
    let scans = 0;
    instances.intercept((request) => {
      if (request.method === "GET" && request.route === "manualimport") {
        scans += 1;
        // The submission's own recovery: every check before it has passed.
        if (scans === 3) {
          setEpisodeFile(1003, true);
        }
      }
      return undefined;
    });

    const { content } = await fix();

    expect(content.downloads?.[0]).toMatchObject({
      action: "none",
      reason: downloadReasons.libraryHasFile,
    });
    expect(commandPosts()).toBe(0);
    expect(claims.size).toBe(0);
  });
});

describe("media_fix with an import whose answer was lost", () => {
  beforeEach(() => {
    instances.state("sonarr").queue = [structuredClone(blocked)];
    makeImportable();
  });

  function commandPosts(): number {
    return instances.mutations().filter((request) => request.route === "command").length;
  }

  /** Accepts the import upstream, or not, and then loses the answer. */
  function loseImportAnswer(accept: boolean): void {
    instances.intercept((request) => {
      if (request.method === "POST" && request.route === "command") {
        if (accept) {
          instances.state("sonarr").commands.set(7999, {
            id: 7999,
            name: "ManualImport",
            status: "queued",
          });
        }
        throw new TypeError("fetch failed");
      }
      return undefined;
    });
  }

  it("keeps the claim and reports the download importing, starting no second import", async () => {
    loseImportAnswer(true);

    const first = await fix();
    expect(first.content.downloads?.[0]).toMatchObject({
      action: "none",
      reason: fixReasons.importUncertain,
    });
    expect(claims.pending().map(([, claimed]) => claimed.commandId)).toEqual([undefined]);
    expect((await status()).content.downloads?.[0]).toMatchObject({ state: "importing" });

    clock.advance(5 * 60 * 1000);
    const again = await fix();
    const [left, right] = await Promise.all([fix(), fix()]);
    for (const call of [again, left, right]) {
      expect(call.content.downloads?.[0]?.reason).toBe(fixReasons.alreadyFixing);
    }
    expect(commandPosts()).toBe(1);
  });

  it("treats an accepted answer it cannot read as a lost one", async () => {
    instances.intercept((request) =>
      request.method === "POST" && request.route === "command"
        ? new Response(JSON.stringify({ accepted: true }), { status: 201 })
        : undefined,
    );

    const first = await fix();

    expect(first.content.downloads?.[0]?.reason).toBe(fixReasons.importUncertain);
    expect(claims.size).toBe(1);
    await fix();
    expect(commandPosts()).toBe(1);
  });

  it("releases the claim once it is clear the import never arrived", async () => {
    loseImportAnswer(false);
    await fix();

    // Too soon for an empty command list to mean anything.
    clock.advance(60 * 1000);
    await status();
    expect(claims.size).toBe(1);

    clock.advance(2 * 60 * 1000);
    await status();
    expect(claims.size).toBe(0);
  });

  it("releases the claim once the download has left the queue", async () => {
    loseImportAnswer(true);
    await fix();

    instances.state("sonarr").queue = [];
    await status({ kind: "series", id: 100_002 });

    expect(claims.size).toBe(0);
  });

  it("releases the claim once the library has a file for everything it was for", async () => {
    loseImportAnswer(true);
    await fix();

    setEpisodeFile(1003, true);
    await status();

    expect(claims.size).toBe(0);
  });

  it("releases the claim at the hold bound when nothing settles it", async () => {
    loseImportAnswer(true);
    await fix();

    clock.advance(uncertainHoldMs - 1);
    await status();
    expect(claims.size).toBe(1);

    clock.advance(1);
    await status();
    expect(claims.size).toBe(0);
    expect(uncertainHoldMs).toBe(30 * 60 * 1000);
  });

  it("releases the claim when the instance refused the import outright", async () => {
    instances.intercept((request) =>
      request.method === "POST" && request.route === "command"
        ? new Response(JSON.stringify([{ errorMessage: "refused" }]), { status: 400 })
        : undefined,
    );

    const { content } = await fix();

    expect(content.downloads?.[0]?.reason).toBe(fixReasons.requestFailed);
    expect(claims.size).toBe(0);
  });
});

describe("media_fix concludes nothing from a read cut short", () => {
  /** Rows of other downloads of the same title, enough to fill the scan bound. */
  function filler(): UpstreamRecord[] {
    return Array.from({ length: defaultScanLimit }, (_, index) => ({
      ...blocked,
      id: 20_000 + index,
      downloadId: `filler-${index}`,
      status: "downloading",
      trackedDownloadState: "downloading",
      trackedDownloadStatus: "ok",
    }));
  }

  function loseAcceptedImport(): void {
    instances.intercept((request) => {
      if (request.method === "POST" && request.route === "command") {
        instances
          .state("sonarr")
          .commands.set(7999, { id: 7999, name: "ManualImport", status: "queued" });
        throw new TypeError("fetch failed");
      }
      return undefined;
    });
  }

  beforeEach(() => {
    instances.state("sonarr").queue = [structuredClone(blocked)];
    makeImportable();
  });

  it("keeps a lost import's claim when its download is missing only from a truncated queue read", async () => {
    loseAcceptedImport();
    await fix();
    expect(claims.size).toBe(1);

    // The download is still queued, past the bound of what one read covers.
    instances.state("sonarr").queue = [...filler(), structuredClone(blocked)];
    await status({ kind: "series", id: 100_002 });

    expect(claims.size).toBe(1);
  });

  it("keeps a lost import's claim when the command list was too long to read in full", async () => {
    loseAcceptedImport();
    await fix();
    const commands = instances.state("sonarr").commands;
    const unfinished = commands.get(7999) ?? {};
    commands.clear();
    for (let index = 0; index < defaultScanLimit; index += 1) {
      commands.set(10_000 + index, { id: 10_000 + index, name: "RssSync", status: "completed" });
    }
    // The unfinished import sits past the bound of what one read covers.
    commands.set(7999, unfinished);

    clock.advance(5 * 60 * 1000);
    await status();

    expect(claims.size).toBe(1);
  });

  it("does not call a download missing from a truncated re-read no longer stuck", async () => {
    instances.state("sonarr").queue = [failedRow(502, "one")];
    let reads = 0;
    instances.intercept((request) => {
      if (request.method === "GET" && request.route === "queue/details") {
        reads += 1;
        if (reads === 2) {
          instances.state("sonarr").queue = [...filler(), failedRow(502, "one")];
        }
      }
      return undefined;
    });

    const { content } = await fix();

    expect(content.downloads?.[0]).toMatchObject({
      action: "none",
      reason: downloadReasons.queueIncomplete,
    });
    expect(instances.mutations()).toEqual([]);
  });

  it("refuses an import, in status and in fix alike, when the title's queue is truncated", async () => {
    instances.state("sonarr").queue = [structuredClone(blocked), ...filler()];

    const reported = (await status()).content;
    const { content } = await fix();

    expect(reported.downloads?.[0]).toMatchObject({
      remedy: "none",
      reason: downloadReasons.queueIncomplete,
    });
    expect(reported.warnings).toContain(
      "this title has more queue entries than could be read, so its downloads may be incomplete",
    );
    expect(content.downloads?.[0]).toMatchObject({
      action: "none",
      reason: downloadReasons.queueIncomplete,
    });
    expect(content.warnings).toEqual([
      "this title has more queue entries than could be read, so remaining counts only those read",
    ]);
    expect(instances.mutations()).toEqual([]);
  });
});

describe("media_fix with a replacement whose answer was lost", () => {
  /**
   * Lets the instance accept the replacement and lose the answer, with the
   * download still listed for a while, as a queue slow to show a removal is.
   */
  function loseReplacementAnswer(answer: () => Response | never): void {
    instances.intercept((request) => (request.method === "DELETE" ? answer() : undefined));
  }

  function deletes(): number {
    return instances.mutations().filter((request) => request.method === "DELETE").length;
  }

  beforeEach(() => {
    instances.state("sonarr").queue = [failedRow(502, "one")];
  });

  it("holds the claim and sends no second replacement, sequential or concurrent", async () => {
    loseReplacementAnswer(() => {
      throw new TypeError("fetch failed");
    });

    const first = await fix();
    expect(first.content.downloads?.[0]).toMatchObject({
      action: "none",
      reason: fixReasons.replaceUncertain,
    });
    expect(claims.pending().map(([, outcome]) => outcome.action)).toEqual(["replace"]);
    expect((await status()).content.downloads?.[0]).toMatchObject({
      state: "stuck",
      remedy: "none",
      reason: fixReasons.alreadyFixing,
    });

    const again = await fix();
    const [left, right] = await Promise.all([fix(), fix()]);
    for (const call of [again, left, right]) {
      expect(call.content.downloads?.[0]?.reason).toBe(fixReasons.alreadyFixing);
    }
    expect(deletes()).toBe(1);
  });

  it("holds the claim across contexts that share the process's claims, as HTTP requests do", async () => {
    loseReplacementAnswer(() => new Response("not json", { status: 200 }));
    const shared = createDownloadClaims();

    await fix(undefined, shared);
    await Promise.all([fix(undefined, shared), fix(undefined, shared)]);

    expect(deletes()).toBe(1);
    expect(shared.size).toBe(1);
  });

  it("holds the claim after an instance-side failure, which proves nothing", async () => {
    loseReplacementAnswer(() => new Response("{}", { status: 500 }));

    await fix();
    await fix();

    expect(deletes()).toBe(1);
    expect(claims.size).toBe(1);
  });

  it("releases the claim once a complete read shows the download gone, and not before", async () => {
    loseReplacementAnswer(() => {
      throw new TypeError("fetch failed");
    });
    await fix();

    // Still listed, past the bound of a read: no evidence yet.
    instances.state("sonarr").queue = [
      ...Array.from({ length: defaultScanLimit + 1 }, (_, index) => ({
        ...blocked,
        id: 20_000 + index,
        downloadId: `filler-${index}`,
        status: "downloading",
        trackedDownloadState: "downloading",
        trackedDownloadStatus: "ok",
      })),
      failedRow(502, "one"),
    ];
    await status();
    expect(claims.size).toBe(1);

    instances.state("sonarr").queue = [];
    await status({ kind: "series", id: 100_002 });
    expect(claims.size).toBe(0);
  });

  it("releases the claim at the hold bound, and a download still listed then is acted on", async () => {
    let answers = 0;
    loseReplacementAnswer(() => {
      answers += 1;
      if (answers === 1) {
        throw new TypeError("fetch failed");
      }
      return new Response(null, { status: 200 });
    });
    await fix();

    clock.advance(uncertainHoldMs - 1);
    await fix();
    expect(deletes()).toBe(1);

    clock.advance(1);
    const after = await fix();
    expect(after.content.downloads?.[0]?.action).toBe("replaced");
    expect(deletes()).toBe(2);
  });
});
