import { beforeAll, describe, expect, it } from "vitest";
import { fileIdentity, reprocessCandidate } from "../src/adapters/import/candidates.js";
import {
  blockingRejections,
  checkFreeSpace,
  compileCorrections,
  isImportable,
  type MappingCorrections,
  staleFacts,
  validateForImport,
} from "../src/adapters/import/corrections.js";
import type { ImportCandidate, ImportCandidateContext } from "../src/adapters/import/model.js";
import { isRetainedLabel } from "../src/adapters/import/model.js";
import type { MediaApplication } from "../src/adapters/library/model.js";
import { activityFixture } from "./support/activity.js";
import { fixtureBody, jsonResponse, libraryHarness, type UpstreamCall } from "./support/library.js";
import { reprocessAnswer } from "./support/manual-import.js";

/**
 * Manual-import corrections and the validation that precedes an import.
 *
 * Two subjects run through every assertion. A correction is a closed set of
 * five typed fields, so what reaches the upstream payload is checked field by
 * field and the payload is checked for everything a caller might have hoped to
 * smuggle into it. And validation is real validation, so each precondition is
 * exercised on its own — a file that moved, a rejection the instance raised, a
 * mount without room — rather than through one happy path that would pass
 * whichever of them was removed.
 */

const recordedFolder = "/media/example/downloads/complete/example-series";
const cleanFile = `${recordedFolder}/Example Series - S01E01 - Example Pilot Bluray-1080p.mkv`;
const rejectedFile = `${recordedFolder}/Season 02/Example Series - S02E05 - Example Second WEBDL-720p.mkv`;
const existingFile = `${recordedFolder}/Example Series - S01E02 - Example Existing Bluray-1080p.mkv`;

interface Fixtures {
  readonly candidates: Record<string, unknown>[];
  readonly queue: unknown[];
  readonly records: Array<{ id: number }>;
  readonly diskspace: unknown[];
  readonly qualities: unknown[];
  readonly languages: unknown[];
}

let sonarr: Fixtures;
/** The two applications' recorded scans and queues, for the request assertions. */
let recorded: Record<MediaApplication, { candidates: Record<string, unknown>[]; queue: unknown[] }>;

beforeAll(async () => {
  const [
    candidates,
    queue,
    records,
    diskspace,
    qualities,
    languages,
    radarrCandidates,
    radarrQueue,
  ] = await Promise.all([
    activityFixture<Record<string, unknown>[]>("sonarr", "manualimport"),
    activityFixture<unknown[]>("sonarr", "queue/details"),
    activityFixture<Array<{ id: number }>>("sonarr", "series"),
    fixtureBody("sonarr", "diskspace") as Promise<unknown[]>,
    fixtureBody("sonarr", "qualitydefinition") as Promise<unknown[]>,
    fixtureBody("sonarr", "language") as Promise<unknown[]>,
    activityFixture<Record<string, unknown>[]>("radarr", "manualimport"),
    activityFixture<unknown[]>("radarr", "queue/details"),
  ]);
  sonarr = { candidates, queue, records, diskspace, qualities, languages };
  recorded = {
    sonarr: { candidates, queue },
    radarr: { candidates: radarrCandidates, queue: radarrQueue },
  };
});

interface InstanceOptions {
  /** Replaces what the manual-import GET answers, for a file that moved. */
  readonly scan?: Record<string, unknown>[] | undefined;
  /** Replaces what the reprocess POST answers, for a re-decided candidate. */
  readonly decided?: Record<string, unknown>[] | undefined;
  /**
   * Answers the reprocess from the element it was sent, as an instance does.
   *
   * A fixed answer cannot express a decision that depends on the request, and
   * the mapping guard below is exactly that: the same file and the same
   * corrected series are accepted or rejected according to which episodes the
   * element named.
   */
  readonly decide?: ((element: Record<string, unknown>) => Record<string, unknown>) | undefined;
  readonly diskspace?: unknown[] | undefined;
}

interface Instance {
  readonly calls: UpstreamCall[];
  readonly posted: Record<string, unknown>[];
  readonly client: Parameters<typeof reprocessCandidate>[0];
}

function instance(options: InstanceOptions = {}): Instance {
  const posted: Record<string, unknown>[] = [];
  const harness = libraryHarness("sonarr", (call) => {
    const path = call.url.pathname;
    const method = call.init.method ?? "GET";

    if (path.endsWith("/manualimport")) {
      if (method === "POST") {
        const body: unknown = JSON.parse(String(call.init.body));
        // Read as the list the endpoint declares. A body of any other shape is
        // recorded as sending nothing, which is what it amounts to upstream.
        const elements = Array.isArray(body) ? (body as Record<string, unknown>[]) : [];
        posted.push(...elements);
        if (options.decide !== undefined) {
          return jsonResponse(elements.map(options.decide));
        }
        return jsonResponse(options.decided ?? [sonarr.candidates[0]]);
      }
      return jsonResponse(options.scan ?? sonarr.candidates);
    }
    if (path.endsWith("/queue/details")) {
      return jsonResponse(sonarr.queue);
    }
    if (path.endsWith("/diskspace")) {
      return jsonResponse(options.diskspace ?? sonarr.diskspace);
    }
    if (path.endsWith("/qualitydefinition")) {
      return jsonResponse(sonarr.qualities);
    }
    if (path.endsWith("/language")) {
      return jsonResponse(sonarr.languages);
    }
    const single = /\/series\/(\d+)$/u.exec(path);
    if (single !== null) {
      return jsonResponse(sonarr.records.find((record) => record.id === Number(single[1])));
    }
    return jsonResponse({ message: "unexpected route" }, 404);
  });

  return { calls: harness.calls, posted, client: harness.client };
}

