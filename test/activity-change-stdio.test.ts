import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import type { ApplicationId } from "../src/applications.js";
import {
  activityChangeOutputSchema,
  activityQueryOutputSchema,
} from "../src/tools/schemas/activity.js";
import type { ActivityViewResult } from "../src/tools/schemas/activity-results.js";
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
 * `arr_activity_change` over the transport, against running instances.
 *
 * The point of exercising this at the protocol boundary rather than only in
 * process is that the two things most easily lost in between are exactly the
 * two this change must not lose: the mutation envelope a caller reads its
 * receipt from, and the guarantee that no upstream identifier or canonical path
 * ever crosses the wire. Both are asserted here on the raw JSON that was sent.
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
        readonly status: string;
        readonly warnings: readonly string[];
        readonly error?: { readonly code: string };
      }>;
      readonly error?: { readonly code: string; readonly remediation: string };
    }>;
    readonly mutation?: {
      readonly requestedEffects: ReadonlyArray<{ readonly summary: string }>;
      readonly predictedEffects: ReadonlyArray<{ readonly summary: string }>;
      readonly plan?: string;
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
    name: "arr_activity_change",
    arguments: args,
  })) as CallResult;

  const structured = called.result?.structuredContent;
  const label = String(args.intent ?? "plan reference");
  expect(activityChangeOutputSchema.safeParse(structured).success, label).toBe(true);
  expect(called.result?.content?.[0]?.type, label).toBe("text");

  return {
    isError: called.result?.isError === true,
    summary: called.result?.content?.[0]?.text ?? "",
    structured: structured as ChangeAnswer["structured"],
    raw: JSON.stringify(called),
  };
}

/** One record's published reference, taken from a real query answer. */
async function reference(
  child: SpawnedStdioProcess,
  id: number,
  view: "history" | "blocklist",
  index: number,
): Promise<string> {
  const called = (await child.request(id, "tools/call", {
    name: "arr_activity_query",
    arguments: { view, applications: ["sonarr"] },
  })) as CallResult;
  const structured = called.result?.structuredContent;
  expect(activityQueryOutputSchema.safeParse(structured).success).toBe(true);

  const envelope = structured as {
    applications: Array<{ application: string; data?: ActivityViewResult }>;
  };
  const data = envelope.applications.find((entry) => entry.application === "sonarr")?.data;
  if (data?.view !== view) {
    throw new Error(`Expected the sonarr ${view} view`);
  }
  const record = data.items[index];
  if (record === undefined) {
    throw new Error(`Expected a ${view} record at index ${index}`);
  }
  return record.reference;
}

describe("arr_activity_change over stdio", () => {
  it("plans and applies both intents against a running instance", async () => {
    const sonarr = await instance("sonarr");
    const child = spawnBuiltServer(instanceEnvironment([sonarr]), 15_000);

    try {
      await child.initializeSession(1, LATEST_PROTOCOL_VERSION);
      const grabbed = await reference(child, 2, "history", 0);
      const blocked = await reference(child, 3, "blocklist", 0);

      const planned = await change(child, 4, {
        intent: "mark_history_failed",
        mode: "plan",
        records: [grabbed],
      });
      expect(planned.isError).toBe(false);
      expect(planned.structured.mutation?.plan).toMatch(/^pln_/u);
      expect(
        planned.structured.mutation?.requestedEffects.map((effect) => effect.summary).join(" "),
      ).toContain("blocklist");
      // Planning is not applying: the instance recorded no write.
      expect(sonarr.failedHistory).toEqual([]);

      const failed = await change(child, 5, {
        intent: "mark_history_failed",
        mode: "apply",
        records: [grabbed],
      });
      expect(failed.isError).toBe(false);
      expect(failed.structured.mutation?.receipt?.state).toBe("succeeded");
      expect(sonarr.failedHistory).toEqual([9001]);

      const removed = await change(child, 6, {
        intent: "remove_blocklist_record",
        mode: "apply",
        records: [blocked],
      });
      expect(removed.isError).toBe(false);
      expect(removed.structured.mutation?.receipt?.state).toBe("succeeded");
      expect(sonarr.removedBlocklist).toEqual([7001]);
      // Disclosed on the apply itself, not only in a plan: a caller that
      // applies directly never reads a plan's predictions, and "remove" is the
      // word most easily mistaken for deletion.
      expect(
        removed.structured.mutation?.requestedEffects.map((effect) => effect.summary),
      ).toContain(
        "no media file, download-client payload, or queue item is removed by this change",
      );

      // Neither mutation touched media, the queue, or the download client.
      expect(sonarr.requests.some((route) => route.startsWith("queue"))).toBe(false);
      expect(sonarr.requests.some((route) => route.startsWith("series"))).toBe(false);
      expect(sonarr.grabs).toEqual([]);
      expect(sonarr.commands).toEqual([]);
      await child.terminateGracefully();
      assertCleanProtocolStdout(child.stdout);
      expect(child.stderr).toBe("");
    } finally {
      await child.forceCleanup().catch(() => undefined);
    }
  }, 30_000);

  it("carries no upstream identifier or canonical path across the transport", async () => {
    const sonarr = await instance("sonarr");
    const child = spawnBuiltServer(instanceEnvironment([sonarr]), 15_000);

    try {
      await child.initializeSession(1, LATEST_PROTOCOL_VERSION);
      const grabbed = await reference(child, 2, "history", 0);

      const applied = await change(child, 3, {
        intent: "mark_history_failed",
        mode: "apply",
        records: [grabbed],
      });

      // The download-client identifier the recorded grab carries, the paths its
      // import event names, and the instance's own credential: none of them may
      // appear anywhere in what was sent, including inside an effect summary.
      expect(applied.raw).not.toContain("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0");
      expect(applied.raw).not.toContain("/media/example");
      expect(applied.raw).not.toContain(sonarr.apiKey);
      // Nor the upstream record identifier the reference stands in for.
      expect(applied.raw).not.toContain("9001");
      await child.terminateGracefully();
      assertCleanProtocolStdout(child.stdout);
      expect(child.stderr).toBe("");
    } finally {
      await child.forceCleanup().catch(() => undefined);
    }
  }, 30_000);

  it("reports a stale reference in the summary a caller may be reading alone", async () => {
    const sonarr = await instance("sonarr");
    const child = spawnBuiltServer(instanceEnvironment([sonarr]), 15_000);

    try {
      await child.initializeSession(1, LATEST_PROTOCOL_VERSION);
      const blocked = await reference(child, 2, "blocklist", 0);

      await change(child, 3, {
        intent: "remove_blocklist_record",
        mode: "apply",
        records: [blocked],
      });
      // The record is gone now, so planning the same removal has nothing to act
      // on and says so per item.
      const planned = await change(child, 4, {
        intent: "remove_blocklist_record",
        mode: "plan",
        records: [blocked],
      });

      const outcome = planned.structured.applications.find(
        (entry) => entry.application === "sonarr",
      );
      expect(outcome?.items?.[0]?.error?.code).toBe("stale_reference");
      expect(planned.structured.mutation?.predictedEffects).toEqual([]);
      expect(sonarr.removedBlocklist).toEqual([7001]);
      await child.terminateGracefully();
      assertCleanProtocolStdout(child.stdout);
      expect(child.stderr).toBe("");
    } finally {
      await child.forceCleanup().catch(() => undefined);
    }
  }, 30_000);
});
