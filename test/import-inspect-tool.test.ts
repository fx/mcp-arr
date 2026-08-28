import { beforeEach, describe, expect, it } from "vitest";
import { createWorkflowState, type WorkflowState } from "../src/state/workflow.js";
import { findToolDefinition, type ToolDefinition } from "../src/tools/definitions.js";
import type { ToolContext } from "../src/tools/dispatch.js";
import type { ToolResult } from "../src/tools/results.js";
import { activityFixture } from "./support/activity.js";
import { fixtureBody } from "./support/library.js";
import { reprocessAnswer } from "./support/manual-import.js";
import {
  allApplicationsEnvironment,
  createTestToolContext,
  jsonResponse,
} from "./support/tool-context.js";

/**
 * Correcting a candidate's mapping through the tools a caller actually holds.
 *
 * The adapter tests own what one reprocess puts on the wire. This file owns the
 * thing above it: that a caller who says "this file belongs to that other
 * series" gets a mapping about that other series and nothing left over from the
 * one the instance guessed — and that what it gets back cannot then be imported
 * when the application refuses it.
 *
 * It exists because the carry-over that made that possible lived in the tool
 * layer rather than in the adapter: the reference retains the episodes the scan
 * found, and the correction was written over the media alone. An adapter test
 * cannot see that, because by the time the adapter is called the episodes are
 * already in the patch as though a caller had named them.
 *
 * Every reference is obtained the way a caller obtains one, by running the
 * query it comes from against the same context. Nothing is hand-minted.
 */

const inspectTool = findToolDefinition("arr_import_inspect") as ToolDefinition;
const executeTool = findToolDefinition("arr_import_execute") as ToolDefinition;
const queryTool = findToolDefinition("arr_activity_query") as ToolDefinition;
const libraryTool = findToolDefinition("arr_library_query") as ToolDefinition;

/**
 * The series a caller moves the file to, and one of its episodes.
 *
 * The recorded scan maps the file to series 12, season 1, episode 1001. Series
 * 13 is therefore a genuine move, and episode 1002 is the only episode of it
 * the recorded library holds — so a mapping naming both is one a caller could
 * actually have selected, while 1001 is one only the scan could have supplied.
 */
const correctedSeriesId = 13;
const correctedEpisodeId = 1002;

interface Instance {
  readonly fetch: (input: string, init: RequestInit) => Promise<Response>;
  /** Every element sent to the reprocess endpoint, in order. */
  readonly reprocessed: Record<string, unknown>[];
  /** Every command body, which for this surface means every import. */
  readonly commands: Record<string, unknown>[];
}

/**
 * A Sonarr that decides a reprocess from the element it was sent.
 *
 * That asymmetry is the whole point: verified against 4.0.19.2979, the same
 * file and the same corrected series come back importable with no rejections
 * when the element names episodes, and carry a permanent rejection when it
 * names none. An instance double answering the same thing either way would make
 * this test pass whichever mapping the server sent.
 */
async function createInstance(): Promise<Instance> {
  const [candidates, queue, queueDetails, series, episodes, diskspace, qualities, languages] =
    await Promise.all([
      activityFixture<Record<string, unknown>[]>("sonarr", "manualimport"),
      activityFixture<{ records: unknown[] }>("sonarr", "queue"),
      activityFixture<unknown[]>("sonarr", "queue/details"),
      activityFixture<unknown[]>("sonarr", "series"),
      activityFixture<unknown[]>("sonarr", "episode"),
      fixtureBody("sonarr", "diskspace"),
      fixtureBody("sonarr", "qualitydefinition"),
      fixtureBody("sonarr", "language"),
    ]);

  const reprocessed: Record<string, unknown>[] = [];
  const commands: Record<string, unknown>[] = [];

  return {
    reprocessed,
    commands,
    fetch: async (input, init) => {
      const url = new URL(input);
      const route = url.pathname.slice(url.pathname.indexOf("/api/v3/") + "/api/v3/".length);
      const method = init.method ?? "GET";

      if (route === "manualimport" && method === "POST") {
        const body: unknown = JSON.parse(String(init.body));
        const elements = Array.isArray(body) ? (body as Record<string, unknown>[]) : [];
        reprocessed.push(...elements);
        return jsonResponse(
          elements.map((element) => {
            const named = Array.isArray(element.episodeIds) ? element.episodeIds : [];
            return reprocessAnswer(
              element,
              named.length === 0 ? [{ reason: "Episodes not selected", type: "permanent" }] : [],
            );
          }),
        );
      }
      if (route === "command" && method === "POST") {
        commands.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return jsonResponse({ id: 7701, name: "ManualImport", status: "queued" });
      }

      switch (route) {
        case "system/status":
          return jsonResponse({ appName: "Sonarr", version: "4.0.19.2979" });
        case "manualimport":
          return jsonResponse(candidates);
        case "queue":
          return jsonResponse(queue);
        case "queue/details":
          return jsonResponse(queueDetails);
        case "series":
          return jsonResponse(series);
        case "episode":
          return jsonResponse(episodes);
        case "diskspace":
          return jsonResponse(diskspace);
        case "qualitydefinition":
          return jsonResponse(qualities);
        case "language":
          return jsonResponse(languages);
        default: {
          const single = /^series\/(\d+)$/u.exec(route);
          if (single !== null) {
            const record = (series as { id: number }[]).find(
              (item) => item.id === Number(single[1]),
            );
            return jsonResponse(
              record ?? { message: "not found" },
              record === undefined ? 404 : 200,
            );
          }
          return jsonResponse({ message: "unexpected route" }, 404);
        }
      }
    },
  };
}

