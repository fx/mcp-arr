/**
 * The legacy values each minimum-version fixture was recorded with, in the
 * fields that identify a library or its services, listed against the one file
 * each comes from.
 *
 * These fixtures were written before the capture neutralized identifying
 * content, with hand-chosen stand-ins in the "Example …" style rather than the
 * exact forms the capture now writes. Every value here is one of those
 * stand-ins, checked when it was listed; none is a real library's. The screen
 * accepts a value outside the exact forms only where this list names it for
 * that file, so a value cannot be added to a fixture by resembling one, and a
 * fixture captured from now on, which writes only the exact forms, needs no
 * entry here.
 */
export const legacyStandIns = {
  "prowlarr/v1/2.5.2.5491/applications.json": {
    service: [
      "Example Movie Application",
      "Example Paused Application",
      "Example Series Application",
    ],
    text: [
      "CANARY-PROWLARR-APPLICATION-APIKEY-0008",
      "example-movie-application",
      "example-paused-application",
      "example-prowlarr",
      "example-series-application",
    ],
  },
  "prowlarr/v1/2.5.2.5491/appprofile.json": {
    profileName: ["Example App Profile"],
  },
  "prowlarr/v1/2.5.2.5491/health.json": {
    message: ["Indexers unavailable due to failures: Example Usenet Indexer"],
  },
  "prowlarr/v1/2.5.2.5491/history.json": {
    query: ["example series"],
  },
  "prowlarr/v1/2.5.2.5491/indexer.json": {
    definition: ["exampletracker"],
    indexerUrl: ["example-tracker"],
    service: ["Example Indexer A", "Example Indexer B", "Example Indexer C", "Example Indexer D"],
    text: [
      "CANARY-CARDIGANN-INFO-0007",
      "CANARY-CARDIGANN-PASSKEY-0006",
      "CANARY-CARDIGANN-PASSWORD-0005",
      "CANARY-PROWLARR-INDEXER-APIKEY-0010",
      "created",
      "example-operator",
      "example-tracker",
      "example-usenet-indexer",
      "exampletracker",
    ],
  },
  "prowlarr/v1/2.5.2.5491/indexerstats.json": {
    service: ["Example Indexer", "Example Usenet Indexer"],
  },
  "prowlarr/v1/2.5.2.5491/notification.json": {
    service: ["Example Webhook"],
    text: ["CANARY-PROWLARR-NOTIFICATION-PASSWORD-0009", "example-operator", "example-webhook"],
  },
  "prowlarr/v1/2.5.2.5491/search.json": {
    guid: ["example-indexer-a-7007", "example-indexer-a-8008"],
    service: ["Example Indexer A"],
    text: ["TV", "TV HD"],
    title: [
      "Example Series S01E02 1080p WEB-DL x264-EXAMPLEGRP",
      "Example Series S01E02 720p WEB-DL x264-EXAMPLEGRP",
    ],
  },
  "prowlarr/v1/2.5.2.5491/tag.json": {
    tagLabel: ["example-movies", "example-series"],
  },
  "radarr/v3/6.3.0.10514/blocklist.json": {
    message: ["The release was blocked after the download failed"],
    service: ["Example Indexer"],
    text: ["English"],
    title: ["Example Fallback 2019 WEBDL-1080p"],
  },
  "radarr/v3/6.3.0.10514/calendar.json": {
    "externalId:tmdbId": [300001],
    overview: [
      "A sanitized movie overview recorded only to fix the payload shape",
      "A sanitized movie whose three release dates fall in three different months",
      "A sanitized upcoming movie overview recorded only to fix the payload shape",
    ],
    path: [
      "/media/example/movies/Example Awaited Movie (2026)",
      "/media/example/movies/Example Movie (2021)",
      "/media/example/movies/Example Staggered Movie (2022)",
      "Example Movie (2021) Bluray-1080p.mkv",
    ],
    releaseGroup: ["EXAMPLEGRP"],
    sortTitle: ["example awaited movie", "example movie", "example staggered movie"],
    studio: ["Example Studio"],
    text: ["Director Cut", "English"],
    title: [
      "Example Awaited Movie",
      "Example Collection",
      "Example Movie",
      "Example Movie Alternate",
      "Example Staggered Movie",
    ],
  },
  "radarr/v3/6.3.0.10514/collection.json": {
    "externalId:tmdbId": [300001, 300002],
    overview: [
      "A sanitized collection overview recorded only to fix the payload shape",
      "A sanitized dormant collection overview recorded only to fix the payload shape",
    ],
    path: ["/media/example/movies"],
    sortTitle: ["example collection", "example dormant collection"],
    title: [
      "Example Collection",
      "Example Dormant Collection",
      "Example Movie",
      "Example Movie Sequel",
    ],
  },
  "radarr/v3/6.3.0.10514/config-downloadclient.json": {
    text: ["_UNPACK_|_FAILED_"],
  },
  "radarr/v3/6.3.0.10514/customformat.json": {
    formatName: ["Example Format", "Example Release Title Specification"],
    text: ["example-release-tag"],
  },
  "radarr/v3/6.3.0.10514/diskspace.json": {
    diskLabel: ["Media"],
  },
  "radarr/v3/6.3.0.10514/downloadclient.json": {
    service: ["Example Torrent Client"],
    text: [
      "CANARY-RADARR-DOWNLOADCLIENT-PASSWORD-0004",
      "example-download-client",
      "example-operator",
      "radarr",
    ],
  },
  "radarr/v3/6.3.0.10514/exclusions-paged.json": {
    title: ["Example Movie"],
  },
  "radarr/v3/6.3.0.10514/health.json": {
    message: ["Missing root folder for one or more movies"],
  },
  "radarr/v3/6.3.0.10514/history-movie.json": {
    downloadId: ["b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1"],
    releaseGroup: ["ExampleGroup"],
    service: ["Example Client", "Example Indexer"],
    text: ["English"],
    title: ["Example Movie 2021 Bluray-1080p"],
  },
  "radarr/v3/6.3.0.10514/history.json": {
    downloadId: [
      "a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6",
      "f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5",
    ],
    path: ["/media/example/downloads/complete/example", "/media/example/library/example"],
    releaseGroup: ["ExampleGroup"],
    service: ["Example Client", "Example Indexer"],
    text: ["English", "Upgrade"],
    title: [
      "Example Fallback 2019 WEBDL-1080p",
      "Example Movie 2021 Bluray-1080p",
      "Example Sequel 2023 WEBDL-2160p",
    ],
  },
  "radarr/v3/6.3.0.10514/manualimport.json": {
    formatName: ["Example Movie Format"],
    message: ["Sample file", "Unable to parse movie from filename"],
    path: [
      "/media/example/movies/Example Movie (2021)/Example Movie (2021) Bluray-1080p.mkv",
      "/media/example/movies/Example Movie (2021)/sample.mkv",
      "Example Movie (2021)",
      "Example Movie (2021) Bluray-1080p",
      "Example Movie (2021) Bluray-1080p.mkv",
      "sample",
      "sample.mkv",
    ],
    releaseGroup: ["ExampleGroup"],
    text: ["English"],
    title: ["Example Movie"],
  },
  "radarr/v3/6.3.0.10514/movie-lookup.json": {
    "externalId:tmdbId": [300001],
    overview: [
      "A sanitized lookup movie overview recorded only to fix the payload shape",
      "A sanitized movie overview recorded only to fix the payload shape",
    ],
    path: ["/media/example/movies/Example Movie (2021)", "Example Movie (2021) Bluray-1080p.mkv"],
    releaseGroup: ["EXAMPLEGRP"],
    sortTitle: ["example movie", "example unadded movie"],
    studio: ["Example Other Studio", "Example Studio"],
    text: ["Director Cut", "English"],
    title: [
      "Example Collection",
      "Example Movie",
      "Example Movie Alternate",
      "Example Unadded Movie",
    ],
  },
  "radarr/v3/6.3.0.10514/movie.json": {
    "externalId:tmdbId": [300001],
    overview: [
      "A sanitized archived movie overview recorded only to fix the payload shape",
      "A sanitized movie overview recorded only to fix the payload shape",
      "A sanitized upcoming movie overview recorded only to fix the payload shape",
    ],
    path: [
      "/media/example/movies",
      "/media/example/movies/Example Archived Movie (2004)",
      "/media/example/movies/Example Awaited Movie (2026)",
      "/media/example/movies/Example Movie (2021)",
      "Example Movie (2021) Bluray-1080p.mkv",
    ],
    releaseGroup: ["EXAMPLEGRP"],
    sortTitle: ["example archived movie", "example awaited movie", "example movie"],
    studio: ["Example Studio"],
    text: ["Director Cut", "English"],
    title: [
      "Example Archived Movie",
      "Example Awaited Movie",
      "Example Collection",
      "Example Movie",
      "Example Movie Alternate",
    ],
  },
  "radarr/v3/6.3.0.10514/moviefile.json": {
    formatName: ["Example Format"],
    mediaLanguages: ["eng"],
    mediaRunTime: ["45:12"],
    path: [
      "/media/example/movies/Example Movie (2021)/Example Movie (2021) Bluray-1080p.mkv",
      "Example Movie (2021) Bluray-1080p.mkv",
    ],
    releaseGroup: ["EXAMPLEGRP"],
    text: ["Director Cut", "English"],
  },
  "radarr/v3/6.3.0.10514/qualityprofile.json": {
    profileName: ["Example Any", "Example Bluray"],
    text: ["English"],
  },
  "radarr/v3/6.3.0.10514/queue-details.json": {
    downloadId: [
      "a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6",
      "f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5",
    ],
    message: ["Not an upgrade for existing movie file"],
    path: ["/media/example/downloads/complete"],
    service: [
      "Example Client",
      "Example Indexer",
      "Example Usenet Client",
      "Example Usenet Indexer",
    ],
    text: ["English"],
    title: ["Example Movie 2021 Bluray-1080p", "Example Sequel 2023 WEBDL-2160p"],
  },
  "radarr/v3/6.3.0.10514/queue.json": {
    downloadId: [
      "a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6",
      "f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5",
    ],
    message: ["Not an upgrade for existing movie file"],
    path: ["/media/example/downloads/complete"],
    service: [
      "Example Client",
      "Example Indexer",
      "Example Usenet Client",
      "Example Usenet Indexer",
    ],
    text: ["English"],
    title: [
      "Example Fallback 2019 WEBDL-1080p",
      "Example Movie 2021 Bluray-1080p",
      "Example Sequel 2023 WEBDL-2160p",
    ],
  },
  "radarr/v3/6.3.0.10514/release.json": {
    formatName: ["Example Custom Format"],
    guid: ["example-indexer-a-4004", "example-indexer-a-6006", "example-indexer-b-5005"],
    message: ["Quality WEBRip-1080p is not wanted in profile"],
    releaseGroup: ["EXAMPLEGRP", "OTHERGRP"],
    service: ["Example Indexer A", "Example Indexer B"],
    text: ["Director's Cut", "English", "French"],
    title: [
      "Example Movie",
      "Example Movie 2021 1080p BluRay x264-EXAMPLEGRP",
      "Example Movie 2021 1080p WEBRip x264-OTHERGRP",
      "Example Movie 2021 2160p UHD BluRay x265-EXAMPLEGRP",
      "Example Movie Alternate Title",
    ],
  },
  "radarr/v3/6.3.0.10514/rename.json": {
    path: [
      "Example Movie (2021) Bluray-1080p.mkv",
      "Example Movie (2021) [Bluray-1080p]-EXAMPLEGRP.mkv",
    ],
  },
  "radarr/v3/6.3.0.10514/rootfolder.json": {
    path: ["/media/example/movies"],
  },
  "radarr/v3/6.3.0.10514/tag.json": {
    tagLabel: ["example-archive", "example-tag"],
  },
  "radarr/v3/6.3.0.10514/wanted-cutoff.json": {
    "externalId:tmdbId": [300001],
    overview: ["A sanitized movie overview recorded only to fix the payload shape"],
    path: ["/media/example/movies/Example Movie (2021)"],
    sortTitle: ["example movie"],
    studio: ["Example Studio"],
    text: ["English"],
    title: ["Example Collection", "Example Movie", "Example Movie Alternate"],
  },
  "radarr/v3/6.3.0.10514/wanted-missing.json": {
    overview: [
      "A sanitized missing movie overview recorded only to fix the payload shape",
      "A sanitized upcoming movie overview recorded only to fix the payload shape",
    ],
    path: [
      "/media/example/movies/Example Awaited Movie (2026)",
      "/media/example/movies/Example Missing Movie (2004)",
    ],
    sortTitle: ["example awaited movie", "example missing movie"],
    studio: ["Example Studio"],
    text: ["English"],
    title: ["Example Awaited Movie", "Example Missing Movie"],
  },
  "sonarr/v3/4.0.19.2979/blocklist.json": {
    message: ["The release was blocked after the download failed"],
    service: ["Example Indexer", "Example Usenet Indexer"],
    text: ["English"],
    title: ["Example Anime S01E14 WEBDL-720p", "Example Series S02E01 WEBDL-1080p"],
  },
  "sonarr/v3/4.0.19.2979/calendar.json": {
    "externalId:tvdbId": [900001, 900003],
    overview: [
      "A sanitized episode overview recorded only to fix the payload shape",
      "A sanitized unaired episode overview recorded only to fix the payload shape",
    ],
    path: ["/media/example/series/Example Series"],
    sortTitle: ["example series"],
    title: ["Example Pilot", "Example Return", "Example Series"],
    titleSlug: ["example-series"],
  },
  "sonarr/v3/4.0.19.2979/command.json": {
    message: ["Completed", "Refreshing series"],
  },
  "sonarr/v3/4.0.19.2979/config-downloadclient.json": {
    text: ["_UNPACK_|_FAILED_"],
  },
  "sonarr/v3/4.0.19.2979/diskspace.json": {
    diskLabel: ["Media"],
    path: ["/media/example/downloads"],
  },
  "sonarr/v3/4.0.19.2979/episode.json": {
    "externalId:tvdbId": [900001, 900002, 900003, 900004],
    overview: [
      "A sanitized anime episode overview recorded only to fix the payload shape",
      "A sanitized episode overview recorded only to fix the payload shape",
      "A sanitized second-season episode overview recorded only to fix the payload shape",
      "A sanitized unaired episode overview recorded only to fix the payload shape",
    ],
    title: ["Example Absolute Episode", "Example Follow Up", "Example Pilot", "Example Return"],
  },
  "sonarr/v3/4.0.19.2979/episodefile.json": {
    formatName: ["Example Format"],
    mediaLanguages: ["eng"],
    mediaRunTime: ["45:12"],
    path: [
      "/media/example/series/Example Series/Season 01/Example Series - S01E01 - Example Pilot Bluray-1080p.mkv",
      "/media/example/series/Example Series/Season 02/Example Series - S02E02 - Example Follow Up WEBDL-720p.mkv",
      "Season 01/Example Series - S01E01 - Example Pilot Bluray-1080p.mkv",
      "Season 02/Example Series - S02E02 - Example Follow Up WEBDL-720p.mkv",
    ],
    releaseGroup: ["EXAMPLEGRP"],
    text: ["English"],
  },
  "sonarr/v3/4.0.19.2979/health.json": {
    message: [
      "Lists unavailable due to failures: Example List",
      "Unable to communicate with the configured download client",
    ],
  },
  "sonarr/v3/4.0.19.2979/history-series.json": {
    downloadId: [
      "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
      "d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3",
      "e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4",
    ],
    releaseGroup: ["ExampleGroup"],
    service: ["Example Client", "Example Indexer"],
    text: ["English", "The download client reported the download as failed"],
    title: [
      "Example Series S01E01 Bluray-1080p",
      "Example Series S02E01 WEBDL-1080p",
      "Example Series S02E02 Bluray-1080p",
    ],
  },
  "sonarr/v3/4.0.19.2979/history.json": {
    downloadId: [
      "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
      "d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3",
      "e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4",
    ],
    message: ["Example client reported failure"],
    path: ["/media/example/downloads/complete/example", "/media/example/library/example"],
    releaseGroup: ["ExampleGroup"],
    service: ["Example Client", "Example Indexer"],
    text: ["English", "The download client reported the transfer as failed", "Upgrade"],
    title: [
      "Example Anime S01E14 WEBDL-720p",
      "Example Series S01E01 Bluray-1080p",
      "Example Series S02E01 WEBDL-1080p",
      "Example Series S02E02 Bluray-1080p",
    ],
  },
  "sonarr/v3/4.0.19.2979/importlist.json": {
    path: ["/media/example/series"],
    service: ["Example Import List"],
    text: ["CANARY-SONARR-IMPORTLIST-APIKEY-0003", "example-source"],
  },
  "sonarr/v3/4.0.19.2979/importlistexclusion-paged.json": {
    title: ["Example Other Series", "Example Series"],
  },
  "sonarr/v3/4.0.19.2979/indexer.json": {
    service: ["Example Torrent Indexer", "Example Usenet Indexer"],
    text: [
      "CANARY-SONARR-INDEXER-APIKEY-0001",
      "example-api-path",
      "example-torrent-indexer",
      "example-usenet-indexer",
      "extended=1",
    ],
  },
  "sonarr/v3/4.0.19.2979/manualimport.json": {
    formatName: ["Example Format"],
    message: [
      "Episode file already imported at this quality",
      "Unable to parse episode from filename at /media/example/downloads/complete/example-series/Season 02",
    ],
    path: [
      "/media/example/downloads/complete/example-series/Example Series - S01E01 - Example Pilot Bluray-1080p.mkv",
      "/media/example/downloads/complete/example-series/Example Series - S01E02 - Example Existing Bluray-1080p.mkv",
      "/media/example/downloads/complete/example-series/Season 02/Example Series - S02E05 - Example Second WEBDL-720p.mkv",
      "Example Series - S01E01 - Example Pilot Bluray-1080p",
      "Example Series - S01E01 - Example Pilot Bluray-1080p.mkv",
      "Example Series - S01E02 - Example Existing Bluray-1080p",
      "Example Series - S01E02 - Example Existing Bluray-1080p.mkv",
      "Example Series - S02E05 - Example Second WEBDL-720p",
      "Season 02/Example Series - S02E05 - Example Second WEBDL-720p.mkv",
      "example-series",
    ],
    releaseGroup: ["ExampleGroup"],
    text: ["English"],
    title: ["Example Series"],
  },
  "sonarr/v3/4.0.19.2979/qualityprofile.json": {
    profileName: ["Example Anime HD", "Example Any", "Example HD"],
  },
  "sonarr/v3/4.0.19.2979/queue-details.json": {
    downloadId: [
      "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
      "b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1",
    ],
    message: [
      "Found matching series via grab history, but release was matched to series by ID",
      "One or more episodes expected in this release were not imported or missing",
    ],
    path: ["/media/example/downloads/complete", "/media/example/downloads/complete/example-series"],
    service: [
      "Example Client",
      "Example Indexer",
      "Example Usenet Client",
      "Example Usenet Indexer",
    ],
    text: ["English"],
    title: [
      "Example Anime S01E14 WEBDL-720p",
      "Example Series S01E01 Bluray-1080p",
      "Example Series S02E01 Bluray-1080p",
    ],
  },
  "sonarr/v3/4.0.19.2979/queue.json": {
    downloadId: [
      "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
      "b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1",
      "c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2",
    ],
    message: [
      "Found matching series via grab history, but release was matched to series by ID",
      "One or more episodes expected in this release were not imported or missing",
      "The download client reported an unrecoverable transfer error",
      "The download is not linked to any series in this instance",
    ],
    path: ["/media/example/downloads/complete", "/media/example/downloads/complete/example-series"],
    service: [
      "Example Client",
      "Example Indexer",
      "Example Usenet Client",
      "Example Usenet Indexer",
    ],
    text: ["English"],
    title: [
      "Example Anime S01E14 WEBDL-720p",
      "Example Series S01E01 Bluray-1080p",
      "Example Series S02E01 Bluray-1080p",
      "Unknown Example Download",
    ],
  },
  "sonarr/v3/4.0.19.2979/release.json": {
    formatName: ["Example Custom Format"],
    guid: ["example-indexer-a-1001", "example-indexer-a-3003", "example-indexer-b-2002"],
    message: [
      "Full season release is not wanted for a single episode",
      "Indexer request limit reached",
      "Quality HDTV-720p is not wanted in profile",
    ],
    releaseGroup: ["EXAMPLEGRP", "OTHERGRP"],
    service: ["Example Indexer A", "Example Indexer B"],
    text: ["English"],
    title: [
      "Example Series",
      "Example Series S01 COMPLETE 1080p WEB-DL x264-EXAMPLEGRP",
      "Example Series S01E01 1080p WEB-DL x264-EXAMPLEGRP",
      "Example Series S01E01 720p HDTV x264-OTHERGRP",
    ],
  },
  "sonarr/v3/4.0.19.2979/rename.json": {
    path: [
      "Season 01/Example Series - S01E01 - Example Pilot Bluray-1080p.mkv",
      "Season 01/Example Series - S01E01 - Example Pilot [Bluray-1080p]-EXAMPLEGRP.mkv",
      "Season 02/Example Series - S02E02 - Example Follow Up WEBDL-720p.mkv",
      "Season 02/Example Series - S02E02 - Example Follow Up [WEBDL-720p]-EXAMPLEGRP.mkv",
    ],
  },
  "sonarr/v3/4.0.19.2979/rootfolder.json": {
    path: ["/media/example/archive", "/media/example/series"],
  },
  "sonarr/v3/4.0.19.2979/series-lookup.json": {
    network: ["Example Network", "Example Streamer"],
    overview: [
      "A sanitized lookup overview recorded only to fix the payload shape",
      "A sanitized series overview recorded only to fix the payload shape",
    ],
    path: ["/media/example/series/Example Series"],
    sortTitle: ["example new series", "example series"],
    title: ["Example New Series", "Example Series"],
    titleSlug: ["example-new-series", "example-series"],
  },
  "sonarr/v3/4.0.19.2979/series.json": {
    network: ["Example Broadcaster", "Example Network"],
    overview: [
      "A sanitized anime overview recorded only to fix the payload shape",
      "A sanitized ended-series overview recorded only to fix the payload shape",
      "A sanitized series overview recorded only to fix the payload shape",
    ],
    path: [
      "/media/example/series",
      "/media/example/series/Example Anime",
      "/media/example/series/Example Retired Series",
      "/media/example/series/Example Series",
    ],
    releaseGroup: ["EXAMPLEGRP"],
    sortTitle: ["example anime", "example retired series", "example series"],
    title: ["Example Anime", "Example Retired Series", "Example Series"],
    titleSlug: ["example-anime", "example-retired-series", "example-series"],
  },
  "sonarr/v3/4.0.19.2979/tag.json": {
    tagLabel: ["example-archive", "example-review", "example-tag"],
  },
  "sonarr/v3/4.0.19.2979/wanted-cutoff.json": {
    "externalId:tvdbId": [900001],
    overview: ["A sanitized episode overview recorded only to fix the payload shape"],
    path: ["/media/example/series/Example Series"],
    sortTitle: ["example series"],
    title: ["Example Pilot", "Example Series"],
    titleSlug: ["example-series"],
  },
  "sonarr/v3/4.0.19.2979/wanted-missing.json": {
    "externalId:tvdbId": [900005, 900006],
    overview: [
      "A sanitized missing anime episode overview recorded only to fix the payload shape",
      "A sanitized missing episode overview recorded only to fix the payload shape",
    ],
    path: ["/media/example/series/Example Anime", "/media/example/series/Example Series"],
    sortTitle: ["example anime", "example series"],
    title: [
      "Example Absolute Missing Episode",
      "Example Anime",
      "Example Season Finale",
      "Example Series",
    ],
    titleSlug: ["example-anime", "example-series"],
  },
};
