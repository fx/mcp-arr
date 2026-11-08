import { randomInt } from "node:crypto";
import { legacyStandIns } from "./legacy-stand-ins.mjs";

/**
 * What identifies a library, or the services behind it, in a recorded body —
 * and the stand-in a capture writes in its place.
 *
 * The fixture screens refuse a credential, a host, a path outside the example
 * root, or an address wherever it appears, but a recorded body says more than
 * that: the titles, overviews, artwork, files, and metadata ids of the series
 * and movies in someone's library, the facts that place each one, and the
 * names they gave their indexers, clients, profiles, and formats. None of it is
 * a secret and all of it is personal, so no fixture may carry it. A fixture
 * owes these fields their presence and their type, never their content.
 *
 * Every field is classified here once, by its key and, where one key means
 * different things, by the object it is in and the key that object sits
 * under. A field not classified is structural: an enumeration value, a
 * product's or a command's name, a code, a count, or a flag, which names no
 * one. The classification covers every field of every approved route's
 * recorded fixture; a field a route adds later is structural until it is
 * classified, which is why a capture is inspected before it is committed.
 *
 * The capture replaces every classified value with the stand-in below,
 * whatever it held — the same stand-in for every recurrence within one
 * capture, so the rows of one download, a series and the episodes that name
 * it, and a folder and the files inside it still agree. The screen accepts
 * only the exact forms those stand-ins take, a field's unset values, the
 * shared vocabularies listed below, and the legacy values one minimum-version
 * fixture was recorded with, each listed against its own file in
 * `legacy-stand-ins.mjs`.
 */

/** Where each metadata source's stand-in ids start; an id is the base plus an ordinal. */
const externalIdBases = { tvdbId: 100_000, tmdbId: 200_000, tvMazeId: 400_000, tvRageId: 500_000 };

const maxStandInOrdinal = 9_999;

/** The fields a key always names, wherever it appears. */
const fieldsByKey = {
  title: "title",
  originalTitle: "title",
  seriesTitle: "title",
  movieTitle: "title",
  sourceTitle: "title",
  sceneName: "title",
  movieTitles: "titles",
  sortTitle: "sortTitle",
  cleanTitle: "cleanTitle",
  titleSlug: "titleSlug",
  overview: "overview",
  network: "network",
  studio: "studio",
  certification: "certification",
  genres: "genres",
  ratings: "ratings",
  popularity: "popularity",
  // The name an operator gave a client or an indexer. A client's name
  // defaults to its product's, but need not be one; the product itself is the
  // provider's `implementation`, which is structural.
  indexer: "service",
  indexerName: "service",
  downloadClient: "service",
  downloadClientName: "service",
  downloadId: "downloadId",
  torrentInfoHash: "downloadId",
  tvdbId: "externalId:tvdbId",
  tmdbId: "externalId:tmdbId",
  tvMazeId: "externalId:tvMazeId",
  tvRageId: "externalId:tvRageId",
  imdbId: "imdbId",
  youTubeTrailerId: "trailer",
  remotePoster: "artwork",
  path: "path",
  relativePath: "path",
  existingPath: "path",
  newPath: "path",
  outputPath: "path",
  droppedPath: "path",
  importedPath: "path",
  rootFolderPath: "path",
  originalFilePath: "path",
  folderName: "path",
  query: "query",
  guid: "guid",
  definitionName: "definition",
  indexerUrls: "indexerUrls",
  releaseGroup: "releaseGroup",
  releaseGroups: "releaseGroups",
  message: "message",
  errorMessage: "message",
  messages: "messages",
  rejections: "messages",
  runTime: "mediaRunTime",
  audioLanguages: "mediaLanguages",
  subtitles: "mediaLanguages",
  year: "year",
  movieYear: "year",
  runtime: "runtime",
  airTime: "airTime",
  size: "byteCount",
  sizeleft: "byteCount",
  sizeOnDisk: "byteCount",
  freeSpace: "byteCount",
  totalSpace: "byteCount",
  originalLanguage: "language",
  languages: "languages",
};

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Which identifying field a key holds, given the object it is in and the key
 * that object sits under, or `undefined` for a structural field.
 */