/** The retained context of the recorded clean candidate, as a reference holds it. */
function retainedFor(overrides: Partial<ImportCandidateContext> = {}): ImportCandidateContext {
  return {
    application: "sonarr",
    sourceKind: "tracked_download",
    candidateId: 3001,
    queueItemId: 502,
    mediaId: 12,
    queueMediaId: 12,
    seasonNumber: 1,
    episodeIds: [1001],
    fileIdentity: fileIdentity(cleanFile),
    sizeBytes: 3_221_225_472,
    importable: true,
    selected: {
      quality: "Bluray-1080p",
      languages: ["English"],
      releaseGroup: "ExampleGroup",
    },
    ...overrides,
  };
}

async function compile(
  corrections: MappingCorrections,
  application: MediaApplication = "sonarr",
): Promise<ReturnType<typeof compileCorrections>> {
  return compileCorrections(instance().client, application, corrections);
}

async function compiled(corrections: MappingCorrections) {
  const result = await compile(corrections);
  if (result.status !== "ok") {
    throw new Error(`Expected a compilation, got ${result.reason}`);
  }
  return result.compiled;
}

describe("the corrections a caller may make", () => {
  it("accepts exactly five things and nothing else reaches the payload", async () => {
    const running = instance();
    const compilation = await compileCorrections(running.client, "sonarr", {
      mediaId: 13,
      episodeIds: [1004],
      quality: "WEBDL-720p",
      languages: ["English"],
      releaseGroup: "OtherGroup",
    });
    if (compilation.status !== "ok") {
      throw new Error(`Expected a compilation, got ${compilation.reason}`);
    }

    expect(compilation.compiled.corrected).toEqual([
      "media",
      "episodes",
      "quality",
      "languages",
      "release group",
    ]);
    // The patch's own members are the whole of what a correction can become,
    // and each is an identifier or an object read from the instance.
    expect(Object.keys(compilation.compiled.patch).sort()).toEqual([
      "episodeIds",
      "languages",
      "mediaId",
      "quality",
      "releaseGroup",
    ]);
    expect(compilation.compiled.patch.quality).toMatchObject({ name: "WEBDL-720p" });
  });

  it("carries all five through to the payload and nothing a caller invented", async () => {
    const running = instance();
    await reprocessCandidate(
      running.client,
      "sonarr",
      { sourceKind: "tracked_download", queueItemId: 502, mediaId: 12 },
      fileIdentity(cleanFile),
      (
        await compiled({
          mediaId: 13,
          episodeIds: [1004],
          quality: "WEBDL-720p",
          languages: ["French"],
          releaseGroup: "OtherGroup",
        })
      ).patch,
    );

    // The intermediate patch is not the guarantee — the element that was sent
    // is. This is the one payload in the project that names files on disk, so
    // each correction is checked where it actually lands.
    const sent = running.posted[0];
    expect(sent).toMatchObject({
      seriesId: 13,
      episodeIds: [1004],
      quality: { quality: { name: "WEBDL-720p" } },
      languages: [{ name: "French" }],
      releaseGroup: "OtherGroup",
    });

    // The control: the element is built from named fields, so its keys are the
    // whole of what this surface can send. A caller's invention has no field to
    // arrive in, and neither has an unmodelled property of the instance's row.
    expect(Object.keys(sent ?? {}).sort()).toEqual(
      [
        "downloadId",
        "episodeIds",
        "folderName",
        "languages",
        "path",
        "quality",
        "releaseGroup",
        "seasonNumber",
        "seriesId",
      ].sort(),
    );
  });

  it("costs no request where nothing it names has to be resolved", async () => {
    const running = instance();
    await compileCorrections(running.client, "sonarr", { releaseGroup: "OtherGroup" });

    // A release group is the caller's own string by definition — it names the
    // group that released the file, not something the instance defines — so
    // there is nothing to look up and nothing is looked up.
    expect(running.calls).toEqual([]);
  });

  it("refuses a quality or a language the instance does not define", async () => {
    const quality = await compile({ quality: "Remux-2160p" });
    expect(quality).toMatchObject({ status: "invalid" });
    if (quality.status === "invalid") {
      expect(quality.reason).toContain("Remux-2160p");
    }

    const language = await compile({ languages: ["English", "Klingon"] });
    expect(language).toMatchObject({ status: "invalid" });
    if (language.status === "invalid") {
      // Which one, because a call naming several otherwise cannot act on it.
      expect(language.reason).toContain("Klingon");
    }
  });

  it("refuses an identifier this server could never store", async () => {
    expect(await compile({ mediaId: 0 })).toMatchObject({ status: "invalid" });
    expect(await compile({ mediaId: 1.5 })).toMatchObject({ status: "invalid" });
    expect(await compile({ episodeIds: [1004, 0] })).toMatchObject({ status: "invalid" });
  });

  it("refuses an episode correction on an application with no episodes", async () => {
    const result = await compile({ episodeIds: [1004] }, "radarr");

    expect(result).toMatchObject({ status: "invalid" });
    if (result.status === "invalid") {
      expect(result.reason).toContain("only a series application");
    }
  });

  it("names nothing corrected where nothing was", async () => {
    expect((await compiled({})).corrected).toEqual([]);
    expect((await compiled({})).patch).toEqual({});
  });
});

