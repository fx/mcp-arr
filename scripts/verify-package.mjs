import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
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
import { assert, exchange, freePort, withDeadline } from "./verification.mjs";

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const canonicalRepository = "https://github.com/fx/mcp-arr";
const allowedFiles = [
  "LICENSE",
  "README.md",
  "dist/adapters/acquisition/commands.js",
  "dist/adapters/acquisition/grab.js",
  "dist/adapters/acquisition/model.js",
  "dist/adapters/acquisition/parse.js",
  "dist/adapters/acquisition/prowlarr.js",
  "dist/adapters/acquisition/radarr.js",
  "dist/adapters/acquisition/requests.js",
  "dist/adapters/acquisition/service.js",
  "dist/adapters/acquisition/sonarr.js",
  "dist/adapters/activity/changes.js",
  "dist/adapters/activity/diagnosis.js",
  "dist/adapters/activity/media.js",
  "dist/adapters/activity/model.js",
  "dist/adapters/activity/parse.js",
  "dist/adapters/activity/prowlarr.js",
  "dist/adapters/activity/requests.js",
  "dist/adapters/activity/service.js",
  "dist/adapters/activity/shared.js",
  "dist/adapters/activity/transitions.js",
  "dist/adapters/configuration/domains.js",
  "dist/adapters/configuration/fields.js",
  "dist/adapters/configuration/model.js",
  "dist/adapters/configuration/parse.js",
  "dist/adapters/configuration/resources.js",
  "dist/adapters/configuration/serialize.js",
  "dist/adapters/configuration/service.js",
  "dist/adapters/import/candidates.js",
  "dist/adapters/import/corrections.js",
  "dist/adapters/import/execute.js",
  "dist/adapters/import/model.js",
  "dist/adapters/jobs.js",
  "dist/adapters/library/changes.js",
  "dist/adapters/library/files.js",
  "dist/adapters/library/model.js",
  "dist/adapters/library/paging.js",
  "dist/adapters/library/parse.js",
  "dist/adapters/library/radarr.js",
  "dist/adapters/library/requests.js",
  "dist/adapters/library/service.js",
  "dist/adapters/library/sonarr.js",
  "dist/adapters/library/titles.js",
  "dist/adapters/registry.js",
  "dist/adapters/version.js",
  "dist/applications.js",
  "dist/cli.js",
  "dist/config/base-url.js",
  "dist/config/environment.js",
  "dist/http/client.js",
  "dist/http/errors.js",
  "dist/http-transport.js",
  "dist/process.js",
  "dist/server.js",
  "dist/state/apply-records.js",
  "dist/state/clock.js",
  "dist/state/download-claims.js",
  "dist/state/jobs.js",
  "dist/state/plans.js",
  "dist/state/references.js",
  "dist/state/title-locks.js",
  "dist/state/tokens.js",
  "dist/state/workflow.js",
  "dist/stdin.js",
  "dist/stdio.js",
  "dist/tools/acquisition.js",
  "dist/tools/activity-change.js",
  "dist/tools/activity-references.js",
  "dist/tools/activity.js",
  "dist/tools/capabilities.js",
  "dist/tools/configuration.js",
  "dist/tools/definitions.js",
  "dist/tools/dispatch.js",
  "dist/tools/errors.js",
  "dist/tools/import-execute.js",
  "dist/tools/import-inspect.js",
  "dist/tools/import-references.js",
  "dist/tools/jobs.js",
  "dist/tools/library-change.js",
  "dist/tools/library.js",
  "dist/tools/media/add.js",
  "dist/tools/media/context.js",
  "dist/tools/media/definitions.js",
  "dist/tools/media/downloads.js",
  "dist/tools/media/errors.js",
  "dist/tools/media/find.js",
  "dist/tools/media/fix.js",
  "dist/tools/media/kinds.js",
  "dist/tools/media/probe.js",
  "dist/tools/media/published-text.js",
  "dist/tools/media/remove.js",
  "dist/tools/media/resolution.js",
  "dist/tools/media/schemas.js",
  "dist/tools/media/search-again.js",
  "dist/tools/media/status.js",
  "dist/tools/media/titles.js",
  "dist/tools/names.js",
  "dist/tools/operations.js",
  "dist/tools/projection.js",
  "dist/tools/queue-resolve.js",
  "dist/tools/register.js",
  "dist/tools/results.js",
  "dist/tools/schemas/acquisition-results.js",
  "dist/tools/schemas/acquisition.js",
  "dist/tools/schemas/activity-results.js",
  "dist/tools/schemas/activity.js",
  "dist/tools/schemas/capabilities.js",
  "dist/tools/schemas/common.js",
  "dist/tools/schemas/configuration-results.js",
  "dist/tools/schemas/configuration.js",
  "dist/tools/schemas/jobs.js",
  "dist/tools/schemas/json-schema.js",
  "dist/tools/schemas/library-results.js",
  "dist/tools/schemas/library.js",
  "dist/tools/schemas/projection.js",
  "dist/tools/schemas/publish-results.js",
  "dist/tools/schemas/publish.js",
  "package.json",
].sort();
const strictNpmEnvironment = {
  ...process.env,
  npm_config_engine_strict: "true",
  npm_config_strict_peer_deps: "true",
};
const configurationVariables = [
  "SONARR_URL",
  "SONARR_API_KEY",
  "RADARR_URL",
  "RADARR_API_KEY",
  "PROWLARR_URL",
  "PROWLARR_API_KEY",
  "ARR_UPSTREAM_TIMEOUT_MS",
  "ARR_MCP_TRANSPORT",
  "ARR_MCP_HTTP_HOST",
  "ARR_MCP_HTTP_PORT",
  "ARR_MCP_AUTH_TOKEN",
  "ARR_MCP_TOOLSET",
  "ARR_MCP_MEDIA_MOVIE_QUALITY_PROFILE",
  "ARR_MCP_MEDIA_MOVIE_ROOT_FOLDER",
  "ARR_MCP_MEDIA_SERIES_QUALITY_PROFILE",
  "ARR_MCP_MEDIA_SERIES_ROOT_FOLDER",
  "ARR_MCP_MEDIA_ALLOW_REMOVE",
];
/**
 * The server rejects startup without a complete instance pair. Every inherited
 * variable the server reads is dropped — the instance pairs, the upstream
 * timeout, the transport settings, the toolset selection, and the media
 * defaults alike — so a developer's own settings cannot change the
 * verification, and these placeholders point at the reserved `.invalid`
 * domain, which is never contacted because the verifier only initializes the
 * MCP session.
 */
