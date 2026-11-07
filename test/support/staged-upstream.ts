import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fixturePathFor, loadFixture } from "./fixtures.js";
import { fixtureRoot } from "./tool-context.js";

/**
 * A Sonarr stand-in for a tool call that needs more than one upstream request:
 * it answers the capability probe, after a delay the test chooses, and then
 * never answers anything else.
 *
 * That is the shape a shutdown has to bound. A call whose first request was
 * answered starts its next one with a fresh upstream deadline of its own, so a
 * listener that only stops waiting on its inbound connections leaves the
 * outbound one running past the point the process promised to be gone.
 */
export interface StagedUpstream {
  readonly url: string;
  /** Every request path received, in order. */
  readonly received: readonly string[];
  /** Requests still held open: received, never answered, and not yet closed by the caller. */
  open(): number;
  close(): Promise<void>;
}

export async function startStagedUpstream(probeDelayMs: number): Promise<StagedUpstream> {
  const status = JSON.stringify(
    (await loadFixture(fixtureRoot, fixturePathFor("sonarr", "system/status"))).body,
  );
  const received: string[] = [];
  let open = 0;
  const timers = new Set<NodeJS.Timeout>();
  const server: Server = createServer((request, response) => {
    const path = request.url ?? "";
    received.push(path);
    if (path.startsWith("/api/v3/system/status")) {
      const timer = setTimeout(() => {
        timers.delete(timer);
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(status);
      }, probeDelayMs);
      timers.add(timer);
      return;
    }
    open += 1;
    response.once("close", () => {
      open -= 1;
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${String(port)}`,
    received,
    open: () => open,
    close: async () => {
      for (const timer of timers) {
        clearTimeout(timer);
      }
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
