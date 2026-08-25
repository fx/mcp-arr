export function waitForResponseOrExit(response, exit, label) {
  return Promise.race([
    response,
    exit.then(({ code, signal }) => {
      throw new Error(
        `Process exited before ${label} (code=${String(code)}, signal=${String(signal)})`,
      );
    }),
  ]);
}

export function waitForReadableDrain(stream) {
  if (stream.readableEnded || stream.closed) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      stream.off("end", drained);
      stream.off("close", drained);
      stream.off("error", failed);
    };
    const drained = () => {
      cleanup();
      resolve();
    };
    const failed = (error) => {
      cleanup();
      reject(error);
    };
    stream.once("end", drained);
    stream.once("close", drained);
    stream.once("error", failed);
    if (stream.readableEnded || stream.closed) {
      drained();
    }
  });
}

export function waitForChildCompletion(child) {
  let spawnError;
  const processClosed = new Promise((resolve) => {
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (code, signal) => resolve({ code, signal }));
  });

  return Promise.all([
    processClosed,
    waitForReadableDrain(child.stdout),
    waitForReadableDrain(child.stderr),
  ]).then(([status]) => {
    if (spawnError !== undefined) {
      throw spawnError;
    }
    return status;
  });
}

export function observeChildProcess(child) {
  const stdoutChunks = [];
  const stderrChunks = [];
  const exit = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
  child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
  const closed = waitForChildCompletion(child);

  return {
    exit,
    closed,
    get stdout() {
      return Buffer.concat(stdoutChunks).toString("utf8");
    },
    get stderr() {
      return Buffer.concat(stderrChunks).toString("utf8");
    },
  };
}
