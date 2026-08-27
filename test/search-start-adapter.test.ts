import { describe, expect, it } from "vitest";
import {
  searchCommandName,
  searchCommandRoutes,
  startSearchCommand,
} from "../src/adapters/acquisition/commands.js";
import {
  type SearchStartRequest,
  type SearchStartTarget,
  searchStartApplications,
  searchStartMinimumVersions,
  searchStartTargets,
} from "../src/adapters/acquisition/requests.js";
import { type ApplicationId, applicationIds } from "../src/applications.js";
import { normalizeJobStatus } from "../src/state/jobs.js";
import { operationDefinitions } from "../src/tools/operations.js";
import { jsonResponse, searchHarness, type UpstreamCall } from "./support/acquisition.js";
import { fixtureBody } from "./support/library.js";

/**
 * The automatic-search command adapter.
 *
 * Two properties matter here and nowhere else. The command name is never
 * caller-supplied — it comes from a closed table keyed by the published target
 * and the application — and the body beside it is exactly the identifiers the
 * tool layer resolved, so a target cannot quietly widen into a different search.
 */

/** One minimal request per target. */
const requestForTarget: Readonly<Record<SearchStartTarget, SearchStartRequest>> = {
  sonarr_episode: { target: "sonarr_episode", episodeIds: [11, 12] },
  sonarr_season: { target: "sonarr_season", seriesId: 12, seasonNumber: 1 },
  sonarr_series: { target: "sonarr_series", seriesId: 12 },
  radarr_movie: { target: "radarr_movie", movieIds: [8] },
  missing: { target: "missing", monitoredOnly: true },
  cutoff_unmet: { target: "cutoff_unmet", monitoredOnly: false },
};

function bodyOf(call: UpstreamCall): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

/** The recorded command record an instance answers a created command with. */
async function acceptedCommand(application: "sonarr" | "radarr"): Promise<Record<string, unknown>> {
  const body = await fixtureBody<readonly Record<string, unknown>[]>(application, "command");
  const first = body[0];
  if (first === undefined) {
    throw new Error(`The ${application} command fixture holds no record`);
  }
  return first;
}

describe("automatic search target support", () => {
  it("declares the same targets and applications the operation registry does", () => {
    const registered = operationDefinitions
      .filter((operation) => operation.tool === "arr_search_start")
      .map((operation) => [operation.variant, [...operation.applications]] as const);

    expect(registered.map(([variant]) => variant).sort()).toEqual([...searchStartTargets].sort());
    for (const [variant, applications] of registered) {
      expect([variant, searchStartApplications[variant as SearchStartTarget]]).toEqual([
        variant,
        applications,
      ]);
    }
  });

  it("needs no version newer than each application's recorded minimum", () => {
    expect(searchStartMinimumVersions).toEqual({});
  });

  it("names a command exactly where an application models the target", () => {
    for (const target of searchStartTargets) {
      for (const application of applicationIds) {
        const named = searchCommandName(application, target) !== undefined;
        expect([target, application, named]).toEqual([
          target,
          application,
          searchStartApplications[target].includes(application),
        ]);
      }
    }
  });
});