const instanceEnvironment = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !configurationVariables.includes(name)),
  ),
  SONARR_URL: "https://sonarr.example.invalid/sonarr",
  SONARR_API_KEY: "package-verification-placeholder",
};

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

/**
 * What the installed executable publishes with no toolset selection: the
 * `media` tools, `media_remove` excepted because removal is not enabled.
 * Written out here rather than read from the package, so a changed default is
 * caught rather than followed.
 */
const defaultToolNames = [
  "media_find",
  "media_add",
  "media_status",
  "media_fix",
  "media_search_again",
];

/** The selections the installed stdio executable is started under, and what each must list. */
const stdioSelections = [
  {
    label: "the default selection",
    env: instanceEnvironment,
    assertTools: (names) =>
      assert(
        JSON.stringify(names) === JSON.stringify(defaultToolNames),
        `Installed bin did not list the media toolset by default: ${names.join(", ")}`,
      ),
  },
  {
    label: "ARR_MCP_TOOLSET=arr",
    env: { ...instanceEnvironment, ARR_MCP_TOOLSET: "arr" },
    assertTools: (names) =>
      assert(
        names.length === 14 &&
          names.includes("arr_capabilities") &&
          names.every((name) => name.startsWith("arr_")),
        `Installed bin did not list the fourteen arr tools when arr was selected: ${names.join(", ")}`,
      ),
  },
];