describe("reprocessing a correction", () => {
  it("re-reads the queue row through its own association, not the corrected one", async () => {
    const running = instance();
    // The mapping has been corrected to another series; the download is still
    // filed under the one it arrived under.
    await validateForImport(running.client, "sonarr", {
      retained: retainedFor({ mediaId: 13, queueMediaId: 12 }),
      patch: {},
      destination: "/media/example/series",
    });

    // Scoping that read by the corrected mapping would look for the row under a
    // series it was never under, and report the file as gone.
    expect(running.calls[0]?.url.searchParams.get("seriesId")).toBe("12");
  });

  it("re-derives the file's location instead of remembering it", async () => {
    const running = instance();
    const result = await reprocessCandidate(
      running.client,
      "sonarr",
      { sourceKind: "tracked_download", queueItemId: 502, mediaId: 12 },
      fileIdentity(cleanFile),
      (await compiled({ releaseGroup: "OtherGroup" })).patch,
    );

    expect(result.status).toBe("ok");
    // The queue row is read first and is where the location comes from, exactly
    // as a first scan does it: the reference carried a digest, not a path.
    expect(running.calls[0]?.url.pathname).toBe("/api/v3/queue/details");
    expect(running.calls[1]?.url.searchParams.get("folder")).toBe(recordedFolder);
    // And the corrected row goes back carrying the path the instance reported
    // for it, which is the one thing the endpoint cannot be asked without.
    expect(running.posted[0]?.path).toBe(cleanFile);
    expect(running.posted[0]?.releaseGroup).toBe("OtherGroup");
  });

  it("writes each correction over the instance's own decision rather than replacing it", async () => {
    const running = instance();
    await reprocessCandidate(
      running.client,
      "sonarr",
      { sourceKind: "tracked_download", queueItemId: 502, mediaId: 12 },
      fileIdentity(cleanFile),
      (await compiled({ mediaId: 13, episodeIds: [1004], quality: "WEBDL-720p" })).patch,
    );

    const sent = running.posted[0];
    expect(sent).toMatchObject({
      seriesId: 13,
      episodeIds: [1004],
      quality: { quality: { name: "WEBDL-720p" } },
      // Not corrected here, so the instance's own values travel back: what is
      // re-decided has to be the mapping as a whole rather than the parts of it
      // a caller happened to name.
      seasonNumber: 1,
      // Both applications resolve a quality and a language by name on this
      // endpoint, which is what makes sending the parsed row's names — rather
      // than the instance's full definitions — a faithful restatement of them.
      languages: [{ name: "English" }],
      releaseGroup: "ExampleGroup",
    });
    // The download identity is put back from the re-derived context: it is what
    // ties an import to the queue row, and a scan answer drops it.
    expect(sent?.downloadId).toBe("b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1");
  });

  it("leaves the scan's episodes and season behind when a correction moves the media", async () => {
    const running = instance();
    // A media-only correction: the caller says this file belongs to another
    // series and names no episodes at all.
    await reprocessCandidate(
      running.client,
      "sonarr",
      { sourceKind: "tracked_download", queueItemId: 502, mediaId: 12 },
      fileIdentity(cleanFile),
      (await compiled({ mediaId: 13 })).patch,
    );

    // The scan mapped this file to series 12, season 1, episode 1001. None of
    // that describes series 13: an episode belongs to the series it is an
    // episode of, and a season counts within one series. Sending them anyway
    // builds an element that reads as coherent and is not — and Sonarr answers
    // that one with no rejections at all, so it would be imported.
    const sent = running.posted[0];
    expect(sent?.seriesId).toBe(13);
    expect(sent).not.toHaveProperty("episodeIds");
    expect(sent).not.toHaveProperty("seasonNumber");
    // The control: only the two fields the moved media invalidates are left
    // behind. Everything else the reprocess needs still travels.
    expect(sent).toMatchObject({
      path: cleanFile,
      languages: [{ name: "English" }],
      releaseGroup: "ExampleGroup",
      downloadId: "b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1",
    });
  });

  it.each([
    { named: "corrects nothing about the media", corrections: { quality: "WEBDL-720p" } },
    { named: "names the media the scan already found", corrections: { mediaId: 12 } },
  ])("sends the scan's own episodes where the correction $named", async ({ corrections }) => {
    const running = instance();
    await reprocessCandidate(
      running.client,
      "sonarr",
      { sourceKind: "tracked_download", queueItemId: 502, mediaId: 12 },
      fileIdentity(cleanFile),
      (await compiled(corrections)).patch,
    );

    // Nothing moved, so nothing is dropped: what is re-decided is the mapping
    // the instance itself found, and a guard that fired here would blank the
    // episodes of every ordinary reprocess.
    expect(running.posted[0]).toMatchObject({
      seriesId: 12,
      episodeIds: [1001],
      seasonNumber: 1,
    });
  });

  it("reports a file that is no longer in the folder as absent", async () => {
    // The scan still answers, and the file this reference stands for is not in
    // what it answered with.
    const running = instance({ scan: [sonarr.candidates[1] as Record<string, unknown>] });
    const result = await reprocessCandidate(
      running.client,
      "sonarr",
      { sourceKind: "tracked_download", queueItemId: 502, mediaId: 12 },
      fileIdentity(cleanFile),
      {},
    );

    expect(result.status).toBe("absent");
    // The typed error the rest of this surface gives for a target that has
    // gone, with the remedy a caller can act on.
    if (result.status === "absent") {
      expect(result.error.code).toBe("stale_reference");
    }
    expect(running.posted).toEqual([]);
  });

  it("reports a queue row that is gone as absent without reprocessing anything", async () => {
    const running = instance();
    const result = await reprocessCandidate(
      running.client,
      "sonarr",
      { sourceKind: "tracked_download", queueItemId: 999_999, mediaId: 12 },
      fileIdentity(cleanFile),
      {},
    );

    expect(result.status).toBe("absent");
    expect(running.posted).toEqual([]);
  });

  it.each([
    { sourceKind: "tracked_download", missing: "queue row" },
    { sourceKind: "library_context", missing: "library record" },
  ] as const)(
    "refuses an origin naming no $missing without reaching for anything",
    async ({ sourceKind }) => {
      const running = instance();
      const result = await reprocessCandidate(
        running.client,
        "sonarr",
        // The identifier this kind of scan is re-read through is not there. No
        // number stands in for it: substituting one would read an unrelated
        // record, or report a malformed reference as a target that has gone.
        { sourceKind, mediaId: 12 },
        fileIdentity(cleanFile),
        {},
      );

      expect(result.status).toBe("unmapped");
      if (result.status === "unmapped") {
        expect(result.error.code).toBe("conflict");
      }
      // Refused where it was discovered, so nothing was asked of the instance
      // at all — not the queue, not the record, not the scan.
      expect(running.calls).toEqual([]);
      expect(running.posted).toEqual([]);
    },
  );

  it("refuses an origin whose identifier is the applications' own zero", async () => {
    const running = instance();
    const result = await reprocessCandidate(
      running.client,
      "sonarr",
      // Zero is how both applications report "no record", so it is refused for
      // the same reason an absent identifier is rather than sent as a row.
      { sourceKind: "library_context", scanMediaId: 0 },
      fileIdentity(cleanFile),
      {},
    );

    expect(result.status).toBe("unmapped");
    expect(running.calls).toEqual([]);
  });
});

