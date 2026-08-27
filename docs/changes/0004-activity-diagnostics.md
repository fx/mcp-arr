# 0004: Activity Diagnostics

## Summary

Implement bounded queue, history, blocklist, health, indexer-status, and command diagnostics through `arr_activity_query` as defined by the [Activity Management spec](../specs/activity-management/).

**Spec:** [Activity Management](../specs/activity-management/)
**Status:** draft
**Depends On:** 0001, 0002

## Motivation

The predecessor exposed shallow queue rows and fetched entire queues to emulate pages. Rich, bounded activity evidence is necessary before any safe queue mutation or manual-import workflow can be implemented.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules (see [Architecture — Testing Contract](../specs/architecture/#testing-contract)). CI enforces these as merge gates:

- Exported behavior MUST have automated tests at the narrowest practical level.
- Adapter tests MUST use sanitized, version-labelled fixtures rather than personal live instances.
- Stdio integration tests MUST verify protocol framing and stdout cleanliness.
- Build, type check, lint, and tests MUST pass without focused or skipped tests.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

### Functional Requirements

The [Activity Management spec](../specs/activity-management/#activity-queries) owns read and diagnosis behavior. Queue mutations remain deliberately unimplemented until change 0006.

- Activity adapters MUST preserve evidence required by later state-machine decisions without exposing canonical paths or raw download IDs.
- Prowlarr statistics MUST use a safe allowlist that excludes raw caller host and user-agent aggregates.
- Diagnosis MUST remain read-only and return declared candidate actions rather than invoking them.

## Design

### Approach

- Add queue status, paged queue, and focused queue-detail adapters for Sonarr/Radarr.
- Add history, blocklist, health, and command readers.
- Add Prowlarr history, indexer status/stats, health, scheduled-task, and command readers.
- Create opaque queue references retaining item-kind and tracked context.
- Build a bounded diagnosis aggregator tolerant of partial upstream failures.

### Decisions

- **Decision:** Keep evidence and suggestions separate.
  - **Why:** The agent can reason over evidence without a diagnostic read causing side effects.
  - **Alternatives considered:** Automatic remediation was rejected.
- **Decision:** Use server-side queue paging.
  - **Why:** Fetch-all-and-slice is inefficient and inconsistent under queue mutation.

### Non-Goals

- Queue mutations
- Manual import scanning or execution
- Raw logs, system routes, or arbitrary commands
- Metrics persistence

## Tasks

- [x] Implement queue and activity readers
  - [x] Map queue status, records, details, tracked states, status messages, and media associations
  - [x] Implement bounded history/blocklist/health/command views
  - [x] Add Prowlarr status/statistics views with allowlist sanitization
- [x] Implement references and diagnosis
  - [x] Create typed queue references for tracked and pending items
  - [x] Correlate safe queue, history, blocklist, health, disk, and media evidence
  - [x] Represent partial failures and suggested typed actions
- [ ] Register and verify `arr_activity_query`
  - [ ] Add closed view schemas, filters, pagination, and details
  - [ ] Add fixture and stdio tests for every status/item kind and unavailable application
  - [ ] Add canary-secret and untrusted-status-message tests

## Open Questions

None.

## References

- Spec: [Activity Management](../specs/activity-management/)
- Related changes: [0001-project-foundation](./0001-project-foundation.md), [0002-tool-runtime](./0002-tool-runtime.md)
