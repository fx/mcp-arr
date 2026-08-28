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

- The server MUST expose `arr_capabilities`, `arr_library_query`, `arr_activity_query`, `arr_release_search`, `arr_import_inspect`, `arr_config_observe`, `arr_job_get`, `arr_search_start`, `arr_release_grab`, `arr_queue_resolve`, `arr_activity_change`, `arr_import_execute`, `arr_library_change`, and `arr_job_cancel`.
- Each tool MUST publish a closed input schema and a declared output schema.
- Tool inputs MUST reject unknown properties.
- Domain variants MUST use typed discriminated unions rather than arbitrary operation names or argument objects.
- A published input schema MUST be an object schema that describes every argument the tool accepts, and a tool that accepts arguments MUST NOT publish a schema declaring none.
- Domain variants MUST be discoverable from the published input schema without invoking the tool: the discriminator MUST publish the complete set of accepted values, every variant's arguments MUST appear as properties of that object schema, and each variant's required and optional arguments — including any value set narrower than the published property allows — MUST be described in documentation generated from the same union that validates the input, so the description cannot drift from what is accepted. A published schema MUST NOT rely on a root-level `anyOf`, `oneOf`, or `allOf`, which hosts drop.
- Every value the published input schema admits for a single property MUST be a value some accepted variant admits, and every argument a tool accepts MUST be admitted by its published schema. Where a constraint holds only between properties — a variant's required arguments, a value set scoped by the discriminator, or two forms that may not be combined — the published schema MAY be broader than validation, and the constraint MUST then be described in the generated variant documentation rather than left discoverable only by triggering a validation error.

This parity is about the argument schema only. Cross-property correlations disclosed as documentation, and rejections a schema cannot express — an expired or wrong-kind reference, an unsupported application or version, a bulk combination the upstream handler cannot process, or any current-state precondition — remain governed by the specification that owns them.
- A published input schema MUST NOT declare a maximum length for a string value. The bound MUST remain in validation and MUST be stated in the generated variant documentation, because a host that compiles a published schema into a constrained-decoding grammar expands a length bound once per admissible character, and a schema it cannot compile costs the caller the whole tool rather than the bound.
- A published input schema MUST NOT admit an intent the server refuses unconditionally. An operation that is declared but not yet implemented MUST remain visible in the capability report as unimplemented rather than being advertised as callable.
- The server MUST NOT expose a generic HTTP, upstream endpoint, provider action, command-name, or filesystem-path dispatcher.

#### Scenario: Reject an unknown operation

- **GIVEN** a caller supplies an input variant not declared by a tool schema
- **WHEN** the tool is invoked
- **THEN** validation fails before any upstream request is sent

#### Scenario: Discover a tool's variants without calling it

- **GIVEN** a caller has listed the available tools and has never invoked them
- **WHEN** it reads the published input schema of a tool that accepts typed variants
- **THEN** the published schema names every accepted variant in its discriminator, publishes every argument any variant accepts, and describes each variant's own required and optional arguments in generated documentation, so no variant and no per-variant requirement is discoverable only by triggering a validation error

#### Scenario: A host compiles a published schema into a decoding grammar

- **GIVEN** a host that constrains its model's output by compiling a tool's published input schema into a decoding grammar
- **WHEN** it lists this server's tools and compiles each one
- **THEN** every tool compiles, and a value whose accepted length the schema no longer states is still refused by validation with the bound named

#### Scenario: An unimplemented operation is not advertised as callable

- **GIVEN** the server declares an operation it refuses unconditionally
- **WHEN** a caller reads the published input schema of the tool that would host it
- **THEN** the operation is absent from the schema, and the capability report is where the caller learns it is planned but unimplemented

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
- A collection query MUST accept an optional caller-supplied projection naming which parts of a per-application payload to return, and a projected result MUST carry only the named parts and only values the same call would have returned unprojected.
- A projection MUST NOT remove the result envelope, a per-application outcome's own fields, or the field that discriminates the payload, and a projection path matching nothing MUST produce a warning naming the paths that were available rather than failing the call.
- A published output schema MUST admit every envelope its tool returns, including one a projection reduced, and MAY therefore be broader than the envelope any single call produces.
- Where a published output schema is broader than the envelope returned, each payload's selectable paths MUST be described in documentation generated from the same schemas the envelope is validated against, so the description cannot drift from what is returned.
- That documentation MUST name each path down to a leaf of the payload, and MUST group the paths of a payload that is discriminated by the value that selects it rather than merging every payload's paths into one list, so no path is offered that resolves for no single call. A tool that returns no payload MUST publish no path inventory.

#### Scenario: Partial cross-application result

- **GIVEN** a query targets all relevant configured applications and one application fails
- **WHEN** the query completes
- **THEN** successful results and the failed application's normalized error are returned together

#### Scenario: Return only the fields a caller asked for

- **GIVEN** a caller queries a collection and names a projection covering part of each record
- **WHEN** the query completes
- **THEN** each record carries the named parts and the payload's discriminating field, the envelope and per-application outcome are unchanged, and no value appears that the same call would not have returned unprojected

#### Scenario: A projection names a path that does not exist

- **GIVEN** a caller names a projection path no part of the payload matches
- **WHEN** the query completes
- **THEN** the call succeeds and warns, naming the paths that were available, so the caller can correct the path without a failed request

#### Scenario: Discover selectable paths without calling the tool

- **GIVEN** a caller has listed the available tools and has never invoked them
- **WHEN** it reads a collection query's published output schema and its generated documentation
- **THEN** the selectable paths of every payload the tool can return are named, so a projection can be written without first making an unprojected call

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
- Applying a plan reference MUST re-read every effect-relevant precondition and MUST fail with `stale_plan` when material state changed.
- Direct apply MUST validate current state immediately before sending the mutation upstream.
- The server MUST NOT interpret plan mode as authorization or require a user-interface confirmation.

No tool currently accepts a transient secret. The requirements governing one — resupply on apply, and a plan that retains names and presence fingerprints rather than values — are owned by [Transient Secret Inputs](../configuration-reconciliation/#transient-secret-inputs) in the withdrawn write surface, and bind again if any tool reintroduces one.

#### Scenario: Direct apply

- **GIVEN** the calling agent chooses apply and supplies a valid mutation intent
- **WHEN** current upstream state passes validation
- **THEN** the mutation executes without requiring a prior plan call

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

The fourteen tool names are stable public contracts. The details of upstream HTTP calls remain adapter-private.

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
| 2026-08-27 | Published input schemas flattened to one object root; variant detail moved to generated documentation | [0015-flat-tool-input-schemas](../../changes/0015-flat-tool-input-schemas.md) |
| 2026-08-28 | Published output schemas permitted to be broader than the returned envelope; selectable paths required as generated documentation | [0018-bounded-tool-listing](../../changes/0018-bounded-tool-listing.md) |
| 2026-08-28 | Collection queries required to accept a caller-supplied result projection | [0019-selected-result-fields](../../changes/0019-selected-result-fields.md) |
| 2026-08-28 | Published input schemas barred from declaring string length bounds and unconditionally refused intents | [0017-grammar-compilable-input-schemas](../../changes/0017-grammar-compilable-input-schemas.md) |
| 2026-08-28 | `arr_config_reconcile` withdrawn; transient-secret requirements relocated to the withdrawn surface | [0020-withdraw-configuration-writes](../../changes/0020-withdraw-configuration-writes.md) |
