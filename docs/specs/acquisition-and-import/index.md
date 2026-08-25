# Acquisition and Import

## Overview

This specification defines interactive release search and grab across Sonarr, Radarr, and Prowlarr, plus guarded manual import for Sonarr and Radarr. Search results and import candidates are carried through opaque, expiring references.

## Background

Search and grab are stateful upstream workflows: each application caches search results for a limited period, and a later grab relies on that cache. Manual import has separate discovery, reprocessing, and command-execution stages; the reprocessing endpoint does not import files.

Shared tool behavior is owned by [Tool Contracts](../tool-contracts/).

## Requirements

### Release Search

- `arr_release_search` MUST support Sonarr episode and season search, Radarr movie search, and Prowlarr aggregate search.
- Search results MUST include normalized quality, languages, protocol, indexer, custom-format information where available, approval/rejection state, and safe rejection reasons.
- Prowlarr search results MUST report per-indexer success, failure, timeout, or blocked state and overall completeness.
- Search results MUST replace protected download URLs and cache keys with opaque process-local release references.
- Release references MUST expire no later than the corresponding upstream search cache.

#### Scenario: Partial Prowlarr search

- **GIVEN** one Prowlarr indexer succeeds and another fails
- **WHEN** a release search completes
- **THEN** successful releases and the failed indexer's outcome are returned with incomplete status

### Release Grab

- `arr_release_grab` MUST accept only a valid release reference returned by search.
- `arr_release_grab` MUST NOT accept an arbitrary download URL, GUID, magnet URL, or raw release payload.
- Apply MUST recheck reference expiry and relevant upstream cache state immediately before grab.
- Bulk Prowlarr grabs MUST report an outcome for each selected release.
- Grab results MUST expose the created queue or job reference when available.

#### Scenario: Grab a fresh release

- **GIVEN** a caller selects a non-expired release reference
- **WHEN** direct apply succeeds
- **THEN** the result identifies the accepted download/job without exposing its protected download URL

### Automatic Search

- `arr_search_start` MUST expose supported automatic searches as typed episode, season, series, movie, missing, or cutoff-unmet intents.
- Automatic search MUST return a job reference when the upstream application queues work.
- Wanted-list reads MUST remain separate from starting searches.

#### Scenario: Read wanted without searching

- **GIVEN** monitored episodes are missing
- **WHEN** wanted media is queried
- **THEN** no search command starts

### Manual Import Discovery

- `arr_import_inspect` MUST discover candidates from either an opaque tracked queue reference or an application-qualified media reference returned by `arr_library_query` that identifies a Sonarr series/season or Radarr movie library context.
- The default tool surface MUST NOT accept arbitrary filesystem paths.
- Candidate results MUST include proposed media mapping, episode mapping where applicable, file size/fingerprint, quality, languages, release group/type, custom formats, indexer flags, and structured rejections.
- Canonical server filesystem paths and raw download IDs MUST remain internal.

#### Scenario: Scan a tracked download

- **GIVEN** a completed queue item has a tracked download identity
- **WHEN** import candidates are inspected
- **THEN** candidate references and safe mappings are returned without exposing the canonical output path

### Candidate Reprocessing

- `arr_import_inspect` MUST support reprocessing explicit mapping corrections through the upstream manual-import validation endpoint.
- Reprocessing MUST return new candidate references bound to the corrected mapping and current rejection set.
- Reprocessing MUST NOT be reported as completed import.
- Candidates with blocking rejections MUST NOT be eligible for execution.

#### Scenario: Inspect a library context

- **GIVEN** `arr_library_query` returned a Sonarr series reference or Radarr movie reference
- **WHEN** import candidates are inspected for that reference
- **THEN** existing and unmapped media candidates under the application's known library path are returned without accepting a caller-supplied path

#### Scenario: Correct a season-pack mapping

- **GIVEN** a candidate has incomplete episode mapping
- **WHEN** the caller reprocesses it with explicit episode selections
- **THEN** the updated mapping and any remaining rejections are returned without importing the file

### Manual Import Execution

- `arr_import_execute` MUST accept only validated candidate references and an explicit import mode.
- Immediately before execution, the server MUST rerun upstream candidate reprocessing with the exact selected mapping.
- Execution MUST stop when any blocking rejection remains or file/media/queue fingerprints changed.
- Execution MUST submit the allowlisted `ManualImport` workflow rather than expose arbitrary command names.
- Every tracked-download import MUST be presented as potentially source-consuming unless the adapter can prove otherwise from current state.
- Import results MUST preserve per-file success, failure, and outcome-unknown state.

#### Scenario: Candidate becomes stale

- **GIVEN** a candidate was validated and its source file changes before apply
- **WHEN** import execution begins
- **THEN** the server returns `stale_plan` or `stale_reference` without starting the import command

### Existing Library Files

- Candidates representing existing library files MUST be distinguished from new download imports.
- Existing-file metadata changes MUST use the applicable library-file workflow rather than pretending to import the file again.

#### Scenario: Existing file selected

- **GIVEN** manual-import discovery identifies a file already registered in the library
- **WHEN** the caller attempts import execution
- **THEN** the tool directs the caller to the typed library-file change workflow

## Design

### Architecture

An acquisition service wraps app-specific release caches and manual-import stages. Opaque references retain the minimum server-side data required to re-establish exact upstream context during the process lifetime.

### Data Models

Models include release candidate, rejection, search completeness, import candidate, selected mapping, source fingerprint, import mode, and per-file outcome.

### API Surface

Interactive search uses `arr_release_search`; automatic search commands use `arr_search_start`; grab uses `arr_release_grab`; manual-import discovery and reprocessing use `arr_import_inspect`; execution uses `arr_import_execute`.

### Business Logic

Search then grab is a short-lived transaction. Manual import is a guarded saga: discover, optionally correct/reprocess, revalidate immediately, execute, and poll the resulting job.

## Constraints

- Release push by arbitrary URL is outside the default surface.
- Raw download URLs, magnet URLs, canonical paths, and download IDs are not model-facing contracts.
- Import references and search references do not survive process restart.

## Open Questions

None.

## References

- [Tool Contracts](../tool-contracts/)
- [Activity Management](../activity-management/)
- [Library Management](../library-management/)

## Changelog

| Date | Change | Document |
|------|--------|----------|
| 2026-08-25 | Initial desired-state specification created | [0005-release-search-and-grab](../../changes/0005-release-search-and-grab.md) |
| 2026-08-25 | Guarded manual-import implementation planned | [0007-manual-import](../../changes/0007-manual-import.md) |
