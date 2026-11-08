# 0032: Media Toolset — Status, Fix, Search Again, and Remove

## Summary

Complete the `media` toolset with `media_status`, `media_fix`, `media_search_again`, and the opt-in `media_remove`. With these, a caller can see what is downloading and what is stuck, fix a stuck download in one call, ask for another search, and, where the operator allows it, remove a title, all without knowing any *arr concept. The [Media Toolset spec](../specs/media-toolset/) owns the behavior.

**Spec:** [Media Toolset](../specs/media-toolset/)
**Status:** complete
**Depends On:** 0031

## Motivation

After [0031](./0031-media-toolset-library.md), a `media` deployment can add a title but cannot find out what happened to it. Through the `arr` toolset, "why is this stuck and can you fix it" means:

1. Query the queue.
2. Pick out the queue reference.
3. Inspect the item's status messages.
4. Choose among eight queue intents with different flag semantics.
5. Plan, then apply.

For an import problem, it also means inspecting candidates and executing an import. The activity layer already holds every piece of this:

- normalized queue evidence with tracked state and status messages;
- the flag compiler for each queue transition;
- the candidate scan and import validation;
- the search commands.

Activity diagnosis is implemented in `src/adapters/activity/diagnosis.ts` but published by no tool. This change composes those pieces behind four tools.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules (see [Architecture — Testing Contract](../specs/architecture/#testing-contract)). CI enforces these as merge gates:

- Exported behavior MUST have automated tests at the narrowest practical level.
- Adapter behavior MUST be covered by sanitized, version-labelled fixtures that the application they name genuinely produces. A fixture this change needs MUST be captured with the repeatable capture procedure, never authored.
- MCP tools MUST have protocol-level stdio integration tests for schemas, results, errors, and stdout cleanliness, for each toolset.
- Mutations MUST have tests for retries, partial failure, and redaction.
- Committed tests MUST NOT be focused, skipped, or dependent on live personal *arr instances.
- Build, type check, lint, tests, and package verification MUST pass in CI.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

Additionally, because `media_fix` acts without a plan:

- Every row of the [download-state and remedy tables](../specs/media-toolset/#download-states) MUST have a test. The test runs the upstream evidence that defines the row through both `media_status` and `media_fix`, and asserts that the state and remedy the first reports are the ones the second applies.
- A test MUST prove that `media_fix` sends no upstream mutation for a title with nothing stuck, for a download in any non-`stuck` state, and for a download of another title in the same queue page.
- A test MUST prove that a download whose state changes between `media_status` and `media_fix` is judged from the fix-time reading.
- A test MUST prove that a `replace` remedy sends the queue removal with removal from the client and blocklisting enabled and replacement search allowed. It MUST also show that no request deletes or replaces a library file.
- A test MUST prove the `import` remedy is refused when the library's record for a mapped movie or episode reports a file, or cannot say, even though the scan reports every candidate importable and no existing file.
- A test MUST prove that two `media_fix` calls for the same stuck download, sequential and concurrent, send one replacement between them, and submit one import between them while its command is unfinished.
- A test MUST prove that `media_fix` on a title with more than ten stuck downloads acts on ten and reports the remainder count.
- A test MUST prove that a season pack listed as several queue rows sharing one download identity is reported once by `media_status`, and is replaced or imported once by `media_fix`, both within one call and across concurrent calls.
- A test MUST prove that a row with no download identity is never given the `import` remedy.
- A test MUST prove that a concurrent duplicate `media_remove` reports `not_in_library`.
- A test MUST prove `media_search_again` sends only ids with no file, and sends nothing for a title whose scope has nothing missing.
- A test MUST prove that `media_status` counts as lacking, and a movie, series, or season search covers, only monitored media, and that one named episode is searched monitored or not.

### Functional requirements

[Media Toolset](../specs/media-toolset/) owns these sections, whose scenarios are this change's acceptance criteria and are not restated here:

- [Status](../specs/media-toolset/#status)
- [Fix](../specs/media-toolset/#fix)
- [Search Again](../specs/media-toolset/#search-again)
- [Remove](../specs/media-toolset/#remove)
- [Download States](../specs/media-toolset/#download-states)
- [Published Tools](../specs/media-toolset/#published-tools), for these four tools
- [Deployment Defaults](../specs/media-toolset/#deployment-defaults), for `ARR_MCP_MEDIA_ALLOW_REMOVE`

What implementing them requires of this change:

- **One classifier.** The download state and remedy MUST be computed by one function that both `media_status` and `media_fix` call, so the remedy status predicts and the remedy fix applies cannot diverge.
- **Shared flag compiler.** A `replace` remedy MUST be compiled by the same queue-transition compiler the `arr` toolset uses, so its flags and version gates have one definition.
- **Listing ceiling.** The `media` listing ceiling recorded by [0031](./0031-media-toolset-library.md) MUST be re-measured with all six tools published and MUST remain at or under the spec's bound.

## Design

### Approach

- **Title to library record.**
  - Resolve a kind and id to the library record with the upstream library read filtered by external id, where the instance supports that filter at the recorded minimum version. Otherwise read the library and match the id.
  - Which one holds is established by capturing both routes from live instances, not assumed.
  - A miss means "not in the library". `media_status` reports it that way and `media_search_again` refuses it with `conflict`.
- **Classifier.**
  - Add `classifyDownload(item: QueueItem): { state, reason?, remedy? }` in `src/tools/media/`, implementing the spec's two tables from `QueueEvidence`.
  - The `import` remedy needs a scan, so the classifier answers "import, if the scan and the library confirm". `media_status` and `media_fix` both run `scanTrackedDownload` and `validateForImport` before reporting or applying it. Neither ever reports `import` on the classifier's word alone.
  - File absence comes from the library, not the scan. For every movie or episode the candidates map to, read the library's own record and require that it reports no file. The scan's `existingLibraryFile` is not consulted: it is derived from `episodeFileId`/`movieFileId` on manual-import rows, which neither supported version sends (the open backlog entry in `docs/tasks.md`). A record that cannot be read, or that does not say whether it has a file, makes the remedy `none`.
- **Download resolution.** Read queue rows at a detail level that carries the release's quality, and report its resolution where the quality names one.
- **`media_status`.**
  - Overview:
    - One bounded queue page per configured kind through `readQueue`, sorted as today.
    - The queue status totals, for the cut-off counts.
    - History since seven days ago, filtered to imports.
    - The calendar for the next fourteen days.
  - Title:
    - Every queue row scoped to the library record's id, read through a new adapter function, `readQueueForMedia(client, mediaId, profile, detail)`, in `src/adapters/activity/media.ts`. It issues the same `queue/details` request `readQueueDetails` does but maps every returned row, where `readQueueDetails` keeps only the one matching a queue item id. Bound it by the same scan bound the activity layer applies elsewhere.
    - The record's own monitored state, file statistics, and profile, whose resolution is derived by the same function [0031](./0031-media-toolset-library.md) uses for `media_add`.
    - The distinct resolutions of its files, from the quality each movie or episode file record carries.
    - The next calendar entry.
- **Grouping by download.** Both `media_status` and `media_fix` group queue rows by the queue item's download identity (`QueueOrigin.downloadIdentity`, read at whatever detail level carries it), so a season pack listed once per episode is one download.
  - A row with no identity is its own group.
  - The classifier never gives such a group the `import` remedy, because its sibling rows cannot be ruled out.
- **`media_fix`.** Read the title's queue rows through `readQueueForMedia`, group them, and take at most the first ten stuck downloads in queue order; count the rest as left for a later call.
  - **Claim first.** For each download, claim it in a process-local in-flight map keyed by application and download identity, or by queue item id for an unidentified row, before reading it. Claiming is a synchronous check-and-set, so two overlapping calls cannot both hold it. A call that finds an item already claimed reports it `none`, already being fixed, and moves on.
  - **Then read and classify.** Re-read the title's rows through `readQueueForMedia` once the claim is held, and classify the download from the rows that carry its identity:
    - `replace`: compile `blocklist_and_remove` with replacement search allowed, send it, and release the claim once the request returns.
    - `import`: scan, validate, confirm file absence from the library, then submit the manual import with import mode `auto`. Once the import is accepted, attach the returned command to the claim and keep it. The classifier reports that download `importing` until a refresh of the command through `readCommandRecord` reaches a terminal state or reports the command gone, and only then is the claim released.
    - `none`: report the reason and release the claim.
  - If any upstream request fails, release the claim and report the failure as that item's outcome.
  
  Items are handled one at a time, each with its own outcome, as queue resolution already does.
- **Concurrent removals.** A `media_remove` whose delete finds no record reports `not_in_library`.
- **`media_search_again`.** Never issue a whole-title command, because `SeriesSearch` and `SeasonSearch` also search episodes that already have files and can grab upgrades.
  - For a movie, read the movie record. If it is monitored, has no file, and is released, send `MoviesSearch` for that one movie; otherwise send nothing.
  - For a series, read its episodes within the scope (all, one season, or one episode). For the whole series or a season, keep the released, monitored episodes of a monitored series with no file; for one named episode, keep it when it is released and has no file, monitored or not. Send one `EpisodeSearch` for exactly those ids. If none qualify, send nothing.
  
  The search goes through `startSearchCommand`, and the job projection is discarded rather than returned. The result's count is the number of ids searched for.
- **`media_remove`.** Delete the library record through the existing deletion helpers, with `deleteFiles` from the input and the import-exclusion flag always `false`. Register the tool only when `ARR_MCP_MEDIA_ALLOW_REMOVE` is `true`. Parse that variable alongside the other `media` defaults.

- **Identifying content in captured fixtures.** The queue rows this change captures embed the series and episode records. A capture therefore carries the library's titles, overviews, artwork, and metadata ids, and the operator's indexer and download-client names, none of which the screens refuse. `scripts/identifying-content.mjs` recognizes structure positively, and everything else is identifying. Every string in a recorded body, wherever it sits, is identifying unless one of its 42 structural rules (covering 46 keys) lists its exact value. No rule is a pattern; each holds a closed set taken from one of these sources:
  - the applications' API enumerations, listed per field: states, events, types, health checks, commands with their display names, and the sort keys this server sends;
  - their provider schemas, read from the `schema` routes of Sonarr 4.0.20.3014, Radarr 6.4.4.10685, and Prowlarr 2.7.0.5723 and generated into `scripts/structural-vocabulary.mjs` (100 implementations, each with the display names and settings contracts it is published under, and the descriptor text those schemas use);
  - their built-in quality names and sources;
  - their shipped language list, which a test holds to the `language` routes recorded at those versions;
  - the media-information formatters' codec names.

  An indexer schema's per-tracker implementations, and the settings only such an indexer describes, are left out because naming one says which tracker an operator uses; only Newznab, Torznab, and Cardigann are listed. Only a value's form decides for numbers (a version's dotted numbers and a media file's dimensions included), flags, whole dates and date-times, durations, the empty string, and the masked secret. A named field is never taken for proof that its value was neutralized. A fact field covers only the type it expects: a number for a year, runtime, popularity, or byte count (a number written as text included), a time for an air time, and a list of plain items for a list field. A string anywhere else under it is judged as text. Every rule states where a value it judges sits, and a table-driven test puts title-like values at every rule and every named field and requires the screen to refuse each and the capture to replace each. Named identifying fields take the specific stand-ins below. Any other text becomes `Example text N`, or a stand-in path if it is one. Numbers are structural unless named, because ids, counts, flags, and scores are what the code reads. Fields are named by key and, where one key means different things, by the object the field is in and the key that object sits under. The capture replaces every classified value, whatever it held, with the same stand-in for every recurrence within one capture, and keeps each field's type and presence. The contract screen refuses any value in those fields that is not in the exact form the capture writes.
  - **Titles and text:** titles in every form (`title`, `originalTitle`, `seriesTitle`, `movieTitle`, `sourceTitle`, `sceneName`, `movieTitles`) become `Example Title N`. The sort, clean, and slug forms become `example title N`, `exampletitleN`, and `example-title-N`. An overview becomes one fixed sanitized sentence. Network, studio, and certification become `Example Network N`, `Example Studio N`, and `Example Certification N`. Genres become `Example Genre N`.
  - **Services and configuration:** every name an operator gives a service becomes `Example Service N`, one sequence across `indexer`, `indexerName`, `downloadClient`, `downloadClientName`, and a provider's or Prowlarr indexer's `name`, so a queue row and the indexer list still name one indexer alike. The product a provider is, its `implementation`, is structural and stays. Quality and app profile names become `Example Profile N`, and a quality group's label inside a profile `Example Group N`; the profiles and groups the applications create on install keep their names. A profile's selected language is neutralized like a title's, as `Example Language N`: one rule is simpler than telling a configured choice from a described fact, and no code reads it. The applications' own language list stays. Custom-format and condition names become `Example Format N`. Tag and disk labels become `example-tag-N` and `Example Disk N`. A Prowlarr definition and its indexer addresses become `example-definition-N` and `example-indexer-url-N`.
  - **Downloads and releases:** a download id and a torrent info hash share one sequence, `example-download-N`, matched whatever their case. A release guid becomes `example-guid-N`, a release group `EXAMPLEGRPN`, and a history search query `example query N`.
  - **Paths:** every path and file name (`path`, `relativePath`, `existingPath`, `newPath`, `outputPath`, `droppedPath`, `importedPath`, `rootFolderPath`, `originalFilePath`, `folderName`, and an import candidate's `name`) is replaced segment by segment with `example-N`. It keeps its depth, whether it is absolute (under `/media/example`), and its last segment's media extension, so a file still sits in the folder it sat in.
  - **Application messages:** `message`, `errorMessage`, status `messages`, and rejection reasons become `Example message N`, because they interpolate titles, indexer names, and paths. The code reads states, never message text.
  - **Ids, artwork, and media details:** a metadata id comes from a reserved block per source (TVDB 100001+, TMDB 200001+, TVmaze 400001+, TVRage 500001+, IMDb `tt000…`), and a trailer id becomes `example-trailer-N`. Artwork (`images[].url`/`remoteUrl`, `remotePoster`) becomes `/media/example/artwork-N`. A media file's `runTime` becomes `30:00`, its audio and subtitle languages `und`, and a rating's numbers and a popularity zero.
  - **Facts and dates:** the facts that place a title are replaced as well. A year moves with the dates, runtime becomes 30 and air time 20:00, and a language becomes `Example Language N`. Every byte count (`size`, `sizeleft`, `sizeOnDisk`, `freeSpace`, `totalSpace`) is scaled by one factor per capture, between 1.001 and 1.999, so a download's progress reads the same. Every date in the body, date-only or date and time, moves by one offset of whole days per capture, so time of day, zone, order, spacing, and released-before-now all survive. Technical media details are structural: codecs, bitrates, frame rates, bit depth, and channel and stream counts stay.
  - **The screen:** it accepts only the exact stand-in forms, a field's unset values (`null`, `""`, `0`), the source genres, the rating-board certifications, the install-time profile names, a quality definition titled by its quality's own name, and, for a recorded minimum-version fixture, the legacy values listed against that one file in `scripts/legacy-stand-ins.mjs`. Those are hand-chosen `Example …` values and the redaction tests' canaries, listed per file, each checked when listed, from the fixtures written before the capture neutralized anything. A capture is held to the exact forms alone. No value passes by resembling a stand-in.
  - **Facts the screen cannot tell apart:** rating numbers, popularity, scaled counts, and dates cannot be told apart from real ones anywhere a capture did not write them. So a fixture recorded at a newer version must have every date and year in 2100 or later, every language an example, and every rating and popularity zero. The minimum's fixtures were recorded before dates moved, and their tests are written against the dates they hold, so they are not held to that rule.

### Decisions

- **Decision:** Replace a captured download id with an ordinal, not a digest of the real value.
  - **Why:** The code needs only that the rows of one download share one value. A digest anyone can compute lets anyone confirm a guessed download, such as a torrent's info hash, against the fixture.
  - **Alternatives considered:** A digest of the real id. Rejected for that confirmation risk.
- **Decision:** Recognize structure only by exact values from closed sets, never by a pattern.
  - **Why:** Every rule that accepted a shape admitted a title of that shape: an identifier, a capitalized word, a word ending in `Settings` or `Check`. Closed sets taken from the applications' own enumerations, schemas, and definitions admit nothing else. The table-driven probe test fails for any rule added later that recognizes a shape.
  - **Alternatives considered:** Tightening each pattern. Rejected: a pattern narrow enough to exclude every title is a closed set written badly.
- **Decision:** Recognize structure positively and treat every other string as identifying.
  - **Why:** Each pass that named identifying fields one at a time missed a sibling: a group label, a failure reason, a profile's language. Naming what is structural instead makes an unclassified or newly added field fail closed. It is neutralized at capture and refused by the screen until a rule says why it is safe.
  - **Alternatives considered:** Adding identifying fields as they are found. Rejected because it fails open on every field nobody has looked at.
- **Decision:** Screen identifying fields for the exact stand-in forms, with each minimum fixture's legacy values listed against its own file, rather than for text that mentions an example.
  - **Why:** "Contains example" admits a real title that happens to contain the word, and a value copied into another fixture because it looks like one. An exact form admits only what the capture wrote. A per-file list admits only what one hand-written fixture already held.
  - **Alternatives considered:** Rewriting the minimum's fixtures into the exact forms. Rejected: those fixtures are the evidence for the minimum, and their tests assert their values.
- **Decision:** Name every service with one stand-in sequence, not one per field.
  - **Why:** A queue row's `indexer`, a history event's `indexer`, and the indexer list's `name` name the same indexer. Separate sequences would make them disagree, and code that matches one to the other would read a different library.
  - **Alternatives considered:** A sequence per field (`Example Indexer N`, `Example Download Client N`). Rejected for that reason.
- **Decision:** Move a capture's dates by a random offset that is recorded nowhere, rather than by a fixed one.
  - **Why:** A fixed offset is published with the tool, and anyone could subtract it to recover the real calendar. A random offset of about two centuries plus up to ten years places every date clearly in the future. One offset per capture keeps order and spacing, and whole days keep a date and its date-only form agreeing.
  - **Alternatives considered:** A fixed offset, rejected as reversible. A random offset per field, rejected because it would break the relationships the code reads, such as aired before now, or a download added before it completes.

- **Decision:** Treat a client warning on an active download as stuck, with remedy `replace`.
  - **Why:** In practice, an active download carrying a client warning is the stalled case: no seeders or no connections. That is what a person asking "why is this stuck" means, and replacing it is what they would do through the `arr` toolset. The spec records the grace-period question as open rather than guessing a threshold.
  - **Alternatives considered:** Reporting warnings as `downloading`. Rejected: it hides the most common stuck download. A fixed grace period was also rejected, as unmotivated by any measurement yet.
- **Decision:** Leave the replacement search to the application's own redownload rather than starting a search.
  - **Why:** Blocklisting with replacement search allowed is the application's built-in "try another release" path. A separate search command would race it and could grab twice.
  - **Alternatives considered:** Suppressing redownload and starting an explicit search. Rejected for the double-grab risk.
- **Decision:** Do not give `media` mutations apply records.
  - **Why:** Apply records exist so a retried `arr` apply reference cannot resend a non-idempotent mutation. A `media` call has no reference to retry. Its retry is a new call, and that call re-reads state: a replaced download has left the queue. A re-read alone cannot guard overlapping calls, or an import still queued upstream; the per-download claim above guards both with one small process-local map.
  - **Alternatives considered:** Recording an apply record per `media` call, keyed by title. Rejected: it would hold a record per call for every remedy, where the per-download claim already covers both remedies and is held only as long as each needs it.
- **Decision:** Publish `media_remove` only when enabled, rather than publishing it and refusing it.
  - **Why:** [Tool Contracts](../specs/tool-contracts/#stable-typed-surface) bars advertising an intent the server refuses unconditionally. A tool that is never callable in a deployment does not belong in that deployment's listing.
  - **Alternatives considered:** A `confirm` input. Rejected: a model passes `true` as readily as a person clicks through, so it adds footprint without adding safety.

### Non-Goals

- Choosing a release, manual import with corrections, history or blocklist edits, and upgrade searches.
- A grace period before a warning counts as stuck.
- Making `media` the default, which belongs to [0033](./0033-media-default-toolset.md).

## Tasks

- [x] Report status
  - [x] Implement title resolution from kind and id. The shipped route is the library list match: `readLibraryTitleByExternalId` in `src/adapters/library/titles.ts` reads the whole `series` or `movie` list, which the recorded fixtures cover, and matches the TVDB or TMDB id locally with a raw schema that keeps an absent file flag absent. Every `media` tool resolves records through this one list read. Which of the filtered routes holds has not been recorded, because the live instances were unreachable from the implementing environment; capture C3 below decides whether the filtered route is ever adopted.
  - [x] Add `readQueueForMedia` to `src/adapters/activity/media.ts`, returning every title-scoped queue row, with fixture-backed tests for both applications over the recorded `queue/details`, and inline tests for a season pack listed once per episode and a row with no download identity.
  - [x] Implement `classifyDownload` with a test per table row.
  - [x] Implement `media_status` for the overview and for a title, with bounded lists and cut-off totals. The overview's imports come from the paged `history` read, newest first, paged until a record is older than seven days or the history ends, and bounded at five pages of 100; its downloads come from the whole queue, read page by page up to the activity layer's scan bound and grouped by download, rather than from the queue status totals the Design names, which count rows, so `downloads_total` counts downloads; series file resolutions come from `episodefile?seriesId=`, and a movie's from the file its library record carries.
  - [x] C1: capture Sonarr `queue/details?seriesId=` for a series with a season pack in the queue, at least two rows sharing one `downloadId`, and register it. Captured at Sonarr 4.0.20.3014 as `sonarr/v3/4.0.20.3014/queue-details.json`: one series' six episode rows of one finished download whose import is blocked. `readQueueForMedia` maps all six, `groupDownloads` makes them one download, and `classifyDownload` reports it stuck with the provisional remedy `import`, as the live sweep saw it. The existing `queue/details` tests run unchanged against the minimum's fixtures.
  - [x] C2: capture Sonarr and Radarr `queue` pages and register them. Captured at the newer versions from whatever the live queues held, with no state induced: `sonarr/v3/4.0.20.3014/queue.json` holds the same six blocked-import rows, and `radarr/v3/6.4.4.10685/queue.json` is an empty page. They back the blocked-import rows of the download-state table and the empty queue. No live queue held a failed, failed-pending, stalled, client-unavailable, queued, paused, or importing download. Those rows' state values are tool-layer classification over the same field shape, and they stay unit-tested against inline rows. The shape is now covered by genuine fixtures at the newer versions, so C2 is closed on that basis.
  - [x] C3: capture `series?tvdbId=` and `movie?tmdbId=` from both applications as evidence of whether each filter is honoured, and record here which held. Closed without a capture: the capture tool names a fixture by its route alone, so a request differing only by a query parameter cannot be recorded as its own route without changing the tool's contract. The shipped code reads the whole list and matches the id locally, which is correct whether or not an instance honours the filter. A read-only probe that recorded nothing found both filters honoured at Sonarr 4.0.20.3014 and Radarr 6.4.4.10685; nothing is known at the minimums. Adopting the filtered route is a follow-up that needs that capture.
  - [x] Report a movie due on a later release date: the overview asks the calendar view for its window's dates, takes the earliest of a movie's release dates between now and the window's end, and the library service refuses a calendar window that is not two real dates in order.
  - [x] Count as missing, and search a movie, series, or season for, only monitored, released media; one named episode is searched monitored or not.
  - [x] Neutralize what identifies a library or its services in every captured fixture, and the facts and dates that place a title, and refuse a fixture that carries them.
- [x] Fix stuck downloads
  - [x] Implement `media_fix` with per-item re-read, the `replace` remedy through the existing compiler, the `import` remedy with library file-absence confirmation, the per-download in-flight claim covering both remedies, the ten-item bound with a remainder count, and per-item outcomes. The claims live in the workflow state, so the stdio session and every HTTP request share them.
  - [x] Add the agreement, non-action, state-change, and flag tests from the Testing Requirements above.
- [x] Search again and remove
  - [x] Implement `media_search_again` with missing-only selection, sending `MoviesSearch` or `EpisodeSearch` for exactly the missing released ids, sending nothing when none qualify, and refusing a title not in the library with `conflict`.
  - [x] Parse `ARR_MCP_MEDIA_ALLOW_REMOVE` and implement `media_remove`, registered only when enabled.
  - [x] Extend `test/media-stdio.test.ts` to list all six tools with removal enabled and five without, and re-measure the recorded listing ceiling: 11,866 bytes with all six tools published, re-measured after the monitored-only search wording, recorded at a ceiling of 11,900. Fitting it under the specification's 12,000 bytes took publishing every `media` tool's output schema from plain leaves — validation keeps every bound, and every input still publishes the kinds — dropping the annotation title that repeated each tool's own, and shortening the descriptions. `media_status` publishes its two input forms and `media_search_again` its three, so the rules that a kind and an id come together, that only a series has seasons, and that an episode is named within its season are described from the unions that validate.
  - [x] Add the new variable to the environment filters and every new `dist/**` file to the packed-file inventory.
  - [x] Document the four tools and `ARR_MCP_MEDIA_ALLOW_REMOVE` in the README's "Media tools" section, and update the spec's status note.

An import whose request was sent and whose answer was lost — no answer, or one that could not be read — keeps its download's claim with no command to follow. The download is reported `importing`, and no second import is started, until a later `media_status` or `media_fix` finds evidence. The claim is released when the download has left the queue, when the library has a file for everything the import was for, or when the instance lists no unfinished import at least two minutes after the attempt. It is released anyway thirty minutes after the attempt, so a lost answer cannot hold a place in the bounded claim map for the life of the process. A replacement whose answer was lost — no answer, an instance-side failure, or one that could not be read — is held the same way: the download is reported stuck with remedy `none`, already being fixed, and no second replacement is sent, until a complete read of the title's queue no longer lists it or the same thirty minutes pass. Only a refusal that proves nothing was done releases either claim at once. `media_remove` needs no hold: it settles a lost answer within the call by reading the library again, and repeating a removal is idempotent, since a record already gone answers `not_in_library`.

Accepted: every `media` call that names a title reads the whole library list, the only title route a recorded fixture covers, until a capture of the filtered route at the minimums shows it can replace it; and the overview reads at most five history pages of 100 records, so in a week with more history than that the imported list may be incomplete, which the result says in a warning.

## Open Questions

The spec carries two behavioral questions: upgrades, and the stalled-download threshold.

Resolved:

- **A file appearing between the last check and the import.** Decision: keep the `import` remedy; the spec's [Fix](../specs/media-toolset/#fix) requirements now accept the one residual it cannot close. In the seconds between `media_fix`'s final read of the library's records and the instance running the import, a file can still appear for an approved movie or episode, from the instance's own automatic import of another download, and the instance's manual import has no option that refuses to replace an existing file.
  - **Why:** the race needs a second download of the same movie or episode to be imported automatically inside that window, and the instance treats the result as an upgrade. Withdrawing the remedy would remove the fix for the most common stuck state, a completed download whose import is blocked.
  - **Mitigations, which stay:** `media_fix` claims every movie or episode an import is for, so two fixes never import into the same one at once; it refuses while another download for one of them is being imported; and it reads the library's records once more after every file is recovered, immediately before the import is sent.

## References

- Spec: [Media Toolset](../specs/media-toolset/)
- Spec: [Activity Management](../specs/activity-management/)
- Spec: [Acquisition and Import](../specs/acquisition-and-import/)
- Related changes: [0031-media-toolset-library](./0031-media-toolset-library.md), [0033-media-default-toolset](./0033-media-default-toolset.md)
