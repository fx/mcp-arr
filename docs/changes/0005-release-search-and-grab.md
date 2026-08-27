# 0005: Release Search and Grab

## Summary

Implement stateful Sonarr, Radarr, and Prowlarr release search plus typed grab using expiring opaque references as defined by the [Acquisition and Import spec](../specs/acquisition-and-import/).

**Spec:** [Acquisition and Import](../specs/acquisition-and-import/)
**Status:** draft
**Depends On:** 0002, 0003

## Motivation

Upstream grab endpoints depend on short-lived server-side search caches. Treating grab as an independent URL operation is incorrect and exposes protected URLs. The MCP needs one bounded search-to-reference-to-grab workflow.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules (see [Architecture — Testing Contract](../specs/architecture/#testing-contract)). CI enforces these as merge gates:

- Exported behavior MUST have automated tests at the narrowest practical level.
- Adapter tests MUST use sanitized, version-labelled fixtures rather than personal live instances.
- Stdio integration tests MUST verify protocol framing and stdout cleanliness.
- Build, type check, lint, and tests MUST pass without focused or skipped tests.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

### Functional Requirements

The [Acquisition and Import spec](../specs/acquisition-and-import/#release-search) owns release search, grab, completeness, expiry, and automatic-search behavior. Manual import remains deliberately unimplemented until change 0007.

- Release references MUST retain only process-local cache identity needed to re-establish the exact upstream result.
- Adapter fixtures MUST exercise stale caches, rejected results, partial indexer failure, and per-item bulk grab outcomes.
- Protected URLs MUST be removed before results reach shared envelopes or diagnostics.

## Design

### Approach

- Implement Sonarr episode/season interactive search and Radarr movie interactive search.
- Implement Prowlarr aggregate search with per-indexer completeness metadata.
- Store opaque release references with application, media context, upstream cache identity, and expiry shorter than the upstream cache.
- Implement typed single/bulk grab and allowlisted automatic-search commands.

### Decisions

- **Decision:** Grab only by opaque search result reference.
  - **Why:** Upstream servers resolve grabs from their own 30-minute caches.
  - **Alternatives considered:** Raw URL, GUID, and posted release payloads were rejected.
- **Decision:** Return partial Prowlarr search and grab outcomes.
  - **Why:** Prowlarr intentionally tolerates individual indexer failures.

### Non-Goals

- Release push by arbitrary URL
- Generic automatic command execution
- Queue resolution
- Manual import

## Tasks

- [x] Implement normalized release search
  - [x] Add Sonarr episode/season and Radarr movie search adapters
  - [x] Add Prowlarr aggregate search with per-indexer completeness
  - [x] Normalize decisions, rejections, quality, protocol, and safe metadata
- [x] Implement opaque release references and grab
  - [x] Bind search cache identity, application/media context, and expiration
  - [x] Implement typed single grab and Prowlarr per-item bulk grab
  - [x] Add direct apply, plan/apply, retry, and stale-cache reconciliation
- [ ] Implement and register `arr_search_start`
  - [ ] Add typed episode/season/series/movie/missing/cutoff command variants with plan/direct-apply behavior
  - [ ] Project resulting commands into normalized jobs
  - [ ] Add fixture and stdio tests for partial failure, cache expiry, rejection, redaction, and duplicate retry

## Open Questions

None.

## References

- Spec: [Acquisition and Import](../specs/acquisition-and-import/)
- Related changes: [0002-tool-runtime](./0002-tool-runtime.md), [0003-library-queries](./0003-library-queries.md)
