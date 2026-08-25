import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  consumeReadable,
  observeChildProcess,
  waitForChildCompletion,
  waitForResponseOrExit,
} from "../scripts/child-process.mjs";
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
  it("waits for readable drainage after process close", async () => {
    const events = new EventEmitter();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(events, {
      stdout,
      stderr,
    }) as unknown as ChildProcessWithoutNullStreams;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const stdoutConsumed = consumeReadable(stdout, (chunk) => stdoutChunks.push(chunk));
    const stderrConsumed = consumeReadable(stderr, (chunk) => stderrChunks.push(chunk));
    const completion = waitForChildCompletion(child, stdoutConsumed, stderrConsumed);
    let completed = false;
    void completion.then(() => {
      completed = true;
    });

    events.emit("close", 0, null);
    await Promise.resolve();
    expect(completed).toBe(false);

    stdout.end("late stdout");
    stderr.end("late stderr");
    await expect(completion).resolves.toEqual({ code: 0, signal: null });
    expect(Buffer.concat(stdoutChunks).toString("utf8")).toBe("late stdout");
    expect(Buffer.concat(stderrChunks).toString("utf8")).toBe("late stderr");
  });

  it("handles readable streams that already finished consumption", async () => {
    const events = new EventEmitter();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(events, {
      stdout,
      stderr,
    }) as unknown as ChildProcessWithoutNullStreams;
    const stdoutConsumed = consumeReadable(stdout, () => undefined);
    const stderrConsumed = consumeReadable(stderr, () => undefined);
    stdout.end();
    stderr.end();
    await Promise.all([stdoutConsumed, stderrConsumed]);

    const completion = waitForChildCompletion(child, stdoutConsumed, stderrConsumed);
    events.emit("close", 0, null);
    await expect(completion).resolves.toEqual({ code: 0, signal: null });
  });

  it("propagates premature readable errors after process close", async () => {
    const events = new EventEmitter();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(events, {
      stdout,
      stderr,
    }) as unknown as ChildProcessWithoutNullStreams;
    const stdoutConsumed = consumeReadable(stdout, () => undefined);
    const stderrConsumed = consumeReadable(stderr, () => undefined);
    const completion = waitForChildCompletion(child, stdoutConsumed, stderrConsumed);
    const streamError = new Error("forced premature stream failure");
    const rejected = expect(completion).rejects.toBe(streamError);

    events.emit("close", 1, null);
    stdout.destroy(streamError);
    stderr.end();
    await rejected;
  });

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

  it("propagates spawn errors while waiting for a response", async () => {
    const child = spawn(path.join(tmpdir(), `missing-mcp-arr-command-${process.pid}`), [], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const observed = observeChildProcess(child);
    const response = new Promise<never>(() => undefined);

    await expect(
      waitForResponseOrExit(response, observed.exit, "test response"),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(observed.closed).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects immediately when a process exits before its response", async () => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", "process.exit(7)"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const observed = observeChildProcess(child);
    const response = new Promise<never>(() => undefined);

    await expect(waitForResponseOrExit(response, observed.exit, "test response")).rejects.toThrow(
      "Process exited before test response (code=7, signal=null)",
    );
    await expect(observed.closed).resolves.toEqual({ code: 7, signal: null });
  });
});
