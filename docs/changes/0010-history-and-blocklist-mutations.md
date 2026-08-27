# 0010: History and Blocklist Mutations

## Summary

Implement typed history-failure and single-record blocklist mutation workflows through `arr_activity_change` as defined by the [Activity Management spec](../specs/activity-management/).

**Spec:** [Activity Management](../specs/activity-management/)
**Status:** complete
**Depends On:** 0002, 0004

## Motivation

Marking a historical grab failed is not equivalent to resolving an active queue item, and removing a blocklist record re-allows a release without touching media or download-client data. These actions need explicit ownership outside the queue state machine.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules (see [Architecture — Testing Contract](../specs/architecture/#testing-contract)). CI enforces these as merge gates:

- Exported behavior MUST have automated tests at the narrowest practical level.
- Adapter tests MUST use sanitized, version-labelled fixtures rather than personal live instances.
- Stdio integration tests MUST verify protocol framing and stdout cleanliness.
- Build, type check, lint, and tests MUST pass without focused or skipped tests.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

### Functional Requirements

The [Activity Management spec](../specs/activity-management/#history-and-blocklist) owns history/blocklist mutation behavior and scenarios.

- `mark_history_failed` MUST use an application-qualified history reference and disclose potential blocklist and replacement-search effects.
- `remove_blocklist_record` MUST use an application-qualified blocklist reference and MUST NOT compile to media, queue, or download-client deletion.
- Both variants MUST use shared plan/direct-apply, stale-state, receipt, and retry contracts.

## Design

### Approach

- Add process-local history and blocklist references to activity query results.
- Implement Sonarr/Radarr history-failure adapters separately from queue resolution.
- Implement single-record blocklist removal adapters.
- Capture current history/blocklist state and follow-on search policy in plan read-sets.
- Reconcile ambiguous outcomes by rereading history and blocklist state.

### Decisions

- **Decision:** Use a separate `arr_activity_change` tool.
  - **Why:** These mutations have different targets and effects from queue state transitions, while one tool per endpoint would be unnecessary sprawl.
  - **Alternatives considered:** Adding them to `arr_queue_resolve` would blur active queue and historical state.
- **Decision:** Exclude clear-all blocklist and arbitrary history operations.
  - **Why:** The initial contract covers common targeted remediation without exposing generic administrative commands.

### Non-Goals

- Active queue resolution, owned by change 0006
- Clear-all blocklist/history commands
- Raw history payloads
- Prowlarr mutations without an equivalent supported semantic workflow

## Tasks

- [x] Implement typed activity mutation references and adapters
  - [x] Add safe history and blocklist references to activity results
  - [x] Implement Sonarr/Radarr mark-history-failed behavior and follow-on effect mapping
  - [x] Implement Sonarr/Radarr single-record blocklist removal
- [x] Register and verify `arr_activity_change`
  - [x] Add typed plan/direct-apply variants and structured receipts
  - [x] Add stale-state and unknown-outcome reconciliation
  - [x] Add fixtures and stdio tests for replacement-search effects, record removal, stale references, retry, and non-effects on media/client data

## Open Questions

None.

## References

- Spec: [Activity Management](../specs/activity-management/)
- Related changes: [0002-tool-runtime](./0002-tool-runtime.md), [0004-activity-diagnostics](./0004-activity-diagnostics.md), [0006-queue-resolution](./0006-queue-resolution.md)
