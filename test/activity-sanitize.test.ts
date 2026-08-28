import { describe, expect, it } from "vitest";
import { queueStatuses, trackedDownloadStates } from "../src/adapters/activity/model.js";
import {
  closedWord,
  downloadIdentity,
  maxMessageLength,
  optionalClosedWord,
  safeLabel,
  safeTaxonomyLabel,
  safeText,
} from "../src/adapters/activity/parse.js";
import { runActivityQuery } from "../src/adapters/activity/service.js";
import { payloadInventory } from "../src/tools/schemas/publish-results.js";
import { expectOk, paging, queueItems, servePagedRecords } from "./support/activity.js";
import { jsonResponse, libraryHarness } from "./support/library.js";
import {
  callTool,
  definitionOf,
  leafValues,
  outcomesOf,
  payloadOutcomes,
} from "./support/projection.js";
import { createTestToolContext } from "./support/tool-context.js";

/**
 * A recognizable value planted in the parts of an upstream payload this server
 * claims never to publish. It is deliberately short and hyphenated, so it is
 * below the length at which the sanitizer redacts an opaque identifier: if any
 * of it reached a mapped result the assertions below would see it verbatim
 * rather than being rescued by a redaction that happened to fire.
 */
const canary = "CANARY-SECRET-42";

/**
 * A status message built to escape the shape it is mapped into: an ANSI escape
 * introducer, a NUL, a bidirectional override, a fake JSON structure, an
 * absolute path, a URL, a torrent info hash, and enough padding to run past the
 * length bound.
 */
const hostileMessage = [
  "\u001b[31mALERT\u0000",
  '","injected":"yes","messages":["',
  "\u202eevres esrever",
  "/media/example/library/Example Series/S01E01.mkv",
  "https://exfiltrate.example.invalid/?key=CANARY-SECRET-42",
  "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
  "padding ".repeat(120),
].join(" ");

function hostileQueueRecord(): Record<string, unknown> {
  return {
    id: 701,
    seriesId: 12,
    episodeId: 1001,
    // A status word this server does not know must not widen the closed set.
    status: `downloading\u0000; rm -rf ${canary}`,
    trackedDownloadStatus: "warning",
    trackedDownloadState: "importBlocked",
    title: "Example Series S01E01\u202e Bluray-1080p",
    statusMessages: [
      { title: "\u001b]0;window-title\u0007", messages: [hostileMessage] },
      ...Array.from({ length: 40 }, (_, index) => ({
        title: `filler ${index}`,
        messages: [`filler message ${index}`],
      })),
    ],
    errorMessage: `Import failed for /media/example/downloads/${canary}/file.mkv`,
    // None of the following are declared by the adapter's schema at all.
    outputPath: `/media/example/downloads/${canary}`,
    downloadId: `${canary}-download`,
    downloadClientApiKey: canary,
    series: { id: 12, title: "Example Series", path: `/media/example/library/${canary}` },
    episodeFile: { path: `/media/example/library/${canary}/file.mkv` },
    quality: { quality: { name: "Bluray-1080p" } },
    // Every upstream string reaching the model is sanitized, including the ones
    // that are conventional words in practice.
    languages: [{ id: 1, name: `English /media/example/${canary}` }],
  };
}

async function mapHostileQueue() {
  const harness = libraryHarness("sonarr", servePagedRecords([hostileQueueRecord()], 1));
  const outcome = await runActivityQuery("sonarr", harness.client, {
    view: "queue",
    detail: "full",
    paging: paging(),
  });
  return expectOk(outcome);
}

