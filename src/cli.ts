#!/usr/bin/env node

import { refStdin, unrefStdin } from "./stdin.js";

refStdin();

void import("./process.js")
  .then(({ runProcess }) => runProcess())
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`mcp-arr: startup failed: ${message}\n`);
    process.exitCode = 1;
    unrefStdin();
  });
