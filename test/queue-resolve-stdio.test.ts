import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import type { ApplicationId } from "../src/applications.js";
import {
  activityQueryOutputSchema,
  queueResolveOutputSchema,
} from "../src/tools/schemas/activity.js";
import type { ActivityViewResult } from "../src/tools/schemas/activity-results.js";
import { fixturePathFor, loadFixture } from "./support/fixtures.js";
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
import { fixtureRoot } from "./support/tool-context.js";

/**
 * `arr_queue_resolve` over the transport, against running instances.
 *
 * These are the most consequential operations the server exposes — they remove
 * downloads, ask a download client to delete what it downloaded, and block
 * releases — so the assertions are about two things that are only observable
 * here. What actually reached the wire: each intent's exact flag combination,
 * taken from the request the instance received rather than from the compiler
 * that built it. And what did not: no upstream queue identifier, no
 * download-client identifier, and no canonical path, asserted against the raw
 * JSON the server sent.
 *
 * Every reference is obtained the way a caller obtains one, by querying the
 * queue first.
 */

const started: FixtureInstance[] = [];

async function instance(application: ApplicationId): Promise<FixtureInstance> {
  const running = await startFixtureInstance(application);
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

interface ResolveAnswer {
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
      readonly error?: { readonly code: string; readonly remediation: string };
    }>;
    readonly mutation?: {
      readonly requestedEffects: ReadonlyArray<{
        readonly summary: string;
        readonly severity: string;
      }>;
      readonly predictedEffects: ReadonlyArray<{ readonly summary: string }>;
      readonly plan?: string;
      readonly receipt?: { readonly reference: string; readonly state: string };
    };
  };
  /** The raw JSON the server sent, for asserting what did not cross the wire. */
  readonly raw: string;
}

async function resolve(
  child: SpawnedStdioProcess,
  id: number,
  args: Record<string, unknown>,
): Promise<ResolveAnswer> {
  const called = (await child.request(id, "tools/call", {
    name: "arr_queue_resolve",
    arguments: args,
  })) as CallResult;

  const structured = called.result?.structuredContent;
  const label = String(args.intent ?? "plan reference");
  expect(queueResolveOutputSchema.safeParse(structured).success, label).toBe(true);
  expect(called.result?.content?.[0]?.type, label).toBe("text");

  return {
    isError: called.result?.isError === true,
    summary: called.result?.content?.[0]?.text ?? "",
    structured: structured as ResolveAnswer["structured"],
    raw: JSON.stringify(called),
  };
}

/** The queue rows a caller would hold references for, in the order published. */
async function queueRows(
  child: SpawnedStdioProcess,
  id: number,
  application: "sonarr" | "radarr",
): Promise<ReadonlyArray<{ reference: string; kind: string; status: string }>> {
  const called = (await child.request(id, "tools/call", {
    name: "arr_activity_query",
    arguments: { view: "queue", applications: [application] },
  })) as CallResult;
  const structured = called.result?.structuredContent;
  expect(activityQueryOutputSchema.safeParse(structured).success).toBe(true);

  const envelope = structured as {
    applications: Array<{ application: string; data?: ActivityViewResult }>;
  };
  const data = envelope.applications.find((entry) => entry.application === application)?.data;
  if (data?.view !== "queue") {
    throw new Error(`Expected the ${application} queue view`);
  }
  return data.items.map((item) => ({
    reference: item.reference,
    kind: item.kind,
    status: item.evidence.status,
  }));
}

function referenceOf(
  rows: ReadonlyArray<{ reference: string; kind: string; status: string }>,
  predicate: (row: { kind: string; status: string }) => boolean,
  description: string,
): string {
  const row = rows.find((candidate) => predicate(candidate));
  if (row === undefined) {
    throw new Error(`The recorded queue holds no ${description}`);
  }
  return row.reference;
}

/**
 * The values the recorded queue holds that must never cross the transport: the
 * upstream queue identifier, the download-client identifier, and the canonical
 * path on the operator's disk.
 */
async function queueSecrets(): Promise<{
  queueItemId: number;
  downloadId: string;
  outputPath: string;
}> {
  const fixture = await loadFixture<Array<Record<string, unknown>>>(
    fixtureRoot,
    fixturePathFor("sonarr", "queue/details"),
  );
  const row = fixture.body.find((record) => record.status === "completed");
  if (row === undefined) {
    throw new Error("The recorded queue detail holds no completed row");
  }
  return {
    queueItemId: Number(row.id),
    downloadId: String(row.downloadId),
    outputPath: String(row.outputPath),
  };
}

const blockedImport = (row: { kind: string; status: string }): boolean =>
  row.kind === "tracked_download" && row.status === "completed";
const pendingRelease = (row: { kind: string; status: string }): boolean =>
  row.kind === "pending_release";

