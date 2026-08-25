import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { JSONRPCMessage, RequestId } from "@modelcontextprotocol/sdk/types.js";
import { waitForChildCompletion } from "../../scripts/child-process.mjs";

export interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface SpawnedStdioOptions {
  executable: string;
  args?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  deadlineMs?: number;
}

interface ResponseWaiter {
  resolve: (message: JSONRPCMessage) => void;
  reject: (error: unknown) => void;
}

export function withDeadline<T>(promise: Promise<T>, label: string, timeoutMs = 2_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export class SpawnedStdioProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly exit: Promise<ProcessExit>;
  readonly closed: Promise<ProcessExit>;
  readonly stdoutChunks: Buffer[] = [];
  readonly stderrChunks: Buffer[] = [];

  readonly #deadlineMs: number;
  readonly #readBuffer = new ReadBuffer();
  readonly #responses = new Map<RequestId, JSONRPCMessage>();
  readonly #waiters = new Map<RequestId, ResponseWaiter>();
  readonly #pendingWrites = new Set<(error: unknown) => void>();
  #protocolError: unknown;
  #stdinError: unknown;
  #isClosed = false;

  constructor(options: SpawnedStdioOptions) {
    this.#deadlineMs = options.deadlineMs ?? 2_000;
    this.child = spawn(options.executable, [...(options.args ?? [])], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.exit = new Promise<ProcessExit>((resolve, reject) => {
      this.child.once("error", reject);
      this.child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    this.closed = waitForChildCompletion(this.child).then(
      (status) => {
        this.#finishClose(
          new Error(
            `Process closed before the requested response (code=${String(status.code)}, signal=${String(status.signal)})`,
          ),
          new Error("Spawned process stdin closed before the write completed"),
        );
        return status;
      },
      (error: unknown) => {
        this.#finishClose(error, error);
        throw error;
      },
    );

    this.child.stdin.on("error", (error: unknown) => {
      this.#stdinError = error;
      for (const reject of this.#pendingWrites) {
        reject(error);
      }
      this.#pendingWrites.clear();
    });
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.stdoutChunks.push(chunk);
      this.#decode(chunk);
    });
    this.child.stderr.on("data", (chunk: Buffer) => this.stderrChunks.push(chunk));
  }

  get stdout(): string {
    return Buffer.concat(this.stdoutChunks).toString("utf8");
  }

  get stderr(): string {
    return Buffer.concat(this.stderrChunks).toString("utf8");
  }

  send(message: JSONRPCMessage, timeoutMs = this.#deadlineMs): Promise<void> {
    if (this.#stdinError !== undefined) {
      return Promise.reject(this.#stdinError);
    }
    if (this.child.stdin.destroyed || !this.child.stdin.writable) {
      return Promise.reject(new Error("Spawned process stdin is not writable"));
    }

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(
        () => fail(new Error("Timed out waiting for spawned process stdin write")),
        timeoutMs,
      );
      const settle = () => {
        if (settled) {
          return false;
        }
        settled = true;
        clearTimeout(timer);
        this.#pendingWrites.delete(fail);
        return true;
      };
      const fail = (error: unknown) => {
        if (settle()) {
          reject(error);
        }
      };
      this.#pendingWrites.add(fail);
      try {
        this.child.stdin.write(serializeMessage(message), (error) => {
          if (error !== null && error !== undefined) {
            this.#stdinError = error;
            fail(error);
            return;
          }
          if (settle()) {
            resolve();
          }
        });
      } catch (error) {
        this.#stdinError = error;
        fail(error);
      }
    });
  }

  response(id: RequestId, timeoutMs = this.#deadlineMs): Promise<JSONRPCMessage> {
    if (this.#protocolError !== undefined) {
      return Promise.reject(this.#protocolError);
    }
    const message = this.#responses.get(id);
    if (message !== undefined) {
      this.#responses.delete(id);
      return Promise.resolve(message);
    }
    if (this.#isClosed) {
      return Promise.reject(new Error(`Process already closed before response ${String(id)}`));
    }
    if (this.#waiters.has(id)) {
      return Promise.reject(new Error(`Response ${String(id)} already has a pending waiter`));
    }

    let waiter: ResponseWaiter | undefined;
    const pending = new Promise<JSONRPCMessage>((resolve, reject) => {
      waiter = { resolve, reject };
      this.#waiters.set(id, waiter);
    });
    return withDeadline(pending, `response ${String(id)}`, timeoutMs).finally(() => {
      if (this.#waiters.get(id) === waiter) {
        this.#waiters.delete(id);
      }
    });
  }

  #finishClose(waiterError: unknown, writeError: unknown): void {
    this.#isClosed = true;
    for (const waiter of this.#waiters.values()) {
      waiter.reject(waiterError);
    }
    this.#waiters.clear();
    for (const rejectWrite of this.#pendingWrites) {
      rejectWrite(writeError);
    }
    this.#pendingWrites.clear();
  }

  async terminateGracefully(
    signal: NodeJS.Signals = "SIGTERM",
    timeoutMs = this.#deadlineMs,
  ): Promise<ProcessExit> {
    if (
      this.child.exitCode === null &&
      this.child.signalCode === null &&
      !this.child.kill(signal)
    ) {
      throw new Error(`Failed to send ${signal} to spawned process`);
    }
    try {
      return await this.#awaitClose("graceful process close", timeoutMs);
    } catch (error) {
      await this.forceCleanup().catch(() => undefined);
      throw error;
    }
  }

  async forceCleanup(timeoutMs = this.#deadlineMs): Promise<ProcessExit> {
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill("SIGKILL");
    }
    return this.#awaitClose("forced process cleanup", timeoutMs);
  }

  async #awaitClose(label: string, timeoutMs: number): Promise<ProcessExit> {
    const [exit] = await withDeadline(Promise.all([this.exit, this.closed]), label, timeoutMs);
    return exit;
  }

  #decode(chunk: Buffer): void {
    try {
      this.#readBuffer.append(chunk);
      for (
        let message = this.#readBuffer.readMessage();
        message !== null;
        message = this.#readBuffer.readMessage()
      ) {
        const id = "id" in message ? message.id : undefined;
        if (id === null || id === undefined) {
          continue;
        }
        const waiter = this.#waiters.get(id);
        if (waiter !== undefined) {
          this.#waiters.delete(id);
          waiter.resolve(message);
          continue;
        }
        this.#responses.set(id, message);
      }
    } catch (error) {
      this.#protocolError = error;
      for (const waiter of this.#waiters.values()) {
        waiter.reject(error);
      }
      this.#waiters.clear();
    }
  }
}

export function spawnStdioProcess(options: SpawnedStdioOptions): SpawnedStdioProcess {
  return new SpawnedStdioProcess(options);
}
