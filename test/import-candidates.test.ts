import { describe, expect, it } from "vitest";
import {
  type CandidateScanResult,
  fileIdentity,
  fileNameOf,
  scanLibraryContext,
  scanTrackedDownload,
} from "../src/adapters/import/candidates.js";
import type { ImportCandidate } from "../src/adapters/import/model.js";
import type { MediaApplication } from "../src/adapters/library/model.js";
import type { PageWindow } from "../src/adapters/library/paging.js";
import { createManualClock } from "../src/state/clock.js";
import { createReferenceStore } from "../src/state/references.js";
import {
  type CandidateDetail,
  fingerprintFor,
  isNameableCandidate,
  mintCandidateReference,
  resolveCandidateReference,
} from "../src/tools/import-references.js";
import { activityFixture } from "./support/activity.js";
import { jsonResponse, libraryHarness, type UpstreamCall } from "./support/library.js";

/**
 * Manual-import candidate discovery.
 *
 * The subject of every assertion below is the same one: a candidate is a file
 * on the operator's disk, and nothing this surface produces may say where it
 * is. The scanners read the canonical path and the download-client identifier
 * on purpose — they are what the upstream endpoint is asked with — so the tests
 * check both halves: that the request carried them, and that nothing that comes
 * back does.
 */

interface Scanned {
  readonly result: CandidateScanResult;
  readonly calls: readonly UpstreamCall[];
}

/**
 * One instance answering every route a scan touches.
 *
 * The scanners are reached only through their own entry points now, so a test
 * drives the whole path — the queue row or library record first, then the
 * manual-import endpoint — which is also the only way to observe that the
 * folder and the download identity came from upstream rather than from an
 * argument.
 */
async function instance(application: MediaApplication) {
  const [candidates, queue, records] = await Promise.all([
    activityFixture<unknown[]>(application, "manualimport"),
    activityFixture<unknown[]>(application, "queue/details"),
    activityFixture<Array<{ id: number }>>(
      application,
      application === "sonarr" ? "series" : "movie",
    ),
  ]);

  return (call: UpstreamCall): Response => {
    const path = call.url.pathname;
    if (path.endsWith("/manualimport")) {
      return jsonResponse(candidates);
    }
    if (path.endsWith("/queue/details")) {
      return jsonResponse(queue);
    }
    const single = /\/(?:series|movie)\/(\d+)$/u.exec(path);
    if (single !== null) {
      return jsonResponse(records.find((record) => record.id === Number(single[1])));
    }
    return jsonResponse({ message: "unexpected route" }, 404);
  };
}

/** A window wide enough to hold the recorded folders, unless a test narrows it. */
const wholeFolder = { offset: 0, pageSize: 25 } as const;

async function scanTracked(
  application: MediaApplication,
  request: { queueItemId: number; mediaId?: number },
  window: PageWindow = wholeFolder,
): Promise<Scanned> {
  const harness = libraryHarness(application, await instance(application));
  const result = await scanTrackedDownload(harness.client, application, request, window);
  return { result, calls: harness.calls };
}

async function scanLibrary(
  application: MediaApplication,
  request: { mediaId: number; seasonNumber?: number },
  window: PageWindow = wholeFolder,
): Promise<Scanned> {
  const harness = libraryHarness(application, await instance(application));
  const result = await scanLibraryContext(harness.client, application, request, window);
  return { result, calls: harness.calls };
}

function candidatesOf(scanned: Scanned): readonly ImportCandidate[] {
  if (scanned.result.status !== "ok") {
    throw new Error(`Expected a scan, got ${scanned.result.status}`);
  }
  return scanned.result.scan.items;
}

/** The recorded Sonarr download this suite scans, and its own identifiers. */
const trackedRequest = { queueItemId: 502, mediaId: 12 } as const;
const libraryRequest = { mediaId: 8 } as const;
const recordedDownloadId = "b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1";
const recordedFolder = "/media/example/downloads/complete/example-series";

