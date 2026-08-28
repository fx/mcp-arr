# 0021: Live-Verified Fixtures

## Summary

Give the project a repeatable way to capture upstream fixtures from the instances they name, and bring the fixtures no other change owns into line with what those instances genuinely return. Four fixtures are demonstrably counterfactual today, which is why 1034 passing tests reported a healthy server while six tool paths were broken against the real applications. The [Architecture spec](../specs/architecture/#testing-contract) now states the rule.

Two of those four are the failing test for a defect with its own change document, so they are corrected there rather than here — see [Ownership](#ownership) below.

**Spec:** [Architecture](../specs/architecture/)
**Status:** draft
**Depends On:** [0022](./0022-upstream-field-shape-tolerance.md), [0023](./0023-radarr-exclusion-route.md)

## Motivation

Sweeping all fourteen tools against the live stack — Sonarr 4.0.19.2979, Radarr 6.3.0.10514, Prowlarr 2.5.2.5491, the exact versions [Architecture](../specs/architecture/#version-compatibility) records as the supported minimums — found six defects. The full gate was green for every one of them: 77 test files, 1034 tests, type check, lint, and package verification all passed.

The fixtures are not missing and not unversioned. They are stored per application, per API version, per exact version number, they carry an `endpoint` in their metadata, and a contract test validates the whole inventory. The mechanism is sound. The bodies are wrong:

| Fixture | Records | The named instance actually returns |
|---|---|---|
| `sonarr/v3/4.0.19.2979/release.json` | `indexerFlags: ["G_Freeleech"]` | `indexerFlags: 0` on all 144 rows |
| `sonarr/v3/4.0.19.2979/manualimport.json` | `indexerFlags: ["freeleech"]` | `indexerFlags: 0` |
| `radarr/v3/6.3.0.10514/manualimport.json` | `indexerFlags: []` | `indexerFlags: 0` |
| `radarr/v3/6.3.0.10514/importlistexclusion.json` | a body for `/api/v3/importlistexclusion` | `404` — Radarr serves `/api/v3/exclusions` |

The last one is the clearest tell: a fixture records a response from a route that does not exist on the application it names. These bodies were authored to the shape the adapter expected rather than captured from an instance, so every fixture-backed test confirmed the adapter against its own assumption. That is a closed loop, and it will keep producing defects of exactly this kind — it already has once before, when a provider field's absent `value` key broke `arr_config_observe` against every real instance while the fixtures passed.

The fix is not more tests. It is making the recorded contract answerable to the instance it claims to describe.

### Ownership

A corrected fixture is not a chore to be batched — it is the failing test that proves a defect is real. Where one exposes a defect that has its own change document, correcting it belongs to that document, so the correction and the adapter fix land together and the gate is green at every commit:

| Fixture | Corrected by | Because |
|---|---|---|
| `sonarr/…/release.json` | [0022](./0022-upstream-field-shape-tolerance.md) | it is that change's red test; the adapter fix turns it green |
| `radarr/…` exclusions | [0023](./0023-radarr-exclusion-route.md) | same — the route fix is what makes the recaptured body reachable |
| `sonarr/…/manualimport.json` | **this change** | no point fix needs it; the import adapter already tolerates the real shape |
| `radarr/…/manualimport.json` | **this change** | same |

The two this change corrects break no adapter, because the import adapter already declares the field permissively. They do break the assertions written against the counterfactual bodies, and updating those assertions is part of this change's work rather than a surprise for whoever runs the suite next.

That split is why this change depends on [0022](./0022-upstream-field-shape-tolerance.md) and [0023](./0023-radarr-exclusion-route.md) and lands after both: until each has corrected its own fixture, a sweep here would either have to correct it for them — landing red, since the adapter fix is not in — or record that it deliberately left a known-counterfactual fixture in place. It has no ordering relationship to 0024 through 0027, which touch no fixture.

The prerequisite list is therefore open at the point the sweep runs. Any divergence the sweep finds that needs an adapter change adds one: the [Architecture spec](../specs/architecture/#testing-contract) requires every recorded fixture to match the instance it names, so completing this change while knowingly leaving one that does not would violate the contract this change exists to establish. Filing a follow-up is not a substitute for that — a change nobody has landed leaves the fixture counterfactual just the same.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules (see [Architecture — Testing Contract](../specs/architecture/#testing-contract)). CI enforces these as merge gates:

- Exported behavior MUST have automated tests at the narrowest practical level.
- Adapter tests MUST use sanitized, version-labelled fixtures rather than personal live instances.
- Stdio integration tests MUST verify protocol framing and stdout cleanliness.
- Build, type check, lint, and tests MUST pass without focused or skipped tests.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

Additionally, because this change is about the fixtures themselves:

- The capture procedure MUST NOT become a test. Running the suite MUST NOT require an instance, a network, or credentials.
- Recaptured bodies MUST pass the existing fixture contract test, including its secret and identifying-value screens, without weakening any of those screens to accommodate a captured value.

### Functional requirements

The [Architecture spec](../specs/architecture/#testing-contract) owns the fixture-fidelity rule and its scenario — this change's acceptance criteria, not restated here. What implementing them requires of this change:

- A capture procedure MUST exist that an operator can run against a configured instance to produce or refresh a fixture, and MUST sanitize secrets, identifying values, and canonical paths before writing.
- The captured metadata MUST record the application, API version, exact instance version, and route, so a later reader can re-verify the body against the same source.
- A fixture whose route the named application does not serve MUST be detectable, so a recorded route that 404s cannot survive as a passing fixture.
- The two `manualimport` fixtures MUST be corrected to the shapes their instances return, together with the assertions written against their current bodies, so this change lands with a green gate.
- Every remaining recorded fixture MUST be checked against its instance.
- Where a divergence the sweep finds needs an adapter change, that change MUST be created and MUST become a prerequisite of this one, so this change cannot be completed while a fixture it knows to be counterfactual is still recorded.
- Correcting a fixture MUST NOT quietly relax the adapter that reads it; the adapter fix belongs to the change created for it.

#### Scenario: A correction would need an adapter change

- **GIVEN** a fixture is recaptured and its real shape is one the adapter refuses
- **WHEN** the divergence is found
- **THEN** a change owning that adapter fix is created and recorded as a prerequisite of this one, the fixture is not edited back toward what the adapter accepts, and this change is not complete until that fixture matches its instance

## Design

### Approach

- Add an operator-run capture script, outside the test suite, that reads a route from a configured instance and writes a sanitized fixture with full metadata.
- Reuse the existing sanitizing and validation helpers so a captured fixture is held to the same screens a hand-written one is.
- Correct the two `manualimport` fixtures and the assertions written against them, leaving the other two to the changes that own them.
- Sweep the remaining fixtures against their instances and report what the sweep finds.
- Record the capture command and its expectations in the project documentation so a future contributor refreshes rather than authors.

### Decisions

- **Decision:** Capture is an operator-run script, not a test.
  - **Why:** [Architecture](../specs/architecture/#testing-contract) forbids committed tests that depend on live personal instances, and that rule is right — CI has no instances and must stay offline. The fidelity guarantee comes from the captured artifact being committed, not from the suite reaching an instance.
  - **Alternatives considered:** An opt-in integration suite gated on environment variables, rejected because a suite that is skipped in CI provides no gate and drifts exactly as the fixtures did.
- **Decision:** Each defect's own change corrects the fixture that exposes it; this change corrects only what no point fix needs.
  - **Why:** The corrected fixture is the failing test for that defect, so the two belong in one commit — the test goes red, the fix turns it green, and the gate holds at every point. Batching the corrections here instead would land a change that is knowingly red, which the project's testing contract forbids, and would leave each point fix with nothing demonstrating it was needed.
  - **Alternatives considered:** Correcting all four here and letting the failures stand until the point fixes land, rejected because it breaks the green gate this change is itself held to; one change fixing every fixture and adapter together, rejected because it produces a large PR in which no individual defect can be shown to have been caught.
- **Decision:** Depend on 0022 and 0023, and land after both.
  - **Why:** The sweep this change runs has to reach every fixture, including the two those changes own. Running it before they land would force one of two bad outcomes: correct their fixtures here and land red, because neither adapter fix is in yet, or record a known-counterfactual fixture as acceptable, which is the habit this change exists to end. Waiting costs nothing, since neither point fix depends on anything here.
  - **Alternatives considered:** Landing first with the two fixtures excluded from the sweep, rejected because an excluded fixture is exactly what went unnoticed for six defects.
- **Decision:** A divergence the sweep finds becomes a prerequisite, not a follow-up.
  - **Why:** This change establishes the rule that a recorded fixture matches the instance it names. Completing it while knowingly leaving one that does not would break that rule at the moment it is written down, and a filed follow-up changes nothing about the fixture until someone lands it. Making the corrective change a prerequisite is what turns the rule into a gate.
  - **Alternatives considered:** Filing a follow-up and completing anyway, rejected because it is the same "known-counterfactual fixture is acceptable for now" habit that produced all six defects; correcting the adapter here, rejected because it puts an unreviewed adapter fix inside a fixtures change.
- **Decision:** Record the route in metadata and verify it resolves at capture time.
  - **Why:** The Radarr exclusions fixture proves a wrong route can otherwise be recorded, validated, and depended on indefinitely. A route that 404s must fail at capture rather than become a fixture.
- **Decision:** Do not raise the recorded minimum versions.
  - **Why:** The observed instances are already at the recorded minimums. Nothing here depends on newer behavior, and [Architecture](../specs/architecture/#version-compatibility) allows raising the minimum only when the implementation knowingly requires it.

### Non-Goals

- Correcting the Sonarr `release` fixture or the Radarr exclusions fixture — each is the red test of the change that owns it, [0022](./0022-upstream-field-shape-tolerance.md) and [0023](./0023-radarr-exclusion-route.md) respectively.
- Fixing any adapter defect a corrected fixture reveals.
- Capturing routes the server does not currently read.
- Testing against live instances in CI.
- Changing the fixture storage layout, metadata schema, or contract test beyond adding route verification.

## Tasks

- [ ] Add the operator-run fixture capture procedure
  - [ ] Write a capture script that reads a route from a configured instance and emits a fixture with application, API version, exact version, and route metadata
  - [ ] Sanitize secrets, identifying values, and canonical paths through the existing helpers, and fail the capture rather than write a body that would not pass the contract test
  - [ ] Fail the capture when the named route does not resolve on the named application
  - [ ] Document the procedure so fixtures are refreshed rather than authored
- [ ] Correct the fixtures no point fix owns
  - [ ] Recapture the Sonarr and Radarr `manualimport` fixtures, and update the assertions written against their current bodies so the suite stays green
  - [ ] Confirm the import adapter needs no change to read the recaptured bodies
- [ ] Sweep the remaining fixtures
  - [ ] Compare every other recorded fixture against its instance at the version it names
  - [ ] For any divergence needing an adapter change, create that change, record it as a prerequisite of this one, and do not complete this change until it has landed and the fixture matches
  - [ ] Confirm at completion that no recorded fixture is known to contradict the instance it names

## Open Questions

None.

## References

- Spec: [Architecture](../specs/architecture/)
- Related changes: [0022-upstream-field-shape-tolerance](./0022-upstream-field-shape-tolerance.md), [0023-radarr-exclusion-route](./0023-radarr-exclusion-route.md), [0024-manual-import-request-shape](./0024-manual-import-request-shape.md), [0025-job-projection-refresh](./0025-job-projection-refresh.md)
