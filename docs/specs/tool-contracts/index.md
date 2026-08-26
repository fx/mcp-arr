# Tool Contracts

## Overview

This specification defines the stable MCP tool surface, shared request/result conventions, plan/apply behavior, opaque references, and error semantics. Domain behavior is owned by the linked feature specifications.

## Background

Mirroring upstream HTTP operations produces a large, brittle tool catalog. Conversely, one generic dispatcher hides the same catalog inside an untyped argument object. The desired surface uses a small set of explicitly typed domain tools.

Related behavior:

- [Architecture](../architecture/)
- [Library Management](../library-management/)
- [Activity Management](../activity-management/)
- [Acquisition and Import](../acquisition-and-import/)
- [Configuration Reconciliation](../configuration-reconciliation/)

## Requirements

### Stable Typed Surface

- The server MUST expose `arr_capabilities`, `arr_library_query`, `arr_activity_query`, `arr_release_search`, `arr_import_inspect`, `arr_config_observe`, `arr_job_get`, `arr_search_start`, `arr_release_grab`, `arr_queue_resolve`, `arr_activity_change`, `arr_import_execute`, `arr_library_change`, `arr_config_reconcile`, and `arr_job_cancel`.
- Each tool MUST publish a closed input schema and a declared output schema.
- Tool inputs MUST reject unknown properties.
- Domain variants MUST use typed discriminated unions rather than arbitrary operation names or argument objects.
- A published input schema MUST be an object schema that describes every argument the tool accepts, and a tool that accepts arguments MUST NOT publish a schema declaring none.
- Domain variants MUST be published as declared alternatives of that object schema, so a caller can discover every variant and its arguments without invoking the tool.
- The schema a tool publishes and the schema it validates against MUST be the same contract; a tool MUST NOT enforce a constraint it did not publish.
- The server MUST NOT expose a generic HTTP, upstream endpoint, provider action, command-name, or filesystem-path dispatcher.

#### Scenario: Reject an unknown operation

- **GIVEN** a caller supplies an input variant not declared by a tool schema
- **WHEN** the tool is invoked
- **THEN** validation fails before any upstream request is sent

#### Scenario: Discover a tool's variants without calling it

- **GIVEN** a caller has listed the available tools and has never invoked them
- **WHEN** it reads the published input schema of a tool that accepts typed variants
- **THEN** every accepted variant and its arguments are described there, and no variant is discoverable only by triggering a validation error

### Capabilities

- `arr_capabilities` MUST report configured applications, detected versions, API versions, supported domain operations, and degraded or unavailable status.
- `arr_capabilities` MUST report unconfigured applications without requiring dummy credentials.
- Capability results MUST distinguish unconfigured, unavailable, unsupported, and available states.
- A capability result MUST be bounded by default, summarizing rather than enumerating operations an instance cannot currently perform, and MUST enumerate them only when the caller asks for that detail.

#### Scenario: One application is unavailable

- **GIVEN** Sonarr and Radarr are configured and Radarr is unreachable
- **WHEN** capabilities are queried
- **THEN** Sonarr is reported available and Radarr is reported unavailable without failing the entire result

### Bounded Structured Results

- Every successful tool call MUST return schema-conforming structured content and a concise text summary.
- Collection queries MUST support bounded page size and continuation metadata.
- Default results MUST omit large nested payloads unless the caller requests a supported detail level.
- Bulk and cross-application results MUST report per-item or per-application outcomes and MUST NOT conceal partial failure.

#### Scenario: Partial cross-application result

- **GIVEN** a query targets all relevant configured applications and one application fails
- **WHEN** the query completes
- **THEN** successful results and the failed application's normalized error are returned together

### Error Contract

- Tool execution errors MUST use stable error codes for invalid input, unconfigured application, unsupported capability, unavailable application, upstream authentication, upstream rejection, rate limit, timeout, stale reference, stale plan, conflict, partial failure, and unexpected response.
- Recoverable tool errors MUST include a safe remediation hint.
- An error result's text summary MUST carry the stable error code and the remediation hint, because a caller may see only the summary when a call reports failure.
- A text summary MUST NOT describe an outcome more favorably than the structured result it accompanies.
- Raw upstream bodies, headers, URLs containing credentials, stack traces, and API keys MUST NOT be returned.

#### Scenario: Read an error from the summary alone

- **GIVEN** a caller invokes a tool whose selected variant the target application does not support
- **WHEN** the caller reads only the result's text summary
- **THEN** the summary names the error code and the remediation hint rather than reporting an unqualified failure

#### Scenario: Recover from an expired release reference

- **GIVEN** a release reference has expired
- **WHEN** the caller attempts to grab it
- **THEN** the tool returns `stale_reference` and directs the caller to repeat release search

### Plan and Apply