export function identifyingFieldOf(key, parent, container) {
  if (key === "name") {
    return nameFieldOf(parent, container);
  }
  if (key === "label") {
    // A tag is an id and the label an operator chose for it, and a disk is
    // labelled by whoever mounted it; a provider field's label is the
    // application's own text.
    if (Object.keys(parent).every((name) => name === "id" || name === "label")) {
      return "tagLabel";
    }
    return "freeSpace" in parent ? "diskLabel" : undefined;
  }
  if ((key === "url" || key === "remoteUrl") && "coverType" in parent) {
    return "artwork";
  }
  if (key === "reason" && container === "rejections") {
    return "message";
  }
  if (!Object.hasOwn(fieldsByKey, key)) {
    return undefined;
  }
  // A quality definition is titled by its quality's own name until an
  // operator renames it; only a rename is theirs.
  if (key === "title" && isRecord(parent.quality) && parent.quality.name === parent.title) {
    return undefined;
  }
  return fieldsByKey[key];
}

/** What a `name` names, which depends on what it is the name of. */
function nameFieldOf(parent, container) {
  if (container === "customFormats" || "specifications" in parent || "score" in parent) {
    return "formatName";
  }
  if ("implementation" in parent) {
    // A custom format's condition is a provider too, named by whoever wrote it.
    return "negate" in parent || "required" in parent ? "formatName" : "service";
  }
  // Prowlarr's indexer summary carries no implementation, but its profile.
  if ("appProfileId" in parent) {
    return "service";
  }
  if (("items" in parent && "cutoff" in parent) || "enableRss" in parent) {
    return "profileName";
  }
  // An import candidate is named by its file.
  if ("folderName" in parent) {
    return "path";
  }
  return undefined;
}

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

/** The quality profiles the applications create on install, which name no one's choice. */
const profileVocabulary = new Set([
  "Any",
  "SD",
  "HD-720p",
  "HD-1080p",
  "Ultra-HD",
  "HD - 720p/1080p",
]);

/** The extensions a stand-in path keeps on its last segment, so a file still reads as one. */
const keptExtensions = /\.(?:mkv|mp4|m4v|avi|ts|wmv|iso|srt|ass|sub|idx|nfo)$/iu;

const overviewStandIn = "A sanitized overview recorded only to fix the payload shape";

/** The exact form each text field's stand-in takes. */
const standInForms = {
  title: /^Example Title \d+$/u,
  sortTitle: /^example title \d+$/u,
  cleanTitle: /^exampletitle\d+$/u,
  titleSlug: /^example-title-\d+$/u,
  network: /^Example Network \d+$/u,
  studio: /^Example Studio \d+$/u,
  certification: /^Example Certification \d+$/u,
  service: /^Example Service \d+$/u,
  downloadId: /^example-download-\d+$/u,
  "externalId:tvdbId": /^10\d{4}$/u,
  "externalId:tmdbId": /^20\d{4}$/u,
  "externalId:tvMazeId": /^40\d{4}$/u,
  "externalId:tvRageId": /^50\d{4}$/u,
  imdbId: /^tt000\d{4}$/u,
  trailer: /^example-trailer-\d+$/u,
  artwork: /^\/media\/example\/artwork-\d+$/u,
  path: /^(?:\/media\/example(?:\/example-\d+)*|example-\d+(?:\/example-\d+)*)(?:\.[a-z0-9]{2,4})?$/u,
  query: /^example query \d+$/u,
  guid: /^example-guid-\d+$/u,
  definition: /^example-definition-\d+$/u,
  indexerUrl: /^example-indexer-url-\d+$/u,
  releaseGroup: /^EXAMPLEGRP\d+$/u,
  message: /^Example message \d+$/u,
  mediaRunTime: /^30:00$/u,
  mediaLanguages: /^und$/u,
  formatName: /^Example Format \d+$/u,
  profileName: /^Example Profile \d+$/u,
  tagLabel: /^example-tag-\d+$/u,
  diskLabel: /^Example Disk \d+$/u,
  genre: /^Example Genre \d+$/u,
};

/** The element field of a field that holds a list. */
const elementFields = {
  titles: "title",
  genres: "genre",
  indexerUrls: "indexerUrl",
  releaseGroups: "releaseGroup",
  messages: "message",
};

/** The fields whose values are facts a stand-in cannot be told apart from; see the fact screen. */
const factFields = new Set([
  "ratings",
  "popularity",
  "year",
  "runtime",
  "airTime",
  "byteCount",
  "language",
  "languages",
]);

const isUnset = (value) => value === null || value === undefined || value === "" || value === 0;

