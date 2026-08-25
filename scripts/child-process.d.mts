import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { Readable } from "node:stream";

export interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface ObserveChildProcessOptions {
  onStdoutChunk?: (chunk: Buffer) => void;
  onStderrChunk?: (chunk: Buffer) => void;
}

export interface ObservedChildProcess {
  exit: Promise<ProcessExit>;
  closed: Promise<ProcessExit>;
  readonly stdout: string;
  readonly stderr: string;
}

export function consumeReadable(stream: Readable, onChunk: (chunk: Buffer) => void): Promise<void>;

export function waitForChildCompletion(
  child: ChildProcessWithoutNullStreams,
  stdoutConsumed: Promise<void>,
  stderrConsumed: Promise<void>,
): Promise<ProcessExit>;

export function waitForResponseOrExit<T>(
  response: Promise<T>,
  exit: Promise<ProcessExit>,
  label: string,
): Promise<T>;

export function observeChildProcess(
  child: ChildProcessWithoutNullStreams,
  options?: ObserveChildProcessOptions,
): ObservedChildProcess;