describe("upstream text sanitization", () => {
  it("redacts paths, URLs, and opaque identifiers", () => {
    expect(safeText("failed at /media/example/library/file.mkv now")).toBe(
      "failed at [redacted path] now",
    );
    expect(safeText("see ~/notes for detail")).toBe("see [redacted path] for detail");
    expect(safeText("copy from C:\\Media\\Example to disk")).toBe(
      "copy from [redacted path] to disk",
    );
    expect(safeText("share \\\\server\\media failed")).toBe("share [redacted path] failed");
    expect(safeText("fetch https://indexer.example.invalid/x?key=abc please")).toBe(
      "fetch [redacted url] please",
    );
    expect(safeText("hash a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0 seen")).toBe(
      "hash [redacted id] seen",
    );
    // A path with a space in it leaves no readable tail behind, on any of the
    // three separators: each head rule stops at the first space, and the
    // residual-separator rule takes what they left.
    expect(safeText("missing /media/example/Example Series/S01E01.mkv here")).toBe(
      "missing [redacted path] [redacted path] here",
    );
    expect(safeText("missing C:\\Private Folder\\secret.mkv here")).toBe(
      "missing [redacted path] [redacted path] here",
    );
    expect(safeText("missing \\\\server\\Share Folder\\secret.mkv here")).toBe(
      "missing [redacted path] [redacted path] here",
    );
  });

  /**
   * Every shape either sanitizer must take, whichever one is asked.
   *
   * The list is the union of three classes an adversarial reading found: a path
   * whose head a prefix rule ate and whose tail was then re-tokenized, a
   * secret-shaped token carrying exactly one separator, and a bare two-part
   * shape that a prefix rule has already stripped down to. They are asserted
   * against both sanitizers together, so a future tolerance added to one cannot
   * quietly admit what the other refuses.
   */
  const alwaysRedacted: ReadonlyArray<readonly [string, string]> = [
    // A path with a space in it. Each head rule is `[^\s"']`-bounded and stops
    // at the first space, so the tail arrives at the residual rule as a token of
    // its own. Neither sanitizer may publish it: the separator-joined pair is
    // taken, and only the final bare word — which carries no separator and so
    // names no directory level — survives, exactly as it does in prose.
    ["\\\\NAS01\\media$\\Private Stash\\Home Movies", "[redacted path] [redacted path] Movies"],
    ["C:\\Users\\someone\\My Documents\\Tax Returns", "[redacted path] [redacted path] Returns"],
    ["~/Example Home/Private Notes", "[redacted path] [redacted path] Notes"],
    ["/media/example/Example Series/S01E01.mkv", "[redacted path] [redacted path]"],
    // A secret carrying exactly one separator. The plus is what made unpadded
    // base64 survivable, and the taxonomy segment class no longer admits it.
    ["ghp+16Cabcdefghij/klmnopqrstuvwxyz", "[redacted path]"],
    ["sk-live+abcdefghijklmnop/qrstuvwxyz012345", "[redacted path]"],
    ["YWJjZGVmZ2hpamtsbW5v+cHFyc3R1/dnd4eXoxMjM0", "[redacted path]"],
    // A UNC share or a drive path a prefix rule has already stripped down to two
    // bare parts. The taxonomy rule refuses these too, because it splits on a
    // forward slash alone and no *arr taxonomy is written with a backslash.
    ["server\\share", "[redacted path]"],
    ["C\\Media", "[redacted path]"],
    // The shapes the prefix rules were written for, unchanged.
    ["/media/private/tv", "[redacted path]"],
    ["/home/someone/downloads", "[redacted path]"],
    ["C:\\Media\\file.mkv", "[redacted path]"],
    ["\\\\server\\share\\file", "[redacted path]"],
    ["some/dir/file.mkv", "[redacted path]"],
    ["~/notes/private", "[redacted path]"],
    ["d:/data/tv", "[redacted path]"],
    ["example.com/path", "[redacted path]"],
    ["//server/share", "[redacted path]"],
    // A segment longer than a name ever is. The joiners keep it from being one
    // unbroken run, so the opaque-identifier rule never sees it and the segment
    // bound is what takes it.
    ["Ampersand&Ampersand&Ampersand&Amp/tv", "[redacted path]"],
    // A segment that opens with something other than a word.
    ["-hidden/tv", "[redacted path]"],
    ["https://tracker.example.invalid/rules?apikey=SECRET", "[redacted url]"],
  ];

  it("redacts every path and secret shape from a label, strict or taxonomy", () => {
    for (const [value, expected] of alwaysRedacted) {
      expect(safeLabel(value)).toBe(expected);
      expect(safeTaxonomyLabel(value)).toBe(expected);
    }
    // A path embedded in prose is how one arrives in a rejection reason, and a
    // label that carries a sentence is treated no more gently than the sentence
    // would be.
    expect(safeLabel("cannot import from /media/example/Example Series/S01E01.mkv here")).toBe(
      "cannot import from [redacted path] [redacted path] here",
    );
  });

  /**
   * The whole of what the taxonomy rule costs, written down rather than implied.
   *
   * A bare `root/child` pair of short dotless words is what a two-level taxonomy
   * looks like, and it is also what a path fragment looks like once a prefix
   * rule has eaten everything that distinguished it. No test of shape can refuse
   * `etc/passwd` and still publish `Movies/UHD`, so the tolerance is confined to
   * the three fields whose values carry a separator by construction instead. The
   * strict rule — every direct `safeLabel` caller, and `scrubLabel`, which is
   * every other converted field — still takes all of them.
   */
  it("spares a bare two-part shape only on the taxonomy path, never the strict one", () => {
    for (const value of [
      "etc/passwd",
      "home/someone",
      "Users/someone",
      "admin/hunter2",
      "AKIAIOSFODNN7/wJalrXUtnFEMI",
    ]) {
      expect(safeLabel(value)).toBe("[redacted path]");
      expect(safeTaxonomyLabel(value)).toBe(value);
    }
  });

  /** The values the two taxonomy fields actually publish upstream. */
  const taxonomyNames = [
    "TV/HD",
    "TV/SD",
    "TV/Foreign",
    "TV/Anime",
    "Movies/HD",
    "Movies/UHD",
    "Audio/MP3",
    "Audio/Lossless",
    "Repack/Proper",
    "Console/Wii-U",
    "PC/0day",
  ] as const;

  it("keeps a separator that joins two words of a taxonomy label", () => {
    for (const label of taxonomyNames) {
      expect(safeTaxonomyLabel(label)).toBe(label);
    }
  });

  /**
   * The strict label rule is the prose rule under a label's length bound and
   * nothing else, so a separator never survives it. This is pinned separately
   * from the redaction list because it is the property the whole restructure
   * rests on: a field gets tolerance by asking for it by name, never by default.
   */
  it("takes every separator out of a strict label, taxonomy-shaped or not", () => {
    for (const label of taxonomyNames) {
      expect(safeLabel(label)).toBe("[redacted path]");
    }
    expect(safeText("TV/HD")).toBe("[redacted path]");
    expect(safeText("failed at /media/example/library/file.mkv now")).toBe(
      "failed at [redacted path] now",
    );
  });

  /**
   * The tolerance is spent on a whole bare value and nothing else. A value that
   * has already lost a head to a redaction marker is not a category name, so the
   * surviving tail is refused however name-shaped it looks — which is what keeps
   * the space-bearing paths above from disclosing two directory levels here.
   */
  it("refuses a taxonomy shape that is only what a redaction left behind", () => {
    expect(safeTaxonomyLabel("\\\\server\\share$\\Private Stash\\Home Movies")).toBe(
      "[redacted path] [redacted path] Movies",
    );
    expect(safeTaxonomyLabel("Genre TV/HD")).toBe("Genre [redacted path]");
    expect(safeTaxonomyLabel("TV/HD TV/SD")).toBe("[redacted path] [redacted path]");
  });

  it("deletes hidden characters and collapses real whitespace to a space", () => {
    // A control or format character is removed outright; a tab and a line break
    // are real whitespace and become one space.
    expect(safeText("line\u0000one\u001b\ttwo\u202ethree\n\nfour")).toBe("lineone twothree four");
  });

  it("removes every format character, not a hand-picked list of them", () => {
    // One representative from each family the removal set has to cover: an
    // Arabic letter mark, a zero-width space, a word joiner, an isolate, a byte
    // order mark, and a bidirectional override. The set is named by Unicode
    // category precisely so no family can be forgotten.
    for (const format of ["\u061c", "\u200b", "\u2060", "\u2066", "\ufeff", "\u202e", "\u200f"]) {
      expect(safeText(`before${format}after`)).toBe("beforeafter");
    }
    // A paragraph separator is real whitespace, so it separates rather than
    // vanishing.
    expect(safeText("before\u2029after")).toBe("before after");
  });

  it("cannot be split by a character wedged into a URL or a path", () => {
    // Deleting a hidden character rather than replacing it with a space is what
    // keeps the token whole for the redaction rules: spacing it would end the
    // URL early and leave everything after it readable.
    for (const hidden of ["\u200b", "\u0000", "\u061c", "\ufeff"]) {
      expect(safeText(`see https://indexer.example.invalid/x${hidden}${canary} now`)).toBe(
        "see [redacted url] now",
      );
      expect(safeText(`at /media/example/x${hidden}${canary} now`)).toBe("at [redacted path] now");
      expect(safeText(`at C:\\Example\\x${hidden}${canary} now`)).toBe("at [redacted path] now");
    }
  });

  it("bounds a message and reports nothing for text that sanitizes away", () => {
    const sanitized = safeText("padding ".repeat(maxMessageLength / 4));
    expect(sanitized?.length).toBe(maxMessageLength + 1);
    expect(safeText("   ")).toBeUndefined();
    expect(safeText(null)).toBeUndefined();
  });

  it("narrows an upstream word to the closed set or the stated fallback", () => {
    expect(closedWord("importBlocked", trackedDownloadStates, "unknown")).toBe("import_blocked");
    expect(closedWord("downloadClientUnavailable", queueStatuses, "unknown")).toBe(
      "download_client_unavailable",
    );
    expect(closedWord("somethingNewUpstream", queueStatuses, "unknown")).toBe("unknown");
    expect(closedWord(null, queueStatuses, "unknown")).toBe("unknown");
    // Absent and unrecognized stay distinguishable.
    expect(optionalClosedWord(null, trackedDownloadStates, "unknown")).toBeUndefined();
    expect(optionalClosedWord("brandNew", trackedDownloadStates, "unknown")).toBe("unknown");
  });

  it("digests a download identifier stably without disclosing it", () => {
    const digest = downloadIdentity(`${canary}-download`);
    expect(digest).toMatch(/^[0-9a-f]{16}$/u);
    expect(digest).toBe(downloadIdentity(`${canary}-download`));
    expect(digest).not.toBe(downloadIdentity(`${canary}-other`));
    expect(digest).not.toContain(canary);
    expect(downloadIdentity(undefined)).toBeUndefined();
  });
});

