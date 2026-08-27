import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";

export const approvedFixtureTuples = [
  { application: "sonarr", apiVersion: "v3", version: "4.0.19.2979" },
  { application: "radarr", apiVersion: "v3", version: "6.3.0.10514" },
  { application: "prowlarr", apiVersion: "v1", version: "2.5.2.5491" },
] as const;

export type FixtureApplication = (typeof approvedFixtureTuples)[number]["application"];
export type FixtureApiVersion = (typeof approvedFixtureTuples)[number]["apiVersion"];
export type FixtureVersion = (typeof approvedFixtureTuples)[number]["version"];

export interface FixtureMetadata {
  application: FixtureApplication;
  apiVersion: FixtureApiVersion;
  version: FixtureVersion;
  endpoint: string;
}

export interface VersionedFixture<TBody = unknown> {
  metadata: FixtureMetadata;
  body: TBody;
}

/**
 * The upstream routes this project records a fixture for, per application.
 *
 * Adding a route here is what authorizes a new fixture file: the file name, the
 * approved inventory, and the endpoint each fixture must declare are all
 * derived from this list, so a fixture cannot claim to be the response of one
 * route while living under the name of another.
 */
const approvedRoutes: Readonly<Record<FixtureApplication, readonly string[]>> = {
  sonarr: [
    "system/status",
    "series",
    "series/lookup",
    "episode",
    "episodefile",
    "wanted/missing",
    "wanted/cutoff",
    "calendar",
    "release",
    "queue/status",
    "queue",
    "queue/details",
    "history",
    "blocklist",
    "health",
    "command",
    "diskspace",
    "rootfolder",
    "qualityprofile",
    "tag",
  ],
  radarr: [
    "system/status",
    "movie",
    "movie/lookup",
    "collection",
    "moviefile",
    "wanted/missing",
    "wanted/cutoff",
    "calendar",
    "release",
    "queue/status",
    "queue",
    "queue/details",
    "history",
    "blocklist",
    "health",
    "command",
    "diskspace",
    "rootfolder",
    "qualityprofile",
    "tag",
  ],
  prowlarr: [
    "system/status",
    "indexer",
    "indexerstatus",
    "search",
    "history",
    "health",
    "command",
    "indexerstats",
  ],
};

/** The file that records one route's response. */
export function fixtureFileForRoute(route: string): string {
  return `${route.replaceAll("/", "-")}.json`;
}

export interface ApprovedFixture {
  readonly application: FixtureApplication;
  readonly apiVersion: FixtureApiVersion;
  readonly version: FixtureVersion;
  readonly route: string;
  readonly endpoint: string;
  readonly relativePath: string;
}

export const approvedFixtures: readonly ApprovedFixture[] = approvedFixtureTuples.flatMap(
  ({ application, apiVersion, version }) =>
    approvedRoutes[application].map((route) => ({
      application,
      apiVersion,
      version,
      route,
      endpoint: `/api/${apiVersion}/${route}`,
      relativePath: `${application}/${apiVersion}/${version}/${fixtureFileForRoute(route)}`,
    })),
);

export const approvedFixtureInventory = approvedFixtures.map(({ relativePath }) => relativePath);

/** The recorded fixture for one application's route, for a test to load. */
export function fixturePathFor(application: FixtureApplication, route: string): string {
  const approved = approvedFixtures.find(
    (candidate) => candidate.application === application && candidate.route === route,
  );
  if (approved === undefined) {
    throw new Error(`No approved fixture for ${application} ${route}`);
  }
  return approved.relativePath;
}

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

const sensitiveValuePatterns: ReadonlyArray<readonly [string, RegExp]> = [
  ["email address", /\b[^\s@]+@[^\s@]+\.[^\s@]+\b/u],
  ["URL", /\b[a-z][a-z0-9+.-]*:\/\/[^\s]+/iu],
  ["home path", /(?:~\/|\/(?:home|users)\/[^/\s]+(?:\/|\b)|\/root(?:\/|\b))/iu],
  ["workspace path", /(?:^|\s)\/workspace(?:\/|\b)[^\s]*/iu],
  ["sensitive path", /(?:^|\s)\/(?!media\/example(?:\/|$))[^\s]+/iu],
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectDuplicateObjectKeys(source: string, relativePath: string): void {
  const objectKeys: Array<Set<string> | undefined> = [];

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

    let key: string;
    try {
      key = JSON.parse(rawString) as string;
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

function containsIpAddress(value: string): boolean {
  return value.split(/[^0-9a-f:.]+/iu).some((candidate) => isIP(candidate) !== 0);
}

function requireString(record: Record<string, unknown>, key: string, location: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${location}.${key} must be a non-empty string`);
  }
  return value;
}

function findApprovedTuple(
  application: string,
  apiVersion: string,
  version: string,
): (typeof approvedFixtureTuples)[number] {
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

function validateEndpoint(endpoint: string, apiVersion: FixtureApiVersion): void {
  const expectedPrefix = `/api/${apiVersion}/`;
  if (!endpoint.startsWith(expectedPrefix)) {
    throw new Error(`Fixture endpoint must use the ${expectedPrefix} prefix`);
  }
  const route = endpoint.slice(expectedPrefix.length);
  if (!/^[a-z0-9]+(?:[/-][a-z0-9]+)*$/u.test(route)) {
    throw new Error(`Fixture endpoint must contain a normalized relative route: ${endpoint}`);
  }
}

function validateFixturePath(
  filePath: string,
  fixtureRoot: string,
  metadata: FixtureMetadata,
): string {
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
function validateApprovedRoute(relativePath: string, endpoint: string): void {
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

function validateSanitizedValue(value: unknown, location: string): void {
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
      validateSanitizedValue(child, `${location}.${key}`);
    }
    return;
  }
  if (typeof value !== "string") {
    return;
  }

  if (containsIpAddress(value)) {
    throw new Error(`Sensitive IP address is not allowed at ${location}`);
  }
  const scanned = value.replaceAll(mediaFileExtensionPattern, "");
  for (const [description, pattern] of sensitiveValuePatterns) {
    if (pattern.test(scanned)) {
      throw new Error(`Sensitive ${description} is not allowed at ${location}`);
    }
  }
}

export function validateFixture<TBody = unknown>(
  value: unknown,
  options: { filePath: string; fixtureRoot: string },
): VersionedFixture<TBody> {
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

  const metadata: FixtureMetadata = { ...tuple, endpoint };
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

  return { metadata, body: body as TBody };
}

export async function loadFixture<TBody = unknown>(
  fixtureRoot: string,
  relativePath: string,
): Promise<VersionedFixture<TBody>> {
  if (!approvedFixtureInventory.includes(relativePath)) {
    throw new Error(`Fixture is not in the approved inventory: ${relativePath}`);
  }
  const filePath = path.join(fixtureRoot, relativePath);
  const source = await readFile(filePath, "utf8");
  rejectDuplicateObjectKeys(source, relativePath);
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(`Fixture is not valid JSON: ${relativePath}`, { cause: error });
  }
  return validateFixture<TBody>(value, { filePath, fixtureRoot });
}
