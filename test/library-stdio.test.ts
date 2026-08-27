import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { libraryViews } from "../src/adapters/library/requests.js";
import type { ApplicationId } from "../src/applications.js";
import { libraryQueryOutputSchema } from "../src/tools/schemas/library.js";
import type { LibraryViewResult } from "../src/tools/schemas/library-results.js";
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

/**
 * Calls the tool over the protocol and holds the answer to the whole published
 * contract: a text summary, structured content, and structured content that
 * satisfies the output schema the host received from `tools/list`.
 */
async function query(
  child: SpawnedStdioProcess,
  id: number,
  args: Record<string, unknown>,
): Promise<{
  isError: boolean;
  summary: string;
  outcomes: Array<{
    application: string;
    status: string;
    data?: LibraryViewResult;
    continuation?: { returned: number; hasMore: boolean };
    error?: { code: string; remediation: string };
  }>;
  status: string;
}> {
  const called = (await child.request(id, "tools/call", {
    name: "arr_library_query",
    arguments: args,
  })) as CallResult;

  const structured = called.result?.structuredContent;
  const label = String(args.view);
  expect(libraryQueryOutputSchema.safeParse(structured).success, label).toBe(true);
  expect(called.result?.content?.[0]?.type, label).toBe("text");

  const envelope = structured as {
    status: string;
    applications: Array<{
      application: string;
      status: string;
      data?: LibraryViewResult;
      continuation?: { returned: number; hasMore: boolean };
      error?: { code: string; remediation: string };
    }>;
  };
  return {
    isError: called.result?.isError === true,
    summary: called.result?.content?.[0]?.text ?? "",
    outcomes: envelope.applications,
    status: envelope.status,
  };
}

function only<TValue>(values: readonly TValue[], label: string): TValue {
  const first = values[0];
  if (values.length !== 1 || first === undefined) {
    throw new Error(`Expected exactly one ${label}, got ${values.length}`);
  }
  return first;
}

