# Media Toolset

## Overview

This specification defines the `media` toolset: the smallest set of tools that manages a media library across the supported applications, talking about movies, TV series, and downloads rather than about Sonarr, Radarr, and Prowlarr. Inputs and results carry only what a caller needs for its next step. A caller finds a title, adds it, asks how it is going, and asks for a stuck download to be fixed. The server decides which application handles the request, which quality profile and root folder to use, and which upstream steps to run. Which toolset a process publishes, and the conventions every published tool shares, are owned by [Tool Contracts](../tool-contracts/).

**Status:** unimplemented. [0031-media-toolset-library](../../changes/0031-media-toolset-library.md) implements `media_find` and `media_add` with the identity, footprint, and default rules they need; [0032-media-toolset-activity](../../changes/0032-media-toolset-activity.md) implements the other four tools; [0033-media-default-toolset](../../changes/0033-media-default-toolset.md) makes this the default toolset.

## Background

The `arr` toolset exposes the applications' own model: application names, quality profile and root folder references, queue item kinds, plan and apply, and fourteen tools whose inputs presuppose knowing how the three applications divide the work. That suits an operator who knows them. It costs everyone else several calls and several decisions before anything happens: to add a show, a caller looks it up, observes quality profiles, observes root folders, plans the add, and applies the plan.

Most requests are simpler than that model: get this movie, how is that show doing, why is this stuck. The `media` toolset serves those requests and leaves the full model to the `arr` toolset.

The toolset is built on the same adapters, upstream client, and error contract as the `arr` toolset. It changes what a caller has to know, not how the server talks to the applications.

Related behavior:

- [Tool Contracts](../tool-contracts/) owns toolset selection, published schema rules, bounded results, and the error contract.
- [Library Management](../library-management/), [Activity Management](../activity-management/), and [Acquisition and Import](../acquisition-and-import/) own the `arr` toolset's behavior over the same upstream records.
- [Architecture](../architecture/) owns environment-only configuration and the testing contract.

## Requirements

### Published Tools

- The `media` toolset MUST publish `media_find`, `media_add`, `media_status`, `media_fix`, and `media_search_again`.
- The `media` toolset MUST publish `media_remove` if and only if `ARR_MCP_MEDIA_ALLOW_REMOVE` is `true`.
- A `media` tool's name, title, description, input properties, and result fields MUST NOT name Sonarr, Radarr, Prowlarr, or any of their concepts that a caller would have to understand to use the tool: application, quality profile, root folder, indexer, download client, tag, command, plan, or opaque reference.
- Text an upstream application wrote MAY be carried in a result only as explanatory detail, never as a value a caller must interpret to choose its next call.
- A `media` tool MUST NOT accept a plan reference, a mode, or any other two-step confirmation input; every call acts on its own and its result MUST state what it did.

#### Scenario: List the media toolset

- **GIVEN** the `media` toolset is selected and `ARR_MCP_MEDIA_ALLOW_REMOVE` is absent
- **WHEN** a caller lists tools
- **THEN** exactly `media_find`, `media_add`, `media_status`, `media_fix`, and `media_search_again` are published, and none of their schemas or descriptions names an *arr application

### Minimal Footprint

The toolset exists to be the smallest surface that manages a library across the supported applications. Every input and result field below is there because a caller needs it to take the next step; anything a caller could do without is left out.

- A `media` tool MUST accept only the inputs this specification names for it, and its result MUST carry only the fields this specification names for it plus the shared errors and warnings.
- A `media` tool MUST NOT offer detail levels, projections, paging, or continuation; every list it returns is bounded by this specification instead.
- A `media` tool's text summary MUST be a single line.
- The complete `tools/list` response for the `media` toolset, with `media_remove` published, MUST be at most 12 000 bytes.

#### Scenario: The whole toolset is cheap to list

- **GIVEN** the `media` toolset is selected and removal is enabled
- **WHEN** a caller lists tools
- **THEN** the response is at most 12 000 bytes, and every input property it publishes is one this specification names

### Media Identity

- A movie MUST be identified by `kind: "movie"` and its TMDB id, and a series by `kind: "series"` and its TVDB id.
- Every `media` tool that acts on a title MUST accept that pair as its only identification of the title.
- Every title a `media` tool returns MUST carry its kind and id, so any result can be passed to any other `media` tool without translation.
- A `media` tool MUST NOT require a value that an earlier call minted, and an id MUST remain valid across server restarts.
- A kind whose application is not configured MUST be refused with `unconfigured_application` and a remediation naming the kind rather than the application.

#### Scenario: Identity survives a restart

