# 0032: Media Toolset — Status, Fix, Search Again, and Remove

## Summary

Complete the `media` toolset with `media_status`, `media_fix`, `media_search_again`, and the opt-in `media_remove`. With these, a caller can see what is downloading and what is stuck, fix a stuck download in one call, ask for another search, and, where the operator allows it, remove a title, all without knowing any *arr concept. The [Media Toolset spec](../specs/media-toolset/) owns the behavior.

**Spec:** [Media Toolset](../specs/media-toolset/)
**Status:** in-progress
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
  - For a movie, read the movie record. If it has no file and is released, send `MoviesSearch` for that one movie; otherwise send nothing.
  - For a series, read its episodes within the scope (all, one season, or one episode). Keep the released episodes with no file, and send one `EpisodeSearch` for exactly those ids. If none qualify, send nothing.
  
  The search goes through `startSearchCommand`, and the job projection is discarded rather than returned. The result's count is the number of ids searched for.
- **`media_remove`.** Delete the library record through the existing deletion helpers, with `deleteFiles` from the input and the import-exclusion flag always `false`. Register the tool only when `ARR_MCP_MEDIA_ALLOW_REMOVE` is `true`. Parse that variable alongside the other `media` defaults.

### Decisions

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

- [ ] Report status
  - [x] Implement title resolution from kind and id. The shipped route is the library list match: `readLibraryTitleByExternalId` in `src/adapters/library/titles.ts` reads the whole `series` or `movie` list, which the recorded fixtures cover, and matches the TVDB or TMDB id locally with a raw schema that keeps an absent file flag absent. Every `media` tool resolves records through this one list read. Which of the filtered routes holds has not been recorded, because the live instances were unreachable from the implementing environment; capture C3 below decides whether the filtered route is ever adopted.
  - [x] Add `readQueueForMedia` to `src/adapters/activity/media.ts`, returning every title-scoped queue row, with fixture-backed tests for both applications over the recorded `queue/details`, and inline tests for a season pack listed once per episode and a row with no download identity.
  - [x] Implement `classifyDownload` with a test per table row.
  - [x] Implement `media_status` for the overview and for a title, with bounded lists and cut-off totals. The overview's imports come from the paged `history` read, newest first, paged until a record is older than seven days or the history ends, and bounded at five pages of 100; series file resolutions come from `episodefile?seriesId=`, and a movie's from the file its library record carries.
  - [ ] C1: capture Sonarr `queue/details?seriesId=` for a series with a season pack in the queue, at least two rows sharing one `downloadId`, and register it. Waits on reachable live instances. Until then the season pack is covered by inline rows built over the recorded `queue/details` row. This recaptures a route that already has one fixture, so the existing queue tests must be re-run against the new body.
  - [ ] C2: capture Sonarr and Radarr `queue` pages holding the stuck states the inventory lacks — `failed` or `failedPending`, a client warning while downloading, and where possible `downloadClientUnavailable`, `queued` or `paused`, and `importing` — and register them. Waits on reachable live instances. Until then those rows are built inline from the recorded rows' field shapes, and an unrecognized word falls back to `unknown`, which classifies as `stuck` with remedy `none`. This recaptures a route that already has one fixture, so the existing queue tests must be re-run against the new bodies.
  - [ ] C3: capture `series?tvdbId=` and `movie?tmdbId=` from both applications as evidence of whether each filter is honoured, and record here which held. Waits on reachable live instances. The shipped code does not read these routes.
- [x] Fix stuck downloads
  - [x] Implement `media_fix` with per-item re-read, the `replace` remedy through the existing compiler, the `import` remedy with library file-absence confirmation, the per-download in-flight claim covering both remedies, the ten-item bound with a remainder count, and per-item outcomes. The claims live in the workflow state, so the stdio session and every HTTP request share them.
  - [x] Add the agreement, non-action, state-change, and flag tests from the Testing Requirements above.
- [x] Search again and remove
  - [x] Implement `media_search_again` with missing-only selection, sending `MoviesSearch` or `EpisodeSearch` for exactly the missing released ids, sending nothing when none qualify, and refusing a title not in the library with `conflict`.
  - [x] Parse `ARR_MCP_MEDIA_ALLOW_REMOVE` and implement `media_remove`, registered only when enabled.
  - [x] Extend `test/media-stdio.test.ts` to list all six tools with removal enabled and five without, and re-measure the recorded listing ceiling: 11,671 bytes with all six tools published, recorded at a ceiling of 11,800. Fitting it under the specification's 12,000 bytes took publishing every `media` tool's output schema from plain leaves — validation keeps every bound, and every input still publishes the kinds — and dropping the annotation title that repeated each tool's own. `media_search_again` publishes its three input forms, so the rules that only a series has seasons and that an episode is named within its season are described from the union that validates.
  - [x] Add the new variable to the environment filters and every new `dist/**` file to the packed-file inventory.
  - [x] Document the four tools and `ARR_MCP_MEDIA_ALLOW_REMOVE` in the README's "Media tools" section, and update the spec's status note.

Accepted while the captures wait: every `media` call that names a title reads the whole library list, the only title route a recorded fixture covers, to be revisited once C3 says whether the filtered route can replace it; and the overview reads at most five history pages of 100 records, so in a week with more history than that the imported list may be incomplete, which the result says in a warning.

## Open Questions

None. The spec carries the two behavioral questions: upgrades, and the stalled-download threshold.

## References

- Spec: [Media Toolset](../specs/media-toolset/)
- Spec: [Activity Management](../specs/activity-management/)
- Spec: [Acquisition and Import](../specs/acquisition-and-import/)
- Related changes: [0031-media-toolset-library](./0031-media-toolset-library.md), [0033-media-default-toolset](./0033-media-default-toolset.md)
