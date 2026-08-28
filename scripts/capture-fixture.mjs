#!/usr/bin/env node
/**
 * Refreshes one recorded upstream fixture from a configured instance.
 *
 * This is an operator tool, not a test. The committed suite never reaches an
 * instance, a network, or a credential; the fidelity guarantee comes from the
 * captured artifact being committed, not from the tests being able to capture
 * it. See `docs/specs/architecture/#testing-contract`.
 *
 * It reuses the project's own modules rather than re-implementing them: the
 * built environment parser and URL joiner the server itself uses, and the
 * fixture inventory and sanitizing screens the fixture contract test enforces.
 * A second copy of any of those would drift, and a screen this side did not
 * know about is exactly how an unsanitized value reaches a committed file.
 *
 * Usage:
 *   npm run build
 *   node scripts/capture-fixture.mjs --application sonarr --route manualimport \
 *     --query folder=/downloads/complete/example
 *
 *   --application  sonarr | radarr | prowlarr
 *   --route        an approved route, for example `config/downloadclient`
 *   --query        repeatable `name=value` upstream query parameter
 *   --dry-run      report what would be written without writing it
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { approvedFixtures, validateFixture, validateSanitizedValue } from "./fixture-contract.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const fixtureRoot = path.join(projectRoot, "test", "fixtures");
const requestTimeoutMs = 120_000;

/** Fails the run with a message and no stack trace. */
class CaptureError extends Error {}

function fail(message) {
  throw new CaptureError(message);
}

/**
 * Loads the server modules this capture reuses from the build output, so the
 * request it sends is composed exactly as the server composes one.
 */
async function loadServerModules() {
  try {
    const [applications, environment, baseUrl] = await Promise.all([
      import("../dist/applications.js"),
      import("../dist/config/environment.js"),
      import("../dist/config/base-url.js"),
    ]);
    return { applications, environment, baseUrl };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`Run \`npm run build\` first: the capture reads the build output.\n${detail}`);
  }
}

function parseArguments(argv) {
  const options = { query: [], dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) {
        fail(`Option ${argument} needs a value`);
      }
      index += 1;
      return next;
    };
    switch (argument) {
      case "--application":
        options.application = value();
        break;
      case "--route":
        options.route = value();
        break;
      case "--query":
        options.query.push(value());
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      default:
        fail(`Unknown option: ${argument}`);
    }
  }
  if (options.application === undefined || options.route === undefined) {
    fail("Both --application and --route are required");
  }
  return options;
}

function parseQuery(pairs) {
  const parameters = new URLSearchParams();
  for (const pair of pairs) {
    const separator = pair.indexOf("=");
    if (separator <= 0) {
      // The value is deliberately not echoed: a query parameter carries a path.
      fail("Each --query must be name=value");
    }
    parameters.append(pair.slice(0, separator), pair.slice(separator + 1));
  }
  return parameters;
}

/**
 * Reads one upstream route.
 *
 * A capture that cannot prove it read the route it names fails rather than
 * producing a fixture. A recorded body for a route the application answers
 * with 404 is the defect this procedure exists to prevent, and a 200 carrying
 * the web interface — which these applications serve for an unrecognized API
 * path — is the same defect wearing a success code.
 */