let instance: Instance;
let state: WorkflowState;
let context: ToolContext;

beforeEach(async () => {
  instance = await createInstance();
  state = createWorkflowState();
  context = createTestToolContext({
    environment: { ...allApplicationsEnvironment },
    fetch: instance.fetch,
    state,
  });
});

async function run(definition: ToolDefinition, args: unknown): Promise<ToolResult<unknown>> {
  const parsed = definition.inputSchema.safeParse(args);
  if (!parsed.success) {
    throw new Error(`Arguments rejected by the published schema: ${parsed.error.message}`);
  }
  const result = await definition.handle(context, parsed.data);
  expect(definition.outputSchema.safeParse(result).success).toBe(true);
  return result;
}

interface PublishedCandidate {
  readonly reference: string;
  readonly seasonNumber?: number;
  readonly decision: { readonly importable: boolean; readonly rejections: { reason: string }[] };
}

/** The one application's slice of a result, which is where every read lands. */
function sonarrOf(result: ToolResult<unknown>): {
  readonly data?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
} {
  const applications = (
    result as {
      applications?: readonly {
        application: string;
        data?: unknown;
        error?: { code: string; message: string };
      }[];
    }
  ).applications;
  const sonarr = (applications ?? []).find((entry) => entry.application === "sonarr");
  if (sonarr === undefined) {
    throw new Error(`Expected a sonarr result, got ${JSON.stringify(result).slice(0, 200)}`);
  }
  return sonarr;
}

function candidatesOf(result: ToolResult<unknown>): readonly PublishedCandidate[] {
  return (sonarrOf(result).data as { candidates?: readonly PublishedCandidate[] }).candidates ?? [];
}

/** The candidate a caller reaches from the blocked queue row, as a caller reaches it. */
async function scannedCandidate(): Promise<PublishedCandidate> {
  const queue = await run(queryTool, {
    view: "queue",
    detail: "summary",
    applications: ["sonarr"],
  });
  const rows = (sonarrOf(queue).data as { items: { reference: string; id?: string }[] }).items;
  // The completed, import-blocked row, which is the one the recorded scan
  // answers for.
  const row = rows.find((item) => item.id === "502");
  if (row === undefined) {
    throw new Error("Expected a queue reference to inspect");
  }

  const scanned = await run(inspectTool, {
    source: "queue_item",
    queue: row.reference,
    applications: ["sonarr"],
  });
  const candidate = candidatesOf(scanned)[0];
  if (candidate === undefined) {
    throw new Error("Expected the recorded scan to publish a candidate");
  }
  return candidate;
}

function referenceFor(result: ToolResult<unknown>, upstreamId: number, named: string): string {
  const items = (sonarrOf(result).data as { items: { reference: string; id?: string }[] }).items;
  const match = items.find((item) => item.id === String(upstreamId));
  if (match === undefined) {
    throw new Error(`Expected ${named} ${String(upstreamId)} in the recorded library`);
  }
  return match.reference;
}

/** The media reference for one series, obtained from the library query. */
async function seriesReference(upstreamId: number): Promise<string> {
  return referenceFor(
    await run(libraryTool, { view: "series", applications: ["sonarr"] }),
    upstreamId,
    "series",
  );
}

