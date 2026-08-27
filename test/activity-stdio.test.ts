import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { activityViewApplications, activityViews } from "../src/adapters/activity/requests.js";
import type { ApplicationId } from "../src/applications.js";
import { activityQueryOutputSchema } from "../src/tools/schemas/activity.js";
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

const started: FixtureInstance[] = [];

async function instance(
  application: ApplicationId,
  options: { unreachable?: boolean } = {},
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

interface Outcome {
  application: string;
  status: string;
  data?: ActivityViewResult;
  continuation?: { returned: number; hasMore: boolean };
  error?: { code: string; remediation: string };
}

/**
 * Calls the tool over the protocol and holds the answer to the whole published
 * contract: a text summary, structured content, and structured content that
 * satisfies the output schema the host received from `tools/list`.
 */
async function query(
  child: SpawnedStdioProcess,
  id: number,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; summary: string; outcomes: Outcome[]; status: string }> {
  const called = (await child.request(id, "tools/call", {
    name: "arr_activity_query",
    arguments: args,
  })) as CallResult;

  const structured = called.result?.structuredContent;
  const label = String(args.view);
  expect(activityQueryOutputSchema.safeParse(structured).success, label).toBe(true);
  expect(called.result?.content?.[0]?.type, label).toBe("text");

  const envelope = structured as { status: string; applications: Outcome[] };
  return {
    isError: called.result?.isError === true,
    summary: called.result?.content?.[0]?.text ?? "",
    outcomes: envelope.applications,
    status: envelope.status,
  };
}

/** The item count a view answered with, whichever shape that view returns. */
function returned(data: ActivityViewResult | undefined): number {
  if (data === undefined) {
    return 0;
  }
  if (data.view === "queue_status") {
    return 1;
  }
  return data.view === "queue_details" ? 1 : data.items.length;
}

describe("arr_activity_query over stdio", () => {
  it("answers every view from running instances and keeps stdout clean", async () => {
    const sonarr = await instance("sonarr");
    const radarr = await instance("radarr");
    const prowlarr = await instance("prowlarr");
    const child = spawnBuiltServer(instanceEnvironment([sonarr, radarr, prowlarr]), 10_000);

    try {
      await child.initializeSession(1, LATEST_PROTOCOL_VERSION);

      // The focused read needs a reference the queue view mints, so it is taken
      // from a real answer rather than constructed.
      const queue = (await query(child, 2, { view: "queue" })).outcomes.find(
        (outcome) => outcome.application === "sonarr",
      )?.data;
      if (queue?.view !== "queue") {
        throw new Error("Expected the sonarr queue view");
      }
      const blocked = queue.items.find((item) => item.id === "502");
      if (blocked === undefined) {
        throw new Error("Expected the blocked row in the recorded queue");
      }

      const calls: Readonly<Record<string, Record<string, unknown>>> = {
        queue_status: { view: "queue_status" },
        queue: { view: "queue" },
        queue_details: { view: "queue_details", queue: blocked.reference },
        history: { view: "history" },
        blocklist: { view: "blocklist" },
        health: { view: "health" },
        commands: { view: "commands" },
        disk_space: { view: "disk_space" },
        indexer_status: { view: "indexer_status" },
        indexer_statistics: { view: "indexer_statistics" },
      };
      expect(Object.keys(calls).sort()).toEqual([...activityViews].sort());

      let id = 10;
      for (const view of activityViews) {
        id += 1;
        const answer = await query(child, id, calls[view] as Record<string, unknown>);

        expect(answer.isError, view).toBe(false);
        expect(answer.status, view).toBe("ok");
        expect(answer.summary, view).toContain("arr_activity_query");
        for (const outcome of answer.outcomes) {
          const label = `${view}/${outcome.application}`;
          expect(outcome.status, label).toBe("ok");
          expect(outcome.data?.view, label).toBe(view);
          expect(returned(outcome.data), label).toBeGreaterThan(0);
          expect(outcome.continuation?.returned, label).toBe(returned(outcome.data));
        }
        // A focused read is scoped by its reference; every other view fans out
        // to exactly the applications that model it.
        if (view !== "queue_details") {
          expect(
            answer.outcomes.map((outcome) => outcome.application),
            view,
          ).toEqual([...activityViewApplications[view]]);
        }
      }

      await child.terminateGracefully();
      assertCleanProtocolStdout(child.stdout);
      expect(child.stderr).toBe("");
      // Nothing configured and nothing about the host reaches the transport.
      expect(child.stdout).not.toContain(sonarr.apiKey);
      expect(child.stdout).not.toContain(radarr.apiKey);
      expect(child.stdout).not.toContain(prowlarr.apiKey);
      expect(child.stdout).not.toContain("127.0.0.1");
    } finally {
      await child.forceCleanup().catch(() => undefined);
    }
  }, 30_000);

  it("publishes no canonical path and no download identifier over the transport", async () => {
    // Both media applications, so the queue view fans out to every instance
    // that models it and every recorded queue crosses the boundary.
    const sonarr = await instance("sonarr");
    const radarr = await instance("radarr");
    const child = spawnBuiltServer(instanceEnvironment([sonarr, radarr]), 10_000);

    try {
      await child.initializeSession(1, LATEST_PROTOCOL_VERSION);
      const answer = await query(child, 2, { view: "queue", detail: "full" });
      expect(answer.status).toBe("ok");

      await child.terminateGracefully();
      assertCleanProtocolStdout(child.stdout);
      // The recorded queue carries both, and neither may cross the boundary.
      expect(child.stdout).not.toContain("/media/example");
      expect(child.stdout).not.toContain("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0");
      expect(child.stdout).not.toContain("outputPath");
    } finally {
      await child.forceCleanup().catch(() => undefined);
    }
  }, 30_000);

  it("reports an unavailable application beside the one that answered", async () => {
    const sonarr = await instance("sonarr");
    const radarr = await instance("radarr", { unreachable: true });
    const child = spawnBuiltServer(instanceEnvironment([sonarr, radarr]), 10_000);

    try {
      await child.initializeSession(1, LATEST_PROTOCOL_VERSION);
      const answer = await query(child, 2, { view: "queue_status" });

      expect(answer.status).toBe("partial");
      const failed = answer.outcomes.find((outcome) => outcome.application === "radarr");
      expect(failed?.status).toBe("unavailable");
      expect(failed?.error?.code).toBe("unavailable_application");
      expect(failed?.error?.remediation.length ?? 0).toBeGreaterThan(0);
      // The instance that answered is unaffected by the one that did not.
      expect(answer.outcomes.find((outcome) => outcome.application === "sonarr")?.status).toBe(
        "ok",
      );

      await child.terminateGracefully();
      assertCleanProtocolStdout(child.stdout);
      expect(child.stderr).toBe("");
    } finally {
      await child.forceCleanup().catch(() => undefined);
    }
  }, 30_000);

  it("rejects a stale queue reference without reaching the instance", async () => {
    const sonarr = await instance("sonarr");
    const child = spawnBuiltServer(instanceEnvironment([sonarr]), 10_000);

    try {
      await child.initializeSession(1, LATEST_PROTOCOL_VERSION);
      const before = sonarr.requests.length;
      const answer = await query(child, 2, {
        view: "queue_details",
        queue: `que_${"a".repeat(24)}`,
      });

      // A reference this server never minted is refused by the dispatcher, so
      // no upstream request is sent for it at all.
      expect(answer.status).toBe("error");
      expect(sonarr.requests.length).toBe(before);

      await child.terminateGracefully();
      assertCleanProtocolStdout(child.stdout);
    } finally {
      await child.forceCleanup().catch(() => undefined);
    }
  }, 30_000);
});