- Every mutation tool MUST accept `mode: "plan"` and `mode: "apply"`.
- The calling agent MAY choose either mode without an MCP-owned confirmation workflow.
- Plan mode MUST perform all non-mutating validation available at that time and return requested effects, conditional effects, warnings, read-set fingerprints, and an opaque process-local plan reference.
- Apply mode MAY accept either a complete direct intent or a compatible plan reference.
- Applying a secret-bearing plan reference MUST require the caller to resupply each named transient secret required by that plan.
- A secret-bearing plan MUST retain only the required secret field names and non-reversible presence fingerprints, never secret values.
- Applying a plan reference MUST re-read every effect-relevant precondition and MUST fail with `stale_plan` when material state changed.
- Direct apply MUST validate current state immediately before sending the mutation upstream.
- The server MUST NOT interpret plan mode as authorization or require a user-interface confirmation.

#### Scenario: Direct apply

- **GIVEN** the calling agent chooses apply and supplies a valid mutation intent
- **WHEN** current upstream state passes validation
- **THEN** the mutation executes without requiring a prior plan call

#### Scenario: Apply a secret-bearing plan

- **GIVEN** a plan requires a provider password that was not retained in the plan
- **WHEN** the caller applies the plan reference and resupplies the named password field
- **THEN** the server validates the plan and uses the password only for the current upstream request

#### Scenario: Planned apply becomes stale

- **GIVEN** a caller creates a plan and an effect-relevant upstream resource changes
- **WHEN** the caller applies the plan reference
- **THEN** no mutation is sent and `stale_plan` is returned

### Opaque References

- Queue items, releases, import candidates, plans, and jobs MUST be represented by opaque process-local references when later mutation depends on server-held context.
- Every reference MUST be bound to its application, object kind, creation state, and expiration.
- References MUST NOT expose API keys or canonical filesystem paths.
- A reference from a previous process lifetime MUST be rejected.

#### Scenario: Cross-kind reference misuse

- **GIVEN** a release reference is supplied where an import candidate reference is required
- **WHEN** the tool validates the input
- **THEN** validation fails without an upstream request

### Mutation Receipts and Retry

- The server MUST create an in-memory apply record before sending a mutation upstream.
- Apply records MUST distinguish applying, succeeded, failed, and outcome-unknown states.
- Repeating the same process-local apply reference MUST return its existing record rather than blindly duplicate a non-idempotent mutation.
- Outcome-unknown records SHOULD be reconciled against authoritative upstream queue, history, command, library, or configuration state.

#### Scenario: Connection drops after upstream acceptance

- **GIVEN** an upstream request may have been accepted and the response is lost
- **WHEN** the caller retries the same apply reference
- **THEN** the server reconciles or reports outcome unknown instead of resending blindly

### Job Projection

- `arr_job_get` MUST expose normalized status, progress when known, upstream command identity, terminal result, and per-item outcomes.
- `arr_job_cancel` MUST distinguish cancelled, cancellation requested, uncancellable, completed, and unknown outcomes.
- Job state MUST be process-local and MUST degrade safely when the upstream command record expires or the server restarts.

#### Scenario: Started command cannot be cancelled

- **GIVEN** an upstream command has started and does not permit cancellation
- **WHEN** `arr_job_cancel` is invoked
- **THEN** the job is reported uncancellable without pretending cancellation succeeded

## Design

### Architecture

Each public tool delegates to a domain service. An internal operation registry maps typed variants to application adapters, version support, side-effect classification, and tests. The registry does not accept model-defined operations.

### Data Models

Shared result envelopes carry application, status, data, warnings, continuation, and normalized errors. Mutation results additionally carry requested effects, predicted effects, plan or job references, and receipts.

### API Surface

The fifteen tool names are stable public contracts. The details of upstream HTTP calls remain adapter-private.

### Business Logic

The calling agent chooses plan or apply. The server enforces schema validation, current-state validation, and safe retry behavior but provides no UI or independent approval system.

## Constraints

- Tool count is not a goal by itself; a domain tool is split when its schema or side-effect contract becomes ambiguous.
- MCP annotations are descriptive hints and do not replace runtime validation.
- References and jobs do not survive process restart.

## Open Questions

None.

## References

- [MCP Tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
- [Architecture](../architecture/)

## Changelog

| Date | Change | Document |
|------|--------|----------|
| 2026-08-25 | Initial desired-state specification created | [0002-tool-runtime](../../changes/0002-tool-runtime.md) |
| 2026-08-26 | Published input schemas required to describe every accepted variant | [0012-published-tool-schemas](../../changes/0012-published-tool-schemas.md) |
| 2026-08-26 | Error summaries required to carry code and remediation; capability results bounded | [0013-result-summary-fidelity](../../changes/0013-result-summary-fidelity.md) |
