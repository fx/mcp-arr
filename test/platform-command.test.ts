import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { observeChildProcess } from "../scripts/child-process.mjs";
import { createPlatformCommand, isCleanTermination } from "../scripts/platform-command.mjs";

describe("createPlatformCommand", () => {
  it("uses direct execution on POSIX platforms", () => {
    expect(createPlatformCommand("npm", ["pack", "--json"], "linux")).toEqual({
      executable: "npm",
      args: ["pack", "--json"],
    });
    expect(createPlatformCommand("npm.cmd", ["pack"], "darwin")).toEqual({
      executable: "npm.cmd",
      args: ["pack"],
    });
  });

  it("runs Windows cmd shims through the explicit command interpreter", () => {
    const shim = ["C:", "tools", "npm.CMD"].join("\\");
    expect(createPlatformCommand(shim, ["install", "package.tgz"], "win32", "cmd.exe")).toEqual({
      executable: "cmd.exe",
      args: ["/d", "/s", "/c", shim, "install", "package.tgz"],
    });
  });

  it("keeps native Windows executables direct", () => {
    expect(createPlatformCommand("node.exe", ["server.js"], "win32", "cmd.exe")).toEqual({
      executable: "node.exe",
      args: ["server.js"],
    });
  });
});

describe("isCleanTermination", () => {
  it("requires a zero exit code without a signal on POSIX", () => {
    expect(isCleanTermination({ code: 0, signal: null }, "linux")).toBe(true);
    expect(isCleanTermination({ code: null, signal: "SIGTERM" }, "linux")).toBe(false);
    expect(isCleanTermination({ code: 1, signal: null }, "linux")).toBe(false);
  });

  it("accepts documented Windows cmd-shim SIGTERM status", () => {
    expect(isCleanTermination({ code: 0, signal: null }, "win32")).toBe(true);
    expect(isCleanTermination({ code: null, signal: "SIGTERM" }, "win32")).toBe(true);
    expect(isCleanTermination({ code: null, signal: "SIGKILL" }, "win32")).toBe(false);
  });
});

describe("observeChildProcess", () => {
  it("preserves exit status and waits for buffered streams to close", async () => {
    const payload = "buffered package output\n".repeat(4_096);
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        'process.stderr.write("buffered package output\\n".repeat(4096))',
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const observed = observeChildProcess(child);

    await expect(observed.exit).resolves.toEqual({ code: 0, signal: null });
    await expect(observed.closed).resolves.toEqual({ code: 0, signal: null });
    expect(observed.stdout).toBe("");
    expect(observed.stderr).toBe(payload);
  });

  it("preserves spawn errors for exit and close observers", async () => {
    const child = spawn(path.join(tmpdir(), `missing-mcp-arr-command-${process.pid}`), [], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const observed = observeChildProcess(child);

    await expect(observed.exit).rejects.toMatchObject({ code: "ENOENT" });
    await expect(observed.closed).rejects.toMatchObject({ code: "ENOENT" });
  });
});
