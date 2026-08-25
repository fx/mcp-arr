import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { Readable } from "node:stream";

export interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface ObservedChildProcess {
  exit: Promise<ProcessExit>;
  closed: Promise<ProcessExit>;
  readonly stdout: string;
  readonly stderr: string;
}

export function waitForReadableDrain(stream: Readable): Promise<void>;

export function waitForChildCompletion(child: ChildProcessWithoutNullStreams): Promise<ProcessExit>;

export function waitForResponseOrExit<T>(
  response: Promise<T>,
  exit: Promise<ProcessExit>,
  label: string,
): Promise<T>;

export function observeChildProcess(child: ChildProcessWithoutNullStreams): ObservedChildProcess;
