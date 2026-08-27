import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { importExecuteOutputSchema } from "../src/tools/schemas/acquisition.js";
import {
  type FixtureInstance,
  instanceEnvironment,
  startFixtureInstance,
} from "./support/instance-server.js";
import {
  assertCleanProtocolStdout,
  type SpawnedStdioProcess,
  spawnBuiltServer,
} from "./support/spawned-stdio.js";

/**
 * Manual import over the protocol, against a running instance double.
 *
 * What only the wire can show is asserted here: that a candidate reaches the
 * caller as a reference and never as a path, that planning an import moves no
 * file, that applying one submits exactly one `ManualImport` carrying the path
 * the caller was never given, and that the job which comes back is followable.
 * The refusals are here too, because each is a promise about a file on
 * somebody's disk: a candidate the library already holds, and a reference this
 * process never issued.
 */

const started: FixtureInstance[] = [];

async function instance(): Promise<FixtureInstance> {
  const running = await startFixtureInstance("sonarr", {});
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

interface Envelope {
  readonly status: string;
  readonly mutation?: {
    readonly plan?: string;
    readonly requestedEffects?: readonly { readonly severity: string; readonly summary: string }[];
    readonly receipt?: { readonly state: string };
  };
  readonly errors?: readonly { readonly code: string }[];
  readonly applications: readonly {
    readonly application: string;
    readonly status: string;
    readonly data?: {
      readonly files?: readonly { readonly reference: string }[];
      readonly importMode?: string;
      readonly job?: unknown;
    };
    readonly items?: readonly { readonly reference: string; readonly status: string }[];
    readonly warnings?: readonly string[];
    readonly error?: { readonly code: string };
  }[];
}

async function inspect(
  child: SpawnedStdioProcess,
  id: number,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; structured: unknown }> {
  const called = (await child.request(id, "tools/call", {
    name: "arr_import_inspect",
    arguments: args,
  })) as CallResult;
  return { isError: called.result?.isError === true, structured: called.result?.structuredContent };
}

async function execute(
  child: SpawnedStdioProcess,
  id: number,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; envelope: Envelope }> {
  const called = (await child.request(id, "tools/call", {
    name: "arr_import_execute",
    arguments: args,
  })) as CallResult;
  const structured = called.result?.structuredContent;
  expect(importExecuteOutputSchema.safeParse(structured).success, String(args.mode)).toBe(true);
  expect(called.result?.content?.[0]?.type).toBe("text");
  return { isError: called.result?.isError === true, envelope: structured as Envelope };
}

interface InspectedCandidate {
  readonly reference: string;
  readonly fileName?: string;
  readonly existingLibraryFile?: boolean;
  readonly decision?: { readonly importable: boolean };
}

function candidatesOf(structured: unknown): readonly InspectedCandidate[] {
  const envelope = structured as {
    applications?: readonly { data?: { candidates?: readonly InspectedCandidate[] } }[];
  };
  return envelope.applications?.[0]?.data?.candidates ?? [];
}

describe("arr_import_execute over stdio", () => {
  it("plans an import without moving anything, then applies it as one command", async () => {
    const sonarr = await instance();
    const child = spawnBuiltServer(instanceEnvironment([sonarr]), 10_000);

    try {
      await child.initializeSession(1, LATEST_PROTOCOL_VERSION);
      const inspected = await inspect(child, 2, {
        source: "queue_item",
        queue: await queueReference(child, 90),
        applications: ["sonarr"],
      });
      const importable = candidatesOf(inspected.structured).find(
        (candidate) => candidate.decision?.importable === true,
      );
      if (importable === undefined) {
        throw new Error("Expected an importable candidate in the recorded scan");
      }
      // A candidate is named by reference, and its file by name alone.
      expect(importable.reference).toMatch(/^imp_/u);
      expect(JSON.stringify(inspected.structured)).not.toContain("/media/example/downloads");

      const planned = await execute(child, 3, {
        mode: "plan",
        candidates: [importable.reference],
        importMode: "move",
      });
      expect(planned.isError).toBe(false);
      expect(planned.envelope.mutation?.plan).toMatch(/^pln_/u);
      const effects = planned.envelope.mutation?.requestedEffects ?? [];
      expect(effects.some((effect) => effect.severity === "destructive")).toBe(true);
      // A tracked download in a mode that is not `copy` is presented as
      // potentially source-consuming, which the specification requires.
      expect(JSON.stringify(effects)).toContain("consume the source");
      // Planning sends no command.
      expect(sonarr.commands).toEqual([]);

      const applied = await execute(child, 4, {
        mode: "apply",
        candidates: [importable.reference],
        importMode: "move",
      });
      expect(applied.isError).toBe(false);
      expect(applied.envelope.mutation?.receipt?.state).toBe("succeeded");
      expect(sonarr.commands).toHaveLength(1);
      const command = sonarr.commands[0];
      expect(command?.name).toBe("ManualImport");
      expect(JSON.stringify(command?.body)).toContain("/media/example/downloads");
      // The path went upstream and nowhere else.
      expect(JSON.stringify(applied.envelope)).not.toContain("/media/example/downloads");
      // The files the job is about, by reference and without a verdict: these
      // applications report one outcome for the whole command.
      expect(applied.envelope.applications[0]?.data?.files).toEqual([
        { reference: importable.reference },
      ]);
      expect(applied.envelope.applications[0]?.items).toBeUndefined();

      await child.terminateGracefully();
      assertCleanProtocolStdout(child.stdout);
      expect(child.stdout).not.toContain(sonarr.apiKey);
    } finally {
      await child.forceCleanup().catch(() => undefined);
    }
  });

  it("imports a candidate named twice exactly once", async () => {
    const sonarr = await instance();
    const child = spawnBuiltServer(instanceEnvironment([sonarr]), 10_000);

    try {
      await child.initializeSession(1, LATEST_PROTOCOL_VERSION);
      const inspected = await inspect(child, 2, {
        source: "queue_item",
        queue: await queueReference(child, 90),
        applications: ["sonarr"],
      });
      const importable = candidatesOf(inspected.structured).find(
        (candidate) => candidate.decision?.importable === true,
      );
      if (importable === undefined) {
        throw new Error("Expected an importable candidate in the recorded scan");
      }

      const applied = await execute(child, 3, {
        mode: "apply",
        candidates: [importable.reference, importable.reference],
        importMode: "copy",
      });

      expect(applied.isError).toBe(false);
      // One file in the command, and its size counted once against the
      // destination rather than twice.
      const files = (sonarr.commands[0]?.body as { files?: readonly unknown[] }).files ?? [];
      expect(files).toHaveLength(1);
      expect(applied.envelope.applications[0]?.data?.files).toEqual([
        { reference: importable.reference },
      ]);
      expect(JSON.stringify(applied.envelope.applications[0]?.warnings)).toContain(
        "named more than once",
      );

      await child.terminateGracefully();
      assertCleanProtocolStdout(child.stdout);
    } finally {
      await child.forceCleanup().catch(() => undefined);
    }
  });

  it("refuses a candidate the library already holds and imports nothing", async () => {
    const sonarr = await instance();
    const child = spawnBuiltServer(instanceEnvironment([sonarr]), 10_000);

    try {
      await child.initializeSession(1, LATEST_PROTOCOL_VERSION);
      const inspected = await inspect(child, 2, {
        source: "queue_item",
        queue: await queueReference(child, 90),
        applications: ["sonarr"],
      });
      const blocked = candidatesOf(inspected.structured).find(
        (candidate) => candidate.decision?.importable === false,
      );
      if (blocked === undefined) {
        throw new Error("Expected a candidate the instance refuses");
      }

      const applied = await execute(child, 3, {
        mode: "apply",
        candidates: [blocked.reference],
        importMode: "auto",
      });

      expect(applied.isError).toBe(true);
      // The instance's own refusal, and no command at all.
      expect(applied.envelope.applications[0]?.error?.code).toBe("upstream_rejection");
      expect(sonarr.commands).toEqual([]);

      await child.terminateGracefully();
      assertCleanProtocolStdout(child.stdout);
    } finally {
      await child.forceCleanup().catch(() => undefined);
    }
  });

  it("refuses a candidate reference this process never issued", async () => {
    const sonarr = await instance();
    const child = spawnBuiltServer(instanceEnvironment([sonarr]), 10_000);

    try {
      await child.initializeSession(1, LATEST_PROTOCOL_VERSION);
      // A well-formed token from another process lifetime: references live in
      // memory, so a restart invalidates every one of them, and an import is
      // the last place that should be discovered late.
      const applied = await execute(child, 2, {
        mode: "apply",
        candidates: ["imp_00000000000000000000000000000000"],
        importMode: "auto",
      });

      expect(applied.isError).toBe(true);
      // Refused by the dispatcher before any application was reached, so the
      // refusal is the call's rather than one instance's.
      expect(applied.envelope.errors?.map((error) => error.code)).toEqual(["stale_reference"]);
      expect(applied.envelope.applications).toEqual([]);
      expect(sonarr.commands).toEqual([]);

      await child.terminateGracefully();
      assertCleanProtocolStdout(child.stdout);
    } finally {
      await child.forceCleanup().catch(() => undefined);
    }
  });
});

/**
 * The reference of the recorded tracked download, read the way a caller does.
 *
 * Taken from a real answer rather than constructed, because a reference this
 * process did not mint is exactly what the last test in this file is about.
 */
async function queueReference(child: SpawnedStdioProcess, id: number): Promise<string> {
  const called = (await child.request(id, "tools/call", {
    name: "arr_activity_query",
    arguments: { view: "queue", applications: ["sonarr"] },
  })) as CallResult;
  const envelope = called.result?.structuredContent as
    | {
        applications?: readonly {
          data?: { view?: string; items?: readonly { id: string; reference: string }[] };
        }[];
      }
    | undefined;
  const items = envelope?.applications?.[0]?.data?.items ?? [];
  const row = items.find((item) => item.id === "502") ?? items[0];
  if (row === undefined) {
    throw new Error("Expected a queue reference from the recorded queue");
  }
  return row.reference;
}
