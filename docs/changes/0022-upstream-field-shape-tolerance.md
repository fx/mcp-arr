# 0022: Upstream Field Shape Tolerance

## Summary

Stop refusing an entire release search because one advisory field arrived as a number instead of a list. Sonarr 4.0.19.2979 sends `indexerFlags` as a numeric bitmask, the acquisition adapter declares it as an array, and every Sonarr interactive search therefore fails with `unexpected_response`. The [Architecture spec](../specs/architecture/#upstream-connection-handling) now states the rule.

**Spec:** [Architecture](../specs/architecture/)
**Status:** draft
**Depends On:** —

## Motivation

`arr_release_search` fails for `sonarr_episode` and `sonarr_season` one hundred percent of the time. Reading `GET /api/v3/release?seriesId=2&seasonNumber=4` from Sonarr 4.0.19.2979 returns 200 with 144 releases; validating those rows against the adapter's schema fails **144 of 144**, every one on the same issue:

```
{"expected":"array","code":"invalid_type","path":["indexerFlags"],
 "message":"Invalid input: expected array, received number"}
```

The shape divergence is real and splits by application and by endpoint:

| Source | `indexerFlags` |
|---|---|
| Sonarr `GET /api/v3/release` | `0` — number, all 144 rows |
| Radarr `GET /api/v3/release` | `[]` — array, all 228 rows |
| Sonarr `GET /api/v3/manualimport` | `0` — number |
| Radarr `GET /api/v3/manualimport` | `0` — number |

So Radarr's search is unaffected, which is why the defect looked application-specific rather than structural.

The code already knows this. The comment above the declaration says indexer flags "have been a string list and a numeric bitmask across releases" and that "neither is worth refusing a whole search over" — and then the declaration refuses one. The import adapter, reading the same concept from a sibling endpoint, uses the tolerant form and survives. One adapter implemented the intent; the other wrote it down and did the opposite.

The field is advisory. Nothing in a release result depends on it: the mapper keeps only values it can name as strings and drops the rest. A bitmask it cannot name should yield no flags, not destroy the search.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules (see [Architecture — Testing Contract](../specs/architecture/#testing-contract)). CI enforces these as merge gates:

- Exported behavior MUST have automated tests at the narrowest practical level.
- Adapter tests MUST use sanitized, version-labelled fixtures rather than personal live instances.
- Stdio integration tests MUST verify protocol framing and stdout cleanliness.
- Build, type check, lint, and tests MUST pass without focused or skipped tests.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

Additionally, because the defect is a refused result rather than a wrong value:

- The Sonarr release fixture MUST carry the numeric `indexerFlags` its instance sends, so a test fails if the array-only declaration returns. Correcting it is this change's own work, not [0021](./0021-live-verified-fixtures.md)'s: it is the red test the adapter fix turns green, and the two MUST land together so the gate holds at every commit.
- The assertions written against the fixture's current flag arrays MUST be updated in the same change, so correcting the fixture does not leave the suite failing for an unrelated reason.
- A test MUST assert that a release carrying an unnameable flags value is returned with no flags rather than dropped or errored.

### Functional requirements

The [Architecture spec](../specs/architecture/#upstream-connection-handling) owns the rule that an unmodelled shape in a field the answer does not depend on must be dropped rather than fail the result, and its scenario is this change's acceptance criterion. What implementing them requires of this change:

- The release schema MUST accept the shapes both applications send for `indexerFlags` at the recorded minimum versions, and MUST NOT require either one.
- A value it cannot name MUST produce no indexer flags on the mapped release, leaving every other mapped field intact.
- The tolerance MUST NOT extend to fields the result genuinely depends on; a release with no usable identity or title MUST still be refused.
- The acquisition and import adapters MUST agree on how this field is declared, so the same concept cannot be strict in one and tolerant in the other.

#### Scenario: A bitmask reaches the release mapper

- **GIVEN** Sonarr returns releases whose `indexerFlags` is a number
- **WHEN** an episode or season search runs
- **THEN** every release is returned with its quality, decision, and other fields intact, and none carries a named indexer flag

## Design

### Approach

- Declare the field as an unconstrained optional value, matching the form the import adapter already uses, and let the existing name filter keep only the strings.
- Recapture or correct the Sonarr release fixture so the numeric shape is the recorded contract.
- Add a case for the unnameable value, asserting the release survives with no flags.
- Check the remaining advisory fields in the same schema against the captured bodies for the same class of divergence, and report anything found rather than widening this change.

### Decisions

- **Decision:** Accept any shape for this field rather than accepting a number specifically.
  - **Why:** The field has already shipped as a string list and as a bitmask across versions, so enumerating today's two shapes only defers the same failure to the next one. Nothing depends on the value, so there is no benefit to constraining it.
  - **Alternatives considered:** A union of array and number, rejected because it re-breaks on the next shape and buys nothing the name filter does not already give.
- **Decision:** Do not decode the bitmask into flag names.
  - **Why:** The bit-to-name mapping is an internal Sonarr enum, not a documented contract, and inventing names for it would publish a claim this project cannot keep true across versions. Reporting no flags is honest; reporting guessed flags is not.
  - **Alternatives considered:** Decoding known bits, rejected for the reason above.
- **Decision:** Align the two adapters on one declaration rather than only fixing acquisition.
  - **Why:** The divergence is the defect. Leaving two declarations of one concept guarantees they drift again.

### Non-Goals

- Adding indexer-flag filtering, sorting, or scoring.
- Changing Radarr or Prowlarr search behavior, which is correct.
- Relaxing any field a release result depends on.
- Repairing any fixture other than the Sonarr release one, or adding the capture procedure — that is [0021](./0021-live-verified-fixtures.md).

## Tasks

- [ ] Tolerate the shapes both applications send for indexer flags
  - [ ] Declare the field so neither an array nor a number is refused, matching the import adapter's existing form
  - [ ] Confirm an unnameable value maps to no flags with every other field intact
  - [ ] Assert that the tolerance does not spread: a release carrying no usable identity or title is still refused, so the schema has not been loosened beyond the advisory field
  - [ ] Correct the Sonarr release fixture to the numeric shape, update the assertions written against its current flag arrays, and add a case for an unnameable value — confirming the fixture correction fails against the current declaration before the fix lands
- [ ] Check the rest of the release schema against captured bodies
  - [ ] Compare each declared field against the Sonarr and Radarr release bodies and report any further divergence rather than widening this change

## Open Questions

None.

## References

- Spec: [Architecture](../specs/architecture/)
- Related changes: [0005-release-search-and-grab](./0005-release-search-and-grab.md), [0021-live-verified-fixtures](./0021-live-verified-fixtures.md)
