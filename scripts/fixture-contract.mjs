import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";

/**
 * The recorded fixture contract: which fixtures exist, what each one must
 * declare, and the screens every recorded body is held to.
 *
 * It is plain JavaScript with a declaration file beside it, the same shape as
 * `platform-command.mjs` and `child-process.mjs`, because two callers need it
 * and they cannot share a TypeScript module: `test/support/fixtures.ts`
 * re-exports it for the suite, and `capture-fixture.mjs` runs it under plain
 * `node` on the version this project supports. A second copy would drift, and a
 * screen the capture side did not know about is how an unsanitized value
 * reaches a committed file.
 */

/**
 * The versions this project records fixtures at, and the upstream routes it
 * records at each, per application.
 *
 * An application's `minimum` is the version the Architecture spec records as
 * its minimum supported version, and the fixtures recorded there are the
 * evidence for that minimum. Every other version listed is a newer one a
 * fixture was captured from, and a fixture recorded there is evidence only for
 * the version it names: it never stands in for the minimum, and it never
 * replaces one recorded there. Recording at a newer version does not raise the
 * minimum either; that is a decision about the implementation, not about which
 * instance happened to answer.
 *
 * Adding a route under a version is what authorizes a new fixture file: the
 * file name, the approved inventory, and the endpoint each fixture must declare
 * are all derived from this record, so a fixture cannot claim to be the
 * response of one route or one version while living under the name of another.
 * A newer version starts with no routes, and each change that needs a body only
 * a newer instance can give adds its route there.
 *
 * One API version per application, because the route list is stated against
 * it: an instance that served the same routes under another API version would
 * be a different contract, not a newer recording of this one.
 */
const recordedVersions = {
  sonarr: {
    apiVersion: "v3",
    minimum: "4.0.19.2979",
    routes: {
      "4.0.19.2979": [
        "system/status",
        "series",
        "series/lookup",
        "episode",
        "episodefile",
        "rename",
        "wanted/missing",
        "wanted/cutoff",
        "calendar",
        "release",
        "queue/status",
        "queue",
        "queue/details",
        "manualimport",
        "history",
        "history/series",
        "blocklist",
        "health",
        "command",
        "diskspace",
        "rootfolder",
        "qualityprofile",
        "qualitydefinition",
        "language",
        "tag",
        "indexer",
        "importlist",
        "config/downloadclient",
        "importlistexclusion/paged",
      ],
      "4.0.20.3014": ["qualityprofile"],
    },
  },
  radarr: {
    apiVersion: "v3",
    minimum: "6.3.0.10514",
    routes: {
      "6.3.0.10514": [
        "system/status",
        "movie",
        "movie/lookup",
        "collection",
        "moviefile",
        "rename",
        "wanted/missing",
        "wanted/cutoff",
        "calendar",
        "release",
        "queue/status",
        "queue",
        "queue/details",
        "manualimport",
        "history",
        "history/movie",
        "blocklist",
        "health",
        "command",
        "diskspace",
        "rootfolder",
        "qualityprofile",
        "qualitydefinition",
        "language",
        "tag",
        "downloadclient",
        "config/downloadclient",
        "customformat",
        "exclusions/paged",
      ],
      "6.4.4.10685": ["qualityprofile"],
    },
  },
  prowlarr: {
    apiVersion: "v1",
    minimum: "2.5.2.5491",
    routes: {
      "2.5.2.5491": [
        "system/status",
        "indexer",
        "indexerstatus",
        "search",
        "history",
        "health",
        "command",
        "indexerstats",
        "applications",
        "notification",
        "appprofile",
        "tag",
      ],
      "2.7.0.5723": [],
    },
  },
};

/** The file that records one route's response. */
export function fixtureFileForRoute(route) {
  return `${route.replaceAll("/", "-")}.json`;
}

/**
 * Orders two dotted numeric version labels, as these applications report them.
 *
 * A label that is not dotted digits is refused rather than ordered, since a
 * recorded version is an exact build an instance reported and anything else is
 * a typing error in the record above.
 */
