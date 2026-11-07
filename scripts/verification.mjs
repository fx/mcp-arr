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

/**
 * One request on a connection of its own, read to the end. A listener that
 * accepts and then never finishes answering fails the exchange at the
 * deadline, and the request is destroyed rather than left holding the socket.
 */
export function exchange(port, { method, path, headers = {}, body, timeoutMs = 5_000 }) {
  return new Promise((resolve, reject) => {
    let timer;
    const settle = (finish, value) => {
      clearTimeout(timer);
      finish(value);
    };
    const request = httpRequest(
      { host: "127.0.0.1", port, method, path, headers, agent: false },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.once("error", (error) => settle(reject, error));
        response.once("end", () =>
          settle(resolve, {
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    timer = setTimeout(() => {
      reject(new Error(`${method} ${path} did not complete within ${timeoutMs} ms`));
      request.destroy();
    }, timeoutMs);
    request.once("error", (error) => settle(reject, error));
    request.end(body);
  });
}
