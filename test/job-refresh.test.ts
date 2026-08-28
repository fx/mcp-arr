import { beforeAll, describe, expect, it } from "vitest";
import {
  type CommandRefresh,
  commandGoneWarning,
  commandRecordRoute,
  readCommandRecord,
} from "../src/adapters/jobs.js";
import type { ApplicationId } from "../src/applications.js";
import { normalizeJobStatus } from "../src/state/jobs.js";
import { activityFixture } from "./support/activity.js";
import { jsonResponse, libraryHarness, type UpstreamCall } from "./support/library.js";
import { testApiKeys } from "./support/tool-context.js";

/**
 * The refresh a job read performs, exercised against the recorded command
 * responses of all three applications.
 *
 * The single-command route answers with one element of the same collection the
 * `command` list route answers with, so these tests serve a recorded record
 * rather than a body invented here: what a job refresh reads is exactly what
 * the instance was observed to send.
 */

const applications: readonly ApplicationId[] = ["sonarr", "radarr", "prowlarr"];

interface RecordedCommand {
  readonly id: number;
  readonly status?: string;
  readonly result?: string;
  readonly message?: string | null;
  readonly trigger?: string;
  readonly body?: Record<string, unknown>;
}

const recorded = new Map<ApplicationId, readonly RecordedCommand[]>();

beforeAll(async () => {
  for (const application of applications) {
    recorded.set(application, await activityFixture<RecordedCommand[]>(application, "command"));
  }
});

function commandOf(application: ApplicationId, index = 0): RecordedCommand {
  const command = recorded.get(application)?.[index];
  if (command === undefined) {
    throw new Error(`The recorded ${application} command list has no entry ${index}`);
  }
  return command;
}

interface Instance {
  readonly calls: readonly UpstreamCall[];
  read(upstreamId: string): Promise<CommandRefresh>;
}

function serving(application: ApplicationId, respond: (call: UpstreamCall) => Response): Instance {
  const harness = libraryHarness(application, respond);
  return {
    calls: harness.calls,
    read: (upstreamId) => readCommandRecord(harness.client, application, upstreamId),
  };
}

describe("commandRecordRoute", () => {
  it("names one command under the shared command route", () => {
    expect(commandRecordRoute("887726")).toBe("command/887726");
  });

  it("encodes an identifier that is not a plain integer", () => {
    // The job store keeps the identifier as a string so a GUID would fit, and
    // the identifier reaches this route from an upstream response rather than
    // from a constant, so it is never assumed to be path-safe.
    expect(commandRecordRoute("a b/c")).toBe("command/a%20b%2Fc");
  });
});

describe("readCommandRecord", () => {
  it("reads each application's own command route and reports its state", async () => {
    for (const application of applications) {
      const command = commandOf(application);
      const instance = serving(application, () => jsonResponse(command));

      const refresh = await instance.read(String(command.id));

      const apiVersion = application === "prowlarr" ? "v1" : "v3";
      expect(instance.calls[0]?.url.pathname, application).toBe(
        `/api/${apiVersion}/command/${command.id}`,
      );
      if (refresh.status !== "observed") {
        throw new Error(`Expected ${application} to answer with an observation`);
      }
      expect(refresh.observation.state, application).toBe(command.status);
      expect(refresh.observation.result, application).toBe(command.result);
    }
  });

  it("normalizes a completed command's result into a terminal status", async () => {
    // Sonarr and Radarr report a separate result beside the state; Prowlarr was
    // observed to send no result field at all, and a completed command with no
    // result is still a completed command.
    const command = commandOf("sonarr", 1);
    const instance = serving("sonarr", () => jsonResponse(command));

    const refresh = await instance.read(String(command.id));
    if (refresh.status !== "observed") {
      throw new Error("Expected an observation");
    }

    expect(command.result).toBe("successful");
    expect(normalizeJobStatus(refresh.observation.state, refresh.observation.result)).toBe(
      "completed",
    );
  });

  it("keeps the command's own payload, trigger, and identity out of the observation", async () => {
    const command = commandOf("sonarr");
    const instance = serving("sonarr", () => jsonResponse(command));

    const refresh = await instance.read(String(command.id));
    if (refresh.status !== "observed") {
      throw new Error("Expected an observation");
    }

    // The recorded response really does carry both, so this is a value that was
    // dropped rather than one that was never there.
    expect(command.body?.name).toBe("RefreshSeries");
    expect(command.trigger).toBe("manual");
    expect(Object.keys(refresh.observation).sort()).toEqual(["result", "state", "warnings"]);
    expect(JSON.stringify(refresh.observation)).not.toContain("manual");
    expect(JSON.stringify(refresh.observation)).not.toContain("updateScheduledTask");
  });

  it("reports no progress, because no application supplies a count", async () => {
    for (const application of applications) {
      const command = commandOf(application);
      const instance = serving(application, () => jsonResponse(command));

      const refresh = await instance.read(String(command.id));

      if (refresh.status !== "observed") {
        throw new Error(`Expected ${application} to answer with an observation`);
      }
      expect(refresh.observation.progress, application).toBeUndefined();
    }
  });

  it("reads a command whose only progress signal is a sentence without deriving counts", async () => {
    // The one progress signal any of the three was observed to send is this
    // free-text message. It travels as a warning, and nothing parses "1 of 1"
    // out of it into the published `{completed, total}` pair.
    const command = { ...commandOf("sonarr"), message: "Processing file 1 of 1" };
    const instance = serving("sonarr", () => jsonResponse(command));

    const refresh = await instance.read(String(command.id));

    if (refresh.status !== "observed") {
      throw new Error("Expected an observation");
    }
    expect(refresh.observation.progress).toBeUndefined();
    expect(refresh.observation.warnings).toEqual(["Processing file 1 of 1"]);
  });

  it("treats a command the application no longer holds as an observation, not a failure", async () => {
    for (const application of applications) {
      const instance = serving(application, () => jsonResponse({ message: "not found" }, 404));

      const refresh = await instance.read("999999999");

      expect(refresh.status, application).toBe("observed");
      if (refresh.status !== "observed") {
        throw new Error(`Expected ${application} to answer with an observation`);
      }
      // No state at all, which the job store normalizes to `unknown`.
      expect(refresh.observation.state, application).toBeUndefined();
      expect(normalizeJobStatus(refresh.observation.state), application).toBe("unknown");
      expect(refresh.observation.warnings, application).toEqual([commandGoneWarning]);
    }
  });

  it("reports an instance it could not reach as a failure that learned nothing", async () => {
    const instance = serving("sonarr", () => jsonResponse({ message: "broken" }, 503));

    const refresh = await instance.read("77");

    if (refresh.status !== "unreachable") {
      throw new Error("Expected an unreachable instance");
    }
    expect(refresh.failure.kind).toBe("unexpected-response");
    expect(refresh.failure.message).toContain("sonarr");
    expect(refresh.failure.message).not.toContain(testApiKeys.sonarr);
  });

  it("reports an unreadable command record as a failure rather than as no state", async () => {
    // A body this server cannot read is not evidence the command has ended, and
    // reading it as an absent state would degrade a running job to `unknown`.
    const instance = serving("sonarr", () => jsonResponse({ status: "started" }));

    const refresh = await instance.read("77");

    expect(refresh.status).toBe("unreachable");
  });
});