- **GIVEN** a caller found a series and received its kind and id
- **WHEN** the server restarts and the caller passes that pair to `media_status`
- **THEN** the series' status is returned, with no stale-reference error

#### Scenario: Ask for a kind the deployment does not serve

- **GIVEN** only movies are served by this deployment
- **WHEN** a caller adds a series
- **THEN** the call fails with `unconfigured_application`, and the remediation says TV series are not available here without naming an application

### Deployment Defaults

- The quality profile and root folder used for a new title MUST come from these environment variables, read once at startup:

  | Variable | Meaning |
  |---|---|
  | `ARR_MCP_MEDIA_MOVIE_QUALITY_PROFILE` | Quality profile name for new movies |
  | `ARR_MCP_MEDIA_MOVIE_ROOT_FOLDER` | Root folder path for new movies |
  | `ARR_MCP_MEDIA_SERIES_QUALITY_PROFILE` | Quality profile name for new series |
  | `ARR_MCP_MEDIA_SERIES_ROOT_FOLDER` | Root folder path for new series |
  | `ARR_MCP_MEDIA_ALLOW_REMOVE` | `true` publishes `media_remove`; absent or `false` does not |

- Where a profile or folder variable is absent and the instance has exactly one quality profile or root folder of that kind, that one MUST be used.
- Where a profile or folder variable is absent and the instance has several, or a variable names a profile or folder the instance does not have, `media_add` MUST fail with `deployment_configuration` and a remediation naming the variable the operator has to set, and MUST NOT add anything.
- These defaults MUST be resolved against the instance when a title is added, not at startup, so an instance that is unreachable when the server starts does not prevent it from starting.
- `ARR_MCP_MEDIA_ALLOW_REMOVE` MUST accept exactly `true` and `false`.