/**
 * What the reprocess actually puts on the wire, for both applications.
 *
 * Every other assertion on this path reads a response, and a response fixture
 * cannot see a malformed request: the wrapped, nested body these tests replaced
 * described a payload both applications refuse outright — `400` for the wrapper
 * and `404` for the nested media — while every response-shaped test stayed
 * green. So the body itself is asserted here, before anything parses it, and
 * for each application rather than for the one this file otherwise exercises.
 */
describe("the body a reprocess sends", () => {
  interface Reprocessing {
    readonly body: unknown;
    readonly element: Record<string, unknown>;
    readonly row: Record<string, unknown>;
  }

  async function reprocessOn(application: MediaApplication): Promise<Reprocessing> {
    const fixtures = recorded[application];
    const row = fixtures.candidates[0] as Record<string, unknown>;
    const queueRow = (fixtures.queue as Record<string, unknown>[]).find(
      (record) => record.outputPath !== undefined && record.downloadId !== undefined,
    );
    if (queueRow === undefined) {
      throw new Error(`Expected a recorded ${application} queue row naming a folder`);
    }

    const bodies: unknown[] = [];
    const harness = libraryHarness(application, (call) => {
      if (call.url.pathname.endsWith("/manualimport")) {
        if ((call.init.method ?? "GET") === "POST") {
          bodies.push(JSON.parse(String(call.init.body)));
          return jsonResponse([row]);
        }
        return jsonResponse(fixtures.candidates);
      }
      if (call.url.pathname.endsWith("/queue/details")) {
        return jsonResponse(fixtures.queue);
      }
      return jsonResponse({ message: "unexpected route" }, 404);
    });

    await reprocessCandidate(
      harness.client,
      application,
      { sourceKind: "tracked_download", queueItemId: Number(queueRow.id) },
      fileIdentity(String(row.path)),
      {},
    );

    const body = bodies[0];
    if (!Array.isArray(body)) {
      throw new Error(`Expected a list body, got ${JSON.stringify(body)}`);
    }
    return { body, element: body[0] as Record<string, unknown>, row };
  }

  it.each([
    { application: "sonarr", flat: "seriesId", nested: "series" },
    { application: "radarr", flat: "movieId", nested: "movie" },
  ] as const)(
    "sends $application the list it accepts, naming the media by $flat",
    async ({ application, flat, nested }) => {
      const sent = await reprocessOn(application);

      // The list itself, holding one element. An object wrapping it is what
      // both applications refuse with a `400` naming the type they wanted, and
      // the wrapper's own name is nowhere in the body at all.
      expect(sent.body).toHaveLength(1);
      expect(JSON.stringify(sent.body)).not.toContain('"files"');

      // The flat identifier the resource declares, and not the nested object
      // the scan answers with — which the endpoint reads as media zero and
      // refuses with a `404` naming a record that does not exist.
      expect(sent.element[flat]).toBe((sent.row[nested] as { id: number }).id);
      expect(sent.element[nested]).toBeUndefined();

      // The path the endpoint cannot decide without, and the download identity
      // the scan answer drops, which is what ties an import to its queue row.
      expect(sent.element.path).toBe(sent.row.path);
      expect(sent.element.downloadId).toEqual(expect.any(String));

      // And nothing the scan reports about the file travels back into a request
      // that never declared it: the row identifier, the size, the relative
      // path, the name, the custom formats and the rejections are all answers,
      // not arguments.
      for (const field of [
        "id",
        "size",
        "relativePath",
        "name",
        "customFormats",
        "customFormatScore",
        "qualityWeight",
        "rejections",
        "episodes",
      ]) {
        expect(sent.element).not.toHaveProperty(field);
      }
    },
  );
});

/**
 * The answer this instance would give for the recorded clean candidate.
 *
 * The shape is {@link reprocessAnswer}'s, which is the narrower resource both
 * applications actually answer a reprocess with — shared with the instance
 * double so the two cannot describe different upstream shapes. What varies here
 * is the decision: the rejections the instance raised on the re-decided
 * mapping.
 */
function reDecided(rejections: readonly unknown[] = []): Record<string, unknown> {
  const row = sonarr.candidates[0] as Record<string, unknown>;
  return reprocessAnswer(
    {
      path: row.path,
      seriesId: (row.series as { id: number }).id,
      seasonNumber: row.seasonNumber,
      episodeIds: (row.episodes as { id: number }[]).map((episode) => episode.id),
      quality: row.quality,
      languages: row.languages,
      releaseGroup: row.releaseGroup,
      downloadId: "b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1",
    },
    rejections,
  );
}

