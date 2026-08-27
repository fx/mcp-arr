import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import type { ApplicationId } from "../src/applications.js";
import {
  libraryChangeOutputSchema,
  libraryQueryOutputSchema,
} from "../src/tools/schemas/library.js";
import type { LibraryViewResult } from "../src/tools/schemas/library-results.js";
import {
  type FixtureInstance,
  type FixtureInstanceOptions,
  instanceEnvironment,
  startFixtureInstance,
} from "./support/instance-server.js";
import { schemaFailures } from "./support/json-schema.js";
import {
  assertCleanProtocolStdout,
  type SpawnedStdioProcess,
  spawnBuiltServer,
} from "./support/spawned-stdio.js";
import { sampleReferences } from "./support/tool-context.js";

/**
 * `arr_library_change` over the transport, against running instances.
 *
 * The unit tests already hold each intent to what it sends. What only the
 * protocol boundary can answer is whether the surface a caller actually reaches
 * behaves the same: whether the mutation envelope survives serialization,
 * whether a receipt still answers a repeat after crossing two process
 * boundaries, and whether an instance that took a write and lost the answer is
 * distinguishable from one that never received it.
 *
 * Every reference here is obtained the way a caller obtains one — by running
 * `arr_library_query` first and using what it published. Nothing is hand-minted,
 * because a hand-minted reference would prove nothing about the surface.
 */

const started: FixtureInstance[] = [];

async function instance(
  application: ApplicationId,
  options: FixtureInstanceOptions = {},
): Promise<FixtureInstance> {
  const running = await startFixtureInstance(application, options);
  started.push(running);
  return running;
}

afterEach(async () => {
  await Promise.all(started.splice(0).map((running) => running.close()));
});

interface CallResult {
  result?: {
    isError?: boolean;
    content?: Array<{ type: string; text?: string }>;
    structuredContent?: unknown;
  };
}

interface ChangeAnswer {
  readonly isError: boolean;
  readonly summary: string;
  readonly structured: {
    readonly status: string;
    readonly applications: ReadonlyArray<{
      readonly application: string;
      readonly status: string;
      readonly warnings: readonly string[];
      readonly items?: ReadonlyArray<{
        readonly reference: string;
        readonly status: string;
        readonly warnings: readonly string[];
        readonly error?: { readonly code: string };
      }>;
      readonly error?: { readonly code: string };
    }>;
    readonly mutation?: {
      readonly requestedEffects: ReadonlyArray<{
        readonly severity: string;
        readonly summary: string;
      }>;
      readonly predictedEffects: ReadonlyArray<{ readonly summary: string }>;
      readonly plan?: string;
      readonly job?: string;
      readonly receipt?: { readonly reference: string; readonly state: string };
    };
  };
  /** The raw JSON the server sent, for asserting what did not cross the wire. */
  readonly raw: string;
}

async function change(
  child: SpawnedStdioProcess,
  id: number,
  args: Record<string, unknown>,
): Promise<ChangeAnswer> {
  const called = (await child.request(id, "tools/call", {
    name: "arr_library_change",
    arguments: args,
  })) as CallResult;

  const structured = called.result?.structuredContent;
  const label = String(args.intent ?? "plan reference");
  expect(libraryChangeOutputSchema.safeParse(structured).success, label).toBe(true);
  expect(called.result?.content?.[0]?.type, label).toBe("text");

  return {
    isError: called.result?.isError === true,
    summary: called.result?.content?.[0]?.text ?? "",
    structured: structured as ChangeAnswer["structured"],
    raw: JSON.stringify(called),
  };
}

/** One library view, read the way a caller reads one. */
async function view(
  child: SpawnedStdioProcess,
  id: number,
  args: Record<string, unknown>,
): Promise<LibraryViewResult> {
  const called = (await child.request(id, "tools/call", {
    name: "arr_library_query",
    arguments: args,
  })) as CallResult;
  const structured = called.result?.structuredContent;
  expect(libraryQueryOutputSchema.safeParse(structured).success).toBe(true);

  const envelope = structured as {
    applications: Array<{ application: string; data?: LibraryViewResult }>;
  };
  const data = envelope.applications.find((entry) => entry.data !== undefined)?.data;
  if (data === undefined) {
    throw new Error(`No library data for ${JSON.stringify(args)}`);
  }
  return data;
}

