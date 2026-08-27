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
import { observeChildProcess, waitForResponseOrExit } from "./child-process.mjs";
import { createPlatformCommand, isCleanTermination } from "./platform-command.mjs";

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const canonicalRepository = "https://github.com/fx/mcp-arr";
const allowedFiles = [
  "LICENSE",
  "README.md",
  "dist/adapters/acquisition/model.js",
  "dist/adapters/acquisition/parse.js",
  "dist/adapters/acquisition/prowlarr.js",
  "dist/adapters/acquisition/radarr.js",
  "dist/adapters/acquisition/requests.js",
  "dist/adapters/acquisition/service.js",
  "dist/adapters/acquisition/sonarr.js",
  "dist/adapters/activity/media.js",
  "dist/adapters/activity/model.js",
  "dist/adapters/activity/parse.js",
  "dist/adapters/activity/prowlarr.js",
  "dist/adapters/activity/requests.js",
  "dist/adapters/activity/service.js",
  "dist/adapters/activity/shared.js",
  "dist/adapters/library/model.js",
  "dist/adapters/library/paging.js",
  "dist/adapters/library/parse.js",
  "dist/adapters/library/radarr.js",
  "dist/adapters/library/requests.js",
  "dist/adapters/library/service.js",
  "dist/adapters/library/sonarr.js",
  "dist/adapters/registry.js",
  "dist/adapters/version.js",
  "dist/applications.js",
  "dist/cli.js",
  "dist/config/base-url.js",
  "dist/config/environment.js",
  "dist/http/client.js",
  "dist/http/errors.js",
  "dist/process.js",
  "dist/server.js",
  "dist/state/apply-records.js",
  "dist/state/clock.js",
  "dist/state/jobs.js",
  "dist/state/plans.js",
  "dist/state/references.js",
  "dist/state/tokens.js",
  "dist/state/workflow.js",
  "dist/stdio.js",
  "dist/tools/capabilities.js",
  "dist/tools/definitions.js",
  "dist/tools/dispatch.js",
  "dist/tools/errors.js",
  "dist/tools/jobs.js",
  "dist/tools/library.js",
  "dist/tools/names.js",
  "dist/tools/operations.js",
  "dist/tools/register.js",
  "dist/tools/results.js",
  "dist/tools/schemas/acquisition.js",
  "dist/tools/schemas/activity.js",
  "dist/tools/schemas/capabilities.js",
  "dist/tools/schemas/common.js",
  "dist/tools/schemas/configuration.js",
  "dist/tools/schemas/jobs.js",
  "dist/tools/schemas/library-results.js",
  "dist/tools/schemas/library.js",
  "package.json",
].sort();
const strictNpmEnvironment = {
  ...process.env,
  npm_config_engine_strict: "true",
  npm_config_strict_peer_deps: "true",
};
const instanceVariables = [
  "SONARR_URL",
  "SONARR_API_KEY",
  "RADARR_URL",
  "RADARR_API_KEY",
  "PROWLARR_URL",
  "PROWLARR_API_KEY",
];
/**
 * The server rejects startup without a complete instance pair. Inherited
 * instance variables are dropped so a developer's own settings cannot change
 * the verification, and these placeholders point at the reserved `.invalid`
 * domain, which is never contacted because the verifier only initializes the
 * MCP session.
 */
const instanceEnvironment = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !instanceVariables.includes(name)),
  ),
  SONARR_URL: "https://sonarr.example.invalid/sonarr",
  SONARR_API_KEY: "package-verification-placeholder",
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
  const invocation = createPlatformCommand(command, args);
  try {
    return await execFileAsync(invocation.executable, invocation.args, {
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
  assert(manifest.license === "MIT", "Packed manifest must declare the MIT license");
  const repositoryUrl =
    typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url;
  assert(typeof repositoryUrl === "string", "Packed manifest must declare its repository");
  assert(
    repositoryUrl.replace(/^git\+/u, "").replace(/\.git$/u, "") === canonicalRepository,
    `Packed manifest repository must be ${canonicalRepository}, not ${repositoryUrl}`,
  );
  assert(
    Array.isArray(manifest.files) && manifest.files.length === 1 && manifest.files[0] === "dist",
    "Packed manifest files allowlist must contain only dist",
  );
}

async function verifyInstalledProcess(binPath, cwd, expectedVersion) {
  const invocation = createPlatformCommand(binPath, []);
  const child = spawn(invocation.executable, invocation.args, {
    cwd,
    env: instanceEnvironment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const readBuffer = new ReadBuffer();
  let resolveResponse;
  let rejectResponse;
  const responsePromise = new Promise((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = reject;
  });
  const observed = observeChildProcess(child, {
    onStdoutChunk: (chunk) => {
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
    },
  });

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
    const response = await withDeadline(
      waitForResponseOrExit(responsePromise, observed.exit, "installed package initialization"),
      "installed package initialization",
    );
    assert(response.jsonrpc === "2.0" && response.id === 1, "Installed bin returned the wrong ID");
    assert(
      response.result?.serverInfo?.name === "mcp-arr",
      "Installed bin returned the wrong server",
    );
    // The advertised version is only trustworthy if it tracks what npm
    // installed; a hardcoded literal silently freezes while releases move on.
    assert(
      response.result?.serverInfo?.version === expectedVersion,
      `Installed bin reported version ${response.result?.serverInfo?.version}, not the installed manifest version ${expectedVersion}`,
    );
    assert(
      response.result?.protocolVersion === LATEST_PROTOCOL_VERSION,
      "Installed bin negotiated the wrong MCP protocol version",
    );

    child.stdin.write(serializeMessage({ jsonrpc: "2.0", method: "notifications/initialized" }));
    assert(child.kill("SIGTERM"), "Installed bin did not accept SIGTERM");
    const exit = await withDeadline(observed.exit, "installed package shutdown");
    assert(isCleanTermination(exit), "Installed bin did not terminate cleanly");
    const closed = await withDeadline(observed.closed, "installed package stream close");
    assert(
      closed.code === exit.code && closed.signal === exit.signal,
      "Installed bin close status did not match its exit status",
    );

    const stdoutLines = observed.stdout.split("\n");
    assert(stdoutLines.length === 2 && stdoutLines[1] === "", "Installed bin polluted stdout");
    assert(
      JSON.stringify(deserializeMessage(stdoutLines[0] ?? "")) === JSON.stringify(response),
      "Installed bin emitted invalid MCP framing",
    );
    assert(observed.stderr === "", "Installed bin wrote to stderr");
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    await withDeadline(observed.closed, "installed package cleanup").catch(() => undefined);
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
  await verifyInstalledProcess(binPath, consumerDirectory, installedManifest.version);
  process.stdout.write("Package verification passed\n");
} finally {
  if (temporaryRoot !== undefined) {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
