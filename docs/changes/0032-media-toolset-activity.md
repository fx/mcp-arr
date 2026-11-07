# 0032: Media Toolset — Status, Fix, Search Again, and Remove

## Summary

Complete the `media` toolset with `media_status`, `media_fix`, `media_search_again`, and the opt-in `media_remove`. With these, a caller can see what is downloading and what is stuck, fix a stuck download in one call, ask for another search, and, where the operator allows it, remove a title, all without knowing any *arr concept. The [Media Toolset spec](../specs/media-toolset/) owns the behavior.

**Spec:** [Media Toolset](../specs/media-toolset/)
**Status:** draft
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
  - The `import` remedy needs a scan, so the classifier answers "import, if the scan confirms". `media_status` and `media_fix` both run `scanTrackedDownload` and `validateForImport` before reporting or applying it. Neither ever reports `import` on the classifier's word alone.
- **`media_status`.**
  - Overview:
    - One bounded queue page per configured kind through `readQueue`, sorted as today.
    - The queue status totals, for the cut-off counts.
    - History since seven days ago, filtered to imports.
    - The calendar for the next fourteen days.
  - Title:
    - `readQueueDetails` scoped to the library record's id.
    - The record's own monitored state and file statistics.
    - The next calendar entry.
- **`media_fix`.** Read the title's queue details. For each item, take a fresh focused read and classify it:
  - `replace`: compile `blocklist_and_remove` with replacement search allowed, and send it.
  - `import`: scan, validate, and submit the manual import with import mode `auto`.
  - `none`: report the reason.
  
  Items are handled one at a time, each with its own outcome, as queue resolution already does.
- **`media_search_again`.** Map the scope to the existing search commands:
  - a movie to `MoviesSearch`;
  - a series to `SeriesSearch`;
  - a season to `SeasonSearch`;
  - an episode to `EpisodeSearch`, after reading the episode id from the series' episodes.
  
  Each goes through `startSearchCommand`, and the job projection is discarded rather than returned.
- **`media_remove`.** Delete the library record through the existing deletion helpers, with `deleteFiles` from the input and the import-exclusion flag always `false`. Register the tool only when `ARR_MCP_MEDIA_ALLOW_REMOVE` is `true`. Parse that variable alongside the other `media` defaults.

### Decisions

- **Decision:** Treat a client warning on an active download as stuck, with remedy `replace`.
  - **Why:** In practice, an active download carrying a client warning is the stalled case: no seeders or no connections. That is what a person asking "why is this stuck" means, and replacing it is what they would do through the `arr` toolset. The spec records the grace-period question as open rather than guessing a threshold.
  - **Alternatives considered:** Reporting warnings as `downloading`. Rejected: it hides the most common stuck download. A fixed grace period was also rejected, as unmotivated by any measurement yet.
- **Decision:** Leave the replacement search to the application's own redownload rather than starting a search.
  - **Why:** Blocklisting with replacement search allowed is the application's built-in "try another release" path. A separate search command would race it and could grab twice.
  - **Alternatives considered:** Suppressing redownload and starting an explicit search. Rejected for the double-grab risk.
- **Decision:** Do not give `media` mutations apply records.
  - **Why:** Apply records exist so a retried `arr` apply reference cannot resend a non-idempotent mutation. A `media` call has no reference to retry. Its retry is a new call, and that call re-reads state: a replaced download has left the queue, and an imported one is no longer stuck. The safety comes from the re-read, which the spec requires.
  - **Alternatives considered:** Recording an apply record per `media` call, keyed by title. Rejected: it adds process state that a restart loses anyway, and it guards nothing the re-read does not already guard.
- **Decision:** Publish `media_remove` only when enabled, rather than publishing it and refusing it.
  - **Why:** [Tool Contracts](../specs/tool-contracts/#stable-typed-surface) bars advertising an intent the server refuses unconditionally. A tool that is never callable in a deployment does not belong in that deployment's listing.
  - **Alternatives considered:** A `confirm` input. Rejected: a model passes `true` as readily as a person clicks through, so it adds footprint without adding safety.

### Non-Goals

- Choosing a release, manual import with corrections, history or blocklist edits, and upgrade searches.
- A grace period before a warning counts as stuck.
- Making `media` the default, which belongs to [0033](./0033-media-default-toolset.md).

## Tasks

- [ ] Report status
  - [ ] Implement title resolution from kind and id, capturing the external-id library read for both applications. Fall back to library matching where the filter is not honored, and record which held in this document.
  - [ ] Implement `classifyDownload` with a test per table row.
  - [ ] Implement `media_status` for the overview and for a title, with bounded lists and cut-off totals.
  - [ ] Capture any fixture the overview needs that the inventory lacks, such as a queue page holding stalled and import-blocked items or an import history window, and register it.
- [ ] Fix stuck downloads
  - [ ] Implement `media_fix` with per-item re-read, the `replace` and `import` remedies through the existing compiler and import path, and per-item outcomes.
  - [ ] Add the agreement, non-action, state-change, and flag tests from the Testing Requirements above.
- [ ] Search again and remove
  - [ ] Implement `media_search_again` over the existing search commands, with `conflict` for a title not in the library.
  - [ ] Parse `ARR_MCP_MEDIA_ALLOW_REMOVE` and implement `media_remove`, registered only when enabled.
  - [ ] Extend `test/media-stdio.test.ts` to list all six tools with removal enabled and five without, and re-measure the recorded listing ceiling.
  - [ ] Add the new variable to the environment filters and every new `dist/**` file to the packed-file inventory.
  - [ ] Document the four tools and `ARR_MCP_MEDIA_ALLOW_REMOVE` in the README's "Media tools" section, and update the spec's status note.

## Open Questions

None. The spec carries the two behavioral questions: upgrades, and the stalled-download threshold.

## References

- Spec: [Media Toolset](../specs/media-toolset/)
- Spec: [Activity Management](../specs/activity-management/)
- Spec: [Acquisition and Import](../specs/acquisition-and-import/)
- Related changes: [0031-media-toolset-library](./0031-media-toolset-library.md), [0033-media-default-toolset](./0033-media-default-toolset.md)