describe("what a reprocess answer leaves out", () => {
  it("takes the file's own facts from the scan this same call just ran", async () => {
    const running = instance({ decided: [reDecided()] });
    const result = await reprocessCandidate(
      running.client,
      "sonarr",
      { sourceKind: "tracked_download", queueItemId: 502, mediaId: 12 },
      fileIdentity(cleanFile),
      {},
    );

    if (result.status !== "ok") {
      throw new Error(`Expected a re-decided candidate, got ${result.status}`);
    }
    // The decision's own facts, read from the answer.
    expect(result.candidate.media?.id).toBe("12");
    expect(result.candidate.decision.importable).toBe(true);
    expect(result.candidate.context.episodeIds).toEqual([1001]);
    // The file's facts, which this answer does not state and the scan does.
    expect(result.candidate.sizeBytes).toBe(3_221_225_472);
    expect(result.candidate.context.candidateId).toBe(3001);
    expect(result.candidate.existingLibraryFile).toBe(false);
  });

  /**
   * The indexer-flag guard, on values this test owns rather than on a fixture's.
   *
   * The guard keeps a *list of names* the scan stated where the answer restates
   * the flags as something else, and neither application currently sends that
   * list: both answer the numeric bitfield on the scan as well as on the
   * reprocess. So there is no recording that can supply the shape the guard is
   * for, and a test reading one would assert against whatever the recording
   * happens to hold — and would have to be rewritten again the next time a
   * fixture is corrected towards what the instances actually send. The names
   * below are synthetic for that reason, and both directions are exercised:
   * a list is kept where the answer states no list, and given up where it does.
   */
  const namedFlags = ["freeleech", "halfleech"];

  function scannedWithFlags(flags: unknown): Record<string, unknown> {
    return { ...(sonarr.candidates[0] as Record<string, unknown>), indexerFlags: flags };
  }

  async function reDecidedFlags(
    scanned: unknown,
    answered: unknown,
  ): Promise<readonly string[] | undefined> {
    const running = instance({
      scan: [scannedWithFlags(scanned)],
      decided: [{ ...reDecided(), indexerFlags: answered }],
    });
    const result = await reprocessCandidate(
      running.client,
      "sonarr",
      { sourceKind: "tracked_download", queueItemId: 502, mediaId: 12 },
      fileIdentity(cleanFile),
      {},
    );

    if (result.status !== "ok") {
      throw new Error(`Expected a re-decided candidate, got ${result.status}`);
    }
    return result.candidate.indexerFlags;
  }

  it.each([
    { answered: 0, named: "a bitfield" },
    { answered: null, named: "nothing at all" },
  ])(
    "keeps the flag names the scan stated where the answer states $named",
    async ({ answered }) => {
      expect(await reDecidedFlags(namedFlags, answered)).toEqual(namedFlags);
    },
  );

  it("takes the flag names the answer states, where it states a list", async () => {
    // The other half, so the guard above is what keeps the scan's names rather
    // than an adapter that never reads the answer's flags at all.
    expect(await reDecidedFlags(namedFlags, ["halfleech"])).toEqual(["halfleech"]);
  });

  it("keeps what the scan stated over a default the answer echoes", async () => {
    // Sonarr answers `releaseType: "unknown"` for a file its own scan called a
    // single episode, so taking the answer's word would have the same file
    // report a type when it is inspected and no type when it is re-decided —
    // an untrue answer about something this server is holding. The custom
    // formats are held to the same rule: an answer that blanks them would drop
    // a format and a score the scan reported, on every re-decided candidate.
    const scanned = sonarr.candidates[0] as Record<string, unknown>;
    expect(scanned.releaseType).toBe("singleEpisode");
    expect(scanned.customFormats).toEqual([{ id: 2, name: "Example Format" }]);
    expect(scanned.customFormatScore).toBe(25);

    const running = instance({ decided: [reDecided()] });
    const result = await reprocessCandidate(
      running.client,
      "sonarr",
      { sourceKind: "tracked_download", queueItemId: 502, mediaId: 12 },
      fileIdentity(cleanFile),
      {},
    );

    if (result.status !== "ok") {
      throw new Error(`Expected a re-decided candidate, got ${result.status}`);
    }
    // The control: the answer really did state each of these defaults, so the
    // assertions below are about what this adapter chose rather than about
    // what it happened to be given.
    const answered = reDecided();
    expect(answered.releaseType).toBe("unknown");
    expect(answered.customFormats).toEqual([]);
    expect(answered.customFormatScore).toBe(0);

    expect(result.candidate.releaseType).toBe("singleEpisode");
    expect(result.candidate.customFormats).toEqual(["Example Format"]);
    expect(result.candidate.customFormatScore).toBe(25);
  });

  it("still refuses a rejection the answer raised, though it carries no other facts", async () => {
    // The rejection is the one thing this answer does state, and it still stops
    // the import once the call succeeds: completing the file's facts from the
    // scan settles what the answer omits and decides nothing it reported.
    const running = instance({
      decided: [
        reDecided([{ reason: "Not an upgrade for existing episode file(s)", type: "permanent" }]),
      ],
    });

    const result = await validateForImport(running.client, "sonarr", {
      retained: retainedFor({ importable: false }),
      patch: {},
      destination: "/media/example/series",
    });

    expect(result).toMatchObject({ status: "refused", refusal: { kind: "rejected" } });
    if (result.status === "refused" && result.refusal.kind === "rejected") {
      expect(result.refusal.rejections).toHaveLength(1);
    }
  });
});

