import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, type Readable } from "node:stream";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import {
  consumeReadable,
  observeChildProcess,
  waitForChildCompletion,
  waitForResponseOrExit,
} from "../scripts/child-process.mjs";
import { createPlatformCommand, isCleanTermination } from "../scripts/platform-command.mjs";

function controlledCloseBeforeRead(): {
  stream: Readable;
  closeWith: (chunk?: Buffer) => void;
} {
  const events = new EventEmitter();
  const buffered: Buffer[] = [];
  let finishIteration: (() => void) | undefined;
  const iterationFinished = new Promise<void>((resolve) => {
    finishIteration = resolve;
  });
  const stream = Object.assign(events, {
    read: () => buffered.shift() ?? null,
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        await iterationFinished;
        return { done: true as const, value: undefined };
      },
    }),
  }) as unknown as Readable;

  return {
    stream,
    closeWith: (chunk) => {
      if (chunk !== undefined) {
        buffered.push(chunk);
      }
      events.emit("close");
      finishIteration?.();
    },
  };
}

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
      args: ["/d", "/s", "/c", String.raw`"C:\tools\npm.CMD ^^^"install^^^" ^^^"package.tgz^^^""`],
    });
  });

  it("escapes spaced Windows shim paths and arguments", () => {
    const shim = ["C:", "Program Files", "node tools", "npm.cmd"].join("\\");
    const archive = ["C:", "package files", "archive.tgz"].join("\\");

    expect(createPlatformCommand(shim, ["install", archive], "win32", "cmd.exe")).toEqual({
      executable: "cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        String.raw`"C:\Program^ Files\node^ tools\npm.cmd ^^^"install^^^" ^^^"C:\package^^^ files\archive.tgz^^^""`,
      ],
    });
  });

  it("escapes quotes in Windows shim arguments", () => {
    const shim = ["C:", "tools", "runner.cmd"].join("\\");

    expect(createPlatformCommand(shim, ['say "hello"'], "win32", "cmd.exe")).toEqual({
      executable: "cmd.exe",
      args: ["/d", "/s", "/c", String.raw`"C:\tools\runner.cmd ^^^"say^^^ \^^^"hello\^^^"^^^""`],
    });
  });

  it("escapes Windows cmd metacharacters in shim arguments", () => {
    const shim = ["C:", "tools", "runner.cmd"].join("\\");
    const metacharacters = "safe & whoami | more <in >out ^caret %PATH% !value! (group)";

    expect(createPlatformCommand(shim, [metacharacters], "win32", "cmd.exe")).toEqual({
      executable: "cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        String.raw`"C:\tools\runner.cmd ^^^"safe^^^ ^^^&^^^ whoami^^^ ^^^|^^^ more^^^ ^^^<in^^^ ^^^>out^^^ ^^^^caret^^^ ^^^%PATH^^^%^^^ ^^^!value^^^!^^^ ^^^(group^^^)^^^""`,
      ],
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
  it("drains buffered unread output after stream close before completion", async () => {
    const events = new EventEmitter();
    const stdout = controlledCloseBeforeRead();
    const stderr = controlledCloseBeforeRead();
    const child = Object.assign(events, {
      stdout: stdout.stream,
      stderr: stderr.stream,
    }) as unknown as ChildProcessWithoutNullStreams;
    const response: JSONRPCMessage = {
      jsonrpc: "2.0",
      id: 321,
      result: { phase: "buffered-after-close" },
    };
    const framedResponse = serializeMessage(response);
    const readBuffer = new ReadBuffer();
    let resolveDecoded: ((message: JSONRPCMessage) => void) | undefined;
    const decoded = new Promise<JSONRPCMessage>((resolve) => {
      resolveDecoded = resolve;
    });
    const observed = observeChildProcess(child, {
      onStdoutChunk: (chunk) => {
        readBuffer.append(chunk);
        const message = readBuffer.readMessage();
        if (message !== null) {
          resolveDecoded?.(message);
        }
      },
    });
    let finalized = false;
    void observed.closed.then(() => {
      finalized = true;
    });

    events.emit("close", 0, null);
    stdout.closeWith(Buffer.from(framedResponse));
    stderr.closeWith();

    await expect(decoded).resolves.toEqual(response);
    expect(finalized).toBe(false);
    await expect(observed.closed).resolves.toEqual({ code: 0, signal: null });
    expect(finalized).toBe(true);
    expect(observed.stdout).toBe(framedResponse);
    expect(observed.stderr).toBe("");
  });

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