async function verifyInstalledProcess(binPath, cwd, expectedVersion, selection) {
  const invocation = createPlatformCommand(binPath, []);
  const child = spawn(invocation.executable, invocation.args, {
    cwd,
    env: selection.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const readBuffer = new ReadBuffer();
  const responses = new Map();
  const observed = observeChildProcess(child, {
    onStdoutChunk: (chunk) => {
      try {
        readBuffer.append(chunk);
        for (
          let message = readBuffer.readMessage();
          message !== null;
          message = readBuffer.readMessage()
        ) {
          if ("id" in message) {
            responses.get(message.id)?.resolve(message);
          }
        }
      } catch (error) {
        for (const response of responses.values()) {
          response.reject(error);
        }
      }
    },
  });
  const expectResponse = (id) =>
    new Promise((resolve, reject) => {
      responses.set(id, { resolve, reject });
    });

  try {
    const responsePromise = expectResponse(1);
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
    const listedPromise = expectResponse(2);
    child.stdin.write(serializeMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
    const listed = await withDeadline(
      waitForResponseOrExit(listedPromise, observed.exit, "installed package tool listing"),
      "installed package tool listing",
    );
    assert(listed.jsonrpc === "2.0" && listed.id === 2, "Installed bin returned the wrong ID");
    selection.assertTools((listed.result?.tools ?? []).map((tool) => tool.name));

    assert(child.kill("SIGTERM"), `Installed bin did not accept SIGTERM under ${selection.label}`);
    const exit = await withDeadline(observed.exit, "installed package shutdown");
    assert(isCleanTermination(exit), "Installed bin did not terminate cleanly");
    const closed = await withDeadline(observed.closed, "installed package stream close");
    assert(
      closed.code === exit.code && closed.signal === exit.signal,
      "Installed bin close status did not match its exit status",
    );

    const stdoutLines = observed.stdout.split("\n");
    assert(stdoutLines.length === 3 && stdoutLines[2] === "", "Installed bin polluted stdout");
    assert(
      JSON.stringify(deserializeMessage(stdoutLines[0] ?? "")) === JSON.stringify(response) &&
        JSON.stringify(deserializeMessage(stdoutLines[1] ?? "")) === JSON.stringify(listed),
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

/**
 * Starts the installed executable with the HTTP transport, with stdin ignored
 * as a container without an attached stdin starts it, and holds it to the
 * listener's contract: an unauthenticated health check, a challenge without
 * the token, a stateless initialization with it, a single startup line that
 * carries no credential, and a clean exit on SIGTERM.
 */
async function verifyInstalledHttpProcess(binPath, cwd, expectedVersion) {
  const port = await freePort();
  const token = randomBytes(32).toString("hex");
  const invocation = createPlatformCommand(binPath, []);
  const child = spawn(invocation.executable, invocation.args, {
    cwd,
    env: {
      ...instanceEnvironment,
      ARR_MCP_TOOLSET: "arr",
      ARR_MCP_TRANSPORT: "http",
      ARR_MCP_HTTP_PORT: String(port),
      ARR_MCP_AUTH_TOKEN: token,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const startupLine = `mcp-arr: listening on http://127.0.0.1:${port}/mcp with the arr toolset\n`;
  let resolveListening;
  const listening = new Promise((resolve) => {
    resolveListening = resolve;
  });
  let stderr = "";
  const observed = observeChildProcess(child, {
    onStderrChunk: (chunk) => {
      stderr += chunk.toString("utf8");
      if (stderr.includes("\n")) {
        resolveListening();
      }
    },
  });

  try {
    await withDeadline(
      waitForResponseOrExit(listening, observed.exit, "installed HTTP listener startup"),
      "installed HTTP listener startup",
    );

    const health = await exchange(port, { method: "GET", path: "/healthz" });
    assert(health.status === 200, `Installed HTTP health check answered ${health.status}`);

    const initialize = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "package-verifier", version: "1.0.0" },
      },
    });
    const mcpHeaders = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    const challenged = await exchange(port, {
      method: "POST",
      path: "/mcp",
      headers: mcpHeaders,
      body: initialize,
    });
    assert(
      challenged.status === 401,
      `Installed HTTP bin answered ${challenged.status} without a token`,
    );
    assert(
      challenged.headers["www-authenticate"] === 'Bearer realm="mcp-arr"',
      "Installed HTTP bin did not challenge for a bearer token",
    );

    const initialized = await exchange(port, {
      method: "POST",
      path: "/mcp",
      headers: { ...mcpHeaders, Authorization: `Bearer ${token}` },
      body: initialize,
    });
    assert(
      initialized.status === 200,
      `Installed HTTP bin answered ${initialized.status} to initialize`,
    );
    assert(
      initialized.headers["content-type"] === "application/json",
      "Installed HTTP bin did not answer initialize with JSON",
    );
    assert(
      initialized.headers["mcp-session-id"] === undefined,
      "Installed HTTP bin minted a session identifier",
    );
    const response = JSON.parse(initialized.body);
    assert(
      response.jsonrpc === "2.0" && response.id === 1,
      "Installed HTTP bin returned the wrong ID",
    );
    assert(
      response.result?.serverInfo?.name === "mcp-arr",
      "Installed HTTP bin returned the wrong server",
    );
    assert(
      response.result?.serverInfo?.version === expectedVersion,
      `Installed HTTP bin reported version ${response.result?.serverInfo?.version}, not the installed manifest version ${expectedVersion}`,
    );

    assert(child.kill("SIGTERM"), "Installed HTTP bin did not accept SIGTERM");
    const exit = await withDeadline(observed.exit, "installed HTTP bin shutdown");
    assert(isCleanTermination(exit), "Installed HTTP bin did not terminate cleanly");
    await withDeadline(observed.closed, "installed HTTP bin stream close");

    assert(observed.stdout === "", "Installed HTTP bin wrote to stdout");
    assert(!observed.stderr.includes(token), "Installed HTTP bin wrote its token to stderr");
    assert(
      observed.stderr === startupLine,
      "Installed HTTP bin wrote something other than its startup line to stderr",
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    await withDeadline(observed.closed, "installed HTTP bin cleanup").catch(() => undefined);
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
  for (const selection of stdioSelections) {
    await verifyInstalledProcess(binPath, consumerDirectory, installedManifest.version, selection);
  }
  await verifyInstalledHttpProcess(binPath, consumerDirectory, installedManifest.version);
  process.stdout.write("Package verification passed\n");
} finally {
  if (temporaryRoot !== undefined) {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