describe("what blocks an import", () => {
  it("treats every rejection as blocking, whatever its type", async () => {
    const running = instance({ decided: [sonarr.candidates[1] as Record<string, unknown>] });
    const result = await reprocessCandidate(
      running.client,
      "sonarr",
      { sourceKind: "tracked_download", queueItemId: 502, mediaId: 12 },
      fileIdentity(cleanFile),
      {},
    );
    if (result.status !== "ok") {
      throw new Error("Expected a re-decided candidate");
    }

    // A permanent rejection will not pass on a retry and a temporary one does
    // not pass now, so the question "may this import start" has one answer.
    expect(blockingRejections(result.candidate)).toHaveLength(1);
    expect(isImportable(result.candidate)).toBe(false);
  });

  it("names each retained fact that moved, and nothing that did not", () => {
    const current = {
      context: retainedFor({ sizeBytes: 42, importable: false }),
    } as unknown as ImportCandidate;

    expect(staleFacts(retainedFor(), current)).toEqual(["size", "importable"]);
    // The same facts unchanged move nothing, so a plan does not expire for
    // having been re-read.
    expect(
      staleFacts(retainedFor(), { context: retainedFor() } as unknown as ImportCandidate),
    ).toEqual([]);
  });

  it("compares every retained mapping field, including the ones no number stands for", () => {
    const retained = retainedFor({
      selected: { quality: "Bluray-1080p", languages: ["English"], releaseGroup: "ExampleGroup" },
    });
    const changed = (selected: Record<string, unknown>) =>
      ({
        context: retainedFor({ selected: selected as never }),
      }) as unknown as ImportCandidate;

    // Retaining and fingerprinting these without comparing them would have been
    // half a guarantee: the reference would say which quality it was bound to
    // and nothing would check that the import used it.
    expect(
      staleFacts(
        retained,
        changed({ quality: "WEBDL-720p", languages: ["English"], releaseGroup: "ExampleGroup" }),
      ),
    ).toEqual(["quality"]);
    expect(
      staleFacts(
        retained,
        changed({ quality: "Bluray-1080p", languages: ["French"], releaseGroup: "ExampleGroup" }),
      ),
    ).toEqual(["languages"]);
    expect(
      staleFacts(
        retained,
        changed({ quality: "Bluray-1080p", languages: ["English"], releaseGroup: "Other" }),
      ),
    ).toEqual(["release group"]);
    // And the queue row's own association, which a refiled download moves.
    expect(
      staleFacts(retained, {
        context: retainedFor({ selected: retained.selected, queueMediaId: 13 }),
      } as unknown as ImportCandidate),
    ).toEqual(["queue association"]);
  });

  it("holds a newly retained value to the same rule the schema enforces", async () => {
    // A queue row reporting zero as its association is how both applications
    // say "none". An adapter laxer than the schema here would produce a
    // candidate that could never be named, and the failure would be silent.
    const running = instance();
    const result = await reprocessCandidate(
      running.client,
      "sonarr",
      { sourceKind: "tracked_download", queueItemId: 503, mediaId: 0 },
      fileIdentity(cleanFile),
      {},
    );

    if (result.status === "ok") {
      const queueMediaId = result.candidate.context.queueMediaId;
      expect(queueMediaId === undefined || queueMediaId > 0).toBe(true);
    }
    // And a label that is empty never reaches the retained selection, because
    // the rule the reference schema enforces is the one the adapter applies.
    expect(isRetainedLabel("")).toBe(false);
    expect(isRetainedLabel("Bluray-1080p")).toBe(true);
  });

  it("compares languages by their members rather than by their order", () => {
    const retained = retainedFor({ selected: { languages: ["English", "French"] } });
    const reordered = {
      context: retainedFor({ selected: { languages: ["French", "English"] } }),
    } as unknown as ImportCandidate;

    // The same order the fingerprint uses, so a digest and a comparison cannot
    // disagree about what the same languages are.
    expect(staleFacts(retained, reordered)).toEqual([]);
  });

  it("compares an episode set by its members rather than by their order", () => {
    const before = retainedFor({ episodeIds: [1001, 1004] });
    const after = {
      context: retainedFor({ episodeIds: [1004, 1001] }),
    } as unknown as ImportCandidate;

    expect(staleFacts(before, after)).toEqual([]);
  });
});

describe("free space", () => {
  it("chooses the mount the file would land on, and answers in bytes", async () => {
    const running = instance();
    const fits = await checkFreeSpace(running.client, "sonarr", "/media/example/series", 1_000);

    expect(fits.status).toBe("sufficient");
    expect(fits.requiredBytes).toBe(1_000);
    expect(fits.freeBytes).toBeGreaterThan(0);
    // The mount is not named: what a caller needs is whether it fits.
    expect(JSON.stringify(fits)).not.toContain("/media");
  });

  it("matches a mount on a path component rather than on a prefix", async () => {
    const running = instance({
      diskspace: [{ path: "/media", freeSpace: 5_000, totalSpace: 9_000 }],
    });

    // `/media` is not the mount for `/media2`: it is a different disk, and
    // reading its free space would approve an import against somewhere the
    // file will never be written.
    expect(await checkFreeSpace(running.client, "sonarr", "/media2/example", 1_000)).toMatchObject({
      status: "unknown",
    });
    expect(await checkFreeSpace(running.client, "sonarr", "/media/example", 1_000)).toMatchObject({
      status: "sufficient",
    });
    // The mount itself is under itself.
    expect(await checkFreeSpace(running.client, "sonarr", "/media", 1_000)).toMatchObject({
      status: "sufficient",
    });
  });

  it("prefers the longest matching mount over the root it sits under", async () => {
    const running = instance({
      diskspace: [
        { path: "/media", freeSpace: 10, totalSpace: 100 },
        { path: "/media/example/series", freeSpace: 5_000, totalSpace: 9_000 },
      ],
    });

    // The nested mount is the one the file lands on, and reading the root
    // instead would report ten bytes free for a disk with five thousand.
    expect(
      await checkFreeSpace(running.client, "sonarr", "/media/example/series/Example", 1_000),
    ).toMatchObject({ status: "sufficient", freeBytes: 5_000 });
  });

  it("reports too little room rather than rounding it up", async () => {
    const running = instance({
      diskspace: [{ path: "/media", freeSpace: 999, totalSpace: 100_000 }],
    });

    expect(await checkFreeSpace(running.client, "sonarr", "/media/example", 1_000)).toMatchObject({
      status: "insufficient",
      freeBytes: 999,
      requiredBytes: 1_000,
    });
  });

  it("reports unknown where nothing was checked rather than passing", async () => {
    const running = instance({ diskspace: [] });

    // A precondition nobody could check has not been met, so it does not pass.
    expect(await checkFreeSpace(running.client, "sonarr", "/media/example", 1_000)).toMatchObject({
      status: "unknown",
    });
    expect(
      await checkFreeSpace(running.client, "sonarr", "/media/example", undefined),
    ).toMatchObject({ status: "unknown" });
  });
});

