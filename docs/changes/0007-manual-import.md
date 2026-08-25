# 0007: Guarded Manual Import

## Summary

Implement candidate discovery, mapping reprocessing, apply-time revalidation, and command execution for Sonarr and Radarr manual import as defined by the [Acquisition and Import spec](../specs/acquisition-and-import/).

**Spec:** [Acquisition and Import](../specs/acquisition-and-import/)
**Status:** draft
**Depends On:** 0002, 0003, 0004, 0006

## Motivation

Manual import is the key missing operational workflow in the predecessor. Upstream discovery, validation, and execution are separate APIs, and the execution command trusts caller-supplied mappings instead of rerunning the full rejection gate.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules (see [Architecture — Testing Contract](../specs/architecture/#testing-contract)). CI enforces these as merge gates:

- Exported behavior MUST have automated tests at the narrowest practical level.
- Adapter tests MUST use sanitized, version-labelled fixtures rather than personal live instances.
- Stdio integration tests MUST verify protocol framing and stdout cleanliness.
- Build, type check, lint, and tests MUST pass without focused or skipped tests.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

### Functional Requirements

The [Acquisition and Import spec](../specs/acquisition-and-import/#manual-import-discovery) owns candidate discovery, mapping correction, rejection, execution, source-consumption, and existing-file behavior.

- Candidate fingerprints MUST cover every selected mapping field and effect-relevant source/media state.
- The apply handler MUST complete reprocessing and state validation immediately before command submission.
- Import command results MUST be snapshotted into process-local job records before upstream retention expires.

## Design

### Approach

- Resolve either tracked output context from queue references or known Sonarr series/season and Radarr movie paths from application-qualified library references.
- Add Sonarr/Radarr candidate scanners and safe candidate serializers.
- Add reprocessing requests for corrected series/movie, episode, quality, language, release, and flag fields.
- Bind new candidate references to the complete validated mapping and source fingerprint.
- On apply, rerun reprocessing, reject any blocking decision, recheck file/media/queue/free-space state, and submit the allowlisted `ManualImport` command.
- Direct existing-library-file changes to `arr_library_change`.

### Decisions

- **Decision:** Do not expose arbitrary folder paths initially.
  - **Why:** Queue-derived paths cover the core workflow without creating a generic server-filesystem capability.
  - **Alternatives considered:** Root-confined arbitrary scans may be reconsidered later.
- **Decision:** Treat all tracked imports as potentially source-consuming.
  - **Why:** Completed-download cleanup can remove an output folder even when the requested import mode appears non-destructive.

### Non-Goals

- Arbitrary filesystem scans
- Automated model mapping without candidate evidence
- Importing candidates with blocking rejections
- Persistent import history in the MCP

## Tasks

- [ ] Implement candidate discovery and safe references
  - [ ] Resolve tracked download paths internally from queue references
  - [ ] Resolve Sonarr series/season and Radarr movie library contexts from `arr_library_query` media references without accepting raw paths
  - [ ] Map Sonarr and Radarr candidate data, rejections, file identity, and media associations
  - [ ] Add opaque candidate references without canonical paths or raw download IDs
- [ ] Implement correction and apply-time validation
  - [ ] Reprocess explicit mapping corrections and issue new bound references
  - [ ] Rerun reprocessing and verify source, queue, media, file, and free-space preconditions at apply
  - [ ] Reject every blocking decision and stale fingerprint before command submission
- [ ] Implement import execution and jobs
  - [ ] Submit only the typed `ManualImport` command with explicit import mode
  - [ ] Snapshot per-file terminal and unknown outcomes in normalized jobs
  - [ ] Add fixture and stdio tests for packs, split episodes, samples, existing files, blocked upgrades, stale files, source cleanup, partial failure, and restart invalidation

## Open Questions

None.

## References

- Spec: [Acquisition and Import](../specs/acquisition-and-import/)
- Related changes: [0002-tool-runtime](./0002-tool-runtime.md), [0003-library-queries](./0003-library-queries.md), [0004-activity-diagnostics](./0004-activity-diagnostics.md), [0006-queue-resolution](./0006-queue-resolution.md)
