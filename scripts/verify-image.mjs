import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { observeChildProcess, waitForResponseOrExit } from "./child-process.mjs";
import { assert, exchange, freePort, withDeadline } from "./verification.mjs";

/**
 * Smoke-tests a container image that is already loaded into the local Docker
 * daemon, named by its tag. It never builds or pulls anything: CI builds the
 * image once, loads each platform from that one build, runs this against it,
 * and publishes that build only if this passes.
 *
 *   node scripts/verify-image.mjs <local image tag> [--platform <os>/<arch>]
 *
 * `--platform` runs the image for that platform and asserts the image is built
 * for it. When it is not the Docker daemon's own platform the image runs under
 * the emulation CI registers, which is several times slower, so every bound is
 * widened, and PID 1 is the emulator running the image's entrypoint.
 *
 * It is not part of the test suite because it needs a Docker daemon, and the
 * suite must run anywhere without one; the Docker workflow is where it runs.
 */

const [image, platformFlag, platform, ...extra] = process.argv.slice(2);
if (
  image === undefined ||
  image === "" ||
  extra.length > 0 ||
  (platformFlag !== undefined &&
    (platformFlag !== "--platform" || !/^[a-z0-9]+\/[a-z0-9]+$/u.test(platform ?? "")))
) {
  throw new Error(
    "Usage: node scripts/verify-image.mjs <local image tag> [--platform <os>/<arch>]",
  );
}
const platformFlags = platform === undefined ? [] : ["--platform", platform];
/** Whether the image runs under emulation; settled from the daemon before any check runs. */
let emulated = false;

/** A bound on a wait, widened when the image runs under emulation. */
function bound(ms) {
  return emulated ? ms * 5 : ms;
}

const canonicalRepository = "https://github.com/fx/mcp-arr";
const containerPort = 9797;
const runtimeUid = "1000";
const installedPackage = "/usr/local/lib/node_modules/mcp-arr";
/**
 * The server's default upstream deadline, which is also the longest it lets
 * requests in progress drain after SIGTERM. `docker stop` is given exactly
 * this long before it kills, so a container that needed the kill fails here.
 */
const upstreamTimeoutMs = 30_000;
const startupLine = `mcp-arr: listening on http://0.0.0.0:${containerPort}/mcp with the media toolset\n`;

/**
 * What the image publishes when it is run with no toolset selection, as the
 * package does: the `media` tools, `media_remove` excepted because removal is
 * not enabled. Written out here rather than read from the build, so a changed
 * default is caught rather than followed.
 */
const defaultToolNames = [
  "media_find",
  "media_add",
  "media_status",
  "media_fix",
  "media_search_again",
];

/**
 * Placeholder instance settings on the reserved `.invalid` domain. Nothing
 * here contacts the instance — initialize and tools/list are answered by the
 * server alone — so the values only have to be well formed. They reach the
 * container as `-e NAME` with the value in the Docker CLI's environment, so no
 * value, the token included, is ever on a command line.
 */
const instanceEnvironment = {
  SONARR_URL: "https://sonarr.example.invalid",
  SONARR_API_KEY: randomBytes(16).toString("hex"),
};

const startedContainers = new Set();

function containerName(role) {
  const name = `mcp-arr-verify-${role}-${randomBytes(4).toString("hex")}`;
  startedContainers.add(name);
  return name;
}

function environmentFlags(variables) {
  return Object.keys(variables).flatMap((name) => ["-e", name]);
}