describe("arr_queue_resolve over stdio", () => {
  it("sends each tracked intent's exact flag combination", async () => {
    const sonarr = await instance("sonarr");
    const child = spawnBuiltServer(instanceEnvironment([sonarr]), 15_000);

    try {
      await child.initializeSession(1, LATEST_PROTOCOL_VERSION);

      // Ignoring the tracking: nothing removed, nothing blocked, no category
      // change, and no replacement search.
      const ignored = await resolve(child, 3, {
        intent: "ignore_tracking",
        mode: "apply",
        items: [referenceOf(await queueRows(child, 2, "sonarr"), blockedImport, "blocked import")],
      });
      expect(ignored.isError).toBe(false);
      expect(ignored.structured.mutation?.receipt?.state).toBe("succeeded");
      expect(sonarr.queueResolutions).toEqual([
        {
          queueItemId: 502,
          method: "DELETE",
          flags: {
            removeFromClient: "false",
            blocklist: "false",
            skipRedownload: "true",
            changeCategory: "false",
          },
        },
      ]);

      // Data deletion: the one flag that asks the client to delete what it
      // downloaded, disclosed as a destructive effect on the apply itself.
      const deleted = await resolve(child, 5, {
        intent: "remove_from_client_and_delete_data",
        mode: "apply",
        items: [
          referenceOf(
            await queueRows(child, 4, "sonarr"),
            (row) => row.kind === "tracked_download" && row.status === "downloading",
            "downloading item",
          ),
        ],
      });
      expect(deleted.isError).toBe(false);
      expect(sonarr.queueResolutions[1]?.queueItemId).toBe(501);
      expect(sonarr.queueResolutions[1]?.flags).toEqual({
        removeFromClient: "true",
        blocklist: "false",
        skipRedownload: "true",
        changeCategory: "false",
      });
      const destructive = deleted.structured.mutation?.requestedEffects.filter(
        (effect) => effect.severity === "destructive",
      );
      expect(destructive?.map((effect) => effect.summary).join(" ")).toContain(
        "delete the data it downloaded",
      );

      await child.terminateGracefully();
      assertCleanProtocolStdout(child.stdout);
      expect(child.stderr).toBe("");
    } finally {
      await child.forceCleanup().catch(() => undefined);
    }
  }, 30_000);

  it("carries the replacement-search choice into the blocklisting request", async () => {
    const radarr = await instance("radarr");
    const child = spawnBuiltServer(instanceEnvironment([radarr]), 15_000);

    try {
      await child.initializeSession(1, LATEST_PROTOCOL_VERSION);
      const rows = await queueRows(child, 2, "radarr");

      const suppressed = await resolve(child, 3, {
        intent: "blocklist_and_remove",
        mode: "apply",
        items: [referenceOf(rows, blockedImport, "tracked download")],
        replacementSearch: "suppress",
      });
      expect(suppressed.isError).toBe(false);
      // Suppressing the search is what `skipRedownload` says; allowing it is
      // the same request with that one flag false, which is why the choice is
      // required rather than defaulted.
      expect(radarr.queueResolutions[0]?.flags).toEqual({
        removeFromClient: "true",
        blocklist: "true",
        skipRedownload: "true",
        changeCategory: "false",
      });
      expect(
        suppressed.structured.mutation?.requestedEffects.map((effect) => effect.summary).join(" "),
      ).toContain("no replacement search is requested");

      await child.terminateGracefully();
      assertCleanProtocolStdout(child.stdout);
    } finally {
      await child.forceCleanup().catch(() => undefined);
    }
  }, 30_000);

  it("changes category without asking the client to remove anything", async () => {
    const sonarr = await instance("sonarr");
    const child = spawnBuiltServer(instanceEnvironment([sonarr]), 15_000);

    try {
      await child.initializeSession(1, LATEST_PROTOCOL_VERSION);
      const rows = await queueRows(child, 2, "sonarr");

      const recategorized = await resolve(child, 3, {
        intent: "change_category_mark_imported",
        mode: "apply",
        items: [referenceOf(rows, blockedImport, "blocked import")],
      });
      expect(recategorized.isError).toBe(false);
      expect(sonarr.queueResolutions[0]?.flags).toEqual({
        removeFromClient: "false",
        blocklist: "false",
        skipRedownload: "true",
        changeCategory: "true",
      });
      // The whole point of the intent: the download and its data stay put.
      expect(
        recategorized.structured.mutation?.requestedEffects.map((effect) => effect.severity),
      ).not.toContain("destructive");

      await child.terminateGracefully();
      assertCleanProtocolStdout(child.stdout);
    } finally {
      await child.forceCleanup().catch(() => undefined);
    }
  }, 30_000);

  it("grabs a pending release through its own route", async () => {
    const sonarr = await instance("sonarr");
    const child = spawnBuiltServer(instanceEnvironment([sonarr]), 15_000);

    try {
      await child.initializeSession(1, LATEST_PROTOCOL_VERSION);
      const rows = await queueRows(child, 2, "sonarr");

      const grabbed = await resolve(child, 3, {
        intent: "force_pending_grab",
        mode: "apply",
        items: [referenceOf(rows, pendingRelease, "pending release")],
      });
      expect(grabbed.isError, grabbed.summary).toBe(false);
      expect(sonarr.queueResolutions).toEqual([{ queueItemId: 503, method: "POST", flags: {} }]);

      await child.terminateGracefully();
      assertCleanProtocolStdout(child.stdout);
    } finally {
      await child.forceCleanup().catch(() => undefined);
    }
  }, 30_000);

  it("refuses a stale reference and a pending intent on a tracked download", async () => {
    const sonarr = await instance("sonarr");
    const child = spawnBuiltServer(instanceEnvironment([sonarr]), 15_000);

    try {
      await child.initializeSession(1, LATEST_PROTOCOL_VERSION);
      const rows = await queueRows(child, 2, "sonarr");
      const tracked = referenceOf(rows, blockedImport, "blocked import");

      // A pending-only intent on a tracked download is refused before any
      // upstream request, which is what the retained item kind is for.
      const misapplied = await resolve(child, 3, {
        intent: "force_pending_grab",
        mode: "apply",
        items: [tracked],
      });
      expect(misapplied.structured.applications[0]?.items?.[0]?.error?.code).toBe("invalid_input");
      expect(sonarr.queueResolutions).toEqual([]);

      // Resolved for real, so the instance no longer holds the row.
      const resolved = await resolve(child, 4, {
        intent: "ignore_tracking",
        mode: "apply",
        items: [tracked],
      });
      expect(resolved.isError).toBe(false);
      expect(sonarr.queueResolutions).toHaveLength(1);

      // The same reference under a different intent, so this is a fresh
      // mutation rather than a repeat answered from the first one's receipt.
      // The row it names is gone, which is a stale reference and not a
      // conflict: the remedy is to query the queue again.
      const stale = await resolve(child, 5, {
        intent: "change_category_mark_imported",
        mode: "apply",
        items: [tracked],
      });
      expect(stale.structured.applications[0]?.items?.[0]?.error?.code).toBe("stale_reference");
      // Nothing further reached the instance: the refusal happened while the
      // current state was being read, before any transition was sent.
      expect(sonarr.queueResolutions).toHaveLength(1);

      await child.terminateGracefully();
      assertCleanProtocolStdout(child.stdout);
    } finally {
      await child.forceCleanup().catch(() => undefined);
    }
  }, 30_000);

  it("carries no upstream identifier or canonical path across the transport", async () => {
    const sonarr = await instance("sonarr");
    const child = spawnBuiltServer(instanceEnvironment([sonarr]), 15_000);

    try {
      await child.initializeSession(1, LATEST_PROTOCOL_VERSION);
      const rows = await queueRows(child, 2, "sonarr");

      const planned = await resolve(child, 3, {
        intent: "blocklist_and_remove",
        mode: "plan",
        items: [referenceOf(rows, blockedImport, "blocked import")],
        replacementSearch: "allow",
      });
      const applied = await resolve(child, 4, {
        mode: "apply",
        plan: planned.structured.mutation?.plan,
      });

      // Read out of the recording rather than written here, so the assertion
      // cannot quietly stop naming what the instance actually serves. A
      // hand-written identifier that no fixture contains passes for the wrong
      // reason and proves nothing.
      const secrets = await queueSecrets();
      expect(secrets.downloadId).toMatch(/^[0-9a-f]{16,}$/u);
      expect(secrets.outputPath.startsWith("/")).toBe(true);

      // A control, because a no-leak assertion that cannot fail is the defect
      // it is meant to catch: the same matchers fire on a payload that does
      // carry these values.
      const leaked = JSON.stringify({
        queueItemId: secrets.queueItemId,
        downloadId: secrets.downloadId,
        outputPath: secrets.outputPath,
      });
      expect(leaked).toContain(secrets.downloadId);
      expect(leaked).toMatch(
        new RegExp(`[:\\[,]\\s*${String(secrets.queueItemId)}\\s*[,\\]}]`, "u"),
      );

      for (const answer of [planned, applied]) {
        expect(answer.raw).not.toContain(secrets.downloadId);
        expect(answer.raw).not.toContain(secrets.outputPath);
        expect(answer.raw).not.toContain(sonarr.apiKey);
        // Both spellings of the upstream identifier: quoted as a string and
        // bare as a JSON number, which the first form alone would miss.
        expect(answer.raw).not.toContain(`"${String(secrets.queueItemId)}"`);
        expect(answer.raw).not.toMatch(
          new RegExp(`[:\\[,]\\s*${String(secrets.queueItemId)}\\s*[,\\]}]`, "u"),
        );
      }
      expect(applied.structured.mutation?.receipt?.state).toBe("succeeded");

      await child.terminateGracefully();
      assertCleanProtocolStdout(child.stdout);
      expect(child.stderr).toBe("");
    } finally {
      await child.forceCleanup().catch(() => undefined);
    }
  }, 30_000);
});