describe("candidate scan context", () => {
  it("takes a tracked download's location from its queue row, not from a caller", async () => {
    const { result, calls } = await scanTracked("sonarr", trackedRequest);
    expect(result.status).toBe("ok");

    // The queue row is read first, scoped by the media association the queue
    // reference retained, and what it reported is what the scan was asked with.
    expect(calls[0]?.url.pathname).toBe("/api/v3/queue/details");
    expect(calls[0]?.url.searchParams.get("seriesId")).toBe("12");
    expect(calls[1]?.url.pathname).toBe("/api/v3/manualimport");
    expect(calls[1]?.url.searchParams.get("downloadId")).toBe(recordedDownloadId);
    expect(calls[1]?.url.searchParams.get("folder")).toBe(recordedFolder);
  });

  it("reports a row that is gone and one that names no location differently", async () => {
    expect((await scanTracked("sonarr", { queueItemId: 9999 })).result.status).toBe("absent");
    // The pending release in the recorded queue reports neither an output path
    // nor a download identifier, because nothing has been downloaded for it.
    expect((await scanTracked("sonarr", { queueItemId: 503 })).result.status).toBe("unmapped");
  });

  it("takes a library context's folder from the record rather than the caller", async () => {
    const { result, calls } = await scanLibrary("radarr", libraryRequest);
    expect(result.status).toBe("ok");

    expect(calls[0]?.url.pathname).toBe("/api/v3/movie/8");
    expect(calls[1]?.url.searchParams.get("folder")).toBe(
      "/media/example/movies/Example Movie (2021)",
    );
    expect(calls[1]?.url.searchParams.get("movieId")).toBe("8");
    // A library scan is not a download scan, so it carries no download identity.
    expect(calls[1]?.url.searchParams.get("downloadId")).toBeNull();
  });
});

