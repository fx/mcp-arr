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
import { approvedFixtures, validateFixture, validateSanitizedValue } from "./fixture-contract.mjs";

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

/**
 * Replaces what the fixture screens refuse, keeping the shape intact.
 *
 * The screens decide; this only supplies the replacement, and it takes the
 * decision from the refusal they raise rather than from a second copy of their
 * rules. A key the screens name as secret-bearing or identifying is dropped
 * outright: a credential's field name is what makes it findable, and no fixture
 * needs it. Anything else refused — a value, or a key whose own text is a path
 * or a URL — becomes a neutral stand-in, distinct per original text so that two
 * fields which carried the same text still carry the same text afterwards. What
 * a fixture owes is its field shapes, not its text.
 */
function createSanitizer(screen) {
  const replacements = new Map();

  /** `keep`, `drop` — the name itself is the disclosure — or `rename`. */
  const keyDisposition = (key) => {
    try {
      screen({ [key]: 1 }, "value");
      return "keep";
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      return /^(?:Secret-bearing|Identifying) key/u.test(message) ? "drop" : "rename";
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

  /** Replaces every string inside a value, however it is nested. */
  const redact = (value) => {
    if (Array.isArray(value)) {
      return value.map(redact);
    }
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redact(child)]));
    }
    return typeof value === "string" ? replace(value) : value;
  };

  /**
   * Whether this object is a dynamically described provider field.
   *
   * These applications describe a provider's settings as a list of
   * `{ name, value }` pairs, so a credential arrives under the property name
   * `value` with its real name as a sibling. Screening the property name alone
   * sees `value`, finds nothing to object to, and writes the credential — the
   * one shape where what a field holds is stated beside it rather than by the
   * key it is under.
   *
   * Every such value is replaced, not only those whose sibling name the secret
   * list happens to spell. That list cannot be the test here: a private tracker
   * calls its credential `passkey`, `authkey`, `rssKey` or `torrent_pass`, a
   * Cardigann definition may call it anything at all, and adding `key` or
   * `pass` to the list instead would refuse `sortKey` in every paged fixture.
   * A provider field's value is instance configuration that no fixture's shape
   * depends on — the shape is the field's presence, its name and its type, and
   * all three survive — so the safe rule is the one that does not need to
   * recognize the credential to protect it.
   */
  const isProviderField = (value) =>
    typeof value.name === "string" && Object.hasOwn(value, "value");

  const sanitize = (value) => {
    if (Array.isArray(value)) {
      return value.map(sanitize);
    }
    if (typeof value === "object" && value !== null) {
      const redactSiblingValue = isProviderField(value);
      const entries = [];
      for (const [key, child] of Object.entries(value)) {
        const disposition = keyDisposition(key);
        if (disposition === "drop") {
          continue;
        }
        // A key is text the instance chose too. Where a payload is a dictionary
        // its keys carry paths and URLs, and one held only to the name lists
        // would be written verbatim — so such a key is replaced exactly as a
        // value is rather than dropped, which would take its value with it and
        // lose a field the shape has.
        const sanitizedKey = disposition === "rename" ? replace(key) : key;
        entries.push([
          sanitizedKey,
          redactSiblingValue && key === "value" ? redact(child) : sanitize(child),
        ]);
      }
      // A replaced key could land on one the object already has, and building
      // the object would then drop a field rather than record it. This tool
      // refuses rather than writing something the instance did not answer.
      const keys = entries.map(([key]) => key);
      if (new Set(keys).size !== keys.length) {
        fail("A sanitized key collided with another. Nothing was written.");
      }
      // Built as entries rather than assigned: `result.__proto__ = …` invokes
      // the prototype setter, so an upstream key of that name would silently
      // take its whole subtree out of the fixture.
      return Object.fromEntries(entries);
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
  // Parsed before anything is read, so a malformed argument fails without
  // having contacted the instance.
  const query = parseQuery(options.query);
  const { applications, environment, client: http } = await loadServerModules();

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

  const descriptor = applications.describeApplication(options.application);
  const client = http.createUpstreamClient({
    application: options.application,
    baseUrl: instance.baseUrl,
    // The API base comes from the tuple the fixture will name, not from the
    // application descriptor, so the request and the recorded metadata cannot
    // disagree: were the two to drift, a body read from one API version could
    // otherwise be committed as the answer of another.
    apiBasePath: `/api/${approved.apiVersion}`,
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
  const expectedAppName = `${approved.application[0].toUpperCase()}${approved.application.slice(1)}`;
  if (status?.appName !== expectedAppName) {
    fail(
      `The instance ${descriptor.urlVariable} names calls itself ` +
        `${typeof status?.appName === "string" ? status.appName : "nothing"}, not ` +
        `${expectedAppName}. Point that variable at a ${expectedAppName} instance.`,
    );
  }
  const reported = typeof status?.version === "string" ? status.version : "an unreported version";
  if (reported !== approved.version) {
    fail(
      `The configured ${options.application} instance reports ${reported}, and the ` +
        `recorded fixtures name ${approved.version}. Capture from an instance at ` +
        "the recorded version, or raise the recorded version deliberately first.",
    );
  }

  // The status route has already been read, and reading it twice would record
  // the second answer while having checked the first.
  const body =
    approved.route === statusRoute ? status : await readRoute(client, approved.route, query);
  if (typeof body !== "object" || body === null) {
    fail(`${approved.route} answered with a ${typeof body} rather than an object or array`);
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

  const fixtureRoot = path.resolve(options.fixtureRoot ?? defaultFixtureRoot);
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
