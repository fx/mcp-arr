import { request as httpRequest } from "node:http";
import { createServer as createNetServer } from "node:net";

/**
 * The checks the release verifiers share. Each verifier exercises a different
 * artifact — the packed tarball, the container image — against the same
 * listener contract, so the way they assert, bound a wait, and speak HTTP is
 * defined once.
 */

export function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

export function withDeadline(promise, label, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** A loopback port that was free a moment ago: bound, read, and released. */
export async function freePort() {
  const probe = createNetServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/** One request on a connection of its own, read to the end. */
export function exchange(port, { method, path, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: "127.0.0.1", port, method, path, headers, agent: false },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.once("error", reject);
        response.once("end", () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.once("error", reject);
    request.end(body);
  });
}
