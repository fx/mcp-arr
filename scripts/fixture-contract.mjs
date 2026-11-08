import { randomInt } from "node:crypto";
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
      "4.0.20.3014": ["qualityprofile", "queue", "queue/details"],
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
      "6.4.4.10685": ["qualityprofile", "queue"],
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
 * The fields that identify a library, or the services behind it, by what they
 * hold rather than by what they are called.
 *
 * The screens above refuse a credential, a host, a path, or an address
 * wherever it appears, but a recorded body says more than that: the titles,
 * overviews, artwork, and metadata ids of the series and movies in someone's
 * library, and the names they gave their indexers and download clients. None
 * of it is a secret, and all of it is personal, so no fixture may carry it.
 * A fixture owes these fields their presence and their type, never their
 * text: each one is held to a stand-in the capture writes — text naming an
 * example, an id from a reserved block — and a value that is not one is
 * refused.
 *
 * Three kinds of value are held to a shared vocabulary instead, because the
 * minimum's fixtures were recorded with them and they name no one: the
 * genres and content ratings the metadata sources define, and a quality
 * definition's own title where it is the quality's name. A rating's numbers
 * cannot be told apart from a stand-in, so they are replaced at capture and
 * not screened.
 *
 * `downloadId` is replaced by an ordinal rather than by a digest of the real
 * value: a digest anyone can compute lets anyone confirm a guessed download,
 * and an ordinal keeps what the code needs, which is that the rows of one
 * download still share one value.
 *
 * A title is identified by its facts as well as by its text: the year it
 * started, when it airs, how long it runs, its language, and how large its
 * files are. Those are replaced too — a year moved with the dates, a fixed
 * runtime and air time, an example language, and every byte count scaled by
 * one factor so a download's progress still reads the same — and every date
 * in a captured body is moved by one offset of whole days, chosen at random
 * for each capture and recorded nowhere, so their order and spacing survive
 * and their calendar does not. A fact is a number or a date anyone could hold,
 * so only a fixture recorded at a newer version, which a capture with these
 * rules wrote, is screened for them; the minimum's were recorded before it.
 */
const identifyingTextFields = {
  title: "title",
  originalTitle: "title",
  seriesTitle: "title",
  movieTitle: "title",
  sortTitle: "sortTitle",
  cleanTitle: "cleanTitle",
  titleSlug: "titleSlug",
  overview: "overview",
  network: "network",
  studio: "studio",
  certification: "certification",
  indexer: "indexer",
  indexerName: "indexer",
  // The name an operator gave a client, which defaults to the product's but
  // need not be one. The product itself is the provider's `implementation`.
  downloadClient: "downloadClient",
  downloadClientName: "downloadClient",
  downloadId: "downloadId",
};

/** The facts about a title that are replaced rather than screened. */
const identifyingFactFields = {
  year: "year",
  movieYear: "year",
  runtime: "runtime",
  airTime: "airTime",
  size: "byteCount",
  sizeleft: "byteCount",
  sizeOnDisk: "byteCount",
  originalLanguage: "language",
  languages: "languages",
};

/**
 * How far a capture moves its dates: about two centuries and up to ten years
 * more, so a shifted date reads as synthetic at a glance and any date a
 * library holds lands after {@link earliestShiftedYear}.
 */
const minimumDayOffset = 80_000;
const dayOffsetSpread = 3_653;

/** No shifted date falls before this year, and no unshifted one a library holds after it. */
const earliestShiftedYear = 2100;

/** A date, or a date and time, that a capture moves; the time and zone are kept as written. */
const datePrefixPattern = /^(\d{4})-(\d{2})-(\d{2})(?=$|T\d{2}:\d{2})/u;

/** The runtime and air time every captured title is given. */
const standInRuntimeMinutes = 30;
const standInAirTime = "20:00";

/** Where each metadata source's stand-in ids start; an id is the base plus an ordinal. */
const externalIdBases = { tvdbId: 100_000, tmdbId: 200_000, tvMazeId: 400_000, tvRageId: 500_000 };

const maxStandInOrdinal = 9_999;

/** The genres the metadata sources define, which name a kind of story and no one's library. */
const genreVocabulary = new Set([
  "Action",
  "Adventure",
  "Animation",
  "Anime",
  "Biography",
  "Children",
  "Comedy",
  "Crime",
  "Documentary",
  "Drama",
  "Family",
  "Fantasy",
  "History",
  "Horror",
  "Music",
  "Musical",
  "Mystery",
  "Reality",
  "Romance",
  "Science Fiction",
  "Sport",
  "Thriller",
  "War",
  "Western",
]);

/** The content ratings the rating boards define. */
const certificationVocabulary = /^(?:G|PG|PG-13|R|NC-17|NR|TV-(?:Y|Y7|G|PG|14|MA))$/u;

