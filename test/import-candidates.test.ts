import { describe, expect, it } from "vitest";
import {
  fileIdentity,
  fileNameOf,
  type ImportScanContext,
  readCandidates,
  readLibraryScanContext,
  readTrackedScanContext,
} from "../src/adapters/import/candidates.js";
import type { ImportCandidate } from "../src/adapters/import/model.js";
import type { MediaApplication } from "../src/adapters/library/model.js";
import { createManualClock } from "../src/state/clock.js";
import { createReferenceStore } from "../src/state/references.js";
import {
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

async function scan(
  application: MediaApplication,
  context: ImportScanContext,
): Promise<{ candidates: readonly ImportCandidate[]; calls: readonly UpstreamCall[] }> {
  const body = await activityFixture<unknown[]>(application, "manualimport");
  const harness = libraryHarness(application, () => jsonResponse(body));
  const scanned = await readCandidates(harness.client, context);
  return { candidates: scanned.candidates, calls: harness.calls };
}

const sonarrScan: ImportScanContext = {
  application: "sonarr",
  sourceKind: "tracked_download",
  folder: "/media/example/downloads/complete/example-series",
  downloadId: "b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1",
  mediaId: 12,
  queueItemId: 502,
};

const radarrScan: ImportScanContext = {
  application: "radarr",
  sourceKind: "library_context",
  folder: "/media/example/movies/Example Movie (2021)",
  mediaId: 8,
};

describe("candidate scan context", () => {
  it("reads a tracked download's location out of its queue row", async () => {
    const rows = await activityFixture<unknown[]>("sonarr", "queue/details");
    const harness = libraryHarness("sonarr", () => jsonResponse(rows));
    const resolved = await readTrackedScanContext(harness.client, "sonarr", {
      queueItemId: 502,
      mediaId: 12,
    });

    if (!resolved.ok) {
      throw new Error(`Expected the queue row to resolve, got ${resolved.reason}`);
    }
    // The read is the focused one, scoped by the media association the queue
    // reference retained.
    expect(harness.calls[0]?.url.pathname).toBe("/api/v3/queue/details");
    expect(harness.calls[0]?.url.searchParams.get("seriesId")).toBe("12");
    // Both of these are exactly what a caller may never see, and exactly what
    // the upstream endpoint has to be asked with.
    expect(resolved.context.folder).toContain("/media/example");
    expect(resolved.context.downloadId).toMatch(/^[0-9a-f]{16,}$/u);
    expect(resolved.context.sourceKind).toBe("tracked_download");
  });

  it("reports a row that is gone and one that names no location differently", async () => {
    const rows = await activityFixture<unknown[]>("sonarr", "queue/details");
    const harness = libraryHarness("sonarr", () => jsonResponse(rows));
    const absent = await readTrackedScanContext(harness.client, "sonarr", { queueItemId: 9999 });
    expect(absent.ok === false && absent.reason).toBe("absent");

    // The pending release in the recorded queue reports neither an output path
    // nor a download identifier, because nothing has been downloaded for it.
    const unmapped = await readTrackedScanContext(harness.client, "sonarr", { queueItemId: 503 });
    expect(unmapped.ok === false && unmapped.reason).toBe("unmapped");
  });

  it("takes a library context's folder from the record rather than the caller", async () => {
    const records = await activityFixture<Array<{ id: number }>>("radarr", "movie");
    const record = records.find((candidate) => candidate.id === 8);
    const harness = libraryHarness("radarr", () => jsonResponse(record));
    const resolved = await readLibraryScanContext(harness.client, "radarr", { mediaId: 8 });

    if (!resolved.ok) {
      throw new Error(`Expected the movie to resolve, got ${resolved.reason}`);
    }
    expect(harness.calls[0]?.url.pathname).toBe("/api/v3/movie/8");
    expect(resolved.context.folder).toBe("/media/example/movies/Example Movie (2021)");
    expect(resolved.context.sourceKind).toBe("library_context");
  });
});

describe("candidate mapping", () => {
  it("asks the instance with the download identity and the folder", async () => {
    const { calls } = await scan("sonarr", sonarrScan);

    expect(calls[0]?.url.pathname).toBe("/api/v3/manualimport");
    expect(calls[0]?.url.searchParams.get("downloadId")).toBe(sonarrScan.downloadId);
    expect(calls[0]?.url.searchParams.get("folder")).toBe(sonarrScan.folder);
    // Existing library files have to come back, because the specification
    // requires them to be distinguishable rather than hidden.
    expect(calls[0]?.url.searchParams.get("filterExistingFiles")).toBe("false");
  });

  it("scopes a library scan to the record it was asked for", async () => {
    const { calls } = await scan("radarr", radarrScan);

    expect(calls[0]?.url.searchParams.get("movieId")).toBe("8");
    expect(calls[0]?.url.searchParams.get("downloadId")).toBeNull();
  });

  it("maps the mapping, the file identity, and the structured rejections", async () => {
    const { candidates } = await scan("sonarr", sonarrScan);

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

  it("maps a Radarr scan, including a rejected sample with no media mapping", async () => {
    const { candidates } = await scan("radarr", radarrScan);

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
    const first = await scan("sonarr", sonarrScan);
    const second = await scan("sonarr", sonarrScan);

    expect(first.candidates[0]?.fileIdentity).toBe(second.candidates[0]?.fileIdentity);
    expect(first.candidates[0]?.fileIdentity).not.toBe(first.candidates[1]?.fileIdentity);
    // A digest, not a path: sixteen hexadecimal characters and nothing else.
    expect(first.candidates[0]?.fileIdentity).toMatch(/^[0-9a-f]{16}$/u);
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
    const sonarr = await scan("sonarr", sonarrScan);
    const radarr = await scan("radarr", radarrScan);
    const serialized = JSON.stringify([sonarr.candidates, radarr.candidates]);

    // Read out of the recording rather than written here, so the assertion
    // cannot stop naming what the instance actually serves.
    const rows = await activityFixture<Array<Record<string, unknown>>>("sonarr", "manualimport");
    const paths = rows.map((row) => String(row.path));
    const folders = rows.map((row) => String(row.folderName));

    // A control: the same matchers fire on a payload that does carry these.
    const leaked = JSON.stringify({ path: paths[0], folderName: folders[0] });
    expect(leaked).toContain(paths[0]);
    expect(leaked).toContain("/media/example");

    for (const path of paths) {
      expect(serialized).not.toContain(path);
    }
    expect(serialized).not.toContain("/media/example");
    expect(serialized).not.toContain("/downloads");
    expect(serialized).not.toContain(sonarrScan.downloadId);
    // The relative path carries the directory chain inside the download folder,
    // which is a location too.
    expect(serialized).not.toContain("Season 02/");
  });

  it("scrubs every upstream label, not only the free-text ones", async () => {
    // A custom format, a language, and an indexer flag are all names somebody
    // chose, so any of them can carry a path or an identifier. They are
    // sanitized rather than merely trimmed, which a normalizing list helper
    // would not have done.
    const canaryPath = "/media/private/secret-library/file.mkv";
    const canaryId = "b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1";
    const rows = await activityFixture<Array<Record<string, unknown>>>("sonarr", "manualimport");
    const laced = rows.map((row, index) =>
      index === 0
        ? {
            ...row,
            customFormats: [
              { id: 9, name: canaryPath },
              { id: 10, name: "Example Format" },
            ],
            languages: [{ id: 1, name: canaryId }],
            indexerFlags: [canaryPath, "freeleech"],
          }
        : row,
    );
    const harness = libraryHarness("sonarr", () => jsonResponse(laced));
    const scanned = await readCandidates(harness.client, sonarrScan);
    const serialized = JSON.stringify(scanned.candidates);

    // A control, so the assertions below cannot pass for the wrong reason.
    expect(JSON.stringify(laced)).toContain(canaryPath);
    expect(JSON.stringify(laced)).toContain(canaryId);

    expect(serialized).not.toContain(canaryPath);
    expect(serialized).not.toContain(canaryId);
    expect(serialized).not.toContain("/media/private");
    // What was not a path survives, so the scrubbing is not simply dropping the
    // fields.
    expect(scanned.candidates[0]?.customFormats).toEqual(["Example Format"]);
    expect(scanned.candidates[0]?.indexerFlags).toEqual(["freeleech"]);
  });

  it("scrubs a rejection that quotes the path it objected to", async () => {
    const { candidates } = await scan("sonarr", sonarrScan);
    const reason = candidates[1]?.decision.rejections[0]?.reason ?? "";

    expect(reason).toContain("Unable to parse episode");
    expect(reason).not.toContain("/media/example");
    expect(reason).toContain("[redacted path]");
  });
});

describe("candidate references", () => {
  function store() {
    return createReferenceStore({ clock: createManualClock(1_000) });
  }

  async function firstCandidate(): Promise<ImportCandidate> {
    const { candidates } = await scan("sonarr", sonarrScan);
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
    expect(JSON.stringify(entry)).not.toContain(sonarrScan.downloadId);
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

    // A library-context candidate is nameable on its media record instead.
    expect(
      isNameableCandidate({
        ...candidate,
        sourceKind: "library_context",
        context: { ...candidate.context, sourceKind: "library_context", queueItemId: undefined },
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
      ["media zero", { ...candidate, context: { ...candidate.context, mediaId: 0 } }],
      ["negative season", { ...candidate, context: { ...candidate.context, seasonNumber: -1 } }],
      ["episode zero", { ...candidate, context: { ...candidate.context, episodeIds: [0] } }],
      ["negative size", { ...candidate, sizeBytes: -1 }],
      [
        "existing file zero",
        { ...candidate, context: { ...candidate.context, existingFileId: 0 } },
      ],
    ];

    for (const [label, rejected] of invalidClasses) {
      expect(isNameableCandidate(rejected), label).toBe(false);
      expect(mintCandidateReference(references, rejected), label).toBeUndefined();
    }
    expect(references.size()).toBe(before);
  });

  it("refuses a stored identity that is not a digest", async () => {
    const references = store();
    const candidate = await firstCandidate();
    const reference = mintCandidateReference(references, candidate) as string;

    references.update(reference, "import_candidate", {
      kind: "domain",
      snapshot: {
        upstreamId: "3001",
        fingerprint: "x",
        detail: {
          kind: "import_candidate",
          sourceKind: "tracked_download",
          queueItemId: 502,
          fileIdentity: "/media/example/downloads/complete/file.mkv",
        },
      },
    });

    expect(resolveCandidateReference(references, reference, "sonarr").ok).toBe(false);
  });

  it("refuses a stored payload missing what its own kind is re-read through", async () => {
    const references = store();
    const candidate = await firstCandidate();
    const reference = mintCandidateReference(references, candidate) as string;

    references.update(reference, "import_candidate", {
      kind: "domain",
      snapshot: {
        upstreamId: "3001",
        fingerprint: "x",
        detail: {
          kind: "import_candidate",
          sourceKind: "tracked_download",
          fileIdentity: candidate.fileIdentity,
        },
      },
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

    references.update(reference, "import_candidate", {
      kind: "domain",
      snapshot: {
        upstreamId: "3001",
        fingerprint: "x",
        detail: {
          kind: "import_candidate",
          sourceKind: "tracked_download",
          fileIdentity: candidate.fileIdentity,
          // A malformed episode list is refused rather than coerced into an
          // empty mapping, which a later import would have acted on.
          episodeIds: ["not-an-id"],
        },
      },
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