describe("automatic search commands", () => {
  it("compiles each target into its own allowlisted command and payload", async () => {
    const expected: ReadonlyArray<
      readonly [ApplicationId, SearchStartTarget, Record<string, unknown>]
    > = [
      ["sonarr", "sonarr_episode", { name: "EpisodeSearch", episodeIds: [11, 12] }],
      ["sonarr", "sonarr_season", { name: "SeasonSearch", seriesId: 12, seasonNumber: 1 }],
      ["sonarr", "sonarr_series", { name: "SeriesSearch", seriesId: 12 }],
      ["radarr", "radarr_movie", { name: "MoviesSearch", movieIds: [8] }],
      [
        "sonarr",
        "missing",
        { name: "MissingEpisodeSearch", filterKey: "monitored", filterValue: "true" },
      ],
      [
        "radarr",
        "missing",
        { name: "MissingMoviesSearch", filterKey: "monitored", filterValue: "true" },
      ],
      [
        "sonarr",
        "cutoff_unmet",
        { name: "CutoffUnmetEpisodeSearch", filterKey: "monitored", filterValue: "false" },
      ],
      [
        "radarr",
        "cutoff_unmet",
        { name: "CutoffUnmetMoviesSearch", filterKey: "monitored", filterValue: "false" },
      ],
    ];

    for (const [application, target, body] of expected) {
      const command = searchCommandName(application, target);
      if (command === undefined) {
        throw new Error(`${application} must model ${target}`);
      }
      const record = await acceptedCommand(application as "sonarr" | "radarr");
      const harness = searchHarness(application, () => jsonResponse(record, 201));

      const started = await startSearchCommand(
        harness.client,
        application,
        requestForTarget[target],
        command,
      );

      expect(harness.calls).toHaveLength(1);
      const call = harness.calls[0] as UpstreamCall;
      expect(call.init.method).toBe("POST");
      expect(call.url.pathname.endsWith(`/${searchCommandRoutes.command}`)).toBe(true);
      // By equality, so a field this server never meant to send would fail here
      // rather than reach an instance unnoticed.
      expect(bodyOf(call)).toEqual(body);
      expect(started.name).toBe(command);
      expect(started.upstreamId).toBe(String(record.id));
    }
  });

  it("reports the command identity and state the instance answered with", async () => {
    const record = await acceptedCommand("sonarr");
    const harness = searchHarness("sonarr", () =>
      jsonResponse({ ...record, name: "SeriesSearch" }),
    );

    const started = await startSearchCommand(
      harness.client,
      "sonarr",
      requestForTarget.sonarr_series,
      "SeriesSearch",
    );

    expect(started.upstreamId).toBe(String(record.id));
    expect(normalizeJobStatus(started.observation.state, started.observation.result)).toBe(
      normalizeJobStatus(String(record.status)),
    );
  });

  it("keeps the command name this server sent rather than the instance's echo", async () => {
    const record = await acceptedCommand("radarr");
    const harness = searchHarness("radarr", () =>
      jsonResponse({ ...record, name: "SomethingElseEntirely" }),
    );

    const started = await startSearchCommand(
      harness.client,
      "radarr",
      requestForTarget.radarr_movie,
      "MoviesSearch",
    );

    // The published job identity is one of this server's own constants, so an
    // instance cannot put text of its own into it.
    expect(started.name).toBe("MoviesSearch");
  });

  it("sanitizes the one field the instance composes for itself", async () => {
    const record = await acceptedCommand("sonarr");
    const harness = searchHarness("sonarr", () =>
      jsonResponse({
        ...record,
        message: "Searching /srv/canary/media with apikey=canary-instance-key-9f3d",
      }),
    );

    const started = await startSearchCommand(
      harness.client,
      "sonarr",
      requestForTarget.sonarr_series,
      "SeriesSearch",
    );

    const warnings = started.observation.warnings ?? [];
    expect(warnings).toHaveLength(1);
    expect(JSON.stringify(started)).not.toContain("canary");
  });

  it("fails rather than reporting a start it cannot identify", async () => {
    const harness = searchHarness("sonarr", () => jsonResponse({ status: "queued" }));

    // A command whose id never came back is one no caller could ever follow, so
    // it is a failure rather than a job with no identity.
    await expect(
      startSearchCommand(harness.client, "sonarr", requestForTarget.sonarr_series, "SeriesSearch"),
    ).rejects.toThrow();
  });

  it("normalizes an instance that refuses the command", async () => {
    const harness = searchHarness("radarr", () =>
      jsonResponse({ message: "canary-upstream-detail" }, 400),
    );

    await expect(
      startSearchCommand(harness.client, "radarr", requestForTarget.radarr_movie, "MoviesSearch"),
    ).rejects.toThrow(/rejected as invalid/u);
  });
});