function requireVersionLabel(label) {
  if (!/^\d+(?:\.\d+)*$/u.test(label)) {
    throw new Error(`Recorded fixture version is not a dotted numeric version: ${label}`);
  }
  return label.split(".").map(Number);
}

function compareVersions(left, right) {
  const [a, b] = [requireVersionLabel(left), requireVersionLabel(right)];
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) {
      return Math.sign(difference);
    }
  }
  return 0;
}

/**
 * Derives the approved inventory, and the lookups over it, from a record shaped
 * like {@link recordedVersions}.
 *
 * Exported so the derivation can be exercised against a record holding a newer
 * version with routes in it before the real one does; the module's own exports
 * are this function applied to the real record, so there is one derivation and
 * not a second copy for tests.
 */
export function createFixtureInventory(recorded) {
  const tuples = [];
  const minimumTuples = [];
  const fixtures = [];

  for (const [application, { apiVersion, minimum, routes }] of Object.entries(recorded)) {
    // The minimum is the evidence every test that names no version reads, so
    // it has to hold fixtures; a newer version may start empty.
    if (!Object.hasOwn(routes, minimum) || routes[minimum].length === 0) {
      throw new Error(`${application} records no routes at its minimum version ${minimum}`);
    }
    for (const [version, versionRoutes] of Object.entries(routes)) {
      // Every label is held to the format on its own, not only when there is
      // a second version to order it against.
      requireVersionLabel(version);
      if (version !== minimum && compareVersions(version, minimum) <= 0) {
        throw new Error(
          `${application} ${version} is recorded beside its minimum ${minimum} but is not newer`,
        );
      }
      const tuple = { application, apiVersion, version };
      tuples.push(tuple);
      if (version === minimum) {
        minimumTuples.push(tuple);
      }
      for (const route of versionRoutes) {
        const relativePath = `${application}/${apiVersion}/${version}/${fixtureFileForRoute(route)}`;
        // One fixture per application, version and route: a second entry would
        // name the same file, and only one body can live there.
        if (fixtures.some((fixture) => fixture.relativePath === relativePath)) {
          throw new Error(`Fixture is approved twice: ${relativePath}`);
        }
        fixtures.push({
          application,
          apiVersion,
          version,
          route,
          endpoint: `/api/${apiVersion}/${route}`,
          relativePath,
        });
      }
    }
  }

  const find = (application, route, version) =>
    fixtures.find(
      (candidate) =>
        candidate.application === application &&
        candidate.route === route &&
        candidate.version === version,
    );

  const recordedVersionsOf = (application) =>
    tuples.filter((tuple) => tuple.application === application).map(({ version }) => version);

  return {
    tuples,
    minimumTuples,
    fixtures,
    inventory: fixtures.map(({ relativePath }) => relativePath),

    /**
     * The recorded fixture for one application's route. Without a version it
     * is the one recorded at the application's minimum, which is what every
     * test that does not name a version is evidence about.
     */
    pathFor(application, route, options = {}) {
      const version =
        options.version ??
        minimumTuples.find((tuple) => tuple.application === application)?.version;
      const approved = find(application, route, version);
      if (approved === undefined) {
        throw new Error(
          options.version === undefined
            ? `No approved fixture for ${application} ${route}`
            : `No approved fixture for ${application} ${route} at ${options.version}`,
        );
      }
      return approved.relativePath;
    },

    /**
     * Which fixture an instance reporting `reportedVersion` may be captured
     * into for one route, or why none may.
     *
     * The reported version selects the fixture rather than being checked
     * against one already chosen, so an instance at any recorded version can
     * record the routes approved there and nothing else.
     */
    forReportedVersion(application, route, reportedVersion) {
      const approved =
        reportedVersion === undefined ? undefined : find(application, route, reportedVersion);
      if (approved !== undefined) {
        return { kind: "approved", fixture: approved };
      }
      const versions = recordedVersionsOf(application);
      if (reportedVersion === undefined || !versions.includes(reportedVersion)) {
        return { kind: "unrecorded-version", recordedVersions: versions };
      }
      return {
        kind: "route-not-recorded-at-version",
        routeVersions: fixtures
          .filter((candidate) => candidate.application === application && candidate.route === route)
          .map(({ version }) => version),
      };
    },
  };
}