async function seriesByTitle(child: SpawnedStdioProcess, id: number, title: string) {
  const data = await view(child, id, {
    view: "series",
    detail: "full",
    applications: ["sonarr"],
  });
  if (data.view !== "series") {
    throw new Error("Expected the series view");
  }
  const record = data.items.find((item) => item.title === title);
  if (record === undefined) {
    throw new Error(`No recorded series named ${title}`);
  }
  return record;
}

async function lookupByTitle(child: SpawnedStdioProcess, id: number, title: string) {
  const data = await view(child, id, { view: "lookup", term: "example", applications: ["sonarr"] });
  if (data.view !== "lookup") {
    throw new Error("Expected the lookup view");
  }
  const found = data.items.find((item) => item.title === title);
  if (found?.reference === undefined) {
    throw new Error(`No lookup candidate named ${title}`);
  }
  return found.reference;
}

async function episodeFiles(child: SpawnedStdioProcess, id: number, series: string) {
  const data = await view(child, id, {
    view: "episode_files",
    series,
    detail: "full",
    applications: ["sonarr"],
  });
  if (data.view !== "episode_files") {
    throw new Error("Expected the episode files view");
  }
  return data.items;
}

function required(reference: string | undefined, what: string): string {
  return reference ?? `missing ${what} reference`;
}

function outcomeFor(answer: ChangeAnswer, application: ApplicationId) {
  return answer.structured.applications.find((entry) => entry.application === application);
}

async function finish(child: SpawnedStdioProcess): Promise<void> {
  await child.terminateGracefully();
  assertCleanProtocolStdout(child.stdout);
  expect(child.stderr).toBe("");
}

interface ToolListResult {
  result?: { tools?: Array<{ name: string; inputSchema?: Record<string, unknown> }> };
}

/**
 * A minimal argument object for each declared intent.
 *
 * Registering an intent publishes it, so every one of them has to survive the
 * conversion to the schema a host reads over `tools/list` — a variant that is
 * accepted in process and rejected by its own published schema is a contract a
 * caller cannot use. The shared sample set carries one entry per tool and so
 * exercises one variant; this covers the rest of this tool's union.
 */
const intentArguments: Readonly<Record<string, Record<string, unknown>>> = {
  add_media: {
    intent: "add_media",
    mode: "plan",
    application: "sonarr",
    lookup: sampleReferences.media,
    rootFolder: sampleReferences.configuration,
    qualityProfile: sampleReferences.configuration,
    monitor: "all",
    searchOnAdd: false,
  },
  set_monitoring: {
    intent: "set_monitoring",
    mode: "plan",
    items: [sampleReferences.media],
    monitored: true,
  },
  edit_media: {
    intent: "edit_media",
    mode: "plan",
    items: [sampleReferences.media],
    changes: { monitored: true },
  },
  delete_media: {
    intent: "delete_media",
    mode: "plan",
    items: [sampleReferences.media],
    deleteFiles: false,
    addImportListExclusion: false,
  },
  update_file_metadata: {
    intent: "update_file_metadata",
    mode: "plan",
    files: [sampleReferences.mediaFile],
    changes: { releaseGroup: "EXAMPLEGRP" },
  },
  delete_file: { intent: "delete_file", mode: "plan", files: [sampleReferences.mediaFile] },
  rename: { intent: "rename", mode: "plan", media: sampleReferences.media },
  move_media: {
    intent: "move_media",
    mode: "plan",
    media: sampleReferences.media,
    rootFolder: sampleReferences.configuration,
  },
};

