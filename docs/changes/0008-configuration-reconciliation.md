# 0008: Configuration Reconciliation

## Summary

Implement sanitized configuration observation and lossless desired-state reconciliation for upstream providers, profiles, formats, tags, roots, paths, lists, and Prowlarr applications as defined by the [Configuration Reconciliation spec](../specs/configuration-reconciliation/).

**Spec:** [Configuration Reconciliation](../specs/configuration-reconciliation/)
**Status:** draft
**Depends On:** 0001, 0002

## Motivation

Provider APIs use dynamic schemas and full-resource updates. A generic setter can leak secrets or reset unknown fields. Configuration needs a separate observe/diff/plan/apply/verify plane while leaving the upstream applications as the only persistent stores.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules (see [Architecture — Testing Contract](../specs/architecture/#testing-contract)). CI enforces these as merge gates:

- Exported behavior MUST have automated tests at the narrowest practical level.
- Adapter tests MUST use sanitized, version-labelled fixtures rather than personal live instances.
- Stdio integration tests MUST verify protocol framing and stdout cleanliness.
- Build, type check, lint, and tests MUST pass without focused or skipped tests.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

### Functional Requirements

The [Configuration Reconciliation spec](../specs/configuration-reconciliation/) owns observation, desired-state, secret, provider-schema, sync, dependency, and no-local-store behavior.

- Internal persistence serialization MUST remain lossless even though model-facing serialization uses explicit allowlists.
- Dynamic schema changes MUST participate in plan fingerprints and stale-plan rejection.
- Transient secret values MUST be erased from process-local plan and receipt data after the upstream request is built.

## Design

### Approach

- Build provider-schema readers and safe field classifiers for each application.
- Define typed desired-state patches by provider/configuration family.
- Maintain separate safe output models and internal full upstream resources.
- Implement read-modify-write with unknown/masked-field preservation and explicit removals.
- Implement typed provider-test and explicit validation-bypass variants with external-effect warnings and no default `forceSave` behavior.
- Implement Prowlarr app/indexer observe-diff-apply-verify behavior with AddOnly/FullSync/tag semantics.
- Add profile/format/root/tag/list dependency checks and versioned fixtures.

### Decisions

- **Decision:** Allow transient provider secrets in direct tool inputs when required.
  - **Why:** The MCP has no local secret store or database, yet upstream provider creation may require credentials.
  - **Alternatives considered:** Persisted secret slots and a setup UI conflict with environment-only/local-state constraints.
- **Decision:** Keep upstream state authoritative.
  - **Why:** Reconciliation must reconstruct from the apps after every restart.
- **Decision:** Preserve unknown fields internally.
  - **Why:** Full-resource updates can otherwise erase fields added by newer provider definitions.

### Non-Goals

- Managing the MCP's own environment variables through tools
- Local desired-state files or database
- Host/auth/TLS settings, arbitrary actions, update installation, backup restore, or lifecycle
- Generic provider payload passthrough

## Tasks

- [x] Implement safe configuration observation
  - [x] Add provider/profile/format/tag/root/path/list/application schema readers
  - [x] Build explicit safe serializers and configured-secret indicators
  - [x] Add unknown-field, Cardigann, canary-secret, and raw-error leakage tests
- [ ] Implement lossless reconciliation runtime
  - [ ] Add typed desired-state patches, diff/plan output, explicit removal, and dependency validation
  - [ ] Preserve unknown, masked, and unmanaged fields in full-resource writes
  - [ ] Require apply-by-plan to resupply named transient secrets without storing their values in plans or receipts
  - [ ] Add typed provider-test and explicit validation-bypass variants with warnings, external-effect metadata, and no default `forceSave`
  - [ ] Add fixtures and stdio tests for provider tests, sent notifications, test failures, warning bypass, and hard validation failures
  - [ ] Add schema/resource fingerprints, stale rejection, transient-secret handling, apply verification, and direct-apply tests
- [ ] Implement Prowlarr application synchronization
  - [ ] Observe remote mappings and model Disabled/AddOnly/FullSync/tag behavior
  - [ ] Plan explicit additions, updates, removals, and stale mappings
  - [ ] Apply and verify per-item outcomes without claiming atomicity
- [ ] Register and verify configuration tools
  - [ ] Add typed variants to `arr_config_observe` and `arr_config_reconcile`
  - [ ] Add version-labelled adapter fixtures and stdio tests for every supported family
  - [ ] Add capability and unsupported-version coverage

## Open Questions

None.

## References

- Spec: [Configuration Reconciliation](../specs/configuration-reconciliation/)
- Related changes: [0001-project-foundation](./0001-project-foundation.md), [0002-tool-runtime](./0002-tool-runtime.md)
