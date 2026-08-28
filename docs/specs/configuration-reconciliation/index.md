# Configuration Reconciliation

## Overview

This specification defines safe observation of configuration stored in the upstream *arr applications, and retains the design for reconciling it. It does not introduce MCP-local configuration persistence; the MCP's own connection settings remain environment-only as defined by [Architecture](../architecture/).

The exposed surface is observation only. The write surface is withdrawn, and the requirements describing it are retained below as the design for any reinstatement rather than as a description of what the server does — see [Configuration Writes Are Not Exposed](#configuration-writes-are-not-exposed).

## Background

Sonarr, Radarr, and Prowlarr expose dynamic provider schemas and full-resource updates for indexers, download clients, applications, notifications, lists, metadata, proxies, profiles, formats, roots, tags, and related settings. Unknown, masked, and version-specific fields must be preserved even when they are not shown to the calling agent.

## Requirements

### Observe Configuration

- `arr_config_observe` MUST expose sanitized current-state views for supported provider, profile, format, tag, root, remote-path, list, exclusion, and application-sync configuration.
- Observation MUST use explicit output allowlists and MUST drop unknown fields from model-facing results.
- Secret fields MUST be represented as configured or unconfigured rather than returning their current values.
- Observation MUST distinguish unsupported, unavailable, and unconfigured capabilities.
- Every part of an observation payload MUST be governed by the query's page bound, so no detail level makes a result grow without one.
- An observation MUST NOT return the instance's provider template catalogue, and any provider-schema read an operation needs MUST be internal to that operation rather than published to the caller.

#### Scenario: Observe a provider domain at full detail

- **GIVEN** an instance whose provider catalogue offers far more definitions than it has configured records
- **WHEN** the caller observes that provider domain at the detail level that discloses the most
- **THEN** the result describes the configured records the page bound admits and nothing whose size is set by the catalogue instead

#### Scenario: Observe a configured indexer

- **GIVEN** an indexer contains an API key and password
- **WHEN** configuration is observed
- **THEN** safe settings and configured-state indicators are returned without either secret value

### Configuration Writes Are Not Exposed

- The server MUST NOT expose a tool that writes upstream configuration, and MUST NOT report a configuration write as a supported, unsupported, or unimplemented operation.

#### Scenario: No configuration write is offered

- **GIVEN** a caller has listed the available tools and read the capability report for every configured application
- **WHEN** it looks for a way to change upstream configuration
- **THEN** no tool and no reported operation offers one, so the absence is discoverable without attempting a call

### No MCP-Local Configuration Store

- Upstream desired-state documents, provider resources, and observed configuration MUST NOT be persisted in an MCP-local database or configuration file.
- Process-local plans MAY retain redacted diffs and fingerprints only until expiration or restart.
- The upstream applications MUST remain the authoritative configuration stores.

#### Scenario: Restart after observation

- **GIVEN** configuration was observed successfully
- **WHEN** the MCP server restarts
- **THEN** a new observation reconstructs current state from the upstream application

## Retained Design — The Withdrawn Write Surface

The requirements in this section describe a surface the server does not currently expose. They are retained because the decision is that configuration writes are not worth their cost *for now*, not that the design was wrong, and because reinstating them would otherwise mean re-deriving a contract that was carefully worked out. Nothing here is currently implemented, and nothing here is currently testable; treat every requirement below as conditional on that surface being reinstated.

### Desired-State Reconciliation

- Desired state MUST name only fields owned by the requested reconciliation.
- Unspecified fields MUST be preserved from the current upstream resource.
- Field removal MUST be explicit.
- Apply MUST use a schema/version-checked read-modify-write for full-resource APIs.
- Apply MUST fail as stale when the current resource or provider schema materially changed since plan.

#### Scenario: Preserve a newer unknown field

- **GIVEN** a newer Prowlarr provider schema adds a field unknown to this MCP
- **WHEN** the caller changes a known field
- **THEN** the unknown current field is preserved in the upstream update and omitted from the model-facing result

### Transient Secret Inputs

- Provider creation or update MAY accept a secret value as a transient tool input when the upstream configuration requires it.
- Transient secret values MUST be used only for the current upstream request and MUST NOT be retained in MCP-local state, plan references, receipts, diagnostics, or tool results.
- A masked upstream sentinel MUST preserve the existing secret where that application defines such behavior.
- Applying a secret-bearing plan reference MUST require the caller to resupply each named transient secret required for the upstream request.
- Plan output MUST describe a secret field as set, changed, preserved, or cleared without including its value.

#### Scenario: Change a provider password

- **GIVEN** the caller directly applies a provider update with a new password
- **WHEN** the upstream update completes
- **THEN** the password is neither stored locally nor echoed in the result

### Provider Schema and Testing

- Provider templates and fields MUST be derived from the configured application's current schema endpoint where available.
- Provider tests MUST be represented as open-world operations that may contact external systems or send test notifications.
- `forceSave` or equivalent validation bypass MUST NOT be used by default.
- A bypass MAY be exposed only as an explicit typed intent with a warning describing the skipped checks.
- Arbitrary provider action names MUST NOT be accepted.

#### Scenario: Apply a planned secret change

- **GIVEN** a provider plan records that a password must change without retaining its value
- **WHEN** the caller applies the plan reference and resupplies the password field
- **THEN** the update uses the supplied value for that request without storing or echoing it

#### Scenario: Test notification warning

- **GIVEN** a notification provider supports a test action
- **WHEN** the caller plans or applies the test
- **THEN** the result warns that an external notification may be sent

### Prowlarr Application Reconciliation

- Prowlarr application reconciliation MUST distinguish disabled, add-only, and full-sync behavior.
- A plan MUST show remote indexer additions, updates, removals, tag-selection effects, and stale mappings separately.
- Any reconciliation that can remove remote indexers MUST disclose those removals before apply.
- Partial sync failure MUST report each affected remote application or indexer.

#### Scenario: Full sync removes stale mapping

- **GIVEN** Full Sync is configured and a remote indexer mapping is stale
- **WHEN** reconciliation is planned
- **THEN** the proposed remote removal is listed explicitly

### Profiles, Formats, and Dependencies

- Quality profiles, custom formats, release/delay profiles, app profiles, tags, roots, and related policies MUST be reconciled with dependency awareness.
- Deleting a referenced resource MUST fail or require an explicit dependent migration supported by the upstream application.
- Full-resource profile updates MUST preserve ordering and required entries not owned by the requested change.

#### Scenario: Delete an in-use quality profile

- **GIVEN** a quality profile is referenced by media or an import list
- **WHEN** deletion is applied without a dependent migration
- **THEN** the operation fails without attempting to bypass the upstream dependency

## Design

Each subsection below separates the exposed surface from the withdrawn one, on the same terms as the requirements above: the first paragraph describes what the server does, and the second describes what a reinstated write surface would restore.

### Architecture

A configuration service reads application resources and serializes them through an output allowlist, so what reaches the calling agent is a deliberately narrower document than what the instance holds.

Withdrawn: mapping safe desired-state models onto application-specific full resources, with persistence serialization kept separate from output serialization so an internal update preserves untouched unknown and masked fields.

### Data Models

Models include provider summary, dynamic field descriptor, and configured-secret state.

Withdrawn: desired-state patch, dependency, configuration diff, sync effect, and verification result.

### API Surface

Reads use `arr_config_observe`. No tool writes or tests configuration; the retained design above describes the typed variants a reinstated write surface would expose. MCP instance URLs and API keys are not managed by these tools.

### Business Logic

Observation reads current state and returns the allowlisted view of it, bounded by the query's page size. No local configuration database exists, and the upstream applications remain authoritative.

Withdrawn: reading current state, calculating a scoped diff, optionally returning a plan, rereading preconditions at apply, sending a complete upstream resource, and verifying the result.

## Constraints

- Host/authentication/TLS settings, raw filesystem settings, API-key reset, backup restore, update installation, and arbitrary provider actions are outside the default configuration surface.
- Cardigann and other dynamic fields are treated as potentially sensitive regardless of upstream privacy metadata.
- The MCP-local connection configuration remains environment-only.

## Open Questions

None.

## References

- [Architecture](../architecture/)
- [Tool Contracts](../tool-contracts/)

## Changelog

| Date | Change | Document |
|------|--------|----------|
| 2026-08-25 | Initial desired-state specification created | [0008-configuration-reconciliation](../../changes/0008-configuration-reconciliation.md) |
| 2026-08-28 | Provider template derivation made internal; observation payloads required to be bounded in every part | [0016-bounded-provider-schema-observation](../../changes/0016-bounded-provider-schema-observation.md) |
| 2026-08-28 | Write surface withdrawn; reconciliation requirements retained as design rather than current behavior | [0020-withdraw-configuration-writes](../../changes/0020-withdraw-configuration-writes.md) |