describe("arr_library_change published contract", () => {
  it("publishes a schema that admits every registered intent and refuses what they reject", async () => {
    // Listing the published schemas contacts no instance, so a placeholder
    // configuration is all the server needs to start.
    const child = spawnBuiltServer(
      {
        SONARR_URL: "https://sonarr.example.invalid/sonarr",
        SONARR_API_KEY: "library-change-stdio-placeholder",
      },
      15_000,
    );
    let schema: Record<string, unknown> = {};
    try {
      await child.initializeSession(1, LATEST_PROTOCOL_VERSION);
      const listed = (await child.request(2, "tools/list")) as ToolListResult;
      schema =
        listed.result?.tools?.find((tool) => tool.name === "arr_library_change")?.inputSchema ?? {};
      await child.terminateGracefully();
    } finally {
      await child.forceCleanup().catch(() => undefined);
    }

    // Every intent the registry declares, checked against the schema a host
    // actually reads rather than against the one this process holds.
    expect(Object.keys(intentArguments).sort()).toEqual(
      [
        "add_media",
        "delete_file",
        "delete_media",
        "edit_media",
        "move_media",
        "rename",
        "set_monitoring",
        "update_file_metadata",
      ].sort(),
    );

    for (const [intent, args] of Object.entries(intentArguments)) {
      expect(schemaFailures(schema, args), `${intent} accepted`).toEqual([]);
      // A property this intent does not declare, and an apply form that
      // restates the intent alongside a plan reference: the tool refuses both,
      // so a schema that admitted either would tell a host something untrue.
      expect(
        schemaFailures(schema, { ...args, unexpectedProperty: 1 }),
        `${intent} extra`,
      ).not.toEqual([]);
      expect(
        schemaFailures(schema, { ...args, mode: "apply", plan: sampleReferences.plan }),
        `${intent} plan and intent`,
      ).not.toEqual([]);
    }

    // The plan-apply form on its own is the other half of the union.
    expect(
      schemaFailures(schema, { mode: "apply", plan: sampleReferences.plan }),
      "plan reference",
    ).toEqual([]);
    expect(
      schemaFailures(schema, { intent: "not_an_intent", mode: "plan" }),
      "undeclared intent",
    ).not.toEqual([]);
  }, 30_000);
});