describe("validating immediately before an import", () => {
  it("re-runs reprocessing and passes a candidate the instance still accepts", async () => {
    const running = instance();
    const result = await validateForImport(running.client, "sonarr", {
      retained: retainedFor(),
      patch: {},
      destination: "/media/example/series",
    });

    if (result.status !== "ok") {
      throw new Error(`Expected a validation, got ${result.refusal.kind}`);
    }
    // The candidate it carries is the one the instance decided now, not the one
    // that was inspected earlier — a validation that trusted the retained
    // candidate would be checking a memory.
    expect(result.validation.candidate.decision.importable).toBe(true);
    expect(result.validation.space.status).toBe("sufficient");
    expect(running.posted).toHaveLength(1);
  });

  /**
   * A reprocess answered the way Sonarr 4.0.19.2979 answers one.
   *
   * The decision depends on the element: the same file and the same corrected
   * series come back importable when the element names episodes and carry a
   * **permanent** rejection when it names none. That asymmetry is the whole
   * upstream guard this path relies on, so the double states it rather than
   * answering the same thing whatever it is sent.
   */
  function decidedFromElement(element: Record<string, unknown>): Record<string, unknown> {
    const named = Array.isArray(element.episodeIds) ? element.episodeIds : [];
    return reprocessAnswer(
      element,
      named.length === 0 ? [{ reason: "Episodes not selected", type: "permanent" }] : [],
    );
  }

  it("refuses a mapping moved to another media rather than importing it there", async () => {
    const running = instance({ decide: decidedFromElement });

    // The reference stands for a file the caller moved to another series and
    // named no episodes for, which is what a media-only correction leaves: the
    // episodes the scan found belong to the series the file was moved off.
    const result = await validateForImport(running.client, "sonarr", {
      retained: retainedFor({ mediaId: 13, episodeIds: undefined, importable: false }),
      patch: { mediaId: 13 },
      destination: "/media/example/series",
    });

    // The element carried the corrected series and neither the scan's episodes
    // nor its season, so the instance answered with its own permanent rejection
    // — and the rejection guard stopped there. Nothing was submitted: this is
    // the gate every import passes through before a command is built.
    const sent = running.posted[0];
    expect(sent?.seriesId).toBe(13);
    expect(sent).not.toHaveProperty("episodeIds");
    expect(sent).not.toHaveProperty("seasonNumber");
    expect(result).toMatchObject({ status: "refused", refusal: { kind: "rejected" } });
    if (result.status === "refused" && result.refusal.kind === "rejected") {
      expect(result.refusal.rejections.map((rejection) => rejection.reason)).toEqual([
        "Episodes not selected",
      ]);
    }
  });

  it("passes the same moved mapping once the caller names episodes for it", async () => {
    // The control, on the same double: the guard is about a mapping nobody
    // completed rather than about correcting the media, which stays allowed.
    const running = instance({ decide: decidedFromElement });

    const result = await validateForImport(running.client, "sonarr", {
      retained: retainedFor({ mediaId: 13, episodeIds: [2002], seasonNumber: 1 }),
      patch: { mediaId: 13, episodeIds: [2002] },
      destination: "/media/example/series",
    });

    expect(running.posted[0]).toMatchObject({ seriesId: 13, episodeIds: [2002], seasonNumber: 1 });
    expect(result.status).toBe("ok");
  });

  it("refuses a candidate whose file changed underneath it", async () => {
    // The size moves on the scan, which is the only place either application
    // reports one: a reprocess answer restates the decision and says nothing
    // about the file, so a guard that waited to be told there by the answer
    // would never fire at all.
    const moved = { ...(sonarr.candidates[0] as Record<string, unknown>), size: 17 };
    const running = instance({ scan: [moved], decided: [reDecided()] });

    const result = await validateForImport(running.client, "sonarr", {
      retained: retainedFor(),
      patch: {},
      destination: "/media/example/series",
    });

    expect(result).toMatchObject({ status: "refused", refusal: { kind: "stale" } });
    if (result.status === "refused" && result.refusal.kind === "stale") {
      expect(result.refusal.moved).toEqual(["size"]);
    }
  });

  it("refuses a candidate the instance rejected, whatever the caller asked for", async () => {
    const running = instance({ decided: [sonarr.candidates[1] as Record<string, unknown>] });

    const result = await validateForImport(running.client, "sonarr", {
      retained: retainedFor({
        candidateId: 3002,
        fileIdentity: fileIdentity(rejectedFile),
        sizeBytes: 1_610_612_736,
        seasonNumber: 2,
        episodeIds: undefined,
        importable: false,
        selected: { quality: "WEBDL-720p", languages: ["English"] },
      }),
      patch: {},
      destination: "/media/example/series",
    });

    expect(result).toMatchObject({ status: "refused", refusal: { kind: "rejected" } });
    if (result.status === "refused" && result.refusal.kind === "rejected") {
      expect(result.refusal.rejections).toHaveLength(1);
    }
  });

  it("directs an existing library file elsewhere rather than importing it again", async () => {
    // The file identifier is supplied here rather than recorded: neither Sonarr
    // 4.0.19.2979 nor Radarr 6.3.0.10514 sends one on a manual-import row, so a
    // recorded body carrying it would describe a response no instance produces.
    // The guard still has to hold for a release that does send one.
    const existing = { ...(sonarr.candidates[2] as Record<string, unknown>), episodeFileId: 5001 };
    const running = instance({ scan: [existing], decided: [existing] });

    const result = await validateForImport(running.client, "sonarr", {
      retained: retainedFor({
        candidateId: 3003,
        fileIdentity: fileIdentity(existingFile),
        sizeBytes: 3_006_477_107,
        episodeIds: undefined,
        existingFileId: 5001,
        importable: false,
      }),
      patch: {},
      destination: "/media/example/series",
    });

    // Checked before the rejections, because the remedy differs: this caller is
    // sent to the library-file workflow rather than told to fix a mapping.
    expect(result).toMatchObject({ status: "refused", refusal: { kind: "existing_file" } });
  });

  it("refuses an import whose space could not be established at all", async () => {
    const running = instance({ diskspace: [] });

    const result = await validateForImport(running.client, "sonarr", {
      retained: retainedFor(),
      patch: {},
      destination: "/media/example/series",
    });

    // Not the same as fitting. An unreachable or unreported mount read as room
    // enough is the one reading this check exists to prevent.
    expect(result).toMatchObject({ status: "refused", refusal: { kind: "unverified_space" } });
  });

  it("refuses an import the destination has no room for", async () => {
    const running = instance({
      diskspace: [{ path: "/media", freeSpace: 10, totalSpace: 100 }],
    });

    const result = await validateForImport(running.client, "sonarr", {
      retained: retainedFor(),
      patch: {},
      destination: "/media/example/series",
    });

    expect(result).toMatchObject({ status: "refused", refusal: { kind: "no_space" } });
  });

  it("checks the space only for a candidate that passed everything before it", async () => {
    const running = instance({ decided: [sonarr.candidates[1] as Record<string, unknown>] });

    await validateForImport(running.client, "sonarr", {
      retained: retainedFor({
        candidateId: 3002,
        fileIdentity: fileIdentity(rejectedFile),
        sizeBytes: 1_610_612_736,
        seasonNumber: 2,
        episodeIds: undefined,
        importable: false,
        selected: { quality: "WEBDL-720p", languages: ["English"] },
      }),
      patch: {},
      destination: "/media/example/series",
    });

    // A rejected candidate is not going to be imported, so asking the instance
    // how much room it has is a request nobody needed.
    expect(running.calls.some((call) => call.url.pathname.endsWith("/diskspace"))).toBe(false);
  });

  it("refuses a file that is gone without asking anything further about it", async () => {
    const running = instance({ scan: [] });

    const result = await validateForImport(running.client, "sonarr", {
      retained: retainedFor(),
      patch: {},
      destination: "/media/example/series",
    });

    expect(result).toMatchObject({ status: "refused", refusal: { kind: "absent" } });
    // Carried rather than restated: validation reports the same reason the
    // scan does, so a caller is told to re-read the query it came from.
    if (result.status === "refused" && result.refusal.kind === "absent") {
      expect(result.refusal.error.code).toBe("stale_reference");
    }
    expect(running.posted).toEqual([]);
  });
});

