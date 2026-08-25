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

function deliverChunk(value, onChunk) {
  const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
  onChunk(chunk);
}

function drainReadable(stream, onValue) {
  for (let value = stream.read(); value !== null; value = stream.read()) {
    onValue(value);
  }
}

export async function consumeReadable(stream, onChunk) {
  let failure;
  const captureChunk = (value) => {
    try {
      deliverChunk(value, onChunk);
    } catch (error) {
      failure ??= error;
    }
  };

  try {
    for await (const value of stream) {
      captureChunk(value);
    }
  } catch (error) {
    failure ??= error;
  }

  drainReadable(stream, captureChunk);
  await new Promise((resolve) => setImmediate(resolve));
  drainReadable(stream, captureChunk);

  if (failure !== undefined) {
    throw failure;
  }
}

function captureResult(promise) {
  return promise.then(
    () => ({ error: undefined }),
    (error) => ({ error }),
  );
}

export function waitForChildCompletion(child, stdoutConsumed, stderrConsumed) {
  let spawnError;
  const processClosed = new Promise((resolve) => {
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (code, signal) => resolve({ code, signal }));
  });

  return Promise.all([
    processClosed,
    captureResult(stdoutConsumed),
    captureResult(stderrConsumed),
  ]).then(([status, stdoutResult, stderrResult]) => {
    if (spawnError !== undefined) {
      throw spawnError;
    }
    if (stdoutResult.error !== undefined) {
      throw stdoutResult.error;
    }
    if (stderrResult.error !== undefined) {
      throw stderrResult.error;
    }
    return status;
  });
}

export function observeChildProcess(child, options = {}) {
  const stdoutChunks = [];
  const stderrChunks = [];
  const exit = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const stdoutConsumed = consumeReadable(child.stdout, (chunk) => {
    stdoutChunks.push(chunk);
    options.onStdoutChunk?.(chunk);
  });
  const stderrConsumed = consumeReadable(child.stderr, (chunk) => {
    stderrChunks.push(chunk);
    options.onStderrChunk?.(chunk);
  });
  const closed = waitForChildCompletion(child, stdoutConsumed, stderrConsumed);

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
