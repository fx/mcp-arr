# 0003: Library Queries

## Summary

Implement bounded Sonarr and Radarr lookup, library, wanted, calendar, collection, and file queries through `arr_library_query` as defined by the [Library Management spec](../specs/library-management/).

**Spec:** [Library Management](../specs/library-management/)
**Status:** complete
**Depends On:** 0001, 0002

## Motivation

Read-only library context is required before acquisition, queue diagnosis, import, and mutations can use stable media references. It is also the safest first feature slice for validating the normalized adapter model.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules (see [Architecture — Testing Contract](../specs/architecture/#testing-contract)). CI enforces these as merge gates:

- Exported behavior MUST have automated tests at the narrowest practical level.
- Adapter tests MUST use sanitized, version-labelled fixtures rather than personal live instances.
- Stdio integration tests MUST verify protocol framing and stdout cleanliness.
- Build, type check, lint, and tests MUST pass without focused or skipped tests.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

### Functional Requirements

The [Library Management spec](../specs/library-management/#library-queries) owns library-query behavior and scenarios. This change implements only the read/lookup portion; mutation sections remain deliberately unimplemented until change 0009.

- Sonarr and Radarr read adapters MUST map upstream resources into the shared media model while preserving declared application-specific extensions.
- Pagination MUST use upstream paging when available and bounded adapter-side projection otherwise.
- Capability registration MUST expose only views supported by the configured application/version.

## Design

### Approach

- Add Sonarr lookup/series/season/episode/file/wanted/calendar adapters.
- Add Radarr lookup/movie/collection/file/wanted/calendar adapters.
- Define application-qualified media references and view-specific discriminated outputs.
- Avoid returning complete nested records by default.

### Decisions

- **Decision:** Keep one library query tool with typed views.
  - **Why:** The views share filtering/pagination semantics while remaining a closed union.
  - **Alternatives considered:** One tool per entity and a generic search tool.
- **Decision:** Keep Prowlarr out of the library model.
  - **Why:** It has no media library and forcing it into the model would create false symmetry.

### Non-Goals

- Add/update/delete/monitor actions
- Release search or grab
- Queue, history, or import behavior
- Configuration providers and profiles

## Tasks

- [x] Implement normalized lookup and library adapters (PR #7)
  - [x] Add application-qualified media reference and summary/detail models (PR #7)
  - [x] Implement Sonarr and Radarr lookup and core library reads (PR #7)
  - [x] Add version-labelled fixture coverage for mapping and error cases (PR #7)
- [x] Implement wanted, calendar, collection, and file views (PR #7)
  - [x] Add missing/cutoff filters, calendar ranges, and bounded paging (PR #7)
  - [x] Add Sonarr episode-file and Radarr movie-file reads (PR #7)
  - [x] Add Radarr collection support and unsupported-view handling (PR #7)
- [x] Register and verify `arr_library_query` (PR #8)
  - [x] Add typed view schemas, detail levels, pagination, and structured outputs (PR #8)
  - [x] Add stdio integration tests for each view and mixed configured-app state (PR #8)
  - [x] Add capability projection for all implemented views (PR #8)

## Open Questions

None.

## References

- Spec: [Library Management](../specs/library-management/)
- Related changes: [0001-project-foundation](./0001-project-foundation.md), [0002-tool-runtime](./0002-tool-runtime.md)