describe("disclosure", () => {
  it("carries no canonical path or download identity out of validation", async () => {
    const canary = "CANARY-IMPORT-CORRECTION-0007";
    // Planted in fields the model does not publish. The release group and the
    // size are deliberately not among them: the specification requires both to
    // be disclosed, so a canary there would test whether this test can read the
    // model rather than whether the adapter leaks.
    const planted = {
      ...(sonarr.candidates[0] as Record<string, unknown>),
      outputPath: `${recordedFolder}/${canary}`,
      downloadId: canary,
      folderName: canary,
    };
    const running = instance({ decided: [planted] });

    const result = await validateForImport(running.client, "sonarr", {
      retained: retainedFor(),
      patch: {},
      destination: "/media/example/series",
    });
    const published = JSON.stringify(result);

    // Every value named here is one this test or the fixtures actually put into
    // the answer, in the spelling it appears there.
    expect(published).not.toContain(recordedFolder);
    expect(published).not.toContain("/media/example");
    expect(published).not.toContain("b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1");
    expect(published).not.toContain(canary);

    // The control: the same matchers fire on a payload that carries them, so a
    // green assertion above is evidence rather than a spelling accident.
    const carrying = JSON.stringify({
      folder: recordedFolder,
      file: cleanFile,
      downloadId: "b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1",
      planted: canary,
    });
    expect(carrying).toContain(recordedFolder);
    expect(carrying).toContain("/media/example");
    expect(carrying).toContain("b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1");
    expect(carrying).toContain(canary);

    // And what the specification requires a candidate to disclose is disclosed:
    // asserting only absences would pass on an adapter that returned nothing.
    if (result.status !== "ok") {
      throw new Error(`Expected a validation, got ${result.refusal.kind}`);
    }
    expect(result.validation.candidate.sizeBytes).toBe(3_221_225_472);
    expect(result.validation.candidate.fileIdentity).toHaveLength(16);
    expect(result.validation.candidate.releaseGroup).toBe("ExampleGroup");
    // The file's own name is disclosed and its directory is not, which is the
    // model's rule rather than an accident of this fixture's spelling.
    const fileName = result.validation.candidate.fileName ?? "";
    expect(fileName).toContain("Example Pilot");
    expect(fileName).not.toContain("/");
  });

  it("keeps the upstream row identifiers inside the context a reference is minted from", async () => {
    const running = instance();
    const result = await validateForImport(running.client, "sonarr", {
      retained: retainedFor(),
      patch: {},
      destination: "/media/example/series",
    });
    if (result.status !== "ok") {
      throw new Error(`Expected a validation, got ${result.refusal.kind}`);
    }

    // The candidate a caller is shown and the context a reference is minted
    // from are different objects, and the row identifiers live only in the
    // second. The tool layer publishes the first and never the second.
    const { context, ...shown } = result.validation.candidate;
    expect(context.candidateId).toBe(3001);
    expect(JSON.stringify(shown)).not.toContain("3001");
  });
});
