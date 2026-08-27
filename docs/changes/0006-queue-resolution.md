# 0006: Queue Resolution

## Summary

Implement typed queue state-machine mutations for tracked downloads and pending releases through `arr_queue_resolve` as defined by the [Activity Management spec](../specs/activity-management/).

**Spec:** [Activity Management](../specs/activity-management/)
**Status:** draft
**Depends On:** 0002, 0004

## Motivation

The upstream queue delete endpoint encodes several unrelated effects in query flags. A direct wrapper would make destructive precedence, data deletion, blocklisting, category changes, and replacement search easy to misapply.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules (see [Architecture — Testing Contract](../specs/architecture/#testing-contract)). CI enforces these as merge gates:

- Exported behavior MUST have automated tests at the narrowest practical level.
- Adapter tests MUST use sanitized, version-labelled fixtures rather than personal live instances.
- Stdio integration tests MUST verify protocol framing and stdout cleanliness.
- Build, type check, lint, and tests MUST pass without focused or skipped tests.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

### Functional Requirements

The [Activity Management spec](../specs/activity-management/#queue-item-kinds) owns queue-kind validation, tracked/pending intents, effects, history/blocklist distinctions, and scenarios.

- Each public queue intent MUST compile to one reviewed upstream request shape per supported application/version.
- The adapter MUST reject flag combinations not represented by a declared intent.
- Per-item apply records MUST be created before non-idempotent upstream egress.

## Design

### Approach

- Implement a state transition table for tracked and pending queue item kinds.
- Map each intent to the exact Sonarr/Radarr queue action and relevant flags.
- Capture queue, tracked-download, media, and replacement-search preconditions in plans.
- Reconcile ambiguous outcomes using queue state, and history matched on download identity where the queue is ambiguous.
- Keep `route_to_manual_import` as a transition that returns an import-inspection path; it does not import.

### Decisions

- **Decision:** Name effects instead of exposing delete flags.
  - **Why:** Flag precedence is surprising and some combinations imply deletion or automatic search.
  - **Alternatives considered:** A generic queue-delete tool was rejected.
- **Decision:** Process bulk mutations independently.
  - **Why:** Upstream bulk actions are not transactional and may skip stale IDs.
- **Decision:** Reconcile a lost outcome from queue state and from history matched on the download identity, and from nothing else.
  - **Why:** Reconciliation may only settle an unknown outcome on evidence that can be tied to the apply being reconciled. The queue answers that directly: every transition that sends anything removes the row, so a row that is gone confirms the request arrived and a row still queued in the state the mutation was compiled against says it did not. History qualifies once it is matched on the salted download digest, which names the download the row stands for rather than the series it belongs to.
  - **Alternatives considered:** Blocklist and command state were evaluated as corroboration and deliberately excluded. A blocklist record carries no download identity, and the only other keys are the release title, which this server does not retain, and the media association — so a release blocked for the same series last week would settle an unknown outcome as a success. A command is instance-wide, and a search running now may have been started by a scheduled task, by another caller, or by an unrelated grab. Reading either would manufacture confidence rather than establish it, and reporting an unknown outcome as a success is the one direction a receipt must never round in.

### Non-Goals

- Manual import execution
- History-failure and blocklist-record mutations, which are owned by change 0010; clear-all commands remain unsupported
- Download-client operations outside the *arr queue contract
- Prowlarr queue mutations, because Prowlarr has no equivalent managed-download queue

## Tasks

- [x] Implement queue transition compilation
  - [x] Add tracked intents and exact remove/blocklist/category/search flag mappings
  - [x] Add pending-release intents and validation
  - [x] Add state-kind and impossible-combination tests for Sonarr and Radarr
- [x] Implement plan/apply and reconciliation
  - [x] Capture queue/download/media read-set fingerprints and exact predicted effects
  - [x] Add direct apply, planned apply, stale-plan, partial bulk, retry, and unknown-outcome paths
  - [x] Reconcile against queue state and against history matched on download identity
- [ ] Register and verify `arr_queue_resolve`
  - [ ] Add typed input/output unions and conservative annotations
  - [ ] Add fixture and stdio tests for data deletion, blocklist, replacement search, ignore, category change, pending grab, and stale references
  - [ ] Add audit-safe receipts without canonical paths or download IDs

## Open Questions

None.

## References

- Spec: [Activity Management](../specs/activity-management/)
- Related changes: [0002-tool-runtime](./0002-tool-runtime.md), [0004-activity-diagnostics](./0004-activity-diagnostics.md)