const fixtureInventory = createFixtureInventory(recordedVersions);

/** Every version a fixture is recorded at, minimum and newer alike. */
export const approvedFixtureTuples = fixtureInventory.tuples;

/** Each application's minimum supported version, the one its fixtures are evidence for. */
export const minimumFixtureTuples = fixtureInventory.minimumTuples;

export const approvedFixtures = fixtureInventory.fixtures;

export const approvedFixtureInventory = fixtureInventory.inventory;

/**
 * The recorded fixture for one application's route, for a test to load.
 *
 * Without `options.version` this is the fixture recorded at the application's
 * minimum supported version. A test that reads a body only a newer instance
 * returns names that version, so what it is evidence for is stated where it is
 * asserted.
 */
export const fixturePathFor = fixtureInventory.pathFor;

/** Which fixture a capture from an instance at `reportedVersion` may write, or why none. */
export const captureTargetFor = fixtureInventory.forReportedVersion;

const secretKeyParts = [
  "apikey",
  "authorization",
  "cookie",
  "credential",
  "passwd",
  "password",
  "secret",
  "session",
  "token",
];

const identifyingKeyParts = ["host", "instance", "ipaddress", "localaddress", "user"];

const identifyingKeys = new Set(["ip"]);

/**
 * What may precede an absolute path for it to read as one.
 *
 * A leading slash is what distinguishes an absolute path from the separator in
 * a relative one — `Season 01/Example.mkv` is a file name, not a path to
 * refuse — so the patterns below anchor on a boundary rather than on the slash
 * alone. The boundary is stated as everything a path segment cannot end in,
 * rather than as a list of the delimiters seen so far: a path arrives embedded
 * in upstream free text as `detail=/srv/private/data`, `detail:/srv/…` or
 * `detail(/srv/…` just as readily, and a list has to be extended once per
 * punctuation mark somebody thinks of. Inverting it closes them all at once
 * while leaving a relative name a name.
 */
const pathSegmentEnd = "A-Za-z0-9._~)\\]}%+&$#@!'-";

const pathBoundary = `(?:^|[^${pathSegmentEnd}])`;

const sensitiveValuePatterns = [
  ["email address", /\b[^\s@]+@[^\s@]+\.[^\s@]+\b/u],
  ["URL", /\b[a-z][a-z0-9+.-]*:\/\/[^\s]+/iu],
  ["home path", /(?:~\/|\/(?:home|users)\/[^/\s]+(?:\/|\b)|\/root(?:\/|\b))/iu],
  ["workspace path", new RegExp(`${pathBoundary}\\/workspace(?:\\/|\\b)[^\\s]*`, "iu")],
  ["sensitive path", new RegExp(`${pathBoundary}\\/(?!media\\/example(?:\\/|$))[^\\s]+`, "iu")],
  ["Windows path", /\b[a-z]:[\\/][^\s]*/iu],
  ["UNC path", /\\\\[^\\\s]+\\[^\\\s]+/u],
  [
    "hostname",
    /(?:^|[^a-z0-9-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?:$|[^a-z0-9-])/iu,
  ],
  [
    "internal hostname",
    /(?:^|[^a-z0-9-])(?:localhost|[^\s.]+\.(?:internal|lan|local))(?:$|[^a-z0-9-])/iu,
  ],
];

/**
 * Extensions that a sanitized media file name may end in.
 *
 * A file name such as `Example Movie Bluray-1080p.mkv` is structurally
 * indistinguishable from a hostname: a dotted label followed by two or more
 * letters. Media-file fixtures cannot be recorded without one, so a trailing
 * known media extension is removed before the hostname patterns run — and only
 * the extension is, so `evil.example.mkv` still trips the hostname check.
 */
const mediaFileExtensions = ["mkv", "mp4", "m4v", "avi", "srt", "ass", "nfo"];

const mediaFileExtensionPattern = new RegExp(
  `\\.(?:${mediaFileExtensions.join("|")})(?![a-z0-9-])`,
  "giu",
);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectDuplicateObjectKeys(source, relativePath) {
  const objectKeys = [];

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "{") {
      objectKeys.push(new Set());
      continue;
    }
    if (character === "[") {
      objectKeys.push(undefined);
      continue;
    }
    if (character === "}" || character === "]") {
      objectKeys.pop();
      continue;
    }
    if (character !== '"') {
      continue;
    }

    let end = index + 1;
    while (end < source.length) {
      if (source[end] === "\\") {
        end += 2;
        continue;
      }
      if (source[end] === '"') {
        break;
      }
      end += 1;
    }
    if (end >= source.length) {
      return;
    }

    const rawString = source.slice(index, end + 1);
    index = end;
    let next = end + 1;
    while (/\s/u.test(source[next] ?? "")) {
      next += 1;
    }
    const keys = objectKeys.at(-1);
    if (source[next] !== ":" || keys === undefined) {
      continue;
    }

    let key;
    try {
      key = JSON.parse(rawString);
    } catch {
      return;
    }
    if (keys.has(key)) {
      throw new Error(
        `Fixture contains duplicate JSON object key ${JSON.stringify(key)}: ${relativePath}`,
      );
    }
    keys.add(key);
  }
}

