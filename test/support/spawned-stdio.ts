import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { JSONRPCMessage, RequestId } from "@modelcontextprotocol/sdk/types.js";

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
  readonly stdoutChunks: Buffer[] = [];
  readonly stderrChunks: Buffer[] = [];

  readonly #deadlineMs: number;
  readonly #readBuffer = new ReadBuffer();
  readonly #responses = new Map<RequestId, JSONRPCMessage[]>();
  readonly #waiters = new Map<
    RequestId,
    Array<{ resolve: (message: JSONRPCMessage) => void; reject: (error: unknown) => void }>
  >();
  #protocolError: unknown;

  constructor(options: SpawnedStdioOptions) {
    this.#deadlineMs = options.deadlineMs ?? 2_000;
    this.child = spawn(options.executable, [...(options.args ?? [])], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.exit = new Promise<ProcessExit>((resolve, reject) => {
      this.child.once("error", reject);
      this.child.once("exit", (code, signal) => {
        const exit = { code, signal };
        for (const waiters of this.#waiters.values()) {
          for (const waiter of waiters) {
            waiter.reject(
              new Error(
                `Process exited before the requested response (code=${String(code)}, signal=${String(signal)})`,
              ),
            );
          }
        }
        this.#waiters.clear();
        resolve(exit);
      });
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

  send(message: JSONRPCMessage): void {
    this.child.stdin.write(serializeMessage(message));
  }

  response(id: RequestId, timeoutMs = this.#deadlineMs): Promise<JSONRPCMessage> {
    if (this.#protocolError !== undefined) {
      return Promise.reject(this.#protocolError);
    }
    const queued = this.#responses.get(id);
    const message = queued?.shift();
    if (message !== undefined) {
      if (queued?.length === 0) {
        this.#responses.delete(id);
      }
      return Promise.resolve(message);
    }
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      return Promise.reject(new Error(`Process already exited before response ${String(id)}`));
    }

    const pending = new Promise<JSONRPCMessage>((resolve, reject) => {
      const waiters = this.#waiters.get(id) ?? [];
      waiters.push({ resolve, reject });
      this.#waiters.set(id, waiters);
    });
    return withDeadline(pending, `response ${String(id)}`, timeoutMs);
  }

  async terminateGracefully(
    signal: NodeJS.Signals = "SIGTERM",
    timeoutMs = this.#deadlineMs,
  ): Promise<ProcessExit> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      return this.exit;
    }
    if (!this.child.kill(signal)) {
      throw new Error(`Failed to send ${signal} to spawned process`);
    }
    try {
      return await withDeadline(this.exit, "graceful process exit", timeoutMs);
    } catch (error) {
      await this.forceCleanup().catch(() => undefined);
      throw error;
    }
  }

  async forceCleanup(timeoutMs = this.#deadlineMs): Promise<ProcessExit> {
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill("SIGKILL");
    }
    return withDeadline(this.exit, "forced process cleanup", timeoutMs);
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
        const waiters = this.#waiters.get(id);
        const waiter = waiters?.shift();
        if (waiter !== undefined) {
          if (waiters?.length === 0) {
            this.#waiters.delete(id);
          }
          waiter.resolve(message);
          continue;
        }
        const queued = this.#responses.get(id) ?? [];
        queued.push(message);
        this.#responses.set(id, queued);
      }
    } catch (error) {
      this.#protocolError = error;
      for (const waiters of this.#waiters.values()) {
        for (const waiter of waiters) {
          waiter.reject(error);
        }
      }
      this.#waiters.clear();
    }
  }
}

export function spawnStdioProcess(options: SpawnedStdioOptions): SpawnedStdioProcess {
  return new SpawnedStdioProcess(options);
}