describe("arr_library_query over stdio", () => {
  it("answers every view from a running instance and keeps stdout clean", async () => {
    const sonarr = await instance("sonarr");
    const radarr = await instance("radarr");
    const child = spawnBuiltServer(instanceEnvironment([sonarr, radarr]), 10_000);

    try {
      await child.initializeSession(1, LATEST_PROTOCOL_VERSION);

      const series = only((await query(child, 2, { view: "series" })).outcomes, "series outcome");
      const movies = only((await query(child, 3, { view: "movies" })).outcomes, "movies outcome");
      const seriesData = series.data;
      const moviesData = movies.data;
      if (seriesData?.view !== "series" || moviesData?.view !== "movies") {
        throw new Error("Expected the series and movies views");
      }
      const seriesReference = seriesData.items.find((item) => item.id === "12")?.reference;
      const movieReference = moviesData.items.find((item) => item.id === "8")?.reference;
      if (seriesReference === undefined || movieReference === undefined) {
        throw new Error("Expected references for the recorded series and movie");
      }

      /** One call per view, so every registered view is exercised end to end. */
      const calls: Readonly<Record<string, Record<string, unknown>>> = {
        series: { view: "series" },
        seasons: { view: "seasons", series: seriesReference },
        episodes: { view: "episodes", series: seriesReference },
        episode_files: { view: "episode_files", series: seriesReference },
        missing_episodes: { view: "missing_episodes" },
        cutoff_unmet_episodes: { view: "cutoff_unmet_episodes" },
        movies: { view: "movies" },
        collections: { view: "collections" },
        movie_files: { view: "movie_files", movie: movieReference },
        missing_movies: { view: "missing_movies" },
        cutoff_unmet_movies: { view: "cutoff_unmet_movies" },
        calendar: { view: "calendar", start: "2026-01-01", end: "2026-03-01" },
        lookup: { view: "lookup", term: "example" },
      };
      expect(Object.keys(calls).sort()).toEqual([...libraryViews].sort());

      let id = 10;
      for (const view of libraryViews) {
        id += 1;
        const answer = await query(child, id, calls[view] as Record<string, unknown>);

        expect(answer.isError, view).toBe(false);
        expect(answer.status, view).toBe("ok");
        expect(answer.summary, view).toContain("arr_library_query");
        for (const outcome of answer.outcomes) {
          expect(outcome.status, `${view}/${outcome.application}`).toBe("ok");
          expect(outcome.data?.view, `${view}/${outcome.application}`).toBe(view);
          expect(outcome.data?.items.length ?? 0, `${view}/${outcome.application}`).toBeGreaterThan(
            0,
          );
          expect(outcome.continuation?.returned, `${view}/${outcome.application}`).toBe(
            outcome.data?.items.length,
          );
        }
      }

      await child.terminateGracefully();
      assertCleanProtocolStdout(child.stdout);
      expect(child.stderr).toBe("");
      expect(child.stdout).not.toContain(sonarr.apiKey);
      expect(child.stdout).not.toContain(radarr.apiKey);
      expect(child.stdout).not.toContain("127.0.0.1");
    } finally {
      await child.forceCleanup().catch(() => undefined);
    }
  }, 30_000);

  it("reports each application separately when only one of them is configured", async () => {
    const sonarr = await instance("sonarr");
    const child = spawnBuiltServer(instanceEnvironment([sonarr]), 10_000);

    try {
      await child.initializeSession(1, LATEST_PROTOCOL_VERSION);
      const answer = await query(child, 2, {
        view: "calendar",
        start: "2026-01-01",
        end: "2026-03-01",
      });

      // A cross-application view names both applications, so the unconfigured
      // one is reported rather than quietly dropped from the result.
      expect(answer.status).toBe("partial");
      expect(answer.outcomes.map((outcome) => [outcome.application, outcome.status])).toEqual([
        ["sonarr", "ok"],
        ["radarr", "unconfigured"],
      ]);
      expect(answer.outcomes[1]?.error?.code).toBe("unconfigured_application");
      expect(answer.outcomes[1]?.error?.remediation).toBeTruthy();
      // Partial is not total failure: the successful half still reaches a
      // caller that reads structured content.
      expect(answer.isError).toBe(false);
      expect(answer.outcomes[0]?.data?.view).toBe("calendar");

      const sonarrOnly = await query(child, 3, { view: "movies" });
      expect(sonarrOnly.status).toBe("error");
      expect(sonarrOnly.outcomes.map((outcome) => outcome.error?.code)).toEqual([
        "unconfigured_application",
      ]);

      await child.terminateGracefully();
      assertCleanProtocolStdout(child.stdout);
      expect(child.stderr).toBe("");
    } finally {
      await child.forceCleanup().catch(() => undefined);
    }
  }, 30_000);

  it("never conceals one unreachable instance behind the other's results", async () => {
    const sonarr = await instance("sonarr");
    const radarr = await instance("radarr", { unreachable: true });
    const child = spawnBuiltServer(instanceEnvironment([sonarr, radarr]), 10_000);

    try {
      await child.initializeSession(1, LATEST_PROTOCOL_VERSION);
      const answer = await query(child, 2, { view: "lookup", term: "example" });

      expect(answer.status).toBe("partial");
      expect(answer.outcomes.map((outcome) => [outcome.application, outcome.status])).toEqual([
        ["sonarr", "ok"],
        ["radarr", "unavailable"],
      ]);
      expect(answer.outcomes[0]?.data?.view).toBe("lookup");
      expect(answer.outcomes[1]?.error?.code).toBe("unavailable_application");
      expect(answer.outcomes[1]?.error?.remediation).toBeTruthy();
      // The failed half has to be actionable from the text a host shows, and
      // the stdout assertions below cover that text too: carrying the code and
      // the hint into the summary must not carry the instance with them.
      expect(answer.summary).toContain(
        "errors: unavailable_application (Confirm the instance is running and reachable, then retry; other applications are unaffected.)",
      );

      await child.terminateGracefully();
      assertCleanProtocolStdout(child.stdout);
      expect(child.stderr).toBe("");
      expect(child.stdout).not.toContain(radarr.apiKey);
      expect(child.stdout).not.toContain("127.0.0.1");
    } finally {
      await child.forceCleanup().catch(() => undefined);
    }
  }, 30_000);
});

interface CapabilitySnapshot {
  readonly state: string;
  readonly views: readonly (string | undefined)[];
}

interface CapabilityAnswer {
  readonly summary: string;
  readonly byApplication: Record<string, CapabilitySnapshot>;
}