Setting any of these variables while the `arr` toolset is selected, or setting one to an unusable value, rejects startup as [Architecture — Environment-Only Instance Configuration](../architecture/#environment-only-instance-configuration) requires.

#### Scenario: One root folder needs no configuration

- **GIVEN** the movie instance has exactly one root folder and `ARR_MCP_MEDIA_MOVIE_ROOT_FOLDER` is absent
- **WHEN** a caller adds a movie
- **THEN** the movie is added under that root folder

#### Scenario: Ambiguous defaults

- **GIVEN** the series instance has two quality profiles and `ARR_MCP_MEDIA_SERIES_QUALITY_PROFILE` is absent
- **WHEN** a caller adds a series
- **THEN** nothing is added, and the call fails with `deployment_configuration` naming `ARR_MCP_MEDIA_SERIES_QUALITY_PROFILE`

### Find

- `media_find` MUST accept `text`, a search text of 1 to 200 characters, and an optional `kind`, and MUST search every configured kind when `kind` is absent.
- Each returned title MUST carry exactly its kind, id, title, year when known, and `in_library`.
- `media_find` MUST return at most 5 titles per kind, in the order the metadata source ranked them.
- A kind that could not be searched MUST be named in the result as unavailable, with its normalized error, beside the titles of the kinds that could, rather than failing the call.
- `media_find` MUST NOT change any upstream state.

#### Scenario: Find a title that exists as both a film and a show

- **GIVEN** both kinds are configured
- **WHEN** a caller finds "The Office" with no kind
- **THEN** movie and series matches are returned together, each with its kind, id, title, year, and whether it is already in the library

#### Scenario: One kind's source is down

- **GIVEN** both kinds are configured and the series instance is unreachable
- **WHEN** a caller finds a title with no kind
- **THEN** the movie matches are returned and the series kind is reported unavailable, in one successful result

### Add

- `media_add` MUST accept a title's kind and id and, for a series only, an optional `episodes` choice of `all` or `future`, defaulting to `all`.
- `media_add` MUST add the title with the [deployment defaults](#deployment-defaults), monitored, with every other new-record setting taken from the metadata the application's own lookup proposes, and MUST start a search for its missing media.
- Adding a title already in the library MUST succeed with the outcome `already_in_library`, MUST NOT change the existing record, and MUST NOT start a search.
- An id the metadata source does not know MUST fail with `not_found`.
- The result MUST carry the title and exactly one outcome, `added` or `already_in_library`.

#### Scenario: Add a movie

- **GIVEN** a movie that is not in the library and unambiguous deployment defaults
- **WHEN** a caller adds it
- **THEN** the movie is added monitored with the configured profile and folder, a search for it is started, and the outcome is `added`

#### Scenario: Add twice

- **GIVEN** a series is already in the library
- **WHEN** a caller adds it again
- **THEN** the outcome is `already_in_library`, and the existing series' monitoring and settings are unchanged

#### Scenario: Add a series for new episodes only

- **GIVEN** a series that is not in the library
- **WHEN** a caller adds it with `episodes: "future"`
- **THEN** the series is added with only episodes that have not yet aired monitored

### Status

- `media_status` MUST accept either nothing, for an overview, or a title's kind and id, for that title.
- Every download it reports MUST carry its title, which for an episode includes its season and episode numbers, and exactly one state: `queued`, `downloading`, `waiting`, `importing`, or `stuck`.
- A `downloading` download MUST also carry its progress as a whole percentage, and a `stuck` download MUST also carry a one-sentence reason and the remedy `media_fix` would apply to it if state did not change: `replace`, `import`, or `none`.
- The overview MUST carry the kinds this deployment serves, its downloads, the titles imported in the last 7 days with their dates, and the titles or episodes due in the next 14 days with their dates.
- A title's status MUST carry `in_library`; for a title in the library it MUST also carry whether it is monitored, how many of its released movies or episodes the library has and lacks, its downloads, and its next due date when one is known.
- Every list in a status result MUST hold at most 10 entries, and a list cut short MUST carry the total it was cut from.
- `media_status` MUST NOT change any upstream state.

#### Scenario: Overview with a stuck download

- **GIVEN** one download is progressing and another failed in the download client
- **WHEN** a caller asks for the overview
- **THEN** the first is reported `downloading` with its percentage, and the second is reported `stuck` with its reason and the remedy `replace`

#### Scenario: Status of a title not in the library

- **GIVEN** a movie that is not in the library
- **WHEN** a caller asks for its status
- **THEN** the result carries `in_library: false` and nothing else about the title, rather than failing

### Fix

- `media_fix` MUST accept a title's kind and id and MUST act on every download of that title that is `stuck` when the call re-reads it.
- A `stuck` download whose remedy is `replace` MUST be blocklisted, removed from the download client together with its downloaded data, and replaced by the application's own search for another release.
- A `stuck` download whose remedy is `import` MUST be imported, and that remedy MUST apply only when every file the download holds is importable without any correction and none would replace a file already in the library.
- A `stuck` download whose remedy is `none` MUST be left untouched.
- `media_fix` MUST NOT delete or replace any file already in the library, MUST NOT act on a download in any state other than `stuck`, and MUST NOT act on any other title's downloads.
- `media_fix` MUST re-read each download immediately before acting on it, and MUST decide its remedy from that reading rather than from any earlier status result.
- The result MUST carry, for each stuck download, its title and either the action taken, `replaced` or `imported`, or `none` with a one-sentence reason; a title with nothing stuck MUST produce an empty list.
- Calling `media_fix` again after a successful fix MUST NOT repeat an action on a download it already replaced or imported.

#### Scenario: Replace a failed download

- **GIVEN** a series episode's download failed in the download client
- **WHEN** a caller fixes that series
- **THEN** the release is blocklisted, the failed download and its data are removed from the client, a replacement search is left to the application, and the result reports `replaced`

#### Scenario: Nothing to fix

- **GIVEN** a movie whose only download is progressing normally
- **WHEN** a caller fixes it
- **THEN** no upstream change is made, and the result's list is empty

#### Scenario: An import needs a human

- **GIVEN** a completed download whose import is blocked because the application could not tell which episode a file is
- **WHEN** a caller fixes that series
- **THEN** the download is left untouched, and the result reports `none` with a reason saying a file could not be matched to an episode

### Search Again

- `media_search_again` MUST accept a title's kind and id and, for a series, an optional `season` and an optional `episode` within that season.
- It MUST start the application's own search for the media the title lacks within the requested scope and MUST NOT choose or download a specific release itself.
- A title that is not in the library MUST fail with `conflict` and a remediation pointing to `media_add`.
- The result MUST carry only the title and the scope searched; the search's outcome is observed through [Status](#status).

#### Scenario: Search one season again

- **GIVEN** a series in the library is missing episodes in season 2
- **WHEN** a caller searches season 2 again
- **THEN** a search for that season starts and the result names the series and season 2, without downloading a specific release

### Remove

- `media_remove` MUST accept a title's kind and id and an optional `delete_files` flag that defaults to `false`.
- It MUST remove the title from the library, MUST delete the title's files only when `delete_files` is `true`, and MUST NOT exclude the title from future additions.
- Removing a title that is not in the library MUST succeed with the outcome `not_in_library` and change nothing.
- The result MUST carry the title, exactly one outcome, `removed` or `not_in_library`, and whether files were deleted.

#### Scenario: Remove and keep the files

- **GIVEN** removal is enabled and a movie with a file is in the library
- **WHEN** a caller removes it without `delete_files`
- **THEN** the movie leaves the library, its file stays on disk, and the result reports `removed` with no files deleted

## Design

### Architecture

The `media` tools sit beside the `arr` tools, not on top of them. Each calls the same adapters and upstream client the `arr` tools' handlers use, and resolves its targets from stable ids within the same call: a TMDB or TVDB id becomes a library record, the library record's id scopes queue and history reads, and the queue row read immediately before acting is what a remedy is decided from. No `media` tool goes through an `arr` tool or mints a reference for a caller to hold.

```mermaid
flowchart LR
  caller[MCP caller] --> media[media tools]
  caller --> arr[arr tools]
  media --> adapters[Library, activity, acquisition and import adapters]
  arr --> adapters
  adapters --> client[Upstream client]
  client --> sonarr[Sonarr]
  client --> radarr[Radarr]
  client --> prowlarr[Prowlarr]
```

Kind selects the application: movies go to Radarr and series to Sonarr. Prowlarr is never addressed by a `media` tool directly; its indexer status may inform an explanation that search sources are failing.

### Download States

The five states are this toolset's own vocabulary over the applications' queue evidence. The mapping is:

| Upstream evidence | State |
|---|---|
| Delayed or fallback pending release | `waiting` |
| Queued or paused in the client | `queued` |
| Downloading with no warning or error | `downloading` |
| Downloaded and importing, or pending import with no warning | `importing` |
| Failed, failed pending, import blocked, client unavailable, or a client warning such as a stalled download | `stuck` |

And the remedy for a `stuck` download:

| Stuck because | Remedy |
|---|---|
| The download failed, or the client reports it stalled | `replace` |
| Import blocked, and a scan finds every file importable with no correction and no existing library file | `import` |
| Import blocked for any other reason | `none`, with the rejection reasons |
| The download client is unavailable | `none`, because no change can reach the client |

### Business Logic

`media_add` reuses the `arr` toolset's lookup-by-id and duplicate detection, so an add can never create a second record for a title. Its idempotency comes from that state check rather than from an apply record: repeating an add finds the record the first call made.

`media_fix` gets the same property from its re-read. A download it replaced has left the queue, and a download it imported is no longer stuck, so repeating the call finds nothing to act on.

### Safety Without Plan and Apply

The `arr` toolset's plan and apply exist so a caller can inspect effects before committing to them. The `media` toolset trades that for a narrower set of effects, each of which is either additive or confined to a download that is already failing:

- Nothing in the default toolset deletes a library file. `media_fix` removes only a stuck download and its incomplete data from the download client.
- Removal from the library exists only when the operator enables it, and deletes files only when the call asks.
- Every remedy is decided from a reading taken immediately before it is applied.

[Activity Management — Diagnosis](../activity-management/#diagnosis) requires that suggested actions never execute automatically. `media_fix` does not contradict that: diagnosis is still a read that changes nothing, and a remedy runs only because a caller invoked `media_fix` for that title. `media_status` reports the remedy `media_fix` would apply and applies nothing.

## Constraints

- One instance per application, as [Architecture](../architecture/) requires; kind selects it.
- Anime, daily, and standard series types, minimum availability, season folders, and tags are taken from the lookup's proposal or the application's defaults and cannot be chosen per call.
- Choosing a specific release, manual import with corrections, history and blocklist editing, configuration observation, and library edits other than add and remove are `arr` toolset features only.
- Media results are bounded by the fixed limits above. Projections, detail levels, and paging are `arr` toolset features only.
- Adding a title always starts a search for it, and adding never chooses monitoring finer than all or future episodes. A caller who needs anything else uses the `arr` toolset.

## Open Questions

- **Upgrades.** `media_search_again` searches for media the title lacks. Searching for better versions of media it already has, the cutoff-unmet search, is not offered. Default: not offered until a caller asks for it.
- **Stalled-download threshold.** A client warning is treated as stuck as soon as the application reports it. Some stalls recover on their own. Default: no grace period; revisit if live use shows premature replacements.

## References

- [Tool Contracts](../tool-contracts/)
- [Library Management](../library-management/)
- [Activity Management](../activity-management/)
- [Acquisition and Import](../acquisition-and-import/)
- [Architecture](../architecture/)

## Changelog

| Date | Change | Document |
|------|--------|----------|
| 2026-11-07 | Initial desired-state specification created | [0031-media-toolset-library](../../changes/0031-media-toolset-library.md) |
