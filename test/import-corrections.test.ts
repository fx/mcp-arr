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
import type { MediaApplication } from "../src/adapters/library/model.js";
import { activityFixture } from "./support/activity.js";
import { fixtureBody, jsonResponse, libraryHarness, type UpstreamCall } from "./support/library.js";

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

beforeAll(async () => {
  const [candidates, queue, records, diskspace, qualities, languages] = await Promise.all([
    activityFixture<Record<string, unknown>[]>("sonarr", "manualimport"),
    activityFixture<unknown[]>("sonarr", "queue/details"),
    activityFixture<Array<{ id: number }>>("sonarr", "series"),
    fixtureBody("sonarr", "diskspace") as Promise<unknown[]>,
    fixtureBody("sonarr", "qualitydefinition") as Promise<unknown[]>,
    fixtureBody("sonarr", "language") as Promise<unknown[]>,
  ]);
  sonarr = { candidates, queue, records, diskspace, qualities, languages };
});

interface InstanceOptions {
  /** Replaces what the manual-import GET answers, for a file that moved. */
  readonly scan?: Record<string, unknown>[] | undefined;
  /** Replaces what the reprocess POST answers, for a re-decided candidate. */
  readonly decided?: Record<string, unknown>[] | undefined;
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
        const body = JSON.parse(String(call.init.body)) as { files?: Record<string, unknown>[] };
        posted.push(...(body.files ?? []));
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

    // The intermediate patch is not the guarantee — the row that was sent is.
    // This is the one payload in the project that names files on disk, so each
    // correction is checked where it actually lands.
    const sent = running.posted[0];
    expect(sent).toMatchObject({
      series: { id: 13 },
      episodeIds: [1004],
      quality: { quality: { name: "WEBDL-720p" } },
      languages: [{ name: "French" }],
      releaseGroup: "OtherGroup",
    });
    expect(sent?.episodes).toEqual([{ id: 1004 }]);

    // The control: a field the compilation does not produce cannot appear,
    // whatever a caller put in the object it started from. The payload's keys
    // are the instance's own row plus the five corrections and the download
    // identity, so anything else would have come from somewhere it should not.
    const invented = Object.keys(sent ?? {}).filter(
      (key) => !Object.keys(sonarr.candidates[0] ?? {}).includes(key),
    );
    expect(invented.sort()).toEqual(["downloadId", "episodeIds"]);
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

  it("writes each correction over the instance's own row rather than replacing it", async () => {
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
      series: { id: 13 },
      episodeIds: [1004],
      quality: { quality: { name: "WEBDL-720p" } },
      // Untouched by this correction and still present, because these APIs
      // decide from the whole row.
      size: 3_221_225_472,
      id: 3001,
    });
    // The download identity is put back from the re-derived context: it is what
    // ties an import to the queue row, and a scan answer drops it.
    expect(sent?.downloadId).toBe("b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1");
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

  it("refuses a candidate whose file changed underneath it", async () => {
    const moved = { ...(sonarr.candidates[0] as Record<string, unknown>), size: 17 };
    const running = instance({ decided: [moved] });

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
    const running = instance({ decided: [sonarr.candidates[2] as Record<string, unknown>] });

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
