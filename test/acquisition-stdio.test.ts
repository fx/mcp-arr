import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import type { ApplicationId } from "../src/applications.js";
import {
  releaseGrabOutputSchema,
  releaseSearchOutputSchema,
} from "../src/tools/schemas/acquisition.js";
import type {
  ReleaseGrabResultData,
  ReleaseSearchResult,
} from "../src/tools/schemas/acquisition-results.js";
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
 * The search-to-grab transaction over the real transport.
 *
 * The properties under test are the ones only an end-to-end run can show: that
 * a release reference minted by one tool call is accepted by the next, that the
 * grab that follows carries the cache identity and nothing else onto the wire,
 * and that neither half of the exchange puts an API key, an instance address,
 * or a protected download URL on stdout.
 */

const started: FixtureInstance[] = [];

async function instance(
  application: ApplicationId,
  options: { unreachable?: boolean; staleGrabs?: readonly string[] } = {},
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

interface Envelope<TData> {
  readonly isError: boolean;
  readonly summary: string;
  readonly status: string;
  readonly applications: Array<{
    application: string;
    status: string;
    data?: TData;
    items?: Array<{ reference: string; status: string; error?: { code: string } }>;
    error?: { code: string; remediation: string };
  }>;
  readonly errors: Array<{ code: string; remediation: string }>;
  readonly mutation?: { plan?: string; receipt?: { reference: string; state: string } };
}

async function callTool<TData>(
  child: SpawnedStdioProcess,
  id: number,
  name: "arr_release_search" | "arr_release_grab",
  args: Record<string, unknown>,
): Promise<Envelope<TData>> {
  const called = (await child.request(id, "tools/call", {
    name,
    arguments: args,
  })) as CallResult;

  const structured = called.result?.structuredContent;
  const schema =
    name === "arr_release_search" ? releaseSearchOutputSchema : releaseGrabOutputSchema;
  expect(schema.safeParse(structured).success, name).toBe(true);
  expect(called.result?.content?.[0]?.type, name).toBe("text");

  const envelope = structured as Omit<Envelope<TData>, "isError" | "summary">;
  return {
    isError: called.result?.isError === true,
    summary: called.result?.content?.[0]?.text ?? "",
    ...envelope,
  };
}

/** The Sonarr episode reference a release search is run for. */
async function episodeReference(child: SpawnedStdioProcess, id: number): Promise<string> {
  const called = (await child.request(id, "tools/call", {
    name: "arr_library_query",
    arguments: { view: "episodes", series: await seriesReference(child, id - 1) },
  })) as CallResult;
  const structured = called.result?.structuredContent as {
    applications?: Array<{ data?: { items?: Array<{ reference: string }> } }>;
  };
  const reference = structured.applications?.[0]?.data?.items?.[0]?.reference;
  if (reference === undefined) {
    throw new Error("Expected an episode reference from the library query");
  }
  return reference;
}

async function seriesReference(child: SpawnedStdioProcess, id: number): Promise<string> {
  const called = (await child.request(id, "tools/call", {
    name: "arr_library_query",
    arguments: { view: "series" },
  })) as CallResult;
  const structured = called.result?.structuredContent as {
    applications?: Array<{ data?: { items?: Array<{ reference: string }> } }>;
  };
  const reference = structured.applications?.[0]?.data?.items?.[0]?.reference;
  if (reference === undefined) {
    throw new Error("Expected a series reference from the library query");
  }
  return reference;
}

describe("arr_release_search and arr_release_grab over stdio", () => {
  it("carries a search result into a grab and keeps stdout clean", async () => {
    const sonarr = await instance("sonarr");
    const child = spawnBuiltServer(instanceEnvironment([sonarr]), 10_000);

    try {
      await child.initializeSession(1, LATEST_PROTOCOL_VERSION);
      const episode = await episodeReference(child, 3);

      const search = await callTool<ReleaseSearchResult>(child, 4, "arr_release_search", {
        target: "sonarr_episode",
        episode,
      });
      expect(search.isError).toBe(false);
      expect(search.status).toBe("ok");
      const releases = search.applications[0]?.data?.releases ?? [];
      expect(releases.length).toBeGreaterThan(1);
      for (const release of releases) {
        expect(release.reference).toMatch(/^rel_/u);
      }

      const grab = await callTool<ReleaseGrabResultData>(child, 5, "arr_release_grab", {
        mode: "apply",
        releases: [releases[0]?.reference, releases[1]?.reference],
      });

      expect(grab.isError).toBe(false);
      expect(grab.status).toBe("ok");
      expect(grab.applications[0]?.data).toMatchObject({
        stage: "applied",
        requested: 2,
        accepted: 2,
      });
      expect(grab.mutation?.receipt?.state).toBe("succeeded");

      // The instance saw exactly the two cache identities and nothing a caller
      // could have authored.
      // Compared as sets: the two grabs run concurrently, so which one the
      // instance logs first is not something this server decides.
      expect(sonarr.grabs.map((entry) => entry.route)).toEqual(["release", "release"]);
      expect([...sonarr.grabs].map((entry) => entry.indexerId).sort()).toEqual([1, 2]);
      expect(new Set(sonarr.grabs.map((entry) => entry.guid)).size).toBe(2);

      await child.terminateGracefully();
      assertCleanProtocolStdout(child.stdout);
      expect(child.stderr).toBe("");
      expect(child.stdout).not.toContain(sonarr.apiKey);
      expect(child.stdout).not.toContain("127.0.0.1");
      // The GUID is what the reference replaces, so it must never have reached
      // the wire in the other direction either.
      for (const grabbed of sonarr.grabs) {
        expect(child.stdout).not.toContain(grabbed.guid);
      }
      for (const forbidden of ["downloadUrl", "magnetUrl", "infoUrl"]) {
        expect(child.stdout).not.toContain(forbidden);
      }
    } finally {
      await child.forceCleanup().catch(() => undefined);
    }
  }, 30_000);

  it("reports a per-release outcome when the instance's cache has moved on", async () => {
    // The second recorded release is the one the instance no longer holds.
    const sonarr = await instance("sonarr", { staleGrabs: ["example-indexer-b-2002"] });
    const child = spawnBuiltServer(instanceEnvironment([sonarr]), 10_000);

    try {
      await child.initializeSession(1, LATEST_PROTOCOL_VERSION);
      const episode = await episodeReference(child, 3);
      const search = await callTool<ReleaseSearchResult>(child, 4, "arr_release_search", {
        target: "sonarr_episode",
        episode,
      });
      const releases = search.applications[0]?.data?.releases ?? [];

      const grab = await callTool<ReleaseGrabResultData>(child, 5, "arr_release_grab", {
        mode: "apply",
        releases: releases.slice(0, 2).map((release) => release.reference),
      });

      expect(grab.status).toBe("partial");
      // Partial is not total failure: the accepted release still reaches a
      // caller that reads structured content.
      expect(grab.isError).toBe(false);
      expect(grab.applications[0]?.items?.map((item) => item.status)).toEqual(["ok", "error"]);
      expect(grab.applications[0]?.items?.[1]?.error?.code).toBe("stale_reference");
      expect(grab.applications[0]?.data).toMatchObject({ requested: 2, accepted: 1 });
      // A caller that reads only the summary still learns the code and what to
      // do about it.
      expect(grab.summary).toContain("stale_reference");
      expect(grab.summary).toContain("Repeat the query");

      await child.terminateGracefully();
      assertCleanProtocolStdout(child.stdout);
      expect(child.stderr).toBe("");
      expect(child.stdout).not.toContain(sonarr.apiKey);
    } finally {
      await child.forceCleanup().catch(() => undefined);
    }
  }, 30_000);

  it("refuses a grab reference it never issued without contacting the instance", async () => {
    const sonarr = await instance("sonarr");
    const child = spawnBuiltServer(instanceEnvironment([sonarr]), 10_000);

    try {
      await child.initializeSession(1, LATEST_PROTOCOL_VERSION);
      const grab = await callTool<ReleaseGrabResultData>(child, 2, "arr_release_grab", {
        mode: "apply",
        releases: ["rel_00000000"],
      });

      expect(grab.isError).toBe(true);
      expect(grab.errors[0]?.code).toBe("stale_reference");
      expect(sonarr.grabs).toEqual([]);

      await child.terminateGracefully();
      assertCleanProtocolStdout(child.stdout);
      expect(child.stderr).toBe("");
    } finally {
      await child.forceCleanup().catch(() => undefined);
    }
  }, 30_000);
});

describe("arr_search_start over stdio", () => {
  it("starts an allowlisted command and hands back a readable job", async () => {
    const sonarr = await instance("sonarr");
    const child = spawnBuiltServer(instanceEnvironment([sonarr]), 10_000);

    try {
      await child.initializeSession(1, LATEST_PROTOCOL_VERSION);
      const series = await seriesReference(child, 2);

      const started = (await child.request(3, "tools/call", {
        name: "arr_search_start",
        arguments: { target: "sonarr_series", mode: "apply", series },
      })) as CallResult;

      expect(started.result?.isError).toBe(false);
      const envelope = started.result?.structuredContent as {
        status: string;
        applications: Array<{
          data?: { stage: string; job?: { job: string; command?: { upstreamId: string } } };
        }>;
        mutation?: { job?: string; receipt?: { state: string } };
      };
      expect(envelope.status).toBe("ok");
      expect(envelope.applications[0]?.data?.stage).toBe("started");
      expect(envelope.mutation?.receipt?.state).toBe("succeeded");

      // The instance was asked for exactly the allowlisted command, and for
      // nothing a caller could have named.
      expect(sonarr.commands.map((entry) => entry.name)).toEqual(["SeriesSearch"]);
      expect(sonarr.commands[0]?.body).toEqual({ name: "SeriesSearch", seriesId: 12 });

      // The job reference the mutation returned is one arr_job_get resolves,
      // and reading it refreshes the projection from the instance's own record
      // of the command rather than answering from what the start observed.
      const job = envelope.mutation?.job;
      const read = (await child.request(4, "tools/call", {
        name: "arr_job_get",
        arguments: { job },
      })) as CallResult;
      expect(read.result?.isError).toBe(false);
      const projection = (
        read.result?.structuredContent as {
          applications: Array<{ data?: { job: string; status: string } }>;
        }
      ).applications[0]?.data;
      expect(projection?.job).toBe(job);
      expect(projection?.status).toBe("started");
      const upstreamId = envelope.applications[0]?.data?.job?.command?.upstreamId;
      expect(sonarr.requests).toContain(`command/${upstreamId}`);

      await child.terminateGracefully();
      assertCleanProtocolStdout(child.stdout);
      expect(child.stderr).toBe("");
      expect(child.stdout).not.toContain(sonarr.apiKey);
      expect(child.stdout).not.toContain("127.0.0.1");
    } finally {
      await child.forceCleanup().catch(() => undefined);
    }
  }, 30_000);

  it("runs a wanted-list search on the one application the published schema makes it name", async () => {
    const sonarr = await instance("sonarr");
    const radarr = await instance("radarr");
    const child = spawnBuiltServer(instanceEnvironment([sonarr, radarr]), 10_000);

    try {
      await child.initializeSession(1, LATEST_PROTOCOL_VERSION);
      // Exactly what the published schema and its generated documentation
      // describe, with both library applications configured. What is under test
      // is that reading the schema is enough: the call is accepted, and the one
      // job the envelope carries is a job on the one instance that was asked.
      const called = (await child.request(2, "tools/call", {
        name: "arr_search_start",
        arguments: {
          target: "missing",
          mode: "apply",
          application: "sonarr",
          monitoredOnly: true,
        },
      })) as CallResult;

      expect(called.result?.isError).toBe(false);
      const envelope = called.result?.structuredContent as {
        status: string;
        applications: Array<{ application: string; data?: { stage: string } }>;
        mutation?: { job?: string };
      };
      expect(envelope.status).toBe("ok");
      expect(envelope.applications.map((outcome) => outcome.application)).toEqual(["sonarr"]);
      expect(envelope.applications[0]?.data?.stage).toBe("started");
      expect(typeof envelope.mutation?.job).toBe("string");

      expect(sonarr.commands.map((entry) => entry.name)).toEqual(["MissingEpisodeSearch"]);
      // The application the caller did not name was never asked, which is what
      // makes one job reference and one receipt the whole record of the call.
      expect(radarr.commands).toEqual([]);

      await child.terminateGracefully();
      assertCleanProtocolStdout(child.stdout);
      expect(child.stderr).toBe("");
    } finally {
      await child.forceCleanup().catch(() => undefined);
    }
  }, 30_000);

  it("refuses a wanted-list search that names no application, before anything runs", async () => {
    const sonarr = await instance("sonarr");
    const radarr = await instance("radarr");
    const child = spawnBuiltServer(instanceEnvironment([sonarr, radarr]), 10_000);

    try {
      await child.initializeSession(1, LATEST_PROTOCOL_VERSION);
      // The call the schema used to advertise as valid by publishing the
      // selection as optional. It is now refused against the published contract
      // itself rather than by the dispatcher one layer later, so no reading of
      // the schema produces it in the first place.
      const called = (await child.request(2, "tools/call", {
        name: "arr_search_start",
        arguments: { target: "missing", mode: "apply", monitoredOnly: true },
      })) as CallResult;

      // Refused against the declared input schema, so the refusal names the
      // arguments rather than an outcome, and the call never became a dispatch
      // at all.
      expect(called.result?.isError).toBe(true);
      expect(called.result?.content?.[0]?.text ?? "").toContain(
        "Invalid arguments for tool arr_search_start",
      );
      expect(called.result?.structuredContent).toBeUndefined();
      expect(sonarr.commands).toEqual([]);
      expect(radarr.commands).toEqual([]);

      await child.terminateGracefully();
      assertCleanProtocolStdout(child.stdout);
      expect(child.stderr).toBe("");
    } finally {
      await child.forceCleanup().catch(() => undefined);
    }
  }, 30_000);
});