/**
 * The operator's first call, over the same launch path a host uses.
 *
 * Every configuration here is a real one an operator can end up in, and the
 * answer has to be true of it: an instance that is running, one that is not,
 * and one that was never configured are three different reports, not one
 * hedged report.
 */
async function capabilities(instances: readonly FixtureInstance[]): Promise<CapabilityAnswer> {
  const child = spawnBuiltServer(instanceEnvironment(instances), 10_000);
  try {
    await child.initializeSession(1, LATEST_PROTOCOL_VERSION);
    const called = (await child.request(2, "tools/call", {
      name: "arr_capabilities",
      arguments: {},
    })) as {
      result?: {
        isError?: boolean;
        content?: Array<{ type: string; text?: string }>;
        structuredContent?: {
          applications?: Array<{
            application: string;
            data?: {
              state: string;
              supportedOperations: Array<{ tool: string; variant?: string }>;
            };
          }>;
        };
      };
    };

    expect(called.result?.isError).toBe(false);
    const byApplication: Record<string, CapabilitySnapshot> = {};
    for (const outcome of called.result?.structuredContent?.applications ?? []) {
      byApplication[outcome.application] = {
        state: outcome.data?.state ?? "missing",
        views: (outcome.data?.supportedOperations ?? [])
          .filter((operation) => operation.tool === "arr_library_query")
          .map((operation) => operation.variant),
      };
    }

    await child.terminateGracefully();
    assertCleanProtocolStdout(child.stdout);
    expect(child.stderr).toBe("");
    for (const running of instances) {
      expect(child.stdout).not.toContain(running.apiKey);
    }
    return { summary: called.result?.content?.[0]?.text ?? "", byApplication };
  } finally {
    await child.forceCleanup().catch(() => undefined);
  }
}

describe("arr_capabilities over stdio", () => {
  it("reports each configuration truthfully to an operator", async () => {
    const sonarr = await instance("sonarr");
    const radarr = await instance("radarr");
    const prowlarr = await instance("prowlarr");
    const missing = await instance("radarr", { unreachable: true });

    const sonarrOnly = await capabilities([sonarr]);
    expect(sonarrOnly.byApplication.sonarr?.state).toBe("available");
    expect(sonarrOnly.byApplication.sonarr?.views).toContain("series");
    expect(sonarrOnly.byApplication.radarr).toEqual({ state: "unconfigured", views: [] });
    expect(sonarrOnly.byApplication.prowlarr).toEqual({ state: "unconfigured", views: [] });

    const radarrOnly = await capabilities([radarr]);
    expect(radarrOnly.byApplication.radarr?.state).toBe("available");
    expect(radarrOnly.byApplication.radarr?.views).toContain("movies");
    expect(radarrOnly.byApplication.radarr?.views).not.toContain("series");
    expect(radarrOnly.byApplication.sonarr).toEqual({ state: "unconfigured", views: [] });

    // All six variables set, which is the shape the README documents.
    const all = await capabilities([sonarr, radarr, prowlarr]);
    expect(all.byApplication.sonarr?.state).toBe("available");
    expect(all.byApplication.radarr?.state).toBe("available");
    expect(all.byApplication.prowlarr).toEqual({ state: "available", views: [] });

    const unreachable = await capabilities([sonarr, missing]);
    expect(unreachable.byApplication.sonarr?.state).toBe("available");
    expect(unreachable.byApplication.radarr).toEqual({ state: "unavailable", views: [] });
  }, 60_000);

  it("says in its one-line summary what an operator would have to act on", async () => {
    const sonarr = await instance("sonarr", { unreachable: true });
    const radarr = await instance("radarr", { unreachable: true });

    // The exact configuration an operator hits when the URLs are wrong or the
    // instances are down. The summary is the line they read first, so it must
    // not say "ok" while nothing is reachable.
    const nothing = await capabilities([sonarr, radarr]);
    expect(nothing.summary).toBe(
      "arr_capabilities: no application available; sonarr unavailable, radarr unavailable, prowlarr unconfigured",
    );

    const working = await instance("sonarr");
    const mixed = await capabilities([working, radarr]);
    expect(mixed.summary).toBe(
      "arr_capabilities: 1 of 3 application(s) available; sonarr available 4.0.19.2979, radarr unavailable, prowlarr unconfigured",
    );
  }, 60_000);
});