/** The media reference for one episode, obtained the way a caller obtains one. */
async function episodeReference(seriesId: number, upstreamId: number): Promise<string> {
  return referenceFor(
    await run(libraryTool, {
      view: "episodes",
      series: await seriesReference(seriesId),
      applications: ["sonarr"],
    }),
    upstreamId,
    "episode",
  );
}

describe("correcting a candidate's media through the tools", () => {
  it("sends no episodes or season of the series the file is being moved off", async () => {
    const candidate = await scannedCandidate();
    // The control: the scan really did map this file to the other series, with
    // a season and an episode, so what is dropped below is something that was
    // there to drop rather than something that never existed.
    expect(candidate.seasonNumber).toBe(1);

    await run(inspectTool, {
      source: "candidate_reprocess",
      candidate: candidate.reference,
      mapping: { media: await seriesReference(correctedSeriesId) },
      applications: ["sonarr"],
    });

    // A media-only correction. Episode 1001 is an episode of series 12 whatever
    // this mapping is renamed to, and season 1 counts within series 12 — so
    // neither describes series 13, and an element carrying them asks the
    // instance to decide a mapping the caller never selected.
    const sent = instance.reprocessed.at(-1);
    expect(sent?.seriesId).toBe(correctedSeriesId);
    expect(sent).not.toHaveProperty("episodeIds");
    expect(sent).not.toHaveProperty("seasonNumber");
    // And the correction itself still reached the instance, which is what makes
    // the two assertions above about a mapping rather than about an empty call.
    expect(sent).toHaveProperty("path");
  });

  it("publishes the instance's own refusal rather than an importable candidate", async () => {
    const candidate = await scannedCandidate();
    expect(candidate.decision.importable).toBe(true);

    const corrected = await run(inspectTool, {
      source: "candidate_reprocess",
      candidate: candidate.reference,
      mapping: { media: await seriesReference(correctedSeriesId) },
      applications: ["sonarr"],
    });

    // The instance decides an incomplete mapping for itself, and says no. That
    // is the answer a caller needs: the correction it asked for is not one this
    // application will import as it stands.
    const decided = candidatesOf(corrected)[0];
    expect(decided?.decision.importable).toBe(false);
    expect(decided?.decision.rejections.map((rejection) => rejection.reason)).toEqual([
      "Episodes not selected",
    ]);
  });

  it("refuses to import the corrected candidate rather than moving the file", async () => {
    const candidate = await scannedCandidate();
    const corrected = await run(inspectTool, {
      source: "candidate_reprocess",
      candidate: candidate.reference,
      mapping: { media: await seriesReference(correctedSeriesId) },
      applications: ["sonarr"],
    });
    const decided = candidatesOf(corrected)[0];
    if (decided === undefined) {
      throw new Error("Expected a re-decided candidate");
    }

    const planned = await run(executeTool, {
      mode: "plan",
      candidates: [decided.reference],
      importMode: "auto",
    });

    // The rejection guard stops it at the gate every import passes through, so
    // the caller is told why rather than told it worked.
    const refused = sonarrOf(planned).error;
    expect(refused?.code).toBe("upstream_rejection");
    expect(refused?.message).toContain("Episodes not selected");
    // And nothing was submitted. This is the assertion the whole file is for:
    // an import command carrying series 13 and episode 1001 would have attached
    // one series' episode to another on the operator's own disk.
    expect(instance.commands).toEqual([]);
  });

  it("carries the caller's own episodes where it names them", async () => {
    // The control for all three above: correcting the media is not what is
    // refused, and a caller that completes the mapping is not obstructed.
    const candidate = await scannedCandidate();
    const media = await seriesReference(correctedSeriesId);
    // An episode of the series the file is being moved to, which is the mapping
    // a caller completes rather than one carried over from the scan.
    const episode = await episodeReference(correctedSeriesId, correctedEpisodeId);

    await run(inspectTool, {
      source: "candidate_reprocess",
      candidate: candidate.reference,
      mapping: { media, episodes: [episode] },
      applications: ["sonarr"],
    });

    const sent = instance.reprocessed.at(-1);
    expect(sent?.seriesId).toBe(correctedSeriesId);
    expect(sent?.episodeIds).toEqual([correctedEpisodeId]);
    // The season travels with a mapping the caller completed: what is re-decided
    // is the mapping as a whole rather than the parts of it a caller named.
    expect(sent?.seasonNumber).toBe(1);
  });
});
