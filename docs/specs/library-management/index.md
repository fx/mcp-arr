# Library Management

## Overview

This specification defines observable library discovery, query, monitoring, metadata, file, and mutation behavior for Sonarr and Radarr. Prowlarr has no media-library contract in this domain.

## Background

Sonarr models series, seasons, episodes, and episode files. Radarr models movies, collections, and movie files. Their APIs overlap but are not identical, so the MCP exposes normalized concepts with application-specific fields where needed.

Shared tool behavior is owned by [Tool Contracts](../tool-contracts/).

## Requirements

### Library Queries

- `arr_library_query` MUST support typed views for Sonarr series, seasons, episodes, episode files, missing episodes, cutoff-unmet episodes, and calendar entries.
- `arr_library_query` MUST support typed views for Radarr movies, collections, movie files, missing movies, cutoff-unmet movies, and calendar entries.
- Library queries MUST support application filtering, identifier filtering, monitored-state filtering, bounded pagination, and supported detail levels.
- A view unsupported by the selected application MUST return an unsupported-capability error.

#### Scenario: Query missing media

- **GIVEN** Sonarr and Radarr are configured
- **WHEN** missing media is queried for both applications
- **THEN** bounded Sonarr episode results and Radarr movie results are returned with their application identity

### Lookup and Add

- `arr_library_query` MUST support metadata lookup without adding the result.
- `arr_library_change` MUST support adding a Sonarr series or Radarr movie from a lookup result with explicit root, quality profile, monitoring, and application-specific options.
- Add operations MUST detect existing library records and MUST NOT create duplicates silently.
- Search-on-add MUST be an explicit input rather than an implicit default.

#### Scenario: Add without automatic search

- **GIVEN** a lookup result is not already in the target library
- **WHEN** the caller applies an add intent with search-on-add disabled
- **THEN** the record is added without launching an acquisition search

### Monitoring and Bulk Editing

- `arr_library_change` MUST support setting monitoring for Sonarr series, seasons, or episodes and for Radarr movies or collections.
- Profile, root-folder, tag, series-type, minimum-availability, and other application-specific changes MUST be represented by typed fields.
- Bulk changes MUST report an outcome for each selected item and MUST NOT claim transactional behavior.

#### Scenario: Partial bulk monitoring update

- **GIVEN** a bulk request contains one valid and one stale media reference
- **WHEN** the change is applied
- **THEN** the valid item result and stale-item error are both returned

### Deletion Effects

- Deleting a library record MUST require an explicit choice about deleting physical media where the upstream API offers that choice.
- A deletion plan MUST distinguish database-record removal, physical file removal, import-list exclusion, and follow-on list behavior.
- The server MUST NOT default physical-file deletion to true.

#### Scenario: Remove a series but preserve files

- **GIVEN** a Sonarr series exists with episode files
- **WHEN** the caller applies deletion with physical-file deletion disabled
- **THEN** the requested record deletion is sent without requesting file deletion

### Media File Operations

- `arr_library_query` MUST support reading normalized episode-file and movie-file metadata.
- `arr_library_change` MUST support typed metadata updates, deletion, rename preview, and rename execution for supported files.
- Physical file deletion and move/rename effects MUST be disclosed in plan results.
- Bulk file operations MUST reject application-incompatible or cross-parent combinations that upstream handlers cannot process safely.

#### Scenario: Preview rename

- **GIVEN** a media item has files eligible for rename
- **WHEN** rename is requested in plan mode
- **THEN** proposed old and new paths are returned without starting a rename command

### Application-Specific Extensions

- Sonarr results MAY include season numbers, episode numbers, absolute numbers, air dates, and series type.
- Radarr results MAY include collection identity, minimum availability, editions, credits, and alternative titles.
- Application-specific fields MUST remain namespaced or discriminated so consumers can distinguish them from normalized shared fields.

#### Scenario: Preserve Sonarr episode identity

- **GIVEN** a Sonarr episode uses absolute numbering
- **WHEN** the episode is returned
- **THEN** its normalized identity retains both available aired and absolute numbering fields

## Design

### Architecture

A shared library service coordinates Sonarr and Radarr adapters. Normalized media references always include the application kind so overlapping numeric IDs cannot collide.

### Data Models

Core models include media summary, media detail, monitoring state, profile/root/tag references, file summary, wanted state, and calendar event. Sonarr and Radarr extensions are discriminated by application.

### API Surface

Read behavior is exposed through `arr_library_query`; mutations are exposed through `arr_library_change`. Upstream series/movie/editor/file/rename endpoints and commands remain private.

### Business Logic

Queries use real server-side filters or bounded adapter-side filtering where the upstream API lacks paging. Mutations validate current media and dependent configuration immediately before apply.

## Constraints

- Prowlarr is outside this domain.
- Raw filesystem browsing is not exposed.
- Generic series/movie editor payloads are not accepted.

## Open Questions

None.

## References

- [Tool Contracts](../tool-contracts/)
- [Activity Management](../activity-management/)
- [Acquisition and Import](../acquisition-and-import/)

## Changelog

| Date | Change | Document |
|------|--------|----------|
| 2026-08-25 | Initial desired-state specification created | [0003-library-queries](../../changes/0003-library-queries.md) |
| 2026-08-25 | Library-mutation implementation planned | [0009-library-mutations](../../changes/0009-library-mutations.md) |
