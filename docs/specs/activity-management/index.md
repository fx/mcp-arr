# Activity Management

## Overview

This specification defines queue, history, blocklist, health, command, and job behavior. Queue mutation is modeled as typed state transitions rather than a generic delete operation.

## Background

Sonarr and Radarr queues contain tracked download-client items and pending delayed/fallback releases with different valid actions. Their delete flags have consequential precedence and can delete client data or trigger replacement searches. Prowlarr contributes history, indexer status/statistics, health, scheduled tasks, and command activity.

Shared tool behavior is owned by [Tool Contracts](../tool-contracts/).

## Requirements

### Activity Queries

- `arr_activity_query` MUST support typed views for queue status, paged queue records, focused queue details, history, blocklist, health, command activity, and relevant disk conditions on supported applications.
- Prowlarr activity views MUST include indexer status and sanitized performance aggregates without returning caller hosts or user-agent aggregates.
- Activity output MUST preserve status messages, tracked download status/state, download identity through opaque references, and normalized application/media associations.
- Activity queries MUST use bounded upstream paging and MUST NOT fetch an entire queue merely to emulate a page.

#### Scenario: Diagnose a blocked import

- **GIVEN** a tracked Sonarr download is completed with import blocked
- **WHEN** queue details are queried
- **THEN** the result contains its tracked state, safe status messages, media association, and an opaque queue reference

### Queue Item Kinds

- Queue records MUST distinguish tracked downloads from pending delayed/fallback releases.
- Queue resolution intents MUST be validated against the queue item kind.
- An intent valid only for a pending release MUST be rejected for a tracked download and vice versa.

#### Scenario: Reject pending grab on tracked download

- **GIVEN** a reference identifies a tracked download-client item
- **WHEN** `force_pending_grab` is requested
- **THEN** validation fails before any upstream action

### Tracked Download Resolution

- `arr_queue_resolve` MUST support `ignore_tracking`, `remove_from_client_and_delete_data`, `blocklist_and_remove`, `change_category_mark_imported`, and `route_to_manual_import` for applicable tracked downloads.
- `remove_from_client_and_delete_data` MUST disclose that client payload data is requested for deletion.
- `blocklist_and_remove` MUST require an explicit replacement-search choice of allow or suppress.
- `change_category_mark_imported` MUST be compiled without also requesting client removal.
- `ignore_tracking` MUST be compiled without removal, blocklist, or category-change flags.

#### Scenario: Blocklist without replacement search

- **GIVEN** a failed tracked download can be blocklisted
- **WHEN** the caller applies `blocklist_and_remove` with replacement search suppressed
- **THEN** the exact removal/blocklist request suppresses automatic redownload where the upstream API supports that flag

### Pending Release Resolution

- `arr_queue_resolve` MUST support `force_pending_grab`, `remove_pending`, and `blocklist_pending` for applicable pending releases.
- Pending-release resolution MUST NOT claim to remove download-client data when no tracked client item exists.
- Bulk pending grabs MUST report each sequential outcome and MUST NOT claim atomicity.

#### Scenario: One pending bulk grab expires

- **GIVEN** two pending release references and one becomes stale
- **WHEN** both are applied
- **THEN** the successful grab and stale-reference error are reported independently

### History and Blocklist

- `arr_activity_query` MUST support paged history and blocklist inspection with media and event filters.
- `arr_activity_change` MUST support typed `mark_history_failed` and `remove_blocklist_record` intents.
- Queue failure and history failure MUST remain distinct intents because they have different effects on active download-client state.
- Removing a blocklist record MUST be described as re-allowing a release and MUST NOT be described as deleting media or downloads.
- Clearing all blocklist records MUST NOT be exposed through a generic command escape hatch.

#### Scenario: Remove one blocklist record

- **GIVEN** a blocklist record exists
- **WHEN** its typed removal intent is planned
- **THEN** the plan states that the release may be considered again and that no media file is deleted

### Commands and Jobs

- Long-running searches, refreshes, scans, imports, renames, backups, and supported synchronization operations MUST return normalized job references.
- Only allowlisted semantic workflows MAY create upstream commands.
- Arbitrary command names MUST NOT be accepted.
- `arr_job_get` and `arr_job_cancel` MUST follow the shared job contract.

#### Scenario: Poll an upstream command

- **GIVEN** a supported search returns a job reference
- **WHEN** the caller queries that job
- **THEN** queued, running, terminal, failed, or unknown state is returned without requiring the upstream command payload shape

### Diagnosis

- Activity diagnosis SHOULD correlate queue state, safe status messages, relevant history/blocklist records, health, and media state.
- Diagnosis MUST distinguish observed evidence from suggested next actions.
- Suggested actions MUST use declared tool intents and MUST NOT execute automatically.

#### Scenario: Diagnose without mutating

- **GIVEN** a queue item has warning status
- **WHEN** activity diagnosis is requested
- **THEN** evidence and applicable action names are returned without changing upstream state

## Design

### Architecture

An activity service normalizes application-specific queue, history, health, and command models. Queue references retain adapter context required for safe follow-up actions without exposing paths or download IDs directly.

### Data Models

Core models include queue item kind, queue/tracked status, status evidence, history event, blocklist record, health check, job record, and per-item mutation outcome.

### API Surface

Reads use `arr_activity_query`; queue mutations use `arr_queue_resolve`; typed history/blocklist mutations use `arr_activity_change`; job inspection and cancellation use `arr_job_get` and `arr_job_cancel`.

### Business Logic

Queue resolution is a finite state machine. Each intent compiles to one valid upstream flag combination, with exact effects shown in plan mode and revalidated in apply mode.

## Constraints

- Bulk activity mutations are not transactional.
- Raw logs, route diagnostics, arbitrary scheduled-task commands, shutdown, restart, API-key reset, and clear-all commands are outside the default surface.
- Import execution is owned by [Acquisition and Import](../acquisition-and-import/).

## Open Questions

None.

## References

- [Tool Contracts](../tool-contracts/)
- [Acquisition and Import](../acquisition-and-import/)

## Changelog

| Date | Change | Document |
|------|--------|----------|
| 2026-08-25 | Initial desired-state specification created | [0004-activity-diagnostics](../../changes/0004-activity-diagnostics.md) |
| 2026-08-25 | Queue-resolution implementation planned | [0006-queue-resolution](../../changes/0006-queue-resolution.md) |
| 2026-08-25 | History/blocklist mutation implementation planned | [0010-history-and-blocklist-mutations](../../changes/0010-history-and-blocklist-mutations.md) |