/**
 * Whether one value an identifying field holds is a stand-in, a value saying
 * the field is unset, a shared vocabulary's, or a legacy value its own fixture
 * was recorded with.
 */
export function isNeutralIdentifyingValue(field, value, legacy = undefined) {
  if (isUnset(value) || factFields.has(field)) {
    return true;
  }
  const element = elementFields[field];
  if (element !== undefined) {
    return (
      Array.isArray(value) &&
      value.every(
        (item) =>
          // A rejection may be an object, whose reason is screened as its own field.
          isRecord(item) || isNeutralIdentifyingValue(element, item, legacy),
      )
    );
  }
  if (legacy?.[field]?.includes(value) === true) {
    return true;
  }
  if (typeof value !== "string" && typeof value !== "number") {
    return false;
  }
  const text = String(value);
  switch (field) {
    case "overview":
      return text === overviewStandIn;
    case "certification":
      return standInForms.certification.test(text) || certificationVocabulary.test(text);
    case "genre":
      return standInForms.genre.test(text) || genreVocabulary.has(text);
    case "profileName":
      return standInForms.profileName.test(text) || profileVocabulary.has(text);
    default:
      return standInForms[field]?.test(text) === true;
  }
}

/** The legacy values one recorded fixture may hold, by field. */
export function legacyStandInsFor(relativePath) {
  return legacyStandIns[relativePath];
}

/**
 * How far a capture moves its dates: about two centuries and up to ten years
 * more, so a shifted date reads as synthetic at a glance and any date a
 * library holds lands after {@link earliestShiftedYear}.
 */
const minimumDayOffset = 80_000;
const dayOffsetSpread = 3_653;

/** No shifted date falls before this year, and no unshifted one a library holds after it. */
export const earliestShiftedYear = 2100;

/** A date, or a date and time, that a capture moves; the time and zone are kept as written. */
export const datePrefixPattern = /^(\d{4})-(\d{2})-(\d{2})(?=$|T\d{2}:\d{2})/u;

