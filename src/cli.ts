#!/usr/bin/env node

process.stdin.ref();

void import("./process.js")
  .then(({ runProcess }) => runProcess())
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`mcp-arr: startup failed: ${message}\n`);
    process.exitCode = 1;
    process.stdin.unref();
  });
