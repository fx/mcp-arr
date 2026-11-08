# 0035: Fixtures at Newer Versions

## Summary

Let a fixture be recorded at more than one version of an application. Today the fixture contract approves exactly one version per application — the recorded minimum — and `scripts/capture-fixture.mjs` refuses any instance that reports a different version, so a route or a response shape that only a newer instance can give has nowhere truthful to be recorded. This change gives each application one newer recorded version beside its minimum, with its own approved route list that starts empty, and has the capture write under whichever recorded version the instance reports. Every existing fixture stays where it is and stays the evidence for the minimum; the minimum supported versions do not move.

**Spec:** [Architecture](../specs/architecture/)
**Status:** complete
**Depends On:** —

## Motivation

The instances available for capture now run newer releases than the fixtures were recorded from:

| Application | Recorded minimum | Instance reports |
|---|---|---|
| Sonarr | 4.0.19.2979 | 4.0.20.3014 |
| Radarr | 6.3.0.10514 | 6.4.4.10685 |
| Prowlarr | 2.5.2.5491 | 2.7.0.5723 |

The capture compares the reported version against the one approved version and refuses on any difference, which is right as far as it goes: a body read from 4.0.20.3014 and written under `4.0.19.2979/` would be a fixture that lies about where it came from, which is the defect [0021](./0021-live-verified-fixtures.md) exists to end. But the only way the procedure offers past the refusal is to "raise the recorded version deliberately first", and that is the wrong lever. [Architecture — Version Compatibility](../specs/architecture/#version-compatibility) raises a minimum only when the implementation knowingly depends on behavior an older supported version lacks. Changes [0031](./0031-media-toolset-library.md) and [0032](./0032-media-toolset-activity.md) need to capture routes they read for the first time, and nothing about them depends on the newer releases. Raising the minimum to capture them would drop support for versions the server still works against, and recapturing the whole inventory at the new versions would discard the only evidence that it does.

What is missing is a place to record a body truthfully at the version it came from, without it standing in for the minimum.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules (see [Architecture — Testing Contract](../specs/architecture/#testing-contract)). CI enforces these as merge gates:

- Exported behavior MUST have automated tests at the narrowest practical level.
- Adapter tests MUST use sanitized, version-labelled fixtures rather than personal live instances.
- Stdio integration tests MUST verify protocol framing and stdout cleanliness.
- Build, type check, lint, and tests MUST pass without focused or skipped tests.
- A recorded fixture MUST be a response the application it names genuinely produces at the version and route it names, and refreshing one MUST stay a sanitizing procedure outside the suite.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

Additionally, because this change widens what the fixture contract will accept:

- The contract test MUST cover every recorded version: no file may exist that the inventory does not approve, every approved file MUST exist, and each file's metadata, version, and path MUST agree — at newer versions exactly as at the minimum.
- The version-aware lookup MUST be tested both ways: a test that names no version reads the minimum's fixture even where the route is also recorded at a newer one, and a route recorded only at a newer version is never handed to a test that did not ask for it.
- The derivation MUST be tested against a record that holds a newer version with routes in it, since the real record's newer versions start empty.
- The capture's version selection MUST be tested against a loopback stub, never a live instance: an unrecorded version is refused, a recorded newer version is refused for a route not approved there, and neither refusal writes a file.
- No existing fixture file may change.

### Functional requirements

- The fixture contract MUST approve, per application, the minimum supported version with its full route inventory unchanged, and a newer recorded version with its own approved route list.
- One fixture MUST exist for at most one combination of application, version, and route, and its file name, endpoint, and relative path MUST be derived from that combination exactly as they are today.
- A version recorded beside an application's minimum MUST be newer than it, and every recorded version of one application MUST share one API version.
- A test that names no version MUST read the fixture recorded at the application's minimum supported version.
- A test MUST be able to name the version it reads, and a version another application records at MUST NOT type-check.
- The capture MUST select the version a fixture is written under from the version the instance reports, MUST write only a route approved at that version, and MUST refuse otherwise with a message naming the recorded versions.
- Every existing sanitization and safety screen in the capture MUST be unchanged.

#### Scenario: Record a route at a newer version

- **GIVEN** an application's fixtures are recorded at its minimum supported version, and a route is approved at a newer version
- **WHEN** that route is captured from an instance reporting the newer version
- **THEN** the fixture is written under and labelled with the newer version, every minimum-version fixture is left unchanged, and the minimum supported version is unchanged

#### Scenario: A newer instance for a route not approved there

- **GIVEN** an instance reports a recorded newer version, and a route is approved only at the minimum
- **WHEN** that route is captured
- **THEN** the capture refuses, names the version the route is approved at, and writes nothing

## Design

### Approach

- Replace the flat tuple list and the per-application route map in `scripts/fixture-contract.mjs` with one record: per application, its API version, its minimum, and a route list per recorded version.
- Derive everything else from that record in one exported function, `createFixtureInventory`, and export the module's existing names as that function applied to the real record: `approvedFixtureTuples` (now every recorded version), `approvedFixtures`, `approvedFixtureInventory`, `fixturePathFor`. Add `minimumFixtureTuples` and `captureTargetFor`.
- Give `fixturePathFor` an optional third argument, `fixturePathFor(application, route, { version })`. Without it the lookup is the minimum's, so every existing caller is unchanged.
- Have `captureTargetFor(application, route, reportedVersion)` return which fixture the capture may write or why none — an unrecorded version, or a recorded one the route is not approved at — and have the capture turn each answer into its refusal.
- Compare `applicationDescriptors` against `minimumFixtureTuples` rather than against every recorded tuple, since the descriptors record the minimum.

### Decisions

- **Decision:** Record newer versions beside the minimum rather than raising the minimum and recapturing the inventory.
  - **Why:** The minimum is a support promise, not a capture convenience. The Architecture spec raises it only when the implementation depends on newer behavior, and nothing here does. Recapturing at the newer versions would also discard the minimum-version fixtures, which are the only evidence the server still works against the versions it claims to support; after that, nothing in the suite would fail if a change broke them.
  - **Alternatives considered:** Raising the three minimums and recapturing every route, rejected for both reasons above; recording newer bodies under the minimum's directory, rejected because it is the mislabelling 0021 exists to end.
- **Decision:** Each newer version gets its own route list, starting empty.
  - **Why:** Approving a route is what authorizes a fixture file, and it should stay one deliberate edit per route per version. If a newer version inherited the minimum's list, the inventory would require about seventy new files at once, and a capture would be allowed for any route without anyone having decided it needed a newer body.
  - **Alternatives considered:** Inheriting the minimum's routes, rejected for the reason above; a per-version list that also overrides the minimum's fixture for a test that names no version, rejected because a test would then change what it is evidence for without saying so.
- **Decision:** The minimum is named explicitly in the record, and a version beside it must order after it.
  - **Why:** Deriving the minimum from version order alone would let a typo in a newer label silently become the minimum. Naming it, and refusing a "newer" version that is not newer, catches both mistakes when the module loads, in the test suite and the capture alike.
  - **Alternatives considered:** A `minimum: true` flag per tuple, rejected because it needs a separate check for exactly one per application, which an explicit field gets for free.
- **Decision:** One API version per application.
  - **Why:** The route list is stated against an API version, and the capture has to compose its status request before it knows which version the instance is. A newer release that moved to another API version would be a different contract, not a newer recording of this one, and would need its own change.
  - **Alternatives considered:** An API version per recorded version, rejected because the capture would have to probe each API base before it could read a version, for a case none of the three applications presents.
- **Decision:** A version-aware option on `fixturePathFor` rather than a second lookup function.
  - **Why:** REVIEW.md requires tests to address fixtures by route through `fixturePathFor`. One function with an optional version keeps that the only door, and its type ties the version to the application it is passed with, so a Radarr version passed for Sonarr does not compile.
  - **Alternatives considered:** A separate `newerFixturePathFor`, rejected because two lookups invite a test to reach for the wrong one; giving `activityFixture` and `fixtureBody` the option now, deferred until a newer-version fixture exists for one of them to read.
- **Decision:** The capture's version selection lives in the contract module.
  - **Why:** `capture-fixture.mjs` runs its procedure when it is imported, so a decision made inside it can only be tested by spawning it. Putting the selection in `captureTargetFor` lets it be unit-tested against a record that holds a newer route — which the real record does not yet — while the spawned tests cover the refusals the real record can produce.

### Non-Goals

- Capturing any fixture. No fixture file is added or changed here; the first newer-version captures belong to 0031 and 0032.
- Raising any minimum supported version, or changing [Architecture — Version Compatibility](../specs/architecture/#version-compatibility).
- Any change under `src/`.
- Approving a newer version beyond the one per application listed in Motivation.

## Tasks

- [x] Record fixtures at more than one version per application
  - [x] Restate the approved tuples and routes in `scripts/fixture-contract.mjs` as one per-application record of a minimum and per-version route lists, with Sonarr 4.0.20.3014, Radarr 6.4.4.10685, and Prowlarr 2.7.0.5723 approved with no routes
  - [x] Derive the inventory in `createFixtureInventory`, refusing a duplicate fixture, a minimum with no routes, a version beside the minimum that is not newer, and a version label that is not dotted digits
  - [x] Add `fixturePathFor(application, route, { version })`, defaulting to the minimum, and `minimumFixtureTuples` and `captureTargetFor`, with declarations in `scripts/fixture-contract.d.mts` and re-exports in `test/support/fixtures.ts`
  - [x] Compare the application descriptors against the minimum tuples in `test/applications.test.ts`
- [x] Capture under the version the instance reports
  - [x] Select the fixture in `scripts/capture-fixture.mjs` through `captureTargetFor`, refusing an unrecorded version and a recorded version the route is not approved at, with the sanitizer and every screen unchanged
  - [x] Describe the recorded versions and the new refusal in `README.md`
- [x] Test it
  - [x] Cover the six declared tuples, the minimum tuples, the derivation over a record holding a newer route, the version-aware lookup both ways, the capture selection, and the derivation's refusals in `test/fixture-contract.test.ts`
  - [x] Cover the unrecorded-version, unreported-version, and newer-version-route refusals against a loopback stub in `test/fixture-capture.test.ts`
- [x] Record the rule in [Architecture — Testing Contract](../specs/architecture/#testing-contract), with a scenario and a changelog row

## Open Questions

None. The user was not available for design questions, so each ambiguity was resolved to the safer reading and recorded under Decisions: the minimum is unchanged, newer routes are approved one at a time, and a test reads a newer body only by naming its version.

## References

- Spec: [Architecture](../specs/architecture/)
- Related changes: [0021-live-verified-fixtures](./0021-live-verified-fixtures.md), [0031-media-toolset-library](./0031-media-toolset-library.md), [0032-media-toolset-activity](./0032-media-toolset-activity.md)
