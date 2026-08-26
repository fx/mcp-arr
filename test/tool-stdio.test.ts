import { fileURLToPath } from "node:url";
import { deserializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { toolNames } from "../src/tools/names.js";
import { spawnStdioProcess } from "./support/spawned-stdio.js";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const sonarrApiKey = "sonarr-secret-key";
const instanceVariables: readonly string[] = [
  "SONARR_URL",
  "SONARR_API_KEY",
  "RADARR_URL",
  "RADARR_API_KEY",
  "PROWLARR_URL",
  "PROWLARR_API_KEY",
];

/**
 * The built server rejects startup without a complete instance pair. Inherited
 * instance variables are dropped so a developer's own settings cannot change
 * what these tests observe, and the reserved `.invalid` host guarantees that no
 * request in this file can reach a real instance.
 */
const configuredEnvironment: NodeJS.ProcessEnv = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !instanceVariables.includes(name)),
  ),
  SONARR_URL: "https://sonarr.example.invalid/sonarr",
  SONARR_API_KEY: sonarrApiKey,
};

function spawnServer() {
  return spawnStdioProcess({
    executable: process.execPath,
    args: ["dist/cli.js"],
    cwd: projectRoot,
    env: configuredEnvironment,
    deadlineMs: 5_000,
  });
}

interface ToolListResult {
  result?: {
    tools?: Array<{
      name: string;
      description?: string;
      inputSchema?: { type?: string; additionalProperties?: unknown };
      outputSchema?: { type?: string };
      annotations?: Record<string, unknown>;
    }>;
  };
}

interface ToolCallResult {
  result?: {
    isError?: boolean;
    content?: Array<{ type: string; text?: string }>;
    structuredContent?: {
      status?: string;
      errors?: Array<{ code?: string; remediation?: string }>;
      applications?: Array<{
        application: string;
        status: string;
        data?: { state?: string };
        error?: { code?: string; remediation?: string };
      }>;
    };
  };
}

function assertCleanStdout(stdout: string): void {
  const lines = stdout.split("\n");
  expect(lines.at(-1)).toBe("");
  for (const line of lines.slice(0, -1)) {
    expect(() => deserializeMessage(line)).not.toThrow();
  }
}

describe("built stdio tool surface", () => {
  it("publishes the fifteen tools with their schemas and keeps stdout clean", async () => {
    const child = spawnServer();

    try {
      await child.initializeSession(1, LATEST_PROTOCOL_VERSION);
      const listed = (await child.request(2, "tools/list")) as ToolListResult;
      const tools = listed.result?.tools ?? [];

      expect(tools.map((tool) => tool.name)).toEqual([...toolNames]);
      for (const tool of tools) {
        expect(tool.inputSchema?.type, tool.name).toBe("object");
        expect(tool.outputSchema?.type, tool.name).toBe("object");
        expect(tool.description, tool.name).toBeTruthy();
        expect(tool.annotations, tool.name).toBeDefined();
      }

      await child.terminateGracefully();
      assertCleanStdout(child.stdout);
      expect(child.stderr).toBe("");
    } finally {
      await child.forceCleanup().catch(() => undefined);
    }
  });

  it("returns the unsupported_capability error without contacting an instance", async () => {
    const child = spawnServer();

    try {
      await child.initializeSession(1, LATEST_PROTOCOL_VERSION);
      const called = (await child.request(2, "tools/call", {
        name: "arr_library_query",
        arguments: { view: "movies", applications: ["sonarr"] },
      })) as ToolCallResult;

      expect(called.result?.isError).toBe(true);
      expect(called.result?.structuredContent?.status).toBe("error");
      const outcomes = called.result?.structuredContent?.applications ?? [];
      expect(outcomes.map((outcome) => [outcome.application, outcome.error?.code])).toEqual([
        ["sonarr", "unsupported_capability"],
      ]);
      expect(outcomes[0]?.error?.remediation).toBeTruthy();
      expect(called.result?.content?.[0]?.type).toBe("text");

      await child.terminateGracefully();
      assertCleanStdout(child.stdout);
      expect(child.stderr).toBe("");
      expect(child.stdout).not.toContain(sonarrApiKey);
    } finally {
      await child.forceCleanup().catch(() => undefined);
    }
  });

  it("answers both job tools locally with clean stdout and no upstream request", async () => {
    const child = spawnServer();

    try {
      await child.initializeSession(1, LATEST_PROTOCOL_VERSION);
      // A freshly started server holds no job, so a syntactically valid
      // reference is by definition one this process never issued. Answering it
      // is entirely process-local: nothing is probed, and the envelope still
      // conforms to the tool's published output schema.
      const read = (await child.request(2, "tools/call", {
        name: "arr_job_get",
        arguments: { job: "job_00000001" },
      })) as ToolCallResult;
      const cancelled = (await child.request(3, "tools/call", {
        name: "arr_job_cancel",
        arguments: { mode: "apply", job: "job_00000001" },
      })) as ToolCallResult;

      for (const called of [read, cancelled]) {
        expect(called.result?.isError).toBe(true);
        expect(called.result?.structuredContent?.status).toBe("error");
        expect(called.result?.structuredContent?.errors?.map((error) => error.code)).toEqual([
          "stale_reference",
        ]);
        expect(called.result?.structuredContent?.errors?.[0]?.remediation).toBeTruthy();
        expect(called.result?.content?.[0]?.type).toBe("text");
      }

      await child.terminateGracefully();
      assertCleanStdout(child.stdout);
      expect(child.stderr).toBe("");
      expect(child.stdout).not.toContain(sonarrApiKey);
    } finally {
      await child.forceCleanup().catch(() => undefined);
    }
  });

  it("answers arr_capabilities with structured content for every application", async () => {
    const child = spawnStdioProcess({
      executable: process.execPath,
      args: ["dist/cli.js"],
      cwd: projectRoot,
      env: configuredEnvironment,
      deadlineMs: 20_000,
    });

    try {
      await child.initializeSession(1, LATEST_PROTOCOL_VERSION);
      // Only Sonarr is configured and its reserved `.invalid` host cannot
      // resolve, so the report is deterministic: one unreachable instance and
      // two unconfigured ones, with the whole result still succeeding.
      const called = (await child.request(2, "tools/call", {
        name: "arr_capabilities",
        arguments: {},
      })) as ToolCallResult;

      expect(called.result?.isError).toBe(false);
      expect(called.result?.structuredContent?.status).toBe("ok");
      expect(
        (called.result?.structuredContent?.applications ?? []).map((outcome) => [
          outcome.application,
          outcome.status,
          outcome.data?.state,
        ]),
      ).toEqual([
        ["sonarr", "ok", "unavailable"],
        ["radarr", "ok", "unconfigured"],
        ["prowlarr", "ok", "unconfigured"],
      ]);
      expect(called.result?.content?.[0]?.text).toContain("arr_capabilities");

      await child.terminateGracefully();
      assertCleanStdout(child.stdout);
      expect(child.stderr).toBe("");
      expect(child.stdout).not.toContain(sonarrApiKey);
      expect(child.stdout).not.toContain("sonarr.example.invalid");
    } finally {
      await child.forceCleanup().catch(() => undefined);
    }
  }, 30_000);
});
