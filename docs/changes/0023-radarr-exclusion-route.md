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

- The Radarr fixture for this domain MUST be recorded against the route Radarr serves, so a fixture cannot again stand in for a route that 404s. Recording it is this change's own work, not [0021](./0021-live-verified-fixtures.md)'s: it is the red test the route fix turns green, and the two MUST land together so the gate holds at every commit.
- A test MUST cover both applications for this domain, since a single-application test is what allowed a half-wrong route map to pass.

### Functional requirements

The [Configuration Reconciliation spec](../specs/configuration-reconciliation/#observe-configuration) owns exclusion observation and its scenarios — this change's acceptance criteria, not restated here. What implementing them requires of this change:

- The exclusion domain MUST resolve to each application's own route rather than one shared name.
- Both applications' exclusion records MUST be observable through the existing sanitized allowlist, which already names the fields each one contributes.
- Where the domain's route offers a paged form, observation MUST use it, since the spec requires every part of an observation to be governed by the query's page bound.
- The 404 this defect produced MUST be reported as the [Tool Contracts spec](../specs/tool-contracts/#error-contract) now requires — an unexpected response, not a stale reference — since the request carried no reference and the route was this server's own choice. That spec owns the rule and its scenario; this change is what makes the existing behaviour comply.

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
- **Decision:** Put the classification rule in the error contract rather than in this document, and cite it here.
  - **Why:** Which stable code a failure carries is observable behaviour a caller branches on, so it belongs to the [Error Contract](../specs/tool-contracts/#error-contract), not to the one change that happened to trip over it. Left here, the rule would bind only this domain and the next adapter to pick a route the application does not serve would be free to choose differently.
  - **Alternatives considered:** Stating the mapping in this document alone, rejected because it makes a change document the sole owner of an observable contract; leaving the code and rewording only the remediation, rejected because the code is what a caller branches on, so a better sentence leaves the wrong signal in place.

### Non-Goals

- Changing Sonarr's exclusion behavior, which is correct.
- Adding, removing, or editing exclusions — configuration writes remain withdrawn per [0020](./0020-withdraw-configuration-writes.md).
- Reviewing every other domain's route map, beyond confirming this domain.
- Reworking the error taxonomy generally.
- Repairing any fixture other than this domain's Radarr one, or adding the capture procedure — that is [0021](./0021-live-verified-fixtures.md).

## Tasks

- [x] Route exclusion observation per application
  - [x] Give the domain a per-application route and use each application's paged form where it offers one
  - [x] Recapture the Radarr fixture from the route Radarr serves and confirm the observation returns its records through the existing allowlist
  - [x] Extend the domain's tests to cover Sonarr and Radarr, confirming they fail against the shared-route map
- [ ] Stop reporting a route-level 404 as a stale reference
  - [ ] Map a 404 on a referenceless request to an error whose code and remediation describe what actually happened
  - [ ] Cover the mapping so a referenceless 404 cannot regress to a recoverable stale reference

## Open Questions

None.

## References

- Spec: [Configuration Reconciliation](../specs/configuration-reconciliation/)
- Also amends: [Tool Contracts — Error Contract](../specs/tool-contracts/#error-contract), which owns how the 404 is classified
- Related changes: [0008-configuration-reconciliation](./0008-configuration-reconciliation.md), [0021-live-verified-fixtures](./0021-live-verified-fixtures.md)