/** Runs one Docker CLI command to completion and reports how it ended, failing only on the bound. */
function runDocker(args, { variables = {}, timeoutMs = bound(60_000) } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      "docker",
      args,
      {
        env: { ...process.env, ...variables },
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
        timeout: timeoutMs,
      },
      (error, stdout, stderr) => {
        if (error?.killed === true) {
          reject(new Error(`docker ${args[0]} did not finish within ${timeoutMs} ms`));
          return;
        }
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : -1;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

async function docker(args, options) {
  const result = await runDocker(args, options);
  assert(
    result.code === 0,
    `docker ${args.join(" ")} exited ${result.code}\n${result.stdout}${result.stderr}`,
  );
  return result.stdout;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The image's own declaration: who it runs as, how it stops, and what it never carries. */
async function verifyImageConfiguration() {
  const [inspected] = JSON.parse(await docker(["image", "inspect", image]));
  const config = inspected?.Config;
  assert(config !== undefined, `docker image inspect returned no configuration for ${image}`);
  if (platform !== undefined) {
    const built = `${inspected.Os}/${inspected.Architecture}`;
    assert(built === platform, `Image is built for ${built}, not ${platform}`);
  }
  assert(config.User === `${runtimeUid}:${runtimeUid}`, `Image runs as ${config.User}, not 1000`);
  assert(config.StopSignal === "SIGTERM", `Image stop signal is ${config.StopSignal}`);
  assert(
    JSON.stringify(config.Entrypoint) === JSON.stringify(["/usr/bin/tini", "--"]),
    `Image entrypoint is ${JSON.stringify(config.Entrypoint)}, not tini`,
  );
  assert(
    Object.hasOwn(config.ExposedPorts ?? {}, `${containerPort}/tcp`),
    `Image does not expose ${containerPort}/tcp`,
  );
  const test = config.Healthcheck?.Test ?? [];
  assert(
    test[0] === "CMD" && test[1] === "node" && test.some((part) => part.includes("/healthz")),
    `Image health check is not a node probe of /healthz: ${JSON.stringify(test)}`,
  );
  const environment = Object.fromEntries(
    (config.Env ?? []).map((entry) => {
      const separator = entry.indexOf("=");
      return [entry.slice(0, separator), entry.slice(separator + 1)];
    }),
  );
  assert(environment.ARR_MCP_TRANSPORT === "http", "Image does not select the HTTP transport");
  assert(environment.ARR_MCP_HTTP_HOST === "0.0.0.0", "Image does not bind every interface");
  assert(
    environment.ARR_MCP_HTTP_PORT === String(containerPort),
    `Image does not listen on ${containerPort}`,
  );
  const baked = Object.keys(environment).filter(
    (name) => name === "ARR_MCP_AUTH_TOKEN" || /_(?:URL|API_KEY)$/u.test(name),
  );
  assert(baked.length === 0, `Image bakes in credentials or instances: ${baked.join(", ")}`);
  assert(
    environment.ARR_MCP_TOOLSET === undefined,
    "Image selects a toolset instead of publishing the package default",
  );
  assert(
    config.Labels?.["org.opencontainers.image.source"] === canonicalRepository,
    `Image source label is not ${canonicalRepository}`,
  );
  const description = config.Labels?.["org.opencontainers.image.description"];
  assert(
    typeof description === "string" && description.trim() !== "",
    "Image description label is empty",
  );
}

/**
 * What the image contains, read as root so nothing is hidden by permissions:
 * the installed package holds only what npm installs from the packed tarball,
 * and no source tree, build directory, or local MCP host configuration exists
 * anywhere on its filesystem.
 */
async function verifyImageContents() {
  const probe = `
const fs = require("node:fs");
const skipped = new Set(["/proc", "/sys", "/dev"]);
const hostConfigurations = [];
const walk = (directory) => {
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = directory === "/" ? "/" + entry.name : directory + "/" + entry.name;
    if (skipped.has(full)) continue;
    if (entry.name === ".mcp.json") hostConfigurations.push(full);
    if (entry.isDirectory()) walk(full);
  }
};
walk("/");
const root = ${JSON.stringify(installedPackage)};
process.stdout.write(JSON.stringify({
  packageEntries: fs.readdirSync(root).sort(),
  present: ["/app", "/build", "/pack", root + "/src", root + "/test"].filter((path) => fs.existsSync(path)),
  hostConfigurations,
}));
`;
  const output = await docker([
    "run",
    "--rm",
    "--name",
    containerName("contents"),
    "--pull",
    "never",
    ...platformFlags,
    "--network",
    "none",
    "--user",
    "0:0",
    "--entrypoint",
    "node",
    image,
    "-e",
    probe,
  ]);
  const contents = JSON.parse(output);
  const expectedEntries = ["LICENSE", "README.md", "dist", "node_modules", "package.json"];
  assert(
    JSON.stringify(contents.packageEntries) === JSON.stringify(expectedEntries),
    `Installed package holds ${contents.packageEntries.join(", ")}, not ${expectedEntries.join(", ")}`,
  );
  assert(
    contents.present.length === 0,
    `Image carries paths it must not: ${contents.present.join(", ")}`,
  );
  assert(
    contents.hostConfigurations.length === 0,
    `Image carries an MCP host configuration: ${contents.hostConfigurations.join(", ")}`,
  );
}

/** Without a token the server must refuse to start, naming the variable and nothing it was given. */
async function verifyRefusesWithoutToken() {
  const result = await runDocker(
    [
      "run",
      "--rm",
      "--name",
      containerName("no-token"),
      "--pull",
      "never",
      ...platformFlags,
      "--network",
      "none",
      ...environmentFlags(instanceEnvironment),
      image,
    ],
    { variables: instanceEnvironment, timeoutMs: bound(30_000) },
  );
  assert(result.code === 1, `Container without a token exited ${result.code}, not 1`);
  assert(
    result.stderr.includes("ARR_MCP_AUTH_TOKEN is required when ARR_MCP_TRANSPORT is http"),
    `Container without a token did not name ARR_MCP_AUTH_TOKEN:\n${result.stderr}`,
  );
  for (const value of Object.values(instanceEnvironment)) {
    assert(!result.stderr.includes(value), "Startup diagnostic disclosed a configured value");
  }
  assert(result.stdout === "", "Container without a token wrote to stdout");
}

function mcpRequest(port, token, message) {
  return exchange(port, {
    method: "POST",
    path: "/mcp",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(message),
    timeoutMs: bound(5_000),
  });
}

async function waitForHealthy(name, timeoutMs = bound(30_000)) {
  const deadline = Date.now() + timeoutMs;
  let health;
  while (Date.now() < deadline) {
    const state = JSON.parse(await docker(["inspect", "--format", "{{json .State}}", name]));
    assert(state.Running === true, `Container stopped while waiting for health: ${state.Status}`);
    health = state.Health;
    assert(health !== undefined && health !== null, "Container has no health check");
    assert(health.Status !== "unhealthy", "Container health check reported unhealthy");
    if (health.Status === "healthy") {
      return;
    }
    await sleep(500);
  }
  throw new Error(`Container was not healthy within ${timeoutMs} ms (${health?.Status})`);
}

/**
 * The long-running service: it starts with one stderr line, runs as uid 1000
 * under tini, answers the listener contract through a published port, turns
 * healthy by its own health check, and exits 0 on `docker stop`.
 */
async function verifyService(expectedVersion) {
  const name = containerName("service");
  const port = await freePort();
  const token = randomBytes(32).toString("hex");
  const variables = { ...instanceEnvironment, ARR_MCP_AUTH_TOKEN: token };
  const child = spawn(
    "docker",
    [
      "run",
      "--name",
      name,
      "--pull",
      "never",
      ...platformFlags,
      // The probe is the image's own command; only its schedule is shortened,
      // so this need not wait out the production interval before the first run,
      // and under emulation its timeout is widened for Node.js's slower start.
      "--health-interval",
      "1s",
      ...(emulated ? ["--health-timeout", "30s"] : []),
      "--publish",
      `127.0.0.1:${port}:${containerPort}`,
      ...environmentFlags(variables),
      image,
    ],
    { env: { ...process.env, ...variables }, stdio: ["ignore", "pipe", "pipe"] },
  );
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
    // A container that never listens is diagnosed by what it and the Docker
    // CLI wrote, which is the only evidence a CI run leaves behind.
    await withDeadline(
      waitForResponseOrExit(listening, observed.exit, "container listener startup"),
      "container listener startup",
      bound(30_000),
    ).catch((error) => {
      throw new Error(`${error.message}\n${observed.stdout}${observed.stderr}`, { cause: error });
    });
    assert(stderr === startupLine, `Container startup line was ${JSON.stringify(stderr)}`);

    const uid = (await docker(["exec", name, "id", "-u"])).trim();
    assert(uid === runtimeUid, `docker exec runs as uid ${uid}, not ${runtimeUid}`);
    const status = await docker(["exec", name, "cat", "/proc/1/status"]);
    const uids = /^Uid:\s+(.+)$/mu.exec(status)?.[1]?.trim().split(/\s+/u) ?? [];
    assert(
      uids.length === 4 && uids.every((value) => value === runtimeUid),
      `PID 1 runs with uids ${uids.join(" ")}, not ${runtimeUid}`,
    );
    // Under user-mode emulation the kernel starts the registered emulator,
    // which is then PID 1 with the guest's entrypoint as its first argument.
    const command = (await docker(["exec", name, "cat", "/proc/1/cmdline"])).split("\0");
    const guest =
      emulated && /(?:^|\/)qemu-[^/]+$/u.test(command[0] ?? "") ? command[1] : command[0];
    assert(guest === "/usr/bin/tini", `PID 1 runs ${command.join(" ")}, not tini`);

    const health = await exchange(port, {
      method: "GET",
      path: "/healthz",
      timeoutMs: bound(5_000),
    });
    assert(health.status === 200, `GET /healthz answered ${health.status}`);

    const initialize = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "image-verifier", version: "1.0.0" },
      },
    };
    const challenged = await mcpRequest(port, undefined, initialize);
    assert(challenged.status === 401, `POST /mcp without a token answered ${challenged.status}`);
    assert(
      challenged.headers["www-authenticate"] === 'Bearer realm="mcp-arr"',
      "POST /mcp without a token was not challenged for a bearer token",
    );

    const initialized = await mcpRequest(port, token, initialize);
    assert(initialized.status === 200, `initialize answered ${initialized.status}`);
    assert(
      initialized.headers["content-type"] === "application/json",
      "initialize was not answered with JSON",
    );
    assert(
      initialized.headers["mcp-session-id"] === undefined,
      "initialize minted a session identifier",
    );
    const initializeResult = JSON.parse(initialized.body).result;
    assert(initializeResult?.serverInfo?.name === "mcp-arr", "initialize named the wrong server");
    assert(
      initializeResult.serverInfo.version === expectedVersion,
      `Image reported version ${initializeResult.serverInfo.version}, not ${expectedVersion}`,
    );

    const listed = await mcpRequest(port, token, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    assert(listed.status === 200, `tools/list answered ${listed.status}`);
    const tools = JSON.parse(listed.body).result?.tools ?? [];
    const names = tools.map((tool) => tool.name);
    assert(
      JSON.stringify(names) === JSON.stringify(defaultToolNames),
      `tools/list did not list the default media toolset: ${names.join(", ")}`,
    );

    await waitForHealthy(name);

    const stopStarted = Date.now();
    await docker(["stop", "--time", String(upstreamTimeoutMs / 1000), name], {
      timeoutMs: upstreamTimeoutMs + bound(15_000),
    });
    const elapsed = Date.now() - stopStarted;
    const exit = await withDeadline(
      observed.exit,
      "container exit after docker stop",
      bound(15_000),
    );
    assert(
      exit.code === 0 && exit.signal === null,
      `Container exited ${exit.code} (${exit.signal}) on docker stop, not 0`,
    );
    const state = JSON.parse(await docker(["inspect", "--format", "{{json .State}}", name]));
    assert(state.ExitCode === 0, `Container state recorded exit code ${state.ExitCode}`);
    assert(state.OOMKilled === false, "Container was killed for memory");
    assert(elapsed < upstreamTimeoutMs, `docker stop took ${elapsed} ms`);
    await withDeadline(observed.closed, "container output close", bound(15_000));

    assert(observed.stdout === "", "Container wrote to stdout");
    assert(!observed.stderr.includes(token), "Container wrote its token to stderr");
    assert(
      observed.stderr === startupLine,
      `Container wrote something other than its startup line to stderr:\n${observed.stderr}`,
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    await withDeadline(observed.closed, "container output cleanup").catch(() => undefined);
  }
}

try {
  const daemonPlatform = (
    await docker(["version", "--format", "{{.Server.Os}}/{{.Server.Arch}}"])
  ).trim();
  emulated = platform !== undefined && platform !== daemonPlatform;
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  await verifyImageConfiguration();
  await verifyImageContents();
  await verifyRefusesWithoutToken();
  await verifyService(manifest.version);
  process.stdout.write(
    `Image verification passed for ${image}${platform === undefined ? "" : ` (${platform})`}\n`,
  );
} finally {
  for (const name of startedContainers) {
    await runDocker(["rm", "--force", name]).catch(() => undefined);
  }
}
