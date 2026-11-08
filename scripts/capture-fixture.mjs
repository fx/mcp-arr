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
 * built environment parser and upstream client the server itself uses, and the
 * fixture inventory and sanitizing screens the fixture contract test enforces.
 * A second copy of any of those would drift — a captured body would answer a
 * request no adapter sends, and a screen this side did not know about is
 * exactly how an unsanitized value reaches a committed file.
 *
 * Which recorded version a fixture is written under is the version the instance
 * reports, not a choice made here. An instance at an application's minimum
 * supported version records the minimum's fixtures; an instance at a newer
 * recorded version records only the routes approved at that version, under
 * that version's directory, and leaves the minimum's fixtures as they are. An
 * instance at any other version is refused.
 *
 * Usage:
 *   npm run build
 *   node scripts/capture-fixture.mjs --application sonarr --route manualimport \
 *     --query folder=/downloads/complete/example
 *
 *   --application   sonarr | radarr | prowlarr
 *   --route         an approved route, for example `config/downloadclient`
 *   --query         repeatable `name=value` upstream query parameter
 *   --dry-run       report what would be written without writing it
 *   --fixture-root  where to write, defaulting to this repository's fixtures.
 *                   Only the tests of this procedure pass it, so they can
 *                   observe a real write without overwriting a recorded one.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSanitizer } from "./capture-sanitizer.mjs";
import {
  approvedFixtures,
  capturedBy,
  captureTargetFor,
  validateFixture,
  validateSanitizedValue,
} from "./fixture-contract.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const defaultFixtureRoot = path.join(projectRoot, "test", "fixtures");
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
    const [applications, environment, client] = await Promise.all([
      import("../dist/applications.js"),
      import("../dist/config/environment.js"),
      import("../dist/http/client.js"),
    ]);
    return { applications, environment, client };
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
      case "--fixture-root":
        options.fixtureRoot = value();
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
  const parameters = {};
  for (const pair of pairs) {
    const separator = pair.indexOf("=");
    if (separator <= 0) {
      // The value is deliberately not echoed: a query parameter carries a path.
      fail("Each --query must be name=value");
    }
    parameters[pair.slice(0, separator)] = pair.slice(separator + 1);
  }
  return parameters;
}

/**
 * Reads one upstream route through the server's own client.
 *
 * Going through that client rather than a second request implementation is
 * what makes a captured body the answer to the request the server actually
 * sends: header, timeout and path composition all come from the one place the
 * server composes them, so the fixture cannot record the answer to a request
 * no adapter makes.
 *
 * A capture that cannot prove it read the route it names fails rather than
 * producing a fixture. A recorded body for a route the application answers
 * with 404 is the defect this procedure exists to prevent, and a 200 carrying
 * the web interface — which these applications serve for an unrecognized API
 * path — is the same defect wearing a success code; the client refuses that
 * one too, because the page does not parse as JSON.
 *
 * Which is why the "this route does not exist" reading is taken only from a
 * *successful* status. `unexpected-response` is the client's catch-all: every
 * status it does not name individually arrives under it, a 502 from a reverse
 * proxy included. Telling an operator to correct a perfectly valid approved
 * route because their proxy was restarting would be worse than saying nothing,
 * and failing for the right reason is the whole point of failing here.
 */