async function readRoute(instance, endpoint, parameters, joinUpstreamUrl) {
  const joined = joinUpstreamUrl(instance.baseUrl, endpoint);
  if (!joined.ok) {
    fail(`Route ${endpoint} does not form a usable URL: ${joined.problem}`);
  }
  const url = new URL(joined.url);
  url.search = parameters.toString();

  let response;
  try {
    response = await fetch(url, {
      headers: { "X-Api-Key": instance.apiKey, Accept: "application/json" },
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.name : "unknown error";
    fail(`${instance.application} did not answer ${endpoint} (${detail})`);
  }

  if (response.status === 404) {
    fail(
      `${instance.application} answers ${endpoint} with 404. That application does ` +
        "not serve this route, so no body it returns belongs under this name. " +
        "Correct the approved route rather than recording a body for it.",
    );
  }
  if (!response.ok) {
    fail(`${instance.application} answered ${endpoint} with status ${response.status}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  const body = await response.text();
  if (!contentType.toLowerCase().includes("json")) {
    fail(
      `${instance.application} answered ${endpoint} with ` +
        `${contentType === "" ? "no content type" : contentType} rather than JSON. ` +
        "An unrecognized API path is served the web interface, so this route " +
        "does not resolve on this application.",
    );
  }

  try {
    return JSON.parse(body);
  } catch {
    fail(`${instance.application} answered ${endpoint} with a body that is not JSON`);
  }
}

/**
 * Replaces what the fixture screens refuse, keeping the shape intact.
 *
 * The screens decide; this only supplies the replacement. A refused key is
 * dropped rather than renamed, because a secret's field name is what makes it
 * findable and no fixture needs it. A refused string becomes a neutral
 * stand-in, distinct per original value so that two fields which carried the
 * same value still carry the same value afterwards — what a fixture owes is
 * its field shapes, not its text.
 */
function createSanitizer(screen) {
  const replacements = new Map();

  const refusesKey = (key) => {
    try {
      screen({ [key]: 1 }, "value");
      return false;
    } catch {
      return true;
    }
  };

  const refusesValue = (value) => {
    try {
      screen(value, "value");
      return false;
    } catch {
      return true;
    }
  };

  const replace = (value) => {
    const existing = replacements.get(value);
    if (existing !== undefined) {
      return existing;
    }
    const ordinal = replacements.size + 1;
    // A value that reads as an absolute path stays one, so a path field keeps
    // describing a path. `/media/example` is the one prefix the screens allow.
    const isPath =
      value.startsWith("/") || /^[a-z]:[\\/]/iu.test(value) || value.startsWith("\\\\");
    const fresh = isPath ? `/media/example/example-${ordinal}` : `example-value-${ordinal}`;
    replacements.set(value, fresh);
    return fresh;
  };

  const sanitize = (value) => {
    if (Array.isArray(value)) {
      return value.map(sanitize);
    }
    if (typeof value === "object" && value !== null) {
      const result = {};
      for (const [key, child] of Object.entries(value)) {
        if (refusesKey(key)) {
          continue;
        }
        result[key] = sanitize(child);
      }
      return result;
    }
    if (typeof value === "string" && refusesValue(value)) {
      return replace(value);
    }
    return value;
  };

  return { sanitize, replacements };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const { applications, environment, baseUrl } = await loadServerModules();

  if (!applications.applicationIds.includes(options.application)) {
    fail(`Unknown application: ${options.application}`);
  }

  const approved = approvedFixtures.find(
    (candidate) =>
      candidate.application === options.application && candidate.route === options.route,
  );
  if (approved === undefined) {
    const routes = approvedFixtures
      .filter((candidate) => candidate.application === options.application)
      .map((candidate) => candidate.route);
    fail(
      `${options.application} records no fixture for route ${options.route}.\n` +
        `Approved routes: ${routes.join(", ")}`,
    );
  }

  let configuration;
  try {
    configuration = environment.loadEnvironment();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const instance = environment.findInstance(configuration, options.application);
  if (instance === undefined) {
    const descriptor = applications.describeApplication(options.application);
    fail(`Set ${descriptor.urlVariable} and ${descriptor.apiKeyVariable} to capture this fixture`);
  }

  // The recorded version is part of a fixture's claim, so the instance has to
  // be the version the inventory approves before anything is read from it.
  const descriptor = applications.describeApplication(options.application);
  const status = await readRoute(
    instance,
    `${descriptor.apiBasePath}/system/status`,
    new URLSearchParams(),
    baseUrl.joinUpstreamUrl,
  );
  const reported = typeof status?.version === "string" ? status.version : "an unreported version";
  if (reported !== approved.version) {
    fail(
      `The configured ${options.application} instance reports ${reported}, and the ` +
        `recorded fixtures name ${approved.version}. Capture from an instance at ` +
        "the recorded version, or raise the recorded version deliberately first.",
    );
  }

  const body = await readRoute(
    instance,
    approved.endpoint,
    parseQuery(options.query),
    baseUrl.joinUpstreamUrl,
  );
  if (typeof body !== "object" || body === null) {
    fail(`${approved.endpoint} answered with a ${typeof body} rather than an object or array`);
  }

  const { sanitize, replacements } = createSanitizer(validateSanitizedValue);
  const fixture = {
    metadata: {
      application: approved.application,
      apiVersion: approved.apiVersion,
      version: approved.version,
      endpoint: approved.endpoint,
    },
    body: sanitize(body),
  };

  const filePath = path.join(fixtureRoot, approved.relativePath);
  try {
    validateFixture(fixture, { filePath, fixtureRoot });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(
      `The captured body does not pass the fixture contract: ${detail}\n` +
        "Nothing was written. Neutralize the value the screen names; never " +
        "weaken a screen to accommodate a captured value.",
    );
  }

  const rows = Array.isArray(fixture.body) ? fixture.body.length : 1;
  const summary =
    `${approved.relativePath}: ${rows} ${rows === 1 ? "record" : "records"}, ` +
    `${replacements.size} sanitized ${replacements.size === 1 ? "value" : "values"}`;
  if (options.dryRun) {
    process.stderr.write(`Would write ${summary}\n`);
    return;
  }

  await writeFile(filePath, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
  process.stderr.write(`Wrote ${summary}\n`);
  process.stderr.write("Run `npx biome check --write` to format, then run the suite.\n");
}

try {
  await main();
} catch (error) {
  if (error instanceof CaptureError) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
  throw error;
}