/** A stand-in the minimum's fixtures record as a download: a window of one repeating hex run. */
function isHexRunStandIn(value) {
  if (!/^[a-f0-9]{40}$/u.test(value)) {
    return false;
  }
  const letters = "abcdef";
  const digits = "1234567890";
  for (let index = 2; index < value.length; index += 1) {
    const alphabet = index % 2 === 0 ? letters : digits;
    const previous = alphabet.indexOf(value[index - 2]);
    if (previous < 0 || value[index] !== alphabet[(previous + 1) % alphabet.length]) {
      return false;
    }
  }
  return true;
}

/**
 * Which identifying field a key holds within its object, if it holds one.
 *
 * Exported so the capture replaces exactly what the screen refuses.
 */
export function identifyingFieldOf(key, parent) {
  if (Object.hasOwn(identifyingTextFields, key)) {
    // A quality definition is titled by the quality's own name until an
    // operator renames it; only the rename is theirs.
    if (key === "title" && isRecord(parent.quality) && parent.quality.name === parent.title) {
      return undefined;
    }
    return identifyingTextFields[key];
  }
  if (Object.hasOwn(identifyingFactFields, key)) {
    return identifyingFactFields[key];
  }
  if (Object.hasOwn(externalIdBases, key)) {
    return `externalId:${key}`;
  }
  if (key === "imdbId") {
    return "imdbId";
  }
  if (key === "genres") {
    return "genres";
  }
  if (key === "ratings") {
    return "ratings";
  }
  // A tag is an id and the label an operator chose for it.
  if (key === "label" && Object.keys(parent).every((name) => name === "id" || name === "label")) {
    return "tagLabel";
  }
  if ((key === "url" || key === "remoteUrl") && "coverType" in parent) {
    return "artwork";
  }
  return undefined;
}

const namesAnExample = (value) => typeof value === "string" && /example/iu.test(value);

/** Whether a value an identifying field holds is a stand-in, or says the field is unset. */
export function isNeutralIdentifyingValue(field, value) {
  if (value === null || value === undefined || value === "" || value === 0) {
    return true;
  }
  if (field.startsWith("externalId:")) {
    return /^[1-9]0\d{4}$/u.test(String(value));
  }
  switch (field) {
    case "imdbId":
      return typeof value === "string" && /^tt000\d{4}$/u.test(value);
    case "overview":
      return typeof value === "string" && value.startsWith("A sanitized ");
    case "certification":
      return (
        namesAnExample(value) || (typeof value === "string" && certificationVocabulary.test(value))
      );
    case "downloadId":
      return namesAnExample(value) || (typeof value === "string" && isHexRunStandIn(value));
    case "genres":
      return (
        Array.isArray(value) &&
        value.every((genre) => namesAnExample(genre) || genreVocabulary.has(genre))
      );
    case "ratings":
    case "year":
    case "runtime":
    case "airTime":
    case "byteCount":
    case "language":
    case "languages":
      return true;
    case "artwork":
      return (
        typeof value === "string" && (value.startsWith("/media/example/") || namesAnExample(value))
      );
    default:
      return namesAnExample(value);
  }
}

/** Replaces every number in a value with zero, keeping its shape. */
function zeroNumbers(value) {
  if (Array.isArray(value)) {
    return value.map(zeroNumbers);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, zeroNumbers(child)]),
    );
  }
  return typeof value === "number" ? 0 : value;
}

/**
 * The stand-ins one capture writes for identifying fields.
 *
 * Each distinct original value of one field gets its own stand-in, the same
 * every time it recurs within the capture, so a series and the episode rows
 * that name it, or two rows of one download, still agree after it. Nothing
 * of the original survives in its stand-in, which is an ordinal.
 */