/** The runtime and air time every captured title is given. */
const standInRuntimeMinutes = 30;
const standInAirTime = "20:00";

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
 * The stand-ins one capture writes.
 *
 * Each distinct original value of one field gets its own stand-in, the same
 * every time it recurs within the capture. Nothing of the original survives
 * in a stand-in, which is an ordinal; a path keeps its depth, whether it is
 * absolute, and its last segment's media extension, segment by segment, so a
 * file still sits inside the folder it sat in. Every date moves by one offset
 * of whole days, and every byte count is scaled by one factor, both chosen at
 * random for the capture and recorded nowhere.
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

  const shiftDate = (value) => {
    const match = typeof value === "string" ? datePrefixPattern.exec(value) : null;
    if (match === null) {
      return undefined;
    }
    const day = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    const moved = new Date(day + dayOffset * 86_400_000).toISOString().slice(0, 10);
    return `${moved}${value.slice(match[0].length)}`;
  };

  const path = (value) => {
    const absolute = /^(?:[\\/]|[a-z]:[\\/])/iu.test(value);
    const segments = value
      .replace(/^[a-z]:/iu, "")
      .split(/[\\/]+/u)
      .filter(Boolean);
    const mapped = segments.map((segment, index) => {
      const extension =
        index === segments.length - 1 ? (keptExtensions.exec(segment)?.[0] ?? "") : "";
      const stem = extension === "" ? segment : segment.slice(0, -extension.length);
      return `example-${ordinalFor("pathSegment", stem)}${extension.toLowerCase()}`;
    });
    return absolute ? ["/media/example", ...mapped].join("/") : mapped.join("/");
  };

  const language = (entry) => {
    if (!isRecord(entry) || typeof entry.name !== "string") {
      return entry;
    }
    const n = ordinalFor("language", entry.name);
    return { ...entry, id: n, name: `Example Language ${n}` };
  };

  const text = (field, value) => {
    const n = ordinalFor(field, field === "downloadId" ? String(value).toLowerCase() : value);
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
        return overviewStandIn;
      case "network":
        return `Example Network ${n}`;
      case "studio":
        return `Example Studio ${n}`;
      case "certification":
        return `Example Certification ${n}`;
      case "service":
        return `Example Service ${n}`;
      case "downloadId":
        return `example-download-${n}`;
      case "imdbId":
        return `tt${String(n).padStart(7, "0")}`;
      case "trailer":
        return `example-trailer-${n}`;
      case "artwork":
        return `/media/example/artwork-${n}`;
      case "query":
        return `example query ${n}`;
      case "guid":
        return `example-guid-${n}`;
      case "definition":
        return `example-definition-${n}`;
      case "indexerUrl":
        return `example-indexer-url-${n}`;
      case "releaseGroup":
        return `EXAMPLEGRP${n}`;
      case "message":
        return `Example message ${n}`;
      case "formatName":
        return `Example Format ${n}`;
      case "profileName":
        return `Example Profile ${n}`;
      case "tagLabel":
        return `example-tag-${n}`;
      case "diskLabel":
        return `Example Disk ${n}`;
      case "genre":
        return `Example Genre ${n}`;
      default:
        throw new Error(`No stand-in is defined for ${field}`);
    }
  };

  const neutralize = (field, value) => {
    if (isUnset(value)) {
      return value;
    }
    const element = elementFields[field];
    if (element !== undefined) {
      // A rejection may be an object; the caller screens its reason as a field.
      return Array.isArray(value)
        ? value.map((item) => (isRecord(item) ? item : neutralize(element, item)))
        : value;
    }
    switch (field) {
      case "profileName":
        // A profile the application created on install keeps its own name.
        return typeof value === "string" && profileVocabulary.has(value)
          ? value
          : text(field, value);
      case "ratings":
        return zeroNumbers(value);
      case "popularity":
        return typeof value === "number" ? 0 : value;
      case "year":
        // The year its middle moves to, so a year and the dates it holds agree.
        return typeof value === "number" && Number.isSafeInteger(value) && value > 0
          ? Number(shiftDate(`${String(value).padStart(4, "0")}-07-01`)?.slice(0, 4))
          : value;
      case "runtime":
        return typeof value === "number" ? standInRuntimeMinutes : value;
      case "airTime":
        return typeof value === "string" ? standInAirTime : value;
      case "byteCount":
        return typeof value === "number" ? Math.round(value * sizeFactor) : value;
      case "language":
        return language(value);
      case "languages":
        return Array.isArray(value) ? value.map(language) : value;
      case "mediaRunTime":
        return typeof value === "string" ? "30:00" : value;
      case "mediaLanguages":
        return typeof value === "string" ? "und" : value;
      case "path":
        return typeof value === "string" ? path(value) : value;
      default:
        if (typeof value !== "string" && typeof value !== "number") {
          throw new Error(`An identifying ${field} holds neither text nor a number`);
        }
        return text(field, value);
    }
  };

  return {
    /**
     * A date, or a date and time, moved by this capture's offset with its
     * time and zone as written; anything else is not a date and is left alone.
     */
    shiftDate,
    /** The stand-in for what one identifying field held, of the same type. */
    neutralize,
  };
}

/**
 * Holds a fixture recorded at a newer version — one a capture with these
 * rules wrote — to the facts a capture writes, which cannot be told from real
 * ones anywhere else: every date moved past {@link earliestShiftedYear},
 * every year with it, every language an example, and every rating and
 * popularity zero. A minimum's fixture was recorded before the capture moved
 * dates, and its tests are written against the dates it holds, so it is not
 * held to this.
 */
export function validateShiftedFacts(value, location, container = undefined) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      validateShiftedFacts(item, `${location}[${index}]`, container);
    });
    return;
  }
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      const field = identifyingFieldOf(key, value, container);
      const at = `${location}.${key}`;
      if (field === "year" && typeof child === "number" && child !== 0) {
        if (child < earliestShiftedYear) {
          throw new Error(`Identifying year is not shifted at ${at}`);
        }
      }
      if (
        (field === "ratings" || field === "popularity") &&
        JSON.stringify(zeroNumbers(child)) !== JSON.stringify(child)
      ) {
        throw new Error(`Identifying ${field} is not neutralized at ${at}`);
      }
      const languages = field === "language" ? [child] : field === "languages" ? child : [];
      for (const entry of Array.isArray(languages) ? languages : []) {
        if (
          isRecord(entry) &&
          typeof entry.name === "string" &&
          !/^Example Language \d+$/u.test(entry.name)
        ) {
          throw new Error(`Identifying language is not neutralized at ${at}`);
        }
      }
      validateShiftedFacts(child, at, key);
    }
    return;
  }
  const match = typeof value === "string" ? datePrefixPattern.exec(value) : null;
  if (match !== null && Number(match[1]) < earliestShiftedYear) {
    throw new Error(`Date is not shifted at ${location}`);
  }
}
