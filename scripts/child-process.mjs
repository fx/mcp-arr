export function observeChildProcess(child) {
  const stdoutChunks = [];
  const stderrChunks = [];
  const exit = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });

  child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
  child.stderr.on("data", (chunk) => stderrChunks.push(chunk));

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