export function createIdentifyingNeutralizer(options = {}) {
  const assigned = new Map();
  const dayOffset = options.dayOffset ?? minimumDayOffset + randomInt(0, dayOffsetSpread);
  // Never one, so a scaled count never repeats the original.
  const sizeFactor = options.sizeFactor ?? randomInt(1_001, 2_000) / 1_000;

  const ordinalFor = (field, value) => {
    let byValue = assigned.get(field);
    if (byValue === undefined) {
      byValue = new Map();
      assigned.set(field, byValue);
    }
    const key = JSON.stringify(value);
    let ordinal = byValue.get(key);
    if (ordinal === undefined) {
      ordinal = byValue.size + 1;
      if (ordinal > maxStandInOrdinal) {
        throw new Error(
          `More than ${maxStandInOrdinal} distinct values of ${field} in one capture`,
        );
      }
      byValue.set(key, ordinal);
    }
    return ordinal;
  };

  const standIn = (field, value) => {
    const n = ordinalFor(field, value);
    if (field.startsWith("externalId:")) {
      const id = externalIdBases[field.slice("externalId:".length)] + n;
      return typeof value === "number" ? id : String(id);
    }
    switch (field) {
      case "title":
        return `Example Title ${n}`;
      case "sortTitle":
        return `example title ${n}`;
      case "cleanTitle":
        return `exampletitle${n}`;
      case "titleSlug":
        return `example-title-${n}`;
      case "overview":
        return "A sanitized overview recorded only to fix the payload shape";
      case "network":
        return `Example Network ${n}`;
      case "studio":
        return `Example Studio ${n}`;
      case "certification":
        return `Example Certification ${n}`;
      case "indexer":
        return `Example Indexer ${n}`;
      case "downloadClient":
        return `Example Download Client ${n}`;
      case "downloadId":
        return `example-download-${n}`;
      case "imdbId":
        return `tt${String(n).padStart(7, "0")}`;
      case "tagLabel":
        return `example-tag-${n}`;
      case "artwork":
        return `/media/example/artwork-${n}`;
      default:
        throw new Error(`No stand-in is defined for ${field}`);
    }
  };

  const language = (entry) =>
    isRecord(entry) && typeof entry.name === "string"
      ? {
          ...entry,
          id: ordinalFor("language", entry.name),
          name: `Example Language ${ordinalFor("language", entry.name)}`,
        }
      : entry;

  /**
   * A date, or a date and time, moved by this capture's offset with its time
   * and zone as written; anything else is not a date and is left alone.
   */
  const shiftDate = (value) => {
    const match = typeof value === "string" ? datePrefixPattern.exec(value) : null;
    if (match === null) {
      return undefined;
    }
    const day = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    const moved = new Date(day + dayOffset * 86_400_000).toISOString().slice(0, 10);
    return `${moved}${value.slice(match[0].length)}`;
  };

  return {
    shiftDate,

    /** The stand-in for what one identifying field held, of the same type. */
    neutralize(field, value) {
      if (value === null || value === undefined || value === "" || value === 0) {
        return value;
      }
      if (field === "ratings") {
        return zeroNumbers(value);
      }
      if (field === "year") {
        // The year its middle moves to, so a year and the dates it holds agree.
        return typeof value === "number" && Number.isSafeInteger(value) && value > 0
          ? Number(shiftDate(`${String(value).padStart(4, "0")}-07-01`)?.slice(0, 4))
          : value;
      }
      if (field === "runtime") {
        return typeof value === "number" ? standInRuntimeMinutes : value;
      }
      if (field === "airTime") {
        return typeof value === "string" ? standInAirTime : value;
      }
      if (field === "byteCount") {
        return typeof value === "number" ? Math.round(value * sizeFactor) : value;
      }
      if (field === "language") {
        return language(value);
      }
      if (field === "languages") {
        return Array.isArray(value) ? value.map(language) : value;
      }
      if (field === "genres") {
        return Array.isArray(value)
          ? value.map((genre) =>
              typeof genre === "string" ? `Example Genre ${ordinalFor(field, genre)}` : genre,
            )
          : value;
      }
      if (typeof value !== "string" && typeof value !== "number") {
        throw new Error(`An identifying ${field} holds neither text nor a number`);
      }
      return standIn(field, value);
    },
  };
}

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
      const field = identifyingFieldOf(key, value);
      if (field !== undefined && !isNeutralIdentifyingValue(field, child)) {
        throw new Error(`Identifying ${field} is not neutralized at ${location}.${key}`);
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

/**
 * Holds a fixture recorded at a newer version to the facts a capture writes:
 * every date moved past {@link earliestShiftedYear}, every year with it, and
 * every language an example. A minimum's fixture was recorded before the
 * capture moved dates, and its dates are the ones its tests are written
 * against, so it is not held to this.
 */
function validateShiftedFacts(value, location) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      validateShiftedFacts(item, `${location}[${index}]`);
    });
    return;
  }
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      const field = identifyingFieldOf(key, value);
      const at = `${location}.${key}`;
      if (
        field === "year" &&
        typeof child === "number" &&
        child !== 0 &&
        child < earliestShiftedYear
      ) {
        throw new Error(`Identifying year is not shifted at ${at}`);
      }
      const languages = field === "language" ? [child] : field === "languages" ? child : [];
      for (const entry of Array.isArray(languages) ? languages : []) {
        if (isRecord(entry) && typeof entry.name === "string" && !namesAnExample(entry.name)) {
          throw new Error(`Identifying language is not neutralized at ${at}`);
        }
      }
      validateShiftedFacts(child, at);
    }
    return;
  }
  const match = typeof value === "string" ? datePrefixPattern.exec(value) : null;
  if (match !== null && Number(match[1]) < earliestShiftedYear) {
    throw new Error(`Date is not shifted at ${location}`);
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
  if (!minimumFixtureTuples.includes(tuple)) {
    validateShiftedFacts(body, "fixture.body");
  }

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
