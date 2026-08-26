import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  deserializeMessage,
  ReadBuffer,
  serializeMessage,
} from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { JSONRPCMessage, RequestId } from "@modelcontextprotocol/sdk/types.js";
import { consumeReadable, waitForChildCompletion } from "../../scripts/child-process.mjs";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));

/**
 * The instance variables a spawned server must never inherit.
 *
 * A developer's own settings would otherwise decide what these tests observe,
 * and — worse — could point a test at a real instance.
 */
export const instanceVariables: readonly string[] = [
  "SONARR_URL",
  "SONARR_API_KEY",
  "RADARR_URL",
  "RADARR_API_KEY",
  "PROWLARR_URL",
  "PROWLARR_API_KEY",
];

/** The process environment a host would launch the built server with. */
export function serverEnvironment(instances: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !instanceVariables.includes(name)),
    ),
    ...instances,
  };
}

/**
 * Launches the built server exactly as a host would: the packaged entry point,
 * a command environment, and stdio.
 */
export function spawnBuiltServer(
  instances: Readonly<Record<string, string>>,
  deadlineMs = 5_000,
): SpawnedStdioProcess {
  return spawnStdioProcess({
    executable: process.execPath,
    args: ["dist/cli.js"],
    cwd: projectRoot,
    env: serverEnvironment(instances),
    deadlineMs,
  });
}

/**
 * Holds stdout to the protocol contract: every line it carries must be a
 * decodable MCP message, and the stream must end on a message boundary.
 */
export function assertCleanProtocolStdout(stdout: string): void {
  const lines = stdout.split("\n");
  if (lines.at(-1) !== "") {
    throw new Error("Server stdout did not end on a message boundary");
  }
  for (const line of lines.slice(0, -1)) {
    deserializeMessage(line);
  }
}

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
    const stdoutConsumed = consumeReadable(this.child.stdout, (chunk) => {
      this.stdoutChunks.push(chunk);
      this.#decode(chunk);
    });
    const stderrConsumed = consumeReadable(this.child.stderr, (chunk) => {
      this.stderrChunks.push(chunk);
    });
    this.closed = waitForChildCompletion(this.child, stdoutConsumed, stderrConsumed).then(
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

  /**
   * Sends a request and awaits its response. The waiter is registered before
   * the write so a response that arrives immediately is never missed.
   */
  async request(
    id: RequestId,
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = this.#deadlineMs,
  ): Promise<JSONRPCMessage> {
    const pending = this.response(id, timeoutMs);
    await this.send({
      jsonrpc: "2.0",
      id,
      method,
      ...(params === undefined ? {} : { params }),
    } as JSONRPCMessage);
    return pending;
  }

  /**
   * Completes the MCP initialization handshake so later requests are handled
   * rather than rejected as premature.
   */
  async initializeSession(
    id: RequestId,
    protocolVersion: string,
    clientName = "spawned-stdio-test",
  ): Promise<JSONRPCMessage> {
    const response = await this.request(id, "initialize", {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: clientName, version: "1.0.0" },
    });
    await this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    return response;
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