describe("candidate mapping", () => {
  it("asks the instance for existing files as well as new ones", async () => {
    const { calls } = await scanTracked("sonarr", trackedRequest);
    const scan = calls[1];

    expect(scan?.url.pathname).toBe("/api/v3/manualimport");
    // Existing library files have to come back, because the specification
    // requires them to be distinguishable rather than hidden.
    expect(scan?.url.searchParams.get("filterExistingFiles")).toBe("false");
  });

  it("scopes a library scan to the record it was asked for", async () => {
    const { calls } = await scanLibrary("radarr", libraryRequest);

    expect(calls[1]?.url.searchParams.get("movieId")).toBe("8");
    expect(calls[1]?.url.searchParams.get("downloadId")).toBeNull();
  });

  it("maps the mapping, the file identity, and the structured rejections", async () => {
    const candidates = candidatesOf(await scanTracked("sonarr", trackedRequest));

    expect(candidates).toHaveLength(3);
    const [mapped, unmapped, existing] = candidates;

    expect(mapped?.fileName).toBe("Example Series - S01E01 - Example Pilot Bluray-1080p.mkv");
    expect(mapped?.media).toEqual({ application: "sonarr", kind: "series", id: "12" });
    expect(mapped?.episodes).toEqual([{ application: "sonarr", kind: "episode", id: "1001" }]);
    expect(mapped?.seasonNumber).toBe(1);
    expect(mapped?.quality).toMatchObject({ name: "Bluray-1080p", resolution: 1080, proper: true });
    expect(mapped?.languages).toEqual(["English"]);
    expect(mapped?.customFormats).toEqual(["Example Format"]);
    expect(mapped?.customFormatScore).toBe(25);
    expect(mapped?.indexerFlags).toEqual(["freeleech"]);
    expect(mapped?.decision).toEqual({ importable: true, rejections: [] });
    expect(mapped?.existingLibraryFile).toBe(false);

    // A season-pack file the instance could not map to an episode: no episodes,
    // and a permanent rejection that says why.
    expect(unmapped?.episodes).toBeUndefined();
    expect(unmapped?.decision.importable).toBe(false);
    expect(unmapped?.decision.rejections[0]?.type).toBe("permanent");
    expect(unmapped?.quality?.repack).toBe(true);

    // A file the library already holds is distinguished from a new import.
    expect(existing?.existingLibraryFile).toBe(true);
    expect(existing?.context.existingFileId).toBe(5001);
    expect(existing?.decision.rejections[0]?.type).toBe("temporary");
  });

  it("returns a bounded page and says when the folder holds more", async () => {
    // A folder is not a bound: a library context can hold arbitrarily many
    // files, so the answer is a page like every other collection this server
    // returns, and one that stopped early says so.
    const narrow = await scanTracked("sonarr", trackedRequest, { offset: 0, pageSize: 2 });
    if (narrow.result.status !== "ok") {
      throw new Error("Expected a scan");
    }
    expect(narrow.result.scan.items).toHaveLength(2);
    expect(narrow.result.scan.hasMore).toBe(true);

    const second = await scanTracked("sonarr", trackedRequest, { offset: 2, pageSize: 2 });
    if (second.result.status !== "ok") {
      throw new Error("Expected a scan");
    }
    expect(second.result.scan.items).toHaveLength(1);
    expect(second.result.scan.hasMore).toBe(false);
    // The second page continues the first rather than repeating it.
    expect(second.result.scan.items[0]?.fileIdentity).not.toBe(
      narrow.result.scan.items[0]?.fileIdentity,
    );
  });

  it("reports files it could not identify rather than dropping them silently", async () => {
    const rows = await activityFixture<Array<Record<string, unknown>>>("sonarr", "manualimport");
    const queue = await activityFixture<unknown[]>("sonarr", "queue/details");
    // A row the instance returned with no path at all cannot be fingerprinted,
    // so it is not a candidate — and a page that quietly held one fewer item
    // would be a short answer with no reason attached.
    const laced = [...rows, { id: 3999, size: 1024, rejections: [] }];
    const harness = libraryHarness("sonarr", (call) =>
      jsonResponse(call.url.pathname.endsWith("/manualimport") ? laced : queue),
    );
    const scanned = await scanTrackedDownload(harness.client, "sonarr", trackedRequest, {
      offset: 0,
      pageSize: 25,
    });
    if (scanned.status !== "ok") {
      throw new Error("Expected a scan");
    }

    expect(scanned.scan.items).toHaveLength(3);
    expect(scanned.scan.unmappable).toBe(1);
    expect(scanned.scan.warnings?.join(" ")).toContain("no path to identify them");
  });

  it("bounds the traversal itself, not an already-mapped copy of it", async () => {
    // Five thousand rows the instance cannot identify, followed by one it can.
    // Mapping before the ceiling applied would have mapped all 5,001; the
    // ceiling is on the traversal, so the run stops inside it and says so.
    const queue = await activityFixture<unknown[]>("sonarr", "queue/details");
    const rows = await activityFixture<Array<Record<string, unknown>>>("sonarr", "manualimport");
    const flood = [
      ...Array.from({ length: 5_000 }, (_unused, index) => ({
        id: 100_000 + index,
        size: 1024,
        rejections: [],
      })),
      rows[0],
    ];
    const harness = libraryHarness("sonarr", (call) =>
      jsonResponse(call.url.pathname.endsWith("/manualimport") ? flood : queue),
    );

    const scanned = await scanTrackedDownload(harness.client, "sonarr", trackedRequest, {
      offset: 0,
      pageSize: 25,
    });
    if (scanned.status !== "ok") {
      throw new Error("Expected a scan");
    }

    // The identifiable row sits past the ceiling, so it is not reached, and the
    // answer says the folder was only partly examined rather than reporting an
    // empty one.
    expect(scanned.scan.items).toHaveLength(0);
    expect(scanned.scan.warnings?.join(" ")).toContain("were examined");
    expect(scanned.scan.unmappable).toBe(5_000);
  });

  it("maps a Radarr scan, including a rejected sample with no media mapping", async () => {
    const candidates = candidatesOf(await scanLibrary("radarr", libraryRequest));

    const [movie, sample] = candidates;
    expect(movie?.media).toEqual({ application: "radarr", kind: "movie", id: "8" });
    expect(movie?.episodes).toBeUndefined();
    expect(movie?.sizeBytes).toBe(21474836480);
    expect(movie?.decision.importable).toBe(true);

    expect(sample?.media).toBeUndefined();
    expect(sample?.decision.importable).toBe(false);
    expect(sample?.decision.rejections.map((rejection) => rejection.reason)).toContain(
      "Sample file",
    );
  });

  it("gives the same file the same identity and different files different ones", async () => {
    const first = candidatesOf(await scanTracked("sonarr", trackedRequest));
    const second = candidatesOf(await scanTracked("sonarr", trackedRequest));

    expect(first[0]?.fileIdentity).toBe(second[0]?.fileIdentity);
    expect(first[0]?.fileIdentity).not.toBe(first[1]?.fileIdentity);
    // A digest, not a path: sixteen hexadecimal characters and nothing else.
    expect(first[0]?.fileIdentity).toMatch(/^[0-9a-f]{16}$/u);
  });

  it("keeps every directory above the file out of its name", () => {
    expect(fileNameOf("/media/example/series/Example/Season 01/file.mkv")).toBe("file.mkv");
    expect(fileNameOf("C:\\Media\\Example\\file.mkv")).toBe("file.mkv");
    expect(fileNameOf("file.mkv")).toBe("file.mkv");
    expect(fileNameOf(null)).toBeUndefined();
    // A name that still carries a separator after the last one is cut — which a
    // real path cannot produce, but a hostile one might — is redacted by the
    // sanitizer rather than disclosed.
    expect(fileNameOf("odd/name\\file.mkv")).toBe("file.mkv");
  });
});