function containsIpAddress(value) {
  return value.split(/[^0-9a-f:.]+/iu).some((candidate) => isIP(candidate) !== 0);
}

function requireString(record, key, location) {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${location}.${key} must be a non-empty string`);
  }
  return value;
}

function findApprovedTuple(application, apiVersion, version) {
  const tuple = approvedFixtureTuples.find(
    (candidate) =>
      candidate.application === application &&
      candidate.apiVersion === apiVersion &&
      candidate.version === version,
  );
  if (tuple === undefined) {
    throw new Error(`Unapproved fixture tuple: ${application}/${apiVersion}/${version}`);
  }
  return tuple;
}

function validateEndpoint(endpoint, apiVersion) {
  const expectedPrefix = `/api/${apiVersion}/`;
  if (!endpoint.startsWith(expectedPrefix)) {
    throw new Error(`Fixture endpoint must use the ${expectedPrefix} prefix`);
  }
  const route = endpoint.slice(expectedPrefix.length);
  if (!/^[a-z0-9]+(?:[/-][a-z0-9]+)*$/u.test(route)) {
    throw new Error(`Fixture endpoint must contain a normalized relative route: ${endpoint}`);
  }
}

function validateFixturePath(filePath, fixtureRoot, metadata) {
  const relativePath = path.relative(path.resolve(fixtureRoot), path.resolve(filePath));
  const labels = relativePath.split(path.sep);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath) || labels.length !== 4) {
    throw new Error(`Fixture path must match application/api/version/file: ${relativePath}`);
  }

  const [application, apiVersion, version, fileName] = labels;
  if (fileName === undefined || !fileName.endsWith(".json")) {
    throw new Error(`Fixture filename must end in .json: ${fileName ?? "missing"}`);
  }
  if (application !== metadata.application) {
    throw new Error(`Fixture application label does not match metadata: ${application}`);
  }
  if (apiVersion !== metadata.apiVersion) {
    throw new Error(`Fixture API label does not match metadata: ${apiVersion}`);
  }
  if (version !== metadata.version) {
    throw new Error(`Fixture version label does not match metadata: ${version}`);
  }
  return labels.join("/");
}

/**
 * Holds a fixture to the one route its file name stands for, so a recorded
 * response cannot drift onto a route it was never captured from.
 */
function validateApprovedRoute(relativePath, endpoint) {
  const approved = approvedFixtures.find((candidate) => candidate.relativePath === relativePath);
  if (approved === undefined) {
    throw new Error(`Fixture is not in the approved inventory: ${relativePath}`);
  }
  if (approved.endpoint !== endpoint) {
    throw new Error(
      `Fixture endpoint does not match its file: expected ${approved.endpoint}, got ${endpoint}`,
    );
  }
}

/**
 * The sanitizing screens every recorded fixture is held to.
 *
 * Exported so the capture procedure can run the same screens over a captured
 * value and replace what they refuse, rather than carrying its own copy of the
 * rules.
 */
export function validateSanitizedValue(value, location) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      validateSanitizedValue(item, `${location}[${index}]`);
    });
    return;
  }
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      const normalizedKey = key.toLowerCase().replaceAll(/[^a-z0-9]/gu, "");
      if (secretKeyParts.some((part) => normalizedKey.includes(part))) {
        throw new Error(`Secret-bearing key is not allowed at ${location}.${key}`);
      }
      if (
        identifyingKeys.has(normalizedKey) ||
        identifyingKeyParts.some((part) => normalizedKey.includes(part))
      ) {
        throw new Error(`Identifying key is not allowed at ${location}.${key}`);
      }
      // A key is text an instance chose as readily as a value is. Upstream
      // keys a path or a URL where a payload is a dictionary of them, and a key
      // held only to the name lists above would carry one through untouched.
      screenText(key, `${location}.${key}`);
      validateSanitizedValue(child, `${location}.${key}`);
    }
    return;
  }
  if (typeof value !== "string") {
    return;
  }

  screenText(value, location);
}

/** Refuses one piece of text, whether it arrived as a value or as a key. */
function screenText(text, location) {
  if (containsIpAddress(text)) {
    throw new Error(`Sensitive IP address is not allowed at ${location}`);
  }
  const scanned = text.replaceAll(mediaFileExtensionPattern, "");
  for (const [description, pattern] of sensitiveValuePatterns) {
    if (pattern.test(scanned)) {
      throw new Error(`Sensitive ${description} is not allowed at ${location}`);
    }
  }
}

export function validateFixture(value, options) {
  if (!isRecord(value)) {
    throw new Error("Fixture must be a JSON object");
  }
  if (!isRecord(value.metadata)) {
    throw new Error("Fixture metadata must be an object");
  }
  if (!("body" in value) || (!isRecord(value.body) && !Array.isArray(value.body))) {
    throw new Error("Fixture body must be an object or array");
  }

  const body = value.body;
  const metadataRecord = value.metadata;
  const application = requireString(metadataRecord, "application", "metadata");
  const apiVersion = requireString(metadataRecord, "apiVersion", "metadata");
  const version = requireString(metadataRecord, "version", "metadata");
  const endpoint = requireString(metadataRecord, "endpoint", "metadata");
  const tuple = findApprovedTuple(application, apiVersion, version);
  validateEndpoint(endpoint, tuple.apiVersion);

  const metadata = { ...tuple, endpoint };
  validateApprovedRoute(
    validateFixturePath(options.filePath, options.fixtureRoot, metadata),
    endpoint,
  );

  const isSystemStatus = endpoint === `/api/${metadata.apiVersion}/system/status`;
  if (isSystemStatus && !isRecord(body)) {
    throw new Error("Fixture system-status body must be an object");
  }
  if (isRecord(body) && (isSystemStatus || "version" in body)) {
    const bodyVersion = requireString(body, "version", "body");
    if (bodyVersion !== metadata.version) {
      throw new Error(`Fixture body version does not match metadata: ${bodyVersion}`);
    }
  }

  if (isSystemStatus && isRecord(body)) {
    const expectedAppName = `${metadata.application[0]?.toUpperCase()}${metadata.application.slice(1)}`;
    if (body.appName !== expectedAppName) {
      throw new Error(`Fixture body appName does not match metadata: ${String(body.appName)}`);
    }
  }

  const sanitizedMetadata = Object.fromEntries(
    Object.entries(metadataRecord).filter(([key]) => key !== "endpoint"),
  );
  validateSanitizedValue({ metadata: sanitizedMetadata, body }, "fixture");

  return { metadata, body };
}

export async function loadFixture(fixtureRoot, relativePath) {
  if (!approvedFixtureInventory.includes(relativePath)) {
    throw new Error(`Fixture is not in the approved inventory: ${relativePath}`);
  }
  const filePath = path.join(fixtureRoot, relativePath);
  const source = await readFile(filePath, "utf8");
  rejectDuplicateObjectKeys(source, relativePath);
  let value;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(`Fixture is not valid JSON: ${relativePath}`, { cause: error });
  }
  return validateFixture(value, { filePath, fixtureRoot });
}
