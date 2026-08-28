# 0023: Radarr Exclusion Route

## Summary

Read Radarr's import-list exclusions from the route Radarr serves. The domain map sends both applications to `importlistexclusion`, which Radarr answers with 404, so `arr_config_observe` fails for that domain on Radarr and reports the failure as a stale reference the caller never supplied.

**Spec:** [Configuration Reconciliation](../specs/configuration-reconciliation/)
**Status:** draft
**Depends On:** —

## Motivation

Observing `import_list_exclusions` returns a partial result: Sonarr answers, Radarr errors.

```
radarr: the request to importlistexclusion did not match an existing resource (status 404)
remediation: Repeat the query that produced the reference and use the fresh one.
```

Probing both instances directly settles it — the two applications name this resource differently, and each 404s on the other's name:

| Route | Sonarr 4.0.19.2979 | Radarr 6.3.0.10514 |
|---|---|---|
| `/api/v3/importlistexclusion` | 200 | 404 |
| `/api/v3/importlistexclusion/paged` | 200 | 404 |
| `/api/v3/exclusions` | 404 | 200 |
| `/api/v3/exclusions/paged` | 404 | 200 |

The domain map hard-codes `importlistexclusion` for both. The field allowlist for this domain already names `tmdbId`, `movieTitle`, and `movieYear` alongside Sonarr's `tvdbId`, so the Radarr half of the feature was designed and then pointed at a route that never existed. The recorded fixture is `radarr/v3/6.3.0.10514/importlistexclusion.json`, a body attributed to a route Radarr does not serve, which is why nothing caught it.

The second defect is in the reporting. A 404 is mapped to `stale_reference`, whose remediation tells the caller to repeat the query that produced the reference. This request carried no reference, so the advice is not merely unhelpful — it describes a recovery that does not apply, and it hides a permanent misconfiguration behind an error code that means "try again".

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules (see [Architecture — Testing Contract](../specs/architecture/#testing-contract)). CI enforces these as merge gates:

- Exported behavior MUST have automated tests at the narrowest practical level.
- Adapter tests MUST use sanitized, version-labelled fixtures rather than personal live instances.
- Stdio integration tests MUST verify protocol framing and stdout cleanliness.
- Build, type check, lint, and tests MUST pass without focused or skipped tests.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

Additionally:

- The Radarr fixture for this domain MUST be recorded against the route Radarr serves, so a fixture cannot again stand in for a route that 404s.
- A test MUST cover both applications for this domain, since a single-application test is what allowed a half-wrong route map to pass.

### Functional requirements

The [Configuration Reconciliation spec](../specs/configuration-reconciliation/#observe-configuration) owns exclusion observation and its scenarios — this change's acceptance criteria, not restated here. What implementing them requires of this change:

- The exclusion domain MUST resolve to each application's own route rather than one shared name.
- Both applications' exclusion records MUST be observable through the existing sanitized allowlist, which already names the fields each one contributes.
- Where the domain's route offers a paged form, observation MUST use it, since the spec requires every part of an observation to be governed by the query's page bound.
- A 404 from a route this server chose MUST NOT be reported as a stale reference when the request carried no reference.

#### Scenario: A route this server chose does not exist

- **GIVEN** an observation reaches a route the target application does not serve
- **WHEN** the application answers 404
- **THEN** the error identifies an unsupported or unexpected upstream response and does not advise repeating a query to refresh a reference the caller never supplied

## Design

### Approach

- Give the exclusion domain a per-application route, as the domain map already supports for other differences.
- Recapture the Radarr fixture from `exclusions` and keep the Sonarr fixture as it is.
- Extend the domain's tests to cover both applications.
- Separate the 404 mapping so a route-level miss on a referenceless request is not reported as a recoverable stale reference.

### Decisions

- **Decision:** Use each application's own route rather than probing for whichever answers.
  - **Why:** The routes are stable, documented per application, and verified at both recorded minimum versions. Probing would add a request to every observation to rediscover a fact that does not change within a supported version.
  - **Alternatives considered:** Trying one route and falling back to the other, rejected because it doubles the request count on the failing path and hides a wrong map behind a retry.
- **Decision:** Prefer the paged form where the route offers one.
  - **Why:** The spec requires observation to be bounded by the query's page bound, and both applications serve a paged variant of this resource.
- **Decision:** Narrow the 404 mapping rather than only rewording the remediation.
  - **Why:** The code is what a caller branches on. A `stale_reference` on a referenceless request tells a caller to retry something it cannot retry, and rewording the sentence leaves that wrong signal in place.
  - **Alternatives considered:** Keeping the code and changing only the text, rejected for the reason above.

### Non-Goals

- Changing Sonarr's exclusion behavior, which is correct.
- Adding, removing, or editing exclusions — configuration writes remain withdrawn per [0020](./0020-withdraw-configuration-writes.md).
- Reviewing every other domain's route map, beyond confirming this domain.
- Reworking the error taxonomy generally.

## Tasks

- [ ] Route exclusion observation per application
  - [ ] Give the domain a per-application route and use each application's paged form where it offers one
  - [ ] Recapture the Radarr fixture from the route Radarr serves and confirm the observation returns its records through the existing allowlist
  - [ ] Extend the domain's tests to cover Sonarr and Radarr, confirming they fail against the shared-route map
- [ ] Stop reporting a route-level 404 as a stale reference
  - [ ] Map a 404 on a referenceless request to an error whose code and remediation describe what actually happened
  - [ ] Cover the mapping so a referenceless 404 cannot regress to a recoverable stale reference

## Open Questions

None.

## References

- Spec: [Configuration Reconciliation](../specs/configuration-reconciliation/)
- Related changes: [0008-configuration-reconciliation](./0008-configuration-reconciliation.md), [0021-live-verified-fixtures](./0021-live-verified-fixtures.md)