describe("candidate disclosure", () => {
  it("returns nothing a caller could locate the file with", async () => {
    const sonarr = candidatesOf(await scanTracked("sonarr", trackedRequest));
    const radarr = candidatesOf(await scanLibrary("radarr", libraryRequest));
    const serialized = JSON.stringify([sonarr, radarr]);

    // Read out of the recording rather than written here, so the assertion
    // cannot stop naming what the instance actually serves.
    const rows = [
      ...(await activityFixture<Array<Record<string, unknown>>>("sonarr", "manualimport")),
      ...(await activityFixture<Array<Record<string, unknown>>>("radarr", "manualimport")),
    ];
    const paths = rows.map((row) => String(row.path));
    const folders = rows.map((row) => String(row.folderName));
    const names = rows.map((row) => String(row.relativePath));

    // A control: the same matchers fire on a payload that does carry these.
    const leaked = JSON.stringify({ path: paths[0], folderName: folders[0] });
    expect(leaked).toContain(paths[0]);
    expect(leaked).toContain("/media/example");

    for (const path of paths) {
      expect(serialized).not.toContain(path);
    }
    // A folder name is only assertable textually when it is not also part of a
    // legitimate file name: the Radarr download folder is "Example Movie
    // (2021)", which every file under it is named after. Those are covered by
    // the structural assertion below instead, which is the stronger check
    // anyway — it holds whatever the folder happens to be called.
    const distinctive = folders.filter((folder) => !names.some((name) => name.includes(folder)));
    expect(distinctive.length).toBeGreaterThan(0);
    for (const folder of distinctive) {
      expect(serialized).not.toContain(folder);
    }
    expect(serialized).not.toContain("/media/example");
    expect(serialized).not.toContain("/downloads");
    expect(serialized).not.toContain(recordedDownloadId);
    // The relative path carries the directory chain inside the download folder,
    // which is a location too.
    expect(serialized).not.toContain("Season 02/");

    // A structural assertion beside the textual ones, because some of these
    // words legitimately occur in a title or a file name: no mapped candidate
    // may carry a field that could hold a location at all, whatever it says.
    const forbidden = ["path", "relativePath", "folderName", "outputPath", "downloadId"];
    for (const candidate of [...sonarr, ...radarr]) {
      for (const field of forbidden) {
        expect(Object.hasOwn(candidate, field), field).toBe(false);
        expect(Object.hasOwn(candidate.context, field), `context.${field}`).toBe(false);
      }
    }
  });

  it("scrubs every upstream label, not only the free-text ones", async () => {
    // A custom format, a language, and an indexer flag are all names somebody
    // chose, so any of them can carry a path or an identifier. They are
    // sanitized rather than merely trimmed, which a normalizing list helper
    // would not have done.
    const canaryPath = "/media/private/secret-library/file.mkv";
    // A Windows path, which nothing but the sanitizer removes — and short
    // enough that the generic identifier rule would not have caught it, so the
    // assertion proves these lists are scrubbed rather than proving the
    // redactor works.
    const canaryWindows = "D:\\Secret\\file.mkv";
    const rows = await activityFixture<Array<Record<string, unknown>>>("sonarr", "manualimport");
    const laced = rows.map((row, index) =>
      index === 0
        ? {
            ...row,
            customFormats: [
              { id: 9, name: canaryPath },
              { id: 10, name: "Example Format" },
            ],
            languages: [{ id: 1, name: canaryWindows }],
            indexerFlags: [canaryPath, "freeleech"],
          }
        : row,
    );
    const queue = await activityFixture<unknown[]>("sonarr", "queue/details");
    const harness = libraryHarness("sonarr", (call) =>
      jsonResponse(call.url.pathname.endsWith("/manualimport") ? laced : queue),
    );
    const scanned = await scanTrackedDownload(harness.client, "sonarr", trackedRequest, {
      offset: 0,
      pageSize: 25,
    });
    if (scanned.status !== "ok") {
      throw new Error(`Expected a scan, got ${scanned.status}`);
    }
    const serialized = JSON.stringify(scanned.scan.items);

    // A control, so the assertions below cannot pass for the wrong reason.
    // The control reads the laced values back off the payload itself rather
    // than off its serialization, because JSON escapes a backslash and the
    // escaped spelling is not the value.
    const lacedFirst = laced[0] as { languages: Array<{ name: string }> };
    expect(lacedFirst.languages[0]?.name).toBe(canaryWindows);
    expect(JSON.stringify(laced)).toContain(canaryPath);

    expect(serialized).not.toContain(canaryPath);
    // Both spellings of the Windows path: as written, and as JSON renders it.
    expect(serialized).not.toContain(canaryWindows);
    expect(serialized).not.toContain(JSON.stringify(canaryWindows).slice(1, -1));
    expect(serialized).not.toContain("Secret");
    expect(serialized).not.toContain("/media/private");
    // What was not a path survives, so the scrubbing is not simply dropping the
    // fields.
    expect(scanned.scan.items[0]?.customFormats).toEqual(["Example Format"]);
    expect(scanned.scan.items[0]?.indexerFlags).toEqual(["freeleech"]);
  });

  it("removes a folder name a rejection mentions in prose", async () => {
    // The generic sanitizer knows about separators and long identifiers, which
    // is everything it can know on its own. A rejection naming the folder in
    // prose carries neither, and only the adapter knows what this scan's folder
    // was called — so it is removed literally, before the generic pass.
    const queue = await activityFixture<unknown[]>("sonarr", "queue/details");
    const rows = await activityFixture<Array<Record<string, unknown>>>("sonarr", "manualimport");
    const laced = rows.map((row, index) =>
      index === 0
        ? {
            ...row,
            rejections: [{ reason: "Could not import folder example-series", type: "permanent" }],
          }
        : row,
    );
    const harness = libraryHarness("sonarr", (call) =>
      jsonResponse(call.url.pathname.endsWith("/manualimport") ? laced : queue),
    );
    const scanned = await scanTrackedDownload(harness.client, "sonarr", trackedRequest, {
      offset: 0,
      pageSize: 25,
    });
    if (scanned.status !== "ok") {
      throw new Error("Expected a scan");
    }

    const reason = scanned.scan.items[0]?.decision.rejections[0]?.reason ?? "";
    expect(reason).toContain("Could not import folder");
    expect(reason).not.toContain("example-series");
  });

  it("scrubs a rejection that quotes the path it objected to", async () => {
    const candidates = candidatesOf(await scanTracked("sonarr", trackedRequest));
    const reason = candidates[1]?.decision.rejections[0]?.reason ?? "";

    expect(reason).toContain("Unable to parse episode");
    expect(reason).not.toContain("/media/example");
    expect(reason).not.toContain("example-series");
    // Removed rather than deleted, so a reader can see something was taken out.
    expect(reason).toMatch(/\[redacted/u);
  });
});

describe("candidate references", () => {
  function store() {
    return createReferenceStore({ clock: createManualClock(1_000) });
  }

  async function firstCandidate(): Promise<ImportCandidate> {
    const candidates = candidatesOf(await scanTracked("sonarr", trackedRequest));
    const candidate = candidates[0];
    if (candidate === undefined) {
      throw new Error("The recorded scan produced no candidate");
    }
    return candidate;
  }

  it("mints an opaque reference that carries no path", async () => {
    const references = store();
    const candidate = await firstCandidate();
    const reference = mintCandidateReference(references, candidate);

    expect(reference).toMatch(/^imp_/u);
    expect(reference).not.toContain("media");
    // Nothing in the stored entry either: the reference is resolved by lookup,
    // and what it looks up must be as free of locations as what it answers.
    const entry = references.resolve(reference as string, "import_candidate");
    expect(JSON.stringify(entry)).not.toContain("/media/example");
    expect(JSON.stringify(entry)).not.toContain(recordedDownloadId);
  });

  it("resolves back into the context a later step needs", async () => {
    const references = store();
    const candidate = await firstCandidate();
    const reference = mintCandidateReference(references, candidate) as string;

    const resolved = resolveCandidateReference(references, reference, "sonarr");
    if (!resolved.ok) {
      throw new Error(`Expected the reference to resolve: ${resolved.error.message}`);
    }
    expect(resolved.value).toMatchObject({
      application: "sonarr",
      sourceKind: "tracked_download",
      candidateId: 3001,
      queueItemId: 502,
      mediaId: 12,
      seasonNumber: 1,
      episodeIds: [1001],
      fileIdentity: candidate.fileIdentity,
    });
  });

  it("refuses a candidate it cannot name without writing anything", async () => {
    const references = store();
    const candidate = await firstCandidate();
    const before = references.size();

    // Everything is checked before minting, so a candidate this module cannot
    // describe leaves no entry behind that nothing could resolve.
    const unnameable: readonly ImportCandidate[] = [
      { ...candidate, fileIdentity: "" },
      // The whole reason the identity is held to the digest shape: a path
      // standing where a digest belongs would otherwise be stored verbatim.
      { ...candidate, fileIdentity: "/media/example/downloads/complete/file.mkv" },
      { ...candidate, fileIdentity: candidate.fileIdentity.toUpperCase() },
      // A tracked candidate with no queue row cannot be re-read later, so it is
      // not nameable either.
      { ...candidate, context: { ...candidate.context, queueItemId: undefined } },
    ];

    for (const rejected of unnameable) {
      expect(isNameableCandidate(rejected)).toBe(false);
      expect(mintCandidateReference(references, rejected)).toBeUndefined();
    }
    expect(references.size()).toBe(before);

    // A library-context candidate is nameable on the record its scan was
    // scoped to instead, which is a different fact from the media its mapping
    // proposes — an unmapped file under a movie's folder has the first and not
    // the second.
    expect(
      isNameableCandidate({
        ...candidate,
        sourceKind: "library_context",
        context: {
          ...candidate.context,
          sourceKind: "library_context",
          queueItemId: undefined,
          scanMediaId: 12,
        },
      }),
    ).toBe(true);
  });

  it("mints nothing it could not resolve", async () => {
    // The rule each retained field is held to is one rule, read by both sides.
    // A field that would fail on the way out has to fail on the way in, or the
    // store ends up holding a reference nothing can ever resolve.
    const references = store();
    const candidate = await firstCandidate();
    const before = references.size();

    const invalidClasses: readonly [string, ImportCandidate][] = [
      ["queue item zero", { ...candidate, context: { ...candidate.context, queueItemId: 0 } }],
      ["candidate zero", { ...candidate, context: { ...candidate.context, candidateId: 0 } }],
      // The mapping the caller was shown is what gets stored, so this is the
      // field that has to be refused rather than the context's copy of it.
      [
        "mapped media zero",
        {
          ...candidate,
          media: { application: "sonarr" as const, kind: "series" as const, id: "0" },
        },
      ],
      ["scan media zero", { ...candidate, context: { ...candidate.context, scanMediaId: 0 } }],
      // The season the caller was shown, for the same reason as the mapping:
      // the context's copy is not what gets stored.
      ["negative season", { ...candidate, seasonNumber: -1 }],
      [
        "episode zero",
        {
          ...candidate,
          episodes: [{ application: "sonarr" as const, kind: "episode" as const, id: "0" }],
        },
      ],
      ["negative size", { ...candidate, sizeBytes: -1 }],
      [
        "existing file zero",
        {
          ...candidate,
          existingLibraryFile: true,
          context: { ...candidate.context, existingFileId: 0 },
        },
      ],
      // The kind is recorded twice on a candidate and stored once on the
      // reference, so the two have to agree: minting one as tracked while
      // validating it as a library context is a reference that mints and then
      // refuses to resolve.
      [
        "disagreeing scan kinds",
        {
          ...candidate,
          sourceKind: "tracked_download",
          context: {
            ...candidate.context,
            sourceKind: "library_context",
            queueItemId: undefined,
            scanMediaId: 12,
          },
        },
      ],
    ];

    for (const [label, rejected] of invalidClasses) {
      expect(isNameableCandidate(rejected), label).toBe(false);
      expect(mintCandidateReference(references, rejected), label).toBeUndefined();
    }
    expect(references.size()).toBe(before);
  });

  /**
   * Writes an otherwise-valid snapshot with one thing changed.
   *
   * The fingerprint is recomputed from the detail unless the test is about the
   * fingerprint itself, which is what makes each of these prove the rule it
   * names: leaving a stale digest in place would refuse every case for that one
   * reason and prove nothing about the field under test.
   */
  function corrupt(
    references: ReturnType<typeof store>,
    reference: string,
    detail: Record<string, unknown>,
    overrides: Record<string, unknown> = {},
  ): void {
    references.update(reference, "import_candidate", {
      kind: "domain",
      snapshot: {
        upstreamId: String((detail as { candidateId?: number }).candidateId ?? 0),
        fingerprint: fingerprintFor(detail as unknown as CandidateDetail),
        detail,
        ...overrides,
      },
    });
  }

  it("refuses a snapshot whose own identifier or fingerprint is corrupt", async () => {
    // The two fields the reference store owns are validated too, rather than
    // trusted because this module wrote them: a payload carrying a path where
    // the upstream identifier belongs would otherwise resolve on the strength
    // of a plausible detail beside it.
    const references = store();
    const candidate = await firstCandidate();
    const reference = mintCandidateReference(references, candidate) as string;
    const detail = {
      kind: "import_candidate",
      sourceKind: "tracked_download",
      candidateId: 3001,
      queueItemId: 502,
      fileIdentity: candidate.fileIdentity,
      importable: candidate.decision.importable,
    };

    // Each case starts from a snapshot that would resolve — correct detail,
    // correct identifier, recomputed fingerprint — and changes exactly one
    // thing, so the refusal is attributable to that thing.
    corrupt(references, reference, detail);
    expect(resolveCandidateReference(references, reference, "sonarr").ok).toBe(true);

    const cases: readonly [string, Record<string, unknown>][] = [
      ["a path where the identifier belongs", { upstreamId: "/media/example/file.mkv" }],
      ["an identifier naming another row", { upstreamId: "4242" }],
      ["a fingerprint that is not a digest", { fingerprint: "/media/example" }],
      // A well-formed fingerprint that simply is not this candidate's. The
      // shape says nothing; the value is what has to match.
      [
        "a fingerprint of the right shape but the wrong candidate",
        { fingerprint: "deadbeefcafe1234" },
      ],
      ["an unknown field", { extra: "unexpected" }],
    ];

    for (const [label, overrides] of cases) {
      corrupt(references, reference, detail, overrides);
      expect(resolveCandidateReference(references, reference, "sonarr").ok, label).toBe(false);
    }
  });

  it("refuses a stored identity that is not a digest", async () => {
    const references = store();
    const candidate = await firstCandidate();
    const reference = mintCandidateReference(references, candidate) as string;

    corrupt(references, reference, {
      kind: "import_candidate",
      sourceKind: "tracked_download",
      candidateId: 3001,
      queueItemId: 502,
      fileIdentity: "/media/example/downloads/complete/file.mkv",
      importable: true,
    });

    expect(resolveCandidateReference(references, reference, "sonarr").ok).toBe(false);
  });

  it("refuses a stored payload missing what its own kind is re-read through", async () => {
    const references = store();
    const candidate = await firstCandidate();
    const reference = mintCandidateReference(references, candidate) as string;

    corrupt(references, reference, {
      kind: "import_candidate",
      sourceKind: "tracked_download",
      candidateId: 3001,
      fileIdentity: candidate.fileIdentity,
      importable: true,
    });

    expect(resolveCandidateReference(references, reference, "sonarr").ok).toBe(false);
  });

  it("refuses a reference bound to another application", async () => {
    const references = store();
    const candidate = await firstCandidate();
    const reference = mintCandidateReference(references, candidate) as string;

    const resolved = resolveCandidateReference(references, reference, "radarr");
    expect(resolved.ok).toBe(false);
    expect(resolved.ok === false && resolved.error.code).toBe("invalid_input");
  });

  it("refuses a token of another kind and one this process never issued", () => {
    const references = store();
    const other = references.mint({
      kind: "queue",
      applications: ["sonarr"],
      payload: () => ({
        kind: "domain",
        snapshot: { upstreamId: "502", fingerprint: "x", detail: { kind: "queue_item" } },
      }),
    }).reference;

    expect(resolveCandidateReference(references, other, "sonarr").ok).toBe(false);
    expect(resolveCandidateReference(references, `imp_${"a".repeat(24)}`, "sonarr").ok).toBe(false);
  });

  it("refuses a stored mapping that holds something it would never have written", async () => {
    const references = store();
    const candidate = await firstCandidate();
    const reference = mintCandidateReference(references, candidate) as string;

    corrupt(references, reference, {
      kind: "import_candidate",
      sourceKind: "tracked_download",
      candidateId: 3001,
      queueItemId: 502,
      fileIdentity: candidate.fileIdentity,
      importable: true,
      // A malformed episode list is refused rather than coerced into an empty
      // mapping, which a later import would have acted on.
      episodeIds: ["not-an-id"],
    });

    expect(resolveCandidateReference(references, reference, "sonarr").ok).toBe(false);
  });

  it("keeps season zero, which is a real season", async () => {
    const references = store();
    const candidate = await firstCandidate();
    const specials: ImportCandidate = {
      ...candidate,
      seasonNumber: 0,
      context: { ...candidate.context, seasonNumber: 0 },
    };
    const reference = mintCandidateReference(references, specials) as string;

    const resolved = resolveCandidateReference(references, reference, "sonarr");
    expect(resolved.ok && resolved.value.seasonNumber).toBe(0);
  });

  it("recomputes the fingerprint rather than trusting its shape", async () => {
    // The digest is a function of the detail beside it, which is what makes it
    // checkable at all: every part of it is retained, so resolution recomputes
    // it and requires the exact value.
    const references = store();
    const candidate = await firstCandidate();
    const reference = mintCandidateReference(references, candidate) as string;
    const resolved = references.resolve(reference, "import_candidate");
    if (!resolved.ok || resolved.entry.payload.kind !== "domain") {
      throw new Error("Expected a domain payload");
    }
    const snapshot = resolved.entry.payload.snapshot;

    // Changing what the detail says without changing the digest is refused,
    // and so is changing the digest without changing the detail.
    references.update(reference, "import_candidate", {
      kind: "domain",
      snapshot: {
        ...snapshot,
        detail: { ...snapshot.detail, importable: !candidate.decision.importable },
      },
    });
    expect(resolveCandidateReference(references, reference, "sonarr").ok).toBe(false);
  });

  it("gives two scans of the same file the same fingerprint", async () => {
    const references = store();
    const candidate = await firstCandidate();
    const first = mintCandidateReference(references, candidate) as string;
    const second = mintCandidateReference(references, candidate) as string;

    const left = references.resolve(first, "import_candidate");
    const right = references.resolve(second, "import_candidate");
    expect(first).not.toBe(second);
    expect(
      left.ok && left.entry.payload.kind === "domain" && left.entry.payload.snapshot.fingerprint,
    ).toBe(
      right.ok && right.entry.payload.kind === "domain" && right.entry.payload.snapshot.fingerprint,
    );
  });
});

describe("file identity", () => {
  it("is stable within a process and not the path it came from", () => {
    const path = "/media/example/downloads/complete/example/file.mkv";
    expect(fileIdentity(path)).toBe(fileIdentity(path));
    expect(fileIdentity(path)).not.toContain("media");
    expect(fileIdentity(path)).not.toBe(fileIdentity(`${path}x`));
  });
});
