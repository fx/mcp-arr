# 0002: Typed Tool Runtime

## Summary

Implement the stable typed MCP surface, shared envelopes, ephemeral references, plan/apply runtime, mutation receipts, and job projection defined by the [Tool Contracts spec](../specs/tool-contracts/).

**Spec:** [Tool Contracts](../specs/tool-contracts/)
**Status:** draft
**Depends On:** 0001

## Motivation

Every domain feature needs the same schema, error, pagination, state-reference, stale-plan, retry, and job behavior. Implementing those independently would recreate the drift the blueprint is intended to avoid.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules (see [Architecture — Testing Contract](../specs/architecture/#testing-contract)). CI enforces these as merge gates:

- Exported behavior MUST have automated tests at the narrowest practical level.
- Adapter tests MUST use sanitized, version-labelled fixtures rather than personal live instances.
- Stdio integration tests MUST verify protocol framing and stdout cleanliness.
- Build, type check, lint, and tests MUST pass without focused or skipped tests.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

### Functional Requirements

The [Tool Contracts spec](../specs/tool-contracts/) owns tool names, schemas, results, errors, plan/apply, reference, receipt, and job behavior. Its scenarios are this change's acceptance criteria and are not restated here. What implementing them requires of this change:

- A single internal operation registry MUST drive public variant registration, adapter dispatch, version support, and test coverage without becoming a generic tool.
- Process-local state MUST support typed references, expiration, plan read-sets, apply records, and normalized jobs.
- Domain handlers MUST consume shared result/error builders rather than constructing incompatible envelopes.

## Design

### Approach

- Define public schemas for all fifteen tools, initially with empty or unsupported domain variants where later changes supply behavior.
- Implement a registry keyed by typed internal operation IDs, with application support, minimum version, side-effect metadata, and adapter handler.
- Add in-memory stores for opaque references, plans, apply records, and jobs.
- Implement plan snapshot hashing and adapter-provided precondition readers.
- Project upstream commands into normalized jobs and preserve terminal snapshots while the process runs.

### Decisions

- **Decision:** Expose fifteen typed domain tools rather than dispatchers.
  - **Why:** This preserves useful input schemas and host-visible semantic boundaries without endpoint-level sprawl.
  - **Alternatives considered:** Five generic dispatch tools, one code-mode tool, and one tool per endpoint.
- **Decision:** Let each mutation tool support both plan and direct apply.
  - **Why:** The calling agent owns the interaction strategy; the MCP has no UX.
  - **Alternatives considered:** Mandatory preview/confirmation tokens were rejected.
- **Decision:** Keep all references and receipts process-local.
  - **Why:** The deployment explicitly has no database or local persistence.
  - **Alternatives considered:** Durable MCP-owned task storage is outside scope.

### Non-Goals

- Domain-specific upstream calls
- Cross-restart reference recovery
- User identity, authorization, or confirmation UI
- Generic operation invocation

## Tasks

- [x] Define the public tool and result schemas (PR #5)
  - [x] Register all fifteen tools with strict inputs, declared outputs, annotations, and bounded defaults (PR #5)
  - [x] Implement application/result/error envelopes and partial-failure representation (PR #5)
  - [x] Add schema and protocol snapshot tests (PR #5)
- [ ] Implement ephemeral workflow state
  - [ ] Add opaque reference, plan, apply-record, and job stores with type/application binding and expiration
  - [ ] Add read-set fingerprints, stale-plan checks, and direct-apply validation hooks
  - [ ] Add retry reconciliation states without automatic duplicate egress
- [ ] Implement shared dispatch and job projection
  - [x] Add the internal semantic registry and capability projection (PR #5)
  - [ ] Add normalized job status/cancellation mapping and terminal snapshots
  - [ ] Add adversarial tests for cross-kind references, expiry, restart, stale plans, partial failure, and unknown outcomes

## Open Questions

None.

## References

- Spec: [Tool Contracts](../specs/tool-contracts/)
- Related changes: [0001-project-foundation](./0001-project-foundation.md)
- External: [MCP Tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
