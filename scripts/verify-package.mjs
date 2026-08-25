import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  deserializeMessage,
  ReadBuffer,
  serializeMessage,
} from "@modelcontextprotocol/sdk/shared/stdio.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const allowedFiles = [
  "README.md",
  "dist/cli.js",
  "dist/process.js",
  "dist/server.js",
  "dist/stdio.js",
  "package.json",
].sort();
const strictNpmEnvironment = {
  ...process.env,
  npm_config_engine_strict: "true",
  npm_config_strict_peer_deps: "true",
};

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function withDeadline(promise, label, timeoutMs = 5_000) {
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

async function run(command, args, options) {
  try {
    return await execFileAsync(command, args, {
      ...options,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error) {
    const stdout = typeof error.stdout === "string" ? error.stdout : "";
    const stderr = typeof error.stderr === "string" ? error.stderr : "";
    throw new Error(`${command} ${args.join(" ")} failed\n${stdout}${stderr}`, { cause: error });
  }
}

function assertManifest(manifest) {
  assert(manifest.name === "mcp-arr", "Packed manifest name must be mcp-arr");
  assert(
    typeof manifest.version === "string" &&
      /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(manifest.version),
    "Packed manifest must contain a semantic version",
  );
  assert(manifest.type === "module", "Packed manifest type must be module");
  assert(
    manifest.bin?.["mcp-arr"] === "dist/cli.js",
    "Packed manifest must expose dist/cli.js as the mcp-arr bin",
  );
  assert(manifest.engines?.node === ">=20", "Packed manifest must require Node.js >=20");
  assert(
    Array.isArray(manifest.files) && manifest.files.length === 1 && manifest.files[0] === "dist",
    "Packed manifest files allowlist must contain only dist",
  );
}

async function verifyInstalledProcess(binPath, cwd) {
  const child = spawn(binPath, [], {
    cwd,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdoutChunks = [];
  const stderrChunks = [];
  const readBuffer = new ReadBuffer();
  let resolveResponse;
  let rejectResponse;
  const responsePromise = new Promise((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = reject;
  });
  const exitPromise = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  child.stdout.on("data", (chunk) => {
    stdoutChunks.push(chunk);
    try {
      readBuffer.append(chunk);
      for (
        let message = readBuffer.readMessage();
        message !== null;
        message = readBuffer.readMessage()
      ) {
        if ("id" in message && message.id === 1) {
          resolveResponse(message);
        }
      }
    } catch (error) {
      rejectResponse(error);
    }
  });
  child.stderr.on("data", (chunk) => stderrChunks.push(chunk));

  try {
    child.stdin.write(
      serializeMessage({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "package-verifier", version: "1.0.0" },
        },
      }),
    );
    const response = await withDeadline(responsePromise, "installed package initialization");
    assert(response.jsonrpc === "2.0" && response.id === 1, "Installed bin returned the wrong ID");
    assert(
      response.result?.serverInfo?.name === "mcp-arr",
      "Installed bin returned the wrong server",
    );
    assert(
      response.result?.protocolVersion === LATEST_PROTOCOL_VERSION,
      "Installed bin negotiated the wrong MCP protocol version",
    );

    child.stdin.write(serializeMessage({ jsonrpc: "2.0", method: "notifications/initialized" }));
    assert(child.kill("SIGTERM"), "Installed bin did not accept SIGTERM");
    const exit = await withDeadline(exitPromise, "installed package shutdown");
    assert(exit.code === 0 && exit.signal === null, "Installed bin did not terminate cleanly");

    const stdout = Buffer.concat(stdoutChunks).toString("utf8");
    const stdoutLines = stdout.split("\n");
    assert(stdoutLines.length === 2 && stdoutLines[1] === "", "Installed bin polluted stdout");
    assert(
      JSON.stringify(deserializeMessage(stdoutLines[0] ?? "")) === JSON.stringify(response),
      "Installed bin emitted invalid MCP framing",
    );
    assert(Buffer.concat(stderrChunks).toString("utf8") === "", "Installed bin wrote to stderr");
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    await withDeadline(exitPromise, "installed package cleanup").catch(() => undefined);
  }
}

let temporaryRoot;
try {
  temporaryRoot = await mkdtemp(path.join(tmpdir(), "mcp-arr-package-"));
  const packDirectory = path.join(temporaryRoot, "pack");
  const consumerDirectory = path.join(temporaryRoot, "consumer");
  await Promise.all([mkdir(packDirectory), mkdir(consumerDirectory)]);

  const { stdout: packOutput } = await run(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["pack", "--json", "--pack-destination", packDirectory],
    { cwd: projectRoot, env: strictNpmEnvironment },
  );
  const packResults = JSON.parse(packOutput);
  assert(Array.isArray(packResults) && packResults.length === 1, "npm pack returned no package");
  const packResult = packResults[0];
  const packedFiles = packResult.files.map(({ path: filePath }) => filePath).sort();
  assert(
    JSON.stringify(packedFiles) === JSON.stringify(allowedFiles),
    `Unexpected packed files: ${packedFiles.join(", ")}`,
  );
  const packedBin = packResult.files.find(({ path: filePath }) => filePath === "dist/cli.js");
  assert(packedBin !== undefined, "Packed archive is missing dist/cli.js");
  assert((packedBin.mode & 0o111) !== 0, "Packed dist/cli.js is not executable");

  const tarballPath = path.join(packDirectory, packResult.filename);
  const consumerManifest = {
    name: "mcp-arr-package-consumer",
    version: "1.0.0",
    private: true,
  };
  await Promise.all([
    writeFile(
      path.join(consumerDirectory, "package.json"),
      `${JSON.stringify(consumerManifest, null, 2)}\n`,
      "utf8",
    ),
    writeFile(
      path.join(consumerDirectory, ".npmrc"),
      "engine-strict=true\nstrict-peer-deps=true\n",
      "utf8",
    ),
  ]);
  await run(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["install", "--package-lock=false", "--no-audit", "--no-fund", tarballPath],
    { cwd: consumerDirectory, env: strictNpmEnvironment },
  );

  const installedRoot = path.join(consumerDirectory, "node_modules", "mcp-arr");
  const installedManifest = JSON.parse(
    await readFile(path.join(installedRoot, "package.json"), "utf8"),
  );
  assertManifest(installedManifest);
  const binPath = path.join(
    consumerDirectory,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "mcp-arr.cmd" : "mcp-arr",
  );
  await verifyInstalledProcess(binPath, consumerDirectory);
  process.stdout.write("Package verification passed\n");
} finally {
  if (temporaryRoot !== undefined) {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
