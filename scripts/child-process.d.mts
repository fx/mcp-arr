import type { ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";

/**
 * A child whose stdout and stderr are piped. Its stdin may be a pipe or
 * absent: nothing here writes to it, and a child launched with stdin ignored
 * is exactly how a container without an attached terminal starts one.
 */
export type ObservableChild = ChildProcess & {
  readonly stdout: Readable;
  readonly stderr: Readable;
};

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
  child: ObservableChild,
  stdoutConsumed: Promise<void>,
  stderrConsumed: Promise<void>,
): Promise<ProcessExit>;

export function waitForResponseOrExit<T>(
  response: Promise<T>,
  exit: Promise<ProcessExit>,
  label: string,
): Promise<T>;

export function observeChildProcess(
  child: ObservableChild,
  options?: ObserveChildProcessOptions,
): ObservedChildProcess;
