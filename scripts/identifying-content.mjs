import { randomInt } from "node:crypto";
import { legacyStandIns } from "./legacy-stand-ins.mjs";
import { descriptorText, providerImplementations } from "./structural-vocabulary.mjs";

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
  // A profile's language is neutralized like a title's: one rule is simpler
  // than telling a configured choice from a described fact, and no code reads it.
  language: "language",
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
  // A quality group inside a profile is labelled by whoever made the group.
  if ("allowed" in parent && "items" in parent && !("quality" in parent)) {
    return "profileGroup";
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

/** The quality groups the applications create inside their install-time profiles. */
const profileGroupVocabulary = new Set(["WEB 480p", "WEB 720p", "WEB 1080p", "WEB 2160p"]);

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
  profileGroup: /^Example Group \d+$/u,
  languageName: /^Example Language \d+$/u,
  // What a capture writes for any other text: free text, or a provider
  // field's value.
  text: /^(?:Example text \d+|example-value-\d+)$/u,
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

/** The facts that are numbers, which a history event's data writes as text. */
const numericFactFields = new Set(["popularity", "year", "runtime", "byteCount"]);

/** The facts a capture writes as a number whatever type they arrive in, a rating's included. */
const numericFacts = new Set([...numericFactFields, "ratings"]);

const isNumericText = (value) => /^-?\d+(?:\.\d+)?$/u.test(value);

const isUnset = (value) => value === null || value === undefined || value === "" || value === 0;

/**
 * Whether one value an identifying field holds is a stand-in, a value saying
 * the field is unset, a shared vocabulary's, or a legacy value its own fixture
 * was recorded with.
 */
export function isNeutralIdentifyingValue(field, value, legacy = undefined) {
  if (isUnset(value)) {
    return true;
  }
  // A language written as its name alone is checkable at every version.
  if ((field === "language" || field === "languages") && typeof value === "string") {
    return standInForms.languageName.test(value) || legacy?.text?.includes(value) === true;
  }
  if (factFields.has(field)) {
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
    case "profileGroup":
      return standInForms.profileGroup.test(text) || profileGroupVocabulary.has(text);
    case "text":
      // Text no field names can only have been written by a capture.
      return (
        text === overviewStandIn || Object.values(standInForms).some((form) => form.test(text))
      );
    default:
      return standInForms[field]?.test(text) === true;
  }
}

/** The applications' built-in quality names. */
const qualityVocabulary = new Set([
  "BR-DISK",
  "Bluray-1080p",
  "Bluray-1080p Remux",
  "Bluray-2160p",
  "Bluray-2160p Remux",
  "Bluray-480p",
  "Bluray-576p",
  "Bluray-720p",
  "CAM",
  "DVD",
  "DVD-R",
  "DVDSCR",
  "HDTV-1080p",
  "HDTV-2160p",
  "HDTV-720p",
  "REGIONAL",
  "Raw-HD",
  "Remux-1080p",
  "Remux-2160p",
  "SDTV",
  "TELECINE",
  "TELESYNC",
  "Unknown",
  "WEBDL-1080p",
  "WEBDL-2160p",
  "WEBDL-480p",
  "WEBDL-720p",
  "WEBRip-1080p",
  "WEBRip-2160p",
  "WEBRip-480p",
  "WEBRip-720p",
  "WORKPRINT",
]);

/**
 * The languages Sonarr 4.0.20.3014 and Radarr 6.4.4.10685 ship, as their own
 * `language` routes list them; the recorded `language` fixtures at those
 * versions are the evidence, and a test holds this list to them.
 */
const languageVocabulary = new Set([
  "Afrikaans",
  "Albanian",
  "Any",
  "Arabic",
  "Bengali",
  "Bosnian",
  "Bulgarian",
  "Catalan",
  "Chinese",
  "Croatian",
  "Czech",
  "Danish",
  "Dutch",
  "English",
  "Estonian",
  "Finnish",
  "Flemish",
  "French",
  "Georgian",
  "German",
  "Greek",
  "Hebrew",
  "Hindi",
  "Hungarian",
  "Icelandic",
  "Indonesian",
  "Italian",
  "Japanese",
  "Kannada",
  "Korean",
  "Latvian",
  "Lithuanian",
  "Macedonian",
  "Malayalam",
  "Marathi",
  "Mongolian",
  "Norwegian",
  "Original",
  "Persian",
  "Polish",
  "Portuguese",
  "Portuguese (Brazil)",
  "Romanian",
  "Romansh",
  "Russian",
  "Serbian",
  "Slovak",
  "Slovenian",
  "Spanish",
  "Spanish (Latino)",
  "Swedish",
  "Tagalog",
  "Tamil",
  "Telugu",
  "Thai",
  "Turkish",
  "Ukrainian",
  "Unknown",
  "Urdu",
  "Vietnamese",
]);

/** The codec names the applications' media-information formatters write. */
const codecVocabulary = new Set([
  "AAC",
  "AC3",
  "AV1",
  "DivX",
  "DTS",
  "DTS-ES",
  "DTS-HD HRA",
  "DTS-HD MA",
  "DTS-X",
  "EAC3",
  "EAC3 Atmos",
  "FLAC",
  "h264",
  "h265",
  "MP2",
  "MP3",
  "MPEG",
  "MPEG2",
  "Opus",
  "PCM",
  "TrueHD",
  "TrueHD Atmos",
  "VC1",
  "Vorbis",
  "VP8",
  "VP9",
  "WMA",
  "x264",
  "x265",
  "XviD",
]);

/**
 * The words each enumerated field takes, as the applications' APIs define
 * them. A word outside its field's list is treated as text and neutralized,
 * which fails closed: a fixture recorded with a state no one has listed says
 * so in review rather than passing a name through.
 */
const enumerations = {
  status: [
    // A queue item.
    "unknown",
    "queued",
    "paused",
    "downloading",
    "completed",
    "failed",
    "warning",
    "delay",
    "downloadClientUnavailable",
    "fallback",
    // A command.
    "started",
    "aborted",
    "cancelled",
    "orphaned",
    // A series and a movie.
    "continuing",
    "ended",
    "upcoming",
    "deleted",
    "tba",
    "announced",
    "inCinemas",
    "released",
  ],
  trackedDownloadState: [
    "unknown",
    "downloading",
    "importBlocked",
    "importPending",
    "importing",
    "imported",
    "failedPending",
    "failed",
    "ignored",
  ],
  trackedDownloadStatus: ["ok", "warning", "error", "unknown"],
  eventType: [
    "unknown",
    "grabbed",
    "seriesFolderImported",
    "downloadFolderImported",
    "downloadFailed",
    "episodeFileDeleted",
    "episodeFileRenamed",
    "downloadIgnored",
    "movieFileDeleted",
    "movieFolderImported",
    "movieFileRenamed",
    "releaseGrabbed",
    "indexerQuery",
    "indexerRss",
    "indexerAuth",
    "indexerInfo",
  ],
  protocol: ["unknown", "usenet", "torrent"],
  seriesType: ["standard", "daily", "anime"],
  monitorNewItems: ["all", "none"],
  minimumAvailability: ["tba", "announced", "inCinemas", "released", "deleted"],
  finaleType: ["series", "season", "midseason"],
  coverType: ["unknown", "poster", "banner", "fanart", "screenshot", "headshot", "clearlogo"],
  sortDirection: ["default", "ascending", "descending"],
  modifier: ["none", "regional", "screener", "rawhd", "brdisk", "remux"],
  trigger: ["unspecified", "manual", "scheduled"],
  result: ["unknown", "successful", "unsuccessful"],
  // A setting's privacy, and an indexer's.
  privacy: ["normal", "password", "apiKey", "userName", "public", "private", "semiPrivate"],
  syncLevel: ["disabled", "addOnly", "fullSync"],
  listType: ["program", "plex", "trakt", "simkl", "other", "advanced"],
  shouldMonitor: [
    "unknown",
    "none",
    "all",
    "future",
    "missing",
    "existing",
    "firstSeason",
    "lastSeason",
    "latestSeason",
    "pilot",
    "recent",
    "monitorSpecials",
    "unmonitorSpecials",
    "skip",
  ],
  releaseType: ["unknown", "singleEpisode", "multiEpisode", "seasonPack"],
  grabMethod: ["Proxy", "Redirect"],
  queryType: ["search", "tvsearch", "movie", "music", "book"],
  sourceType: ["tmdb", "mappings", "user", "indexer"],
  type: [
    // A health check, a rejection, and a rating.
    "ok",
    "notice",
    "warning",
    "error",
    "permanent",
    "temporary",
    "user",
    "critic",
    // A provider setting's input.
    "textbox",
    "textarea",
    "select",
    "password",
    "checkbox",
    "number",
    "path",
    "filePath",
    "url",
    "tag",
    "tagSelect",
    "captcha",
    "action",
    "device",
    "oAuth",
    "keyValueList",
    "info",
  ],
  scanType: ["Progressive", "Interlaced", "MBAFF", "PAFF"],
  indexerFlags: [
    "freeleech",
    "halfleech",
    "doubleUpload",
    "internal",
    "scene",
    "freeleech75",
    "freeleech25",
    "nuked",
    "G_Freeleech",
    "G_Halfleech",
    "G_DoubleUpload",
    "PTP_Golden",
    "PTP_Approved",
    "HDB_Internal",
    "AHD_Internal",
    "G_Scene",
    "G_Freeleech75",
    "G_Freeleech25",
    "AHD_UserRelease",
  ],
};

/** The sources a quality is recorded from. */
const qualitySources = [
  "unknown",
  "television",
  "televisionRaw",
  "web",
  "webRip",
  "dvd",
  "bluray",
  "blurayRaw",
  "cam",
  "telesync",
  "telecine",
  "workprint",
  "dvdscr",
  // Radarr's words for some of the same.
  "tv",
  "webdl",
  "webrip",
];

const applicationNames = ["Sonarr", "Radarr", "Prowlarr"];

/**
 * The health checks the applications run, by the class each is reported
 * under; a check outside this list is text.
 */
const healthChecks = [
  "ApiKeyValidationCheck",
  "AppDataLocationCheck",
  "ApplicationLongTermStatusCheck",
  "ApplicationStatusCheck",
  "DotnetVersionCheck",
  "DownloadClientCheck",
  "DownloadClientRemovesCompletedDownloadsCheck",
  "DownloadClientRootFolderCheck",
  "DownloadClientSortingCheck",
  "DownloadClientStatusCheck",
  "ImportListRootFolderCheck",
  "ImportListStatusCheck",
  "ImportMechanismCheck",
  "IndexerDownloadClientCheck",
  "IndexerJackettAllCheck",
  "IndexerLongTermStatusCheck",
  "IndexerNoDefinitionCheck",
  "IndexerProxyStatusCheck",
  "IndexerRssCheck",
  "IndexerSearchCheck",
  "IndexerStatusCheck",
  "IndexerVIPCheck",
  "MountCheck",
  "NotificationStatusCheck",
  "OutdatedDefinitionCheck",
  "PackageGlobalMessageCheck",
  "ProxyCheck",
  "RecyclingBinCheck",
  "RemotePathMappingCheck",
  "RemovedMovieCheck",
  "RemovedSeriesCheck",
  "RootFolderCheck",
  "SystemTimeCheck",
  "UpdateCheck",
];

/** The commands the applications run, by name; a command's display name is its name spaced. */
const commandNames = [
  "ApplicationCheckUpdate",
  "ApplicationIndexerSync",
  "ApplicationUpdate",
  "Backup",
  "CheckHealth",
  "CleanUpRecycleBin",
  "ClearBlocklist",
  "ClearLog",
  "CutoffUnmetEpisodeSearch",
  "CutoffUnmetMoviesSearch",
  "DeleteLogFiles",
  "DeleteUpdateLogFiles",
  "DownloadedEpisodesScan",
  "DownloadedMoviesScan",
  "EpisodeSearch",
  "Housekeeping",
  "ImportListSync",
  "IndexerDefinitionUpdate",
  "ManualImport",
  "MessagingCleanup",
  "MissingEpisodeSearch",
  "MissingMoviesSearch",
  "MoveMovie",
  "MoveSeries",
  "MoviesSearch",
  "ProcessMonitoredDownloads",
  "RefreshCollections",
  "RefreshMonitoredDownloads",
  "RefreshMovie",
  "RefreshSeries",
  "RenameFiles",
  "RenameMovie",
  "RenameSeries",
  "ResetApiKey",
  "RssSync",
  "SeasonSearch",
  "SeriesSearch",
];

/** The fields a page is sorted by, as this server asks for them and the recorded pages echo them. */
const sortKeys = ["airDateUtc", "date", "id", "sortTitle", "timeleft"];

/** A command's display name: its name, spaced before each capital. */
const displayNameOf = (name) => name.replace(/(?<=[a-z0-9])(?=[A-Z])/gu, " ");

const commandOf = (parent) => (typeof parent.name === "string" ? parent.name : parent.body?.name);

/** Whether an object is a provider's settings descriptor rather than anything named `fields`. */
const isDescriptor = (parent, container) =>
  (container === "fields" || container === "selectOptions") &&
  typeof parent.name === "string" &&
  ("order" in parent || "type" in parent || "value" in parent);

const allImplementationNames = new Set(
  Object.values(providerImplementations).flatMap((entry) => entry.names),
);
const allContracts = new Set(
  Object.values(providerImplementations).flatMap((entry) => entry.contracts),
);

/** The display names or contracts one implementation is published under, or any when none is named. */
const publishedFor = (parent, property, all) => {
  const entry =
    typeof parent.implementation === "string"
      ? providerImplementations[parent.implementation]
      : undefined;
  return entry === undefined ? all : new Set(entry[property]);
};

const descriptorSets = Object.fromEntries(
  Object.entries(descriptorText).map(([key, values]) => [key, new Set(values)]),
);

/**
 * What is structural, recognized positively by its exact value; every other
 * string a body holds is identifying.
 *
 * No rule is a pattern. Each rule names the keys it covers, the context it
 * applies in where a key means several things, the closed set of values it
 * accepts — from the applications' API enumerations, their provider schemas,
 * their built-in definitions, or this server's own requests — and which kind
 * of structure it is (`enum`, `product`, `quality`, `descriptor`, or
 * `vocabulary`). Only a value's form decides for numbers, flags, whole dates,
 * durations, the empty string, and the applications' masked secret; see
 * {@link isStructuralShape}. A value no rule lists is text: neutralized at
 * capture and refused by the screen, so a field or a word an upstream adds
 * later fails closed until it is listed here.
 *
 * Every rule also states a `probe`: where a value it judges sits, so the
 * contract test can put a title-like value there and show the rule refuses
 * it. A rule added without one fails that test.
 */
export const structuralRules = [
  ...Object.entries(enumerations).map(([key, words]) => ({
    why: "enum",
    keys: [key],
    accept: (value) => words.includes(value),
    probe: () => ({ parent: {} }),
  })),
  {
    why: "enum",
    // A quality's source, a health check by its class, or an application.
    keys: ["source"],
    accept: (value) =>
      qualitySources.includes(value) ||
      applicationNames.includes(value) ||
      healthChecks.includes(value),
    probe: () => ({ parent: {} }),
  },
  {
    why: "enum",
    keys: ["sortKey"],
    accept: (value) => sortKeys.includes(value),
    probe: () => ({ parent: {} }),
  },
  {
    why: "product",
    keys: ["implementation"],
    accept: (value) => Object.hasOwn(providerImplementations, value),
    probe: () => ({ parent: {} }),
  },
  {
    why: "product",
    keys: ["implementationName"],
    accept: (value, parent) => publishedFor(parent, "names", allImplementationNames).has(value),
    probe: () => ({ parent: { implementation: "Newznab" } }),
  },
  {
    why: "product",
    keys: ["configContract"],
    accept: (value, parent) => publishedFor(parent, "contracts", allContracts).has(value),
    probe: () => ({ parent: { implementation: "Newznab" } }),
  },
  {
    why: "product",
    keys: ["appName"],
    accept: (value) => applicationNames.includes(value),
    probe: () => ({ parent: {} }),
  },
  {
    why: "product",
    keys: ["videoCodec", "audioCodec"],
    accept: (value) => codecVocabulary.has(value),
    probe: () => ({ parent: {}, container: "mediaInfo" }),
  },
  {
    why: "product",
    // What a fixture says about itself.
    keys: ["application"],
    when: (_parent, container) => container === "metadata",
    accept: (value) => ["sonarr", "radarr", "prowlarr"].includes(value),
    probe: () => ({ parent: {}, container: "metadata" }),
  },
  {
    why: "product",
    keys: ["capturedBy"],
    when: (_parent, container) => container === "metadata",
    accept: (value) => value === capturedBy,
    probe: () => ({ parent: {}, container: "metadata" }),
  },
  {
    why: "product",
    keys: ["apiVersion"],
    when: (_parent, container) => container === "metadata",
    accept: (value) => ["v1", "v3"].includes(value),
    probe: () => ({ parent: {}, container: "metadata" }),
  },
  {
    why: "enum",
    // A command, named in its own record or in the body of one.
    keys: ["name"],
    when: (parent, container) =>
      container === "body" || "commandName" in parent || "isLongRunning" in parent,
    accept: (value) => commandNames.includes(value),
    probe: () => ({ parent: { isLongRunning: false } }),
  },
  {
    why: "enum",
    keys: ["commandName"],
    accept: (value, parent) => {
      const name = commandOf(parent);
      return (
        typeof name === "string" && commandNames.includes(name) && value === displayNameOf(name)
      );
    },
    probe: (value) => ({ parent: { name: value.replaceAll(" ", "") } }),
  },
  {
    why: "quality",
    keys: ["name"],
    when: (_parent, container) => container === "quality",
    accept: (value) => qualityVocabulary.has(value),
    probe: () => ({ parent: {}, container: "quality" }),
  },
  {
    why: "quality",
    // A quality definition is titled by its quality's own name until an
    // operator renames it; only a rename is theirs.
    keys: ["title"],
    when: (parent) => isRecord(parent.quality) && parent.quality.name === parent.title,
    accept: (value) => qualityVocabulary.has(value),
    probe: (value) => ({ parent: { quality: { id: 1, name: value } } }),
  },
  {
    why: "descriptor",
    keys: [
      "name",
      "label",
      "helpText",
      "helpTextWarning",
      "section",
      "unit",
      "hint",
      "placeholder",
    ],
    when: (parent, container) => container === "fields" && isDescriptor(parent, container),
    accept: (value, _parent, key) => descriptorSets[key]?.has(value) === true,
    probe: () => ({ parent: { order: 0, name: "apiKey" }, container: "fields" }),
  },
  {
    why: "descriptor",
    keys: ["name", "hint"],
    when: (parent, container) => container === "selectOptions" && isDescriptor(parent, container),
    accept: (value, _parent, key) =>
      (key === "name" ? descriptorSets.optionName : descriptorSets.optionHint)?.has(value) === true,
    probe: () => ({ parent: { value: 0, name: "example" }, container: "selectOptions" }),
  },
  {
    why: "vocabulary",
    // The application's own list of languages, which configures nothing.
    keys: ["name"],
    when: (parent) => "nameLower" in parent,
    accept: (value) => languageVocabulary.has(value),
    probe: () => ({ parent: { nameLower: "english" } }),
  },
  {
    why: "vocabulary",
    keys: ["nameLower"],
    accept: (value, parent) =>
      languageVocabulary.has(parent.name) && value === parent.name.toLowerCase(),
    probe: () => ({ parent: { name: "English" } }),
  },
];

/** The shipped language list, for the test that holds it to the recorded routes. */
export const shippedLanguages = [...languageVocabulary];

const structuralRulesByKey = new Map();
for (const rule of structuralRules) {
  for (const key of rule.keys) {
    structuralRulesByKey.set(key, [...(structuralRulesByKey.get(key) ?? []), rule]);
  }
}

/** How large the structural allowlist is: its rules, and the keys they cover. */
export const structuralAllowlistSize = {
  rules: structuralRules.length,
  keys: structuralRulesByKey.size,
};

/**
 * Text whose form says what it is rather than whom it is about, and the only
 * text recognized by form: a number (a version's dotted numbers and a media
 * file's dimensions included), a flag, a whole date or date-time, a duration,
 * the empty string, or the applications' stand-in for a set secret.
 */
function isStructuralShape(value) {
  return (
    value === "" ||
    /^-?\d+(?:\.\d+)?$/u.test(value) ||
    /^\d+(?:\.\d+){2,3}$/u.test(value) ||
    /^\d{2,5}x\d{2,5}$/u.test(value) ||
    /^(?:true|false)$/iu.test(value) ||
    /^\*+$/u.test(value) ||
    /^(?:\d+\.)?\d{1,3}:\d{2}(?::\d{2})?(?:\.\d+)?$/u.test(value) ||
    datePrefixPattern.test(value)
  );
}

/**
 * How one value a body holds is treated: as the identifying field its key
 * names, as structure a rule recognizes, or, failing both, as identifying
 * text — the default for every string.
 */
export function classifyValue(key, parent, container, value) {
  const field = identifyingFieldOf(key, parent, container);
  if (field !== undefined) {
    // A string is judged as what it is, not as what its field expects: one
    // item of a list field is that list's element, and a string where a
    // number, a record, or a time belongs is text.
    if (typeof value === "string") {
      if (Object.hasOwn(elementFields, field)) {
        return elementFields[field];
      }
      if (field === "airTime") {
        return /^\d{1,2}:\d{2}$/u.test(value) ? field : "text";
      }
      // A language may be written as its name alone.
      if (field === "language" || field === "languages") {
        return "language";
      }
      // A number written as text, as a history event's data holds it, is
      // still the number its field expects.
      if (numericFacts.has(field) && isNumericText(value)) {
        return field;
      }
      if (factFields.has(field)) {
        return "text";
      }
    }
    return field;
  }
  if (typeof value !== "string" || isStructuralShape(value)) {
    return undefined;
  }
  const rules = structuralRulesByKey.get(key) ?? [];
  const recognized = rules.some(
    (rule) =>
      (rule.when === undefined || rule.when(parent, container)) && rule.accept(value, parent, key),
  );
  return recognized ? undefined : "text";
}

/**
 * Whether a named field's own check covers a value as it is, so the value
 * needs no further judgment: text or a number where a text or id field
 * belongs, a number where a fact is one, a time where an air time belongs, or
 * a list of strings where a list field belongs (its direct items only).
 * Anything else — a record, a list where a string belongs, a string where a
 * number belongs — is judged leaf by leaf instead, so a field's name is never
 * taken for proof that what it holds was neutralized.
 */
export function coversValue(field, value) {
  if (field === undefined || value === null || value === undefined) {
    return false;
  }
  if (Object.hasOwn(elementFields, field)) {
    return Array.isArray(value) && value.every((item) => !Array.isArray(item));
  }
  if (field === "airTime") {
    return typeof value === "string" && /^\d{1,2}:\d{2}$/u.test(value);
  }
  if (field === "language" || field === "languages") {
    return typeof value === "string";
  }
  if (factFields.has(field)) {
    return (
      typeof value === "number" ||
      (numericFacts.has(field) && typeof value === "string" && isNumericText(value))
    );
  }
  return typeof value === "string" || typeof value === "number";
}

/** Every key a field is named by, for the test that probes each one. */
export const identifyingFieldKeys = Object.keys(fieldsByKey);

/**
 * Every key a fact is named by, and whether a newer fixture's value can be
 * verified as neutral (`value`) or only trusted through its provenance
 * (`provenance`), for the test that probes each one.
 */
export const factFieldKeys = Object.entries(fieldsByKey)
  .filter(([, field]) => factFields.has(field))
  .map(([key, field]) => ({
    key,
    field,
    verified: field === "byteCount" ? "provenance" : "value",
  }));

/**
 * Where each field named by its context rather than its key sits, for the
 * same test: a value placed under `key`, in an object holding `parent`'s
 * fields, under `container`.
 */
export const contextualFieldProbes = [
  { field: "service", key: "name", parent: { implementation: "Newznab" } },
  { field: "service", key: "name", parent: { appProfileId: 1 } },
  { field: "formatName", key: "name", parent: { specifications: [] } },
  { field: "formatName", key: "name", parent: { format: 1, score: 0 } },
  { field: "formatName", key: "name", parent: { id: 1 }, container: "customFormats" },
  {
    field: "formatName",
    key: "name",
    parent: { implementation: "SizeSpecification", negate: false },
  },
  { field: "profileName", key: "name", parent: { items: [], cutoff: 1 } },
  { field: "profileName", key: "name", parent: { enableRss: true } },
  { field: "profileGroup", key: "name", parent: { id: 1001, allowed: true, items: [] } },
  { field: "path", key: "name", parent: { folderName: "example-1" } },
  { field: "tagLabel", key: "label", parent: { id: 1 } },
  { field: "diskLabel", key: "label", parent: { freeSpace: 1 } },
  { field: "artwork", key: "url", parent: { coverType: "poster" } },
  { field: "artwork", key: "remoteUrl", parent: { coverType: "poster" } },
  { field: "message", key: "reason", parent: { type: "permanent" }, container: "rejections" },
];

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

/**
 * A whole date, or a whole date and time, that a capture moves; the time and
 * zone are kept as written. Text that merely starts with a date is text.
 */
export const datePrefixPattern =
  /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,7})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/u;

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
  // At least a tenth larger, so a scaled count never rounds back to the original.
  const sizeFactor = options.sizeFactor ?? randomInt(1_100, 2_000) / 1_000;

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
    // The applications' stand-in for no date at all is not one to move.
    if (match[1] === "0001") {
      return value;
    }
    const day = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    const moved = new Date(day + dayOffset * 86_400_000).toISOString().slice(0, 10);
    return `${moved}${value.slice(10)}`;
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

  /** A language as a record, by its name alone, or by an id, each kept in its own type. */
  const language = (entry) => {
    if (typeof entry === "string") {
      return entry === "" || standInForms.languageName.test(entry)
        ? entry
        : `Example Language ${ordinalFor("language", entry)}`;
    }
    if (typeof entry === "number") {
      return 0;
    }
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
      case "profileGroup":
        return `Example Group ${n}`;
      case "text":
        return `Example text ${n}`;
      default:
        throw new Error(`No stand-in is defined for ${field}`);
    }
  };

  const neutralize = (field, value) => {
    if (isUnset(value)) {
      return value;
    }
    // A fact keeps the type it arrived in: a number written as text is
    // neutralized as the number and written back as text, and other text
    // where a number belongs is left unset rather than carried.
    if (numericFacts.has(field) && typeof value === "string") {
      return isNumericText(value) ? String(neutralize(field, Number(value))) : "";
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
      case "profileGroup":
        return typeof value === "string" && profileGroupVocabulary.has(value)
          ? value
          : text(field, value);
      case "text":
        // A stand-in this capture already wrote, such as a language's name, stays.
        if (isNeutralIdentifyingValue("text", value)) {
          return value;
        }
        // Unrecognized text keeps the one shape code may read from it: a path.
        return typeof value === "string" && /^(?:[\\/]|[a-z]:[\\/])/iu.test(value)
          ? path(value)
          : text(field, value);
      case "ratings":
        return zeroNumbers(value);
      case "popularity":
        return typeof value === "number" ? 0 : value;
      case "year": {
        if (typeof value !== "number") {
          return value;
        }
        // The year its middle moves to, so a year and the dates it holds
        // agree, and never one before the shifted calendar starts.
        const middle = `${String(Math.max(1, Math.trunc(value))).padStart(4, "0")}-07-01`;
        return Math.max(Number(shiftDate(middle)?.slice(0, 4)), earliestShiftedYear);
      }
      case "runtime":
        return typeof value === "number" ? standInRuntimeMinutes : value;
      case "airTime":
        // An air time written any other way than as text is left unset.
        return typeof value === "string" ? standInAirTime : 0;
      case "byteCount":
        return typeof value === "number" ? Math.round(value * sizeFactor) : value;
      case "language":
        return language(value);
      case "languages":
        return Array.isArray(value) ? value.map(language) : language(value);
      case "mediaRunTime":
        return typeof value === "string" ? "30:00" : value;
      case "mediaLanguages":
        return typeof value === "string" ? "und" : value;
      case "path":
        return typeof value === "string" ? path(value) : value;
      default:
        // Any other shape is judged leaf by leaf by the caller.
        return typeof value === "string" || typeof value === "number" ? text(field, value) : value;
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
      if (field !== undefined && factFields.has(field) && !isNeutralFact(field, child)) {
        throw new Error(`Identifying ${field} is not neutralized at ${at}`);
      }
      validateShiftedFacts(child, at, key);
    }
    return;
  }
  // A fact nested in a list is held to the same form as one that is not.
  const field = container === undefined ? undefined : fieldsByKey[container];
  // Text that is neither a number nor an air time is judged as text by the
  // screens every fixture is held to.
  const judgedAsFact =
    typeof value === "number" ||
    (typeof value === "string" && (isNumericText(value) || field === "airTime"));
  if (
    field !== undefined &&
    factFields.has(field) &&
    judgedAsFact &&
    !isNeutralFact(field, value)
  ) {
    throw new Error(`Identifying ${field} is not neutralized at ${location}`);
  }
  const match = typeof value === "string" ? datePrefixPattern.exec(value) : null;
  if (match !== null && match[1] !== "0001" && Number(match[1]) < earliestShiftedYear) {
    throw new Error(`Date is not shifted at ${location}`);
  }
}

