# 0014: Calendar Anchoring

## Summary

Anchor each calendar entry to the date that actually placed it inside the requested window, and name that date. Radarr entries are currently anchored by a fixed release-date precedence that ignores the query, so most entries report a date outside the window the caller asked for. The [Library Management spec](../specs/library-management/#library-queries) now states the rule.

**Spec:** [Library Management](../specs/library-management/)
**Status:** draft
**Depends On:** —

## Motivation

Querying the calendar against a live Radarr instance for 1–31 August 2026 returned six movies, four of which reported an anchor date outside that window. One reported October 2022 — nearly four years early.

The cause is that a Radarr movie has three candidate release dates. Radarr matches a movie into a calendar window if any of them falls inside it, and the adapter then anchors the entry to whichever exists first in a fixed order of digital, physical, cinema. When a movie matched on its physical release but also has an earlier digital release, the entry is anchored to the earlier date. A consumer rendering or sorting by that date sees entries scattered outside the range it requested.

Two things follow. The anchor is wrong, and the entry does not say which date it represents, so a consumer cannot even correct for it. Sonarr is unaffected: an episode has a single air date, and its entries were correct in the same test.

The implementation was not wrong by the letter of the spec, because the spec said only that calendar views support ranges and never said which date anchors a movie. That is why the spec is amended alongside the fix.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules (see [Architecture — Testing Contract](../specs/architecture/#testing-contract)). CI enforces these as merge gates:

- Exported behavior MUST have automated tests at the narrowest practical level.
- Adapter tests MUST use sanitized, version-labelled fixtures rather than personal live instances.
- Stdio integration tests MUST verify protocol framing and stdout cleanliness.
- Build, type check, lint, and tests MUST pass without focused or skipped tests.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

Additionally, because the defect is a wrong value rather than a failure:

- Fixtures MUST include a movie whose candidate dates differ and whose matching date is not the one the current precedence selects, so the defect cannot return silently.

### Functional Requirements

The [Library Management spec](../specs/library-management/#library-queries) owns calendar anchoring and disclosure, and its scenarios are this change's acceptance criteria. What implementing them requires of this change:

- Anchoring MUST be derived from the requested window rather than from a fixed precedence, since the same movie belongs on a different date depending on the window queried.
- A movie whose candidate dates place it in a window more than once MUST yield a defined, deterministic anchor rather than an arbitrary one.
- The anchor's date type MUST be surfaced through the existing application-specific extension mechanism, so it stays distinguishable from normalized shared fields.
- The event's end MUST remain consistent with its anchor, since it is currently derived from the anchor and a runtime.
- Sonarr calendar mapping MUST remain unchanged.

#### Scenario: The same movie in two different windows

- **GIVEN** a Radarr movie whose digital and physical release dates fall in different months
- **WHEN** the calendar is queried for the month containing the digital release, and again for the month containing the physical release
- **THEN** each query anchors the entry to the date inside its own window and names that date type

## Design

### Approach

- Replace the fixed precedence with selection against the requested window, choosing among the candidate dates the one that falls inside it.
- Define the tie-break for a movie matching on more than one candidate date, and record it.
- Add the anchor's date type to the Radarr extension fields.
- Extend fixtures with a movie whose matching date is not the one the old precedence would have chosen, and assert the anchor falls inside the requested window.

### Decisions

- **Decision:** Fix anchoring in the adapter rather than filtering entries after mapping.
  - **Why:** The entries are genuinely in the window — Radarr is right to return them. Only the date the entry reports is wrong, so discarding them would lose real results and mask the defect.
  - **Alternatives considered:** Dropping entries whose anchor is outside the window, rejected because it would have silently hidden four of six correct results in the observed case.
- **Decision:** Surface the anchor's date type as an application-specific field.
  - **Why:** Only Radarr has multiple candidate dates. Adding the concept to the shared model would impose a field Sonarr has no meaningful value for.
  - **Alternatives considered:** A normalized shared field, rejected for the reason above.
- **Decision:** Treat the anchor change as a correction rather than a breaking change.
  - **Why:** The current values are wrong; a consumer cannot be depending on them correctly. The added date type is additive.

### Non-Goals

- Changing Sonarr calendar behavior, which is correct.
- Changing which movies Radarr returns for a window — that is Radarr's decision and remains so.
- Adding filtering or sorting by release-date type.
- Revisiting any other view's date handling.

## Tasks

- [ ] Anchor Radarr calendar entries to the matching date
  - [ ] Select the anchor from the requested window instead of a fixed precedence, and define the tie-break when several candidates match
  - [ ] Surface the anchor's date type as a Radarr extension field and keep the event end consistent with it
  - [ ] Add fixture coverage for a movie whose matching date differs from the old precedence, asserting the anchor falls inside the requested window, and confirm the test fails against the current implementation

## Open Questions

- [ ] When several candidate dates fall inside the same requested window, which one anchors the entry? The earliest inside the window is the most predictable and is the recommended default, but a consumer building a release calendar may expect the physical release to win. Worth confirming before implementation, and worth recording in the spec once chosen.

## References

- Spec: [Library Management](../specs/library-management/)
- Related changes: [0003-library-queries](./0003-library-queries.md)
