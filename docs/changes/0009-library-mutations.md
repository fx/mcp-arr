# 0009: Library Mutations

## Summary

Implement typed add, monitoring, bulk edit, file metadata, rename, move, and deletion behavior through `arr_library_change` as defined by the [Library Management spec](../specs/library-management/).

**Spec:** [Library Management](../specs/library-management/)
**Status:** draft
**Depends On:** 0002, 0003

## Motivation

After stable library references and query models exist, the MCP can expose common real-world library management without creating one tool per series/movie/file endpoint.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules (see [Architecture — Testing Contract](../specs/architecture/#testing-contract)). CI enforces these as merge gates:

- Exported behavior MUST have automated tests at the narrowest practical level.
- Adapter tests MUST use sanitized, version-labelled fixtures rather than personal live instances.
- Stdio integration tests MUST verify protocol framing and stdout cleanliness.
- Build, type check, lint, and tests MUST pass without focused or skipped tests.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

### Functional Requirements

The [Library Management spec](../specs/library-management/#lookup-and-add) owns add, monitoring, bulk edit, deletion, media-file, and application-extension behavior.

- Every mutation MUST use application-qualified references from current library or lookup results.
- Physical data deletion, move, rename, list exclusion, search-on-add, and other follow-on actions MUST remain explicit typed fields.
- Bulk execution MUST create independent outcomes and read-set fingerprints per item.

## Design

### Approach

- Add Sonarr series and Radarr movie creation from lookup references.
- Add monitoring/profile/root/tag/application-specific edits with shared and discriminated fields.
- Add file metadata updates, delete, rename preview, rename command, and supported move behavior.
- Validate dependency references and current media/file state immediately before apply.

### Decisions

- **Decision:** Keep common writes under one typed library tool initially.
  - **Why:** Add, monitor, edit, and file operations share application-qualified references and plan/apply infrastructure.
  - **Alternatives considered:** Split tools are appropriate if the resulting union becomes too large or risk metadata becomes misleading.
- **Decision:** Never default to physical deletion or automatic search.
  - **Why:** Both are consequential follow-on effects that must remain explicit.

### Non-Goals

- Quality/profile/provider reconciliation, which belongs to change 0008
- Acquisition search/grab, which belongs to change 0005
- Queue and manual import, which belong to changes 0006 and 0007
- Generic series/movie editor payloads

## Tasks

- [x] Implement add and monitoring mutations
  - [x] Add lookup-reference-based Sonarr series and Radarr movie creation
  - [x] Add typed monitoring, profile, root, tag, and application-specific edits
  - [x] Add duplicate detection, explicit search-on-add, dependency validation, and fixtures
- [ ] Implement file and path mutations
  - [ ] Add file metadata update/delete and safe bulk grouping
  - [ ] Add rename preview and allowlisted rename/move command workflows
  - [ ] Add explicit physical-data effects and current-state fingerprints
- [ ] Register and verify `arr_library_change`
  - [ ] Add direct apply and plan/apply variants with per-item outcomes
  - [ ] Add fixture and stdio tests for duplicates, stale references, partial bulk, deletion choices, rename/move, retry, and unknown outcome
  - [ ] Evaluate whether the public union requires splitting before release

## Open Questions

None.

## References

- Spec: [Library Management](../specs/library-management/)
- Related changes: [0002-tool-runtime](./0002-tool-runtime.md), [0003-library-queries](./0003-library-queries.md)