describe("activity canary and untrusted status messages", () => {
  it("publishes nothing from the fields it does not map", async () => {
    const ok = await mapHostileQueue();
    expect(JSON.stringify(ok)).not.toContain(canary);
  });

  it("keeps history free of the paths and hashes upstream puts in its data bag", async () => {
    const harness = libraryHarness(
      "radarr",
      servePagedRecords(
        [
          {
            id: 9500,
            movieId: 8,
            eventType: "downloadFolderImported",
            date: "2026-08-26T17:30:00Z",
            sourceTitle: "Example Movie 2021 Bluray-1080p",
            downloadId: `${canary}-download`,
            data: {
              droppedPath: `/media/example/downloads/${canary}`,
              importedPath: `/media/example/library/${canary}`,
              torrentInfoHash: `${canary}-hash`,
              downloadUrl: `https://indexer.example.invalid/${canary}`,
              downloadClient: "Example Client",
            },
          },
        ],
        1,
      ),
    );
    const outcome = await runActivityQuery("radarr", harness.client, {
      view: "history",
      detail: "full",
      paging: paging(),
    });

    const ok = expectOk(outcome);
    expect(JSON.stringify(ok)).not.toContain(canary);
    expect(JSON.stringify(ok)).toContain("Example Client");
  });

  it("maps a hostile status message into the declared shape and nothing else", async () => {
    const ok = await mapHostileQueue();
    const item = queueItems(ok.data)[0];
    if (item === undefined) {
      throw new Error("Expected the hostile queue row to be mapped");
    }

    // The hostile status word does not widen the closed set, and the tracked
    // state upstream reported correctly still comes through.
    expect(item.evidence.status).toBe("unknown");
    expect(item.evidence.trackedState).toBe("import_blocked");
    expect(item.kind).toBe("tracked_download");

    const group = item.evidence.statusMessages[0];
    const message = group?.messages[0];
    expect(typeof message).toBe("string");
    expect(message?.length).toBeLessThanOrEqual(maxMessageLength + 1);
    // Nothing invisible survived, so the message cannot render as another.
    const invisible = [...(message ?? "")].filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return (
        code < 0x20 ||
        (code >= 0x7f && code <= 0x9f) ||
        (code >= 0x200b && code <= 0x200f) ||
        (code >= 0x202a && code <= 0x202e)
      );
    });
    expect(invisible).toEqual([]);
    expect(message).toContain("[redacted path]");
    expect(message).toContain("[redacted url]");
    expect(message).toContain("[redacted id]");

    // The fake JSON structure stayed inside the string it was written in: no
    // property it named exists on the mapped item or on the group.
    expect(Object.keys(item).sort()).toEqual([
      "application",
      "context",
      "episode",
      "evidence",
      "kind",
      "languages",
      "media",
      "origin",
      "progress",
      "quality",
      "title",
    ]);
    expect(Object.keys(group ?? {}).sort()).toEqual(["messages", "title"]);
    expect(JSON.parse(JSON.stringify(item))).not.toHaveProperty("injected");

    // The row cannot make one page unbounded by carrying hundreds of groups.
    expect(item.evidence.statusMessages.length).toBeLessThanOrEqual(20);

    expect(item.languages).toEqual(["English [redacted path]"]);
  });

  /**
   * The same hostile row again, through the tool and under a projection naming
   * every path the queue payload publishes.
   *
   * A projection runs on an envelope the tool's own output schema has already
   * validated, so it can only ever narrow what leaves — but that is the claim,
   * and this is where it is checked. Asking for everything is the strongest form
   * of it: whatever a projection could possibly return, it returned here, and
   * the marker is still nowhere in it.
   */
  it("cannot select back anything the sanitizer took out of a queue row", async () => {
    const inventory = payloadInventory(definitionOf("arr_activity_query").outputSchema);
    const projection = inventory?.payloads.find((payload) =>
      payload.variants.includes("queue"),
    )?.paths;
    expect(projection?.length ?? 0, "published queue paths").toBeGreaterThan(0);

    const context = createTestToolContext({
      environment: { SONARR_URL: "https://sonarr.example.invalid", SONARR_API_KEY: "key" },
      fetch: async (url) =>
        url.includes("system/status")
          ? jsonResponse({ appName: "Sonarr", version: "4.0.19.2979" })
          : servePagedRecords([hostileQueueRecord()], 1)({ url: new URL(url), init: {} }),
    });

    const projected = await callTool("arr_activity_query", context, {
      view: "queue",
      detail: "full",
      applications: ["sonarr"],
      projection: [...(projection ?? [])],
    });

    const outcome = payloadOutcomes(projected.structured)[0];
    const source = outcome === undefined ? undefined : outcomesOf(projected.envelope)[outcome[0]];
    const returned = leafValues(outcome?.[1]?.data);
    const available = leafValues(source?.data);
    expect(returned.size, "projected values compared").toBeGreaterThan(0);
    for (const [path, value] of returned) {
      expect(available.has(path), `invented ${path}`).toBe(true);
      expect(value, path).toEqual(available.get(path));
    }
    expect(JSON.stringify(projected.structured)).not.toContain(canary);
  });
});