/**
 * Whether one fact a newer fixture holds is in the form the capture writes,
 * in any representation the capture accepts: a number or a number written as
 * text, a language by name, by record, or by id, or a list of them. A byte
 * count cannot be told from a scaled one, which is why a newer fixture must
 * carry the capture's provenance as well; see {@link capturedBy}.
 */
function isNeutralFact(field, value) {
  if (isUnset(value)) {
    return true;
  }
  if (field === "language" || field === "languages") {
    const entries = Array.isArray(value) ? value : [value];
    return entries.every(
      (entry) =>
        isUnset(entry) ||
        Array.isArray(entry) ||
        (typeof entry === "string" && standInForms.languageName.test(entry)) ||
        (isRecord(entry) &&
          (typeof entry.name !== "string" || standInForms.languageName.test(entry.name))),
    );
  }
  if (field === "ratings" && isRecord(value)) {
    return JSON.stringify(zeroNumbers(value)) === JSON.stringify(value);
  }
  // A list or a record of anything else is judged by its leaves.
  if (Array.isArray(value) || isRecord(value)) {
    return true;
  }
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string" && isNumericText(value)
        ? Number(value)
        : undefined;
  switch (field) {
    case "year":
      return number !== undefined && number >= earliestShiftedYear;
    case "runtime":
      return number === standInRuntimeMinutes;
    case "popularity":
    case "ratings":
      return number === 0;
    case "airTime":
      return value === standInAirTime;
    case "byteCount":
      return number !== undefined;
    default:
      return false;
  }
}

/**
 * What a capture writes into a fixture's metadata to say it wrote the body.
 *
 * A scaled byte count looks like any other, so a newer fixture's sizes can
 * only be trusted as far as its provenance can: the fixture contract requires
 * a newer fixture to carry this mark, which a body copied by hand from an
 * instance does not. It guards against an unsanitized body being committed by
 * mistake, not against one forged on purpose, and it records nothing about the
 * capture's offset or factor, which would undo them.
 */
export const capturedBy = "identifying-content-capture-1";