describe("arr_library_change over stdio", () => {
  it("plans a monitoring change, applies the plan, and answers a repeat from its receipt", async () => {
    const sonarr = await instance("sonarr");
    const child = spawnBuiltServer(instanceEnvironment([sonarr]), 15_000);

    try {
      await child.initializeSession(1, LATEST_PROTOCOL_VERSION);
      const retired = await seriesByTitle(child, 2, "Example Retired Series");

      const planned = await change(child, 3, {
        intent: "set_monitoring",
        mode: "plan",
        items: [retired.reference],
        monitored: true,
      });
      expect(planned.isError).toBe(false);
      expect(planned.structured.mutation?.plan).toMatch(/^pln_/u);
      expect(planned.structured.mutation?.predictedEffects).toEqual([
        expect.objectContaining({ summary: "monitor 1 record(s)" }),
      ]);
      // Planning is not applying: the instance recorded no write.
      expect(sonarr.writes).toEqual([]);

      const applied = await change(child, 4, {
        mode: "apply",
        plan: required(planned.structured.mutation?.plan, "plan"),
      });
      expect(applied.isError).toBe(false);
      expect(applied.structured.mutation?.receipt?.state).toBe("succeeded");
      expect(outcomeFor(applied, "sonarr")?.items).toEqual([
        expect.objectContaining({ reference: retired.reference, status: "ok" }),
      ]);
      expect(sonarr.writes).toEqual([expect.objectContaining({ method: "PUT", route: "series" })]);
      expect(sonarr.writes[0]?.body).toMatchObject({ id: 14, monitored: true });

      // The same direct intent again is answered from the receipt the first one
      // settled, and nothing reaches the instance a second time.
      const repeated = await change(child, 5, {
        intent: "set_monitoring",
        mode: "apply",
        items: [retired.reference],
        monitored: true,
      });
      expect(repeated.structured.mutation?.receipt?.reference).toBe(
        applied.structured.mutation?.receipt?.reference,
      );
      expect(outcomeFor(repeated, "sonarr")?.warnings).toEqual([
        expect.stringContaining("already applied by this server"),
      ]);
      expect(sonarr.writes).toHaveLength(1);

      await finish(child);
    } finally {
      await child.forceCleanup().catch(() => undefined);
    }
  }, 30_000);

  it("refuses to add a candidate the library already holds", async () => {
    const sonarr = await instance("sonarr");
    const child = spawnBuiltServer(instanceEnvironment([sonarr]), 15_000);

    try {
      await child.initializeSession(1, LATEST_PROTOCOL_VERSION);
      const series = await seriesByTitle(child, 2, "Example Series");
      const duplicate = await lookupByTitle(child, 3, "Example Series");

      const applied = await change(child, 4, {
        intent: "add_media",
        mode: "apply",
        application: "sonarr",
        lookup: duplicate,
        rootFolder: required(series.rootFolder?.reference, "root folder"),
        qualityProfile: required(series.qualityProfile?.reference, "quality profile"),
        monitor: "all",
        searchOnAdd: false,
      });

      expect(applied.isError).toBe(true);
      expect(outcomeFor(applied, "sonarr")?.error?.code).toBe("conflict");
      expect(outcomeFor(applied, "sonarr")?.error).toMatchObject({ code: "conflict" });
      // Nothing was created, and the summary a host may show alone says so.
      expect(sonarr.writes).toEqual([]);
      expect(applied.summary).toContain("conflict");

      // The candidate the library does not hold is added, and the create really
      // carries the metadata identifier the instance matches on.
      const addable = await lookupByTitle(child, 5, "Example New Series");
      const added = await change(child, 6, {
        intent: "add_media",
        mode: "apply",
        application: "sonarr",
        lookup: addable,
        rootFolder: required(series.rootFolder?.reference, "root folder"),
        qualityProfile: required(series.qualityProfile?.reference, "quality profile"),
        monitor: "all",
        searchOnAdd: false,
      });
      expect(added.isError).toBe(false);
      expect(added.structured.mutation?.receipt?.state).toBe("succeeded");
      expect(sonarr.writes).toEqual([expect.objectContaining({ method: "POST", route: "series" })]);
      expect(sonarr.writes[0]?.body).toMatchObject({
        tvdbId: 100004,
        monitored: true,
        addOptions: { searchForMissingEpisodes: false },
      });
      // Search-on-add was declined, so no search command was started either.
      expect(sonarr.commands).toEqual([]);

      await finish(child);
    } finally {
      await child.forceCleanup().catch(() => undefined);
    }
  }, 30_000);

  it("returns the applied item and the stale one together", async () => {
    const sonarr = await instance("sonarr");
    const child = spawnBuiltServer(instanceEnvironment([sonarr]), 15_000);

    try {
      await child.initializeSession(1, LATEST_PROTOCOL_VERSION);
      const anime = await seriesByTitle(child, 2, "Example Anime");
      const retired = await seriesByTitle(child, 3, "Example Retired Series");

      // The record is removed through the tool itself, which is how a reference
      // published a moment ago comes to name something the instance no longer
      // holds.
      const removed = await change(child, 4, {
        intent: "delete_media",
        mode: "apply",
        items: [anime.reference],
        deleteFiles: false,
        addImportListExclusion: false,
      });
      expect(removed.isError).toBe(false);

      const applied = await change(child, 5, {
        intent: "set_monitoring",
        mode: "apply",
        items: [retired.reference, anime.reference],
        monitored: true,
      });

      expect(applied.structured.status).toBe("partial");
      expect(outcomeFor(applied, "sonarr")?.items).toEqual([
        expect.objectContaining({ reference: retired.reference, status: "ok" }),
        expect.objectContaining({
          reference: anime.reference,
          status: "error",
          error: expect.objectContaining({ code: "stale_reference" }),
        }),
      ]);
      // The item that could be changed still was: a bulk change is not
      // transactional and never claims to be.
      expect(sonarr.writes.filter((write) => write.method === "PUT")).toEqual([
        expect.objectContaining({ route: "series" }),
      ]);
      expect(applied.summary).toContain("1 item(s) failed");

      await finish(child);
    } finally {
      await child.forceCleanup().catch(() => undefined);
    }
  }, 30_000);

  it("sends both deletion choices explicitly, in each application's own spelling", async () => {
    const sonarr = await instance("sonarr");
    const radarr = await instance("radarr");
    const child = spawnBuiltServer(instanceEnvironment([sonarr, radarr]), 15_000);

    try {
      await child.initializeSession(1, LATEST_PROTOCOL_VERSION);
      const retired = await seriesByTitle(child, 2, "Example Retired Series");

      const kept = await change(child, 3, {
        intent: "delete_media",
        mode: "plan",
        items: [retired.reference],
        deleteFiles: false,
        addImportListExclusion: false,
      });
      // A deletion plan says what it destroys, and says it destructively.
      expect(kept.structured.mutation?.requestedEffects).toEqual([
        expect.objectContaining({
          severity: "destructive",
          summary: "remove 1 record(s) from the library",
        }),
      ]);
      expect(outcomeFor(kept, "sonarr")?.warnings).toEqual([
        expect.stringContaining("files are left on disk"),
      ]);

      await change(child, 4, {
        mode: "apply",
        plan: required(kept.structured.mutation?.plan, "plan"),
      });
      // Both choices travel, including the false one: leaving either out would
      // let the instance's own default decide something the caller had to.
      expect(sonarr.writes).toEqual([
        expect.objectContaining({
          method: "DELETE",
          route: "series",
          query: { deleteFiles: "false", addImportListExclusion: "false" },
        }),
      ]);

      const movies = await view(child, 5, {
        view: "movies",
        detail: "full",
        applications: ["radarr"],
      });
      if (movies.view !== "movies") {
        throw new Error("Expected the movies view");
      }
      const taken = await change(child, 6, {
        intent: "delete_media",
        mode: "apply",
        items: [required(movies.items[0]?.reference, "movie")],
        deleteFiles: true,
        addImportListExclusion: true,
      });
      expect(taken.isError).toBe(false);
      expect(taken.structured.mutation?.requestedEffects).toEqual([
        expect.objectContaining({ summary: "remove 1 record(s) from the library" }),
        expect.objectContaining({
          severity: "destructive",
          summary: "delete the files of 1 record(s) from disk",
        }),
        expect.objectContaining({
          summary: "exclude 1 record(s) from future import-list additions",
        }),
      ]);
      // Radarr spells the exclusion differently, and that is the adapter's
      // business rather than the caller's.
      expect(radarr.writes).toEqual([
        expect.objectContaining({
          method: "DELETE",
          route: "movie",
          query: { deleteFiles: "true", addImportExclusion: "true" },
        }),
      ]);

      await finish(child);
    } finally {
      await child.forceCleanup().catch(() => undefined);
    }
  }, 30_000);

  it("previews a rename without starting one, then renames exactly what it previewed", async () => {
    const sonarr = await instance("sonarr");
    const child = spawnBuiltServer(instanceEnvironment([sonarr]), 15_000);

    try {
      await child.initializeSession(1, LATEST_PROTOCOL_VERSION);
      const series = await seriesByTitle(child, 2, "Example Series");

      const planned = await change(child, 3, {
        intent: "rename",
        mode: "plan",
        media: series.reference,
      });
      expect(planned.isError).toBe(false);
      // The proposed paths are what a preview exists to return, and no command
      // was started to produce them.
      expect(outcomeFor(planned, "sonarr")?.warnings).toEqual([
        expect.stringContaining("Example Pilot Bluray-1080p.mkv to Season 01/"),
        expect.stringContaining("Example Follow Up WEBDL-720p.mkv to Season 02/"),
      ]);
      expect(sonarr.commands).toEqual([]);

      const renamed = await change(child, 4, {
        mode: "apply",
        plan: required(planned.structured.mutation?.plan, "plan"),
      });
      expect(renamed.isError).toBe(false);
      // Exactly one command, named by the allowlist, carrying exactly the files
      // the preview named.
      expect(sonarr.commands).toEqual([
        expect.objectContaining({
          name: "RenameFiles",
          body: expect.objectContaining({ seriesId: 12, files: [2001, 2003] }),
        }),
      ]);
      expect(renamed.structured.mutation?.job).toMatch(/^job_/u);

      // A move to the root folder the record is already under asks for nothing,
      // and a move that asks for nothing sends nothing.
      const settled = await change(child, 5, {
        intent: "move_media",
        mode: "apply",
        media: series.reference,
        rootFolder: required(series.rootFolder?.reference, "root folder"),
      });
      expect(settled.isError).toBe(false);
      expect(settled.structured.mutation?.requestedEffects).toEqual([]);
      expect(outcomeFor(settled, "sonarr")?.items).toEqual([
        expect.objectContaining({
          warnings: [expect.stringContaining("already under the selected root folder")],
        }),
      ]);
      expect(sonarr.commands).toHaveLength(1);

      await finish(child);
    } finally {
      await child.forceCleanup().catch(() => undefined);
    }
  }, 30_000);

  it("keeps a write whose answer was lost reconcilable rather than calling it failed", async () => {
    // The instance performs the write and then drops the connection, which is
    // the one case a caller cannot tell from a request that never arrived.
    const sonarr = await instance("sonarr", { loseWriteAnswers: true });
    const child = spawnBuiltServer(instanceEnvironment([sonarr]), 15_000);

    try {
      await child.initializeSession(1, LATEST_PROTOCOL_VERSION);
      const retired = await seriesByTitle(child, 2, "Example Retired Series");
      const intent = {
        intent: "set_monitoring",
        mode: "apply",
        items: [retired.reference],
        monitored: true,
      };

      const applied = await change(child, 3, intent);

      // The request was sent and the instance did perform it, so recording this
      // as a mutation that certainly did not happen would be the one direction
      // a receipt must never round in.
      expect(sonarr.writes).toHaveLength(1);
      expect(applied.structured.mutation?.receipt?.state).toBe("outcome_unknown");
      expect(applied.isError).toBe(true);
      expect(outcomeFor(applied, "sonarr")?.items).toEqual([
        expect.objectContaining({ status: "error" }),
      ]);

      // A repeat is answered from that receipt rather than sent again, which is
      // the whole point of not rounding down to a failure.
      const repeated = await change(child, 4, intent);
      expect(repeated.structured.mutation?.receipt?.reference).toBe(
        applied.structured.mutation?.receipt?.reference,
      );
      expect(sonarr.writes).toHaveLength(1);

      await finish(child);
    } finally {
      await child.forceCleanup().catch(() => undefined);
    }
  }, 30_000);

  it("records an apply that dispatched nothing as failed, and attempts it again", async () => {
    const sonarr = await instance("sonarr");
    const child = spawnBuiltServer(instanceEnvironment([sonarr]), 15_000);

    try {
      await child.initializeSession(1, LATEST_PROTOCOL_VERSION);
      const series = await seriesByTitle(child, 2, "Example Series");
      const files = await episodeFiles(child, 3, series.reference);
      const file = required(files[0]?.reference, "episode file");

      const deleted = await change(child, 4, {
        intent: "delete_file",
        mode: "apply",
        files: [file],
      });
      expect(deleted.isError).toBe(false);
      expect(sonarr.writes).toEqual([
        expect.objectContaining({ method: "DELETE", route: "episodefile" }),
      ]);

      // The file is gone, so a metadata edit naming it fails while reading and
      // dispatches nothing at all.
      const edited = await change(child, 5, {
        intent: "update_file_metadata",
        mode: "apply",
        files: [file],
        changes: { releaseGroup: "EXAMPLEALT" },
      });
      expect(edited.isError).toBe(true);
      expect(edited.structured.mutation?.receipt?.state).toBe("failed");
      expect(sonarr.writes).toHaveLength(1);

      // A failed receipt is the one state a later identical attempt may reuse,
      // so the repeat really is attempted again rather than answered from it.
      const before = sonarr.requests.filter((route) => route === "episodefile/2001").length;
      await change(child, 6, {
        intent: "update_file_metadata",
        mode: "apply",
        files: [file],
        changes: { releaseGroup: "EXAMPLEALT" },
      });
      expect(
        sonarr.requests.filter((route) => route === "episodefile/2001").length,
      ).toBeGreaterThan(before);

      await finish(child);
    } finally {
      await child.forceCleanup().catch(() => undefined);
    }
  }, 30_000);

  it("carries no upstream identifier, path, or credential across the transport", async () => {
    const sonarr = await instance("sonarr");
    const child = spawnBuiltServer(instanceEnvironment([sonarr]), 15_000);

    try {
      await child.initializeSession(1, LATEST_PROTOCOL_VERSION);
      const retired = await seriesByTitle(child, 2, "Example Retired Series");

      const planned = await change(child, 3, {
        intent: "edit_media",
        mode: "plan",
        items: [retired.reference],
        changes: { monitored: true, seriesType: "standard" },
      });
      const applied = await change(child, 4, {
        mode: "apply",
        plan: required(planned.structured.mutation?.plan, "plan"),
      });

      // The instance's own credential, the canonical paths its records carry,
      // and the upstream fields this project does not publish: none of them may
      // appear anywhere in what was sent, including inside an effect summary or
      // a read-set key.
      for (const sent of [planned.raw, applied.raw]) {
        expect(sent).not.toContain(sonarr.apiKey);
        expect(sent).not.toContain("/media/example");
        expect(sent).not.toContain("example-retired-series");
        expect(sent).not.toContain("127.0.0.1");
      }

      await finish(child);
    } finally {
      await child.forceCleanup().catch(() => undefined);
    }
  }, 30_000);
});