async function readRoute(client, route, query = {}) {
  try {
    return await client.get(route, query);
  } catch (error) {
    const kind = error instanceof Error ? Reflect.get(error, "kind") : undefined;
    const status = error instanceof Error ? Reflect.get(error, "status") : undefined;
    if (kind === "not-found") {
      fail(
        `${client.application} answers ${route} with 404. That application does ` +
          "not serve this route, so no body it returns belongs under this name. " +
          "Correct the approved route rather than recording a body for it.",
      );
    }
    if (kind === "unexpected-response" && typeof status === "number" && status >= 500) {
      fail(
        `${client.application} answered ${route} with status ${status}. That is the ` +
          "instance, or something in front of it, reporting its own failure rather " +
          "than an answer about this route. Nothing was read; try again once it is " +
          "healthy, and do not change the approved route on account of it.",
      );
    }
    if (kind === "unexpected-response" && status !== undefined && status >= 200 && status < 300) {
      fail(
        `${client.application} answered ${route} with ${status} and a body that is ` +
          "not JSON. An unrecognized API path is served the web interface, so this " +
          "route does not resolve on this application.",
      );
    }
    fail(error instanceof Error ? error.message : String(error));
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  // Parsed before anything is read, so a malformed argument fails without
  // having contacted the instance.
  const query = parseQuery(options.query);
  const { applications, environment, client: http } = await loadServerModules();

  if (!applications.applicationIds.includes(options.application)) {
    fail(`Unknown application: ${options.application}`);
  }

  // Refused before the instance is contacted when no recorded version approves
  // the route at all; which version's fixture it becomes waits on the status.
  const routeFixtures = approvedFixtures.filter(
    (candidate) =>
      candidate.application === options.application && candidate.route === options.route,
  );
  const [routeFixture] = routeFixtures;
  if (routeFixture === undefined) {
    const routes = new Set(
      approvedFixtures
        .filter((candidate) => candidate.application === options.application)
        .map((candidate) => candidate.route),
    );
    fail(
      `${options.application} records no fixture for route ${options.route}.\n` +
        `Approved routes: ${[...routes].join(", ")}`,
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

  const descriptor = applications.describeApplication(options.application);
  const client = http.createUpstreamClient({
    application: options.application,
    baseUrl: instance.baseUrl,
    // The API base comes from the recorded inventory the fixture will be named
    // by, not from the application descriptor, so the request and the recorded
    // metadata cannot disagree: were the two to drift, a body read from one API
    // version could otherwise be committed as the answer of another. Every
    // recorded version of one application shares its API version, so it is
    // known before the status says which version this instance is.
    apiBasePath: `/api/${routeFixture.apiVersion}`,
    apiKey: instance.apiKey,
    timeoutMs: requestTimeoutMs,
  });

  // A fixture claims an application at a version, so the instance has to be
  // both before anything is read from it. The version alone is not enough: a
  // misconfigured or proxied URL can put another application behind the
  // variables this one names, and its answer would then be written under this
  // application's name — which is the same falsehood as a body recorded for a
  // route its application does not serve.
  const statusRoute = "system/status";
  const status = await readRoute(client, statusRoute);
  const expectedAppName = `${options.application[0].toUpperCase()}${options.application.slice(1)}`;
  if (status?.appName !== expectedAppName) {
    fail(
      `The instance ${descriptor.urlVariable} names calls itself ` +
        `${typeof status?.appName === "string" ? status.appName : "nothing"}, not ` +
        `${expectedAppName}. Point that variable at a ${expectedAppName} instance.`,
    );
  }
  const reportedVersion = typeof status?.version === "string" ? status.version : undefined;
  const reported = reportedVersion ?? "an unreported version";
  const target = captureTargetFor(options.application, options.route, reportedVersion);
  if (target.kind === "unrecorded-version") {
    fail(
      `The configured ${options.application} instance reports ${reported}, and ` +
        `${options.application} fixtures are recorded only at ` +
        `${target.recordedVersions.join(", ")}. Capture from an instance at a ` +
        "recorded version, or record its version deliberately first.",
    );
  }
  if (target.kind === "route-not-recorded-at-version") {
    fail(
      `The configured ${options.application} instance reports ${reported}, a recorded ` +
        `version, but ${options.route} is approved only at ` +
        `${target.routeVersions.join(", ")}. A body from this instance is evidence ` +
        `for ${reported} alone; approve ${options.route} at ${reported} deliberately ` +
        "first rather than writing it under another version.",
    );
  }
  const approved = target.fixture;

  // The status route has already been read, and reading it twice would record
  // the second answer while having checked the first.
  const body =
    approved.route === statusRoute ? status : await readRoute(client, approved.route, query);
  if (typeof body !== "object" || body === null) {
    fail(`${approved.route} answered with a ${typeof body} rather than an object or array`);
  }

  const { sanitize, replacements } = createSanitizer(validateSanitizedValue, fail);
  const fixture = {
    metadata: {
      application: approved.application,
      apiVersion: approved.apiVersion,
      version: approved.version,
      endpoint: approved.endpoint,
      capturedBy,
    },
    body: sanitize(body),
  };

  const fixtureRoot = path.resolve(options.fixtureRoot ?? defaultFixtureRoot);
  const filePath = path.join(fixtureRoot, approved.relativePath);
  try {
    validateFixture(fixture, { filePath, fixtureRoot, legacy: false });
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

  await mkdir(path.dirname(filePath), { recursive: true });
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
