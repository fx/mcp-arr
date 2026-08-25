# 0001: Project Foundation

## Summary

Create the TypeScript/Node project, stdio MCP entrypoint, environment-only instance configuration, version probes, and standing CI/test foundation required by the [Architecture spec](../specs/architecture/).

**Spec:** [Architecture](../specs/architecture/)
**Status:** draft
**Depends On:** —

## Motivation

The repository has no implementation, package metadata, test suite, or CI. Every later domain tool depends on a clean stdio runtime, validated environment contract, safe upstream HTTP boundary, and version-aware application adapters.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules (see [Architecture — Testing Contract](../specs/architecture/#testing-contract)). CI enforces these as merge gates:

- Exported behavior MUST have automated tests at the narrowest practical level.
- Adapter tests MUST use sanitized, version-labelled fixtures rather than personal live instances.
- Stdio integration tests MUST verify protocol framing and stdout cleanliness.
- Build, type check, lint, and tests MUST pass without focused or skipped tests.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

### Functional Requirements

The [Architecture spec](../specs/architecture/) owns runtime, transport, environment, connection, compatibility, state, and testing behavior. Its scenarios are this change's acceptance criteria and are not restated here. What implementing them requires of this change:

- The project MUST establish one package command usable as an MCP stdio server with environment variables supplied by the host.
- The implementation MUST isolate environment parsing, upstream HTTP, version probing, and stdio startup behind separately testable modules.
- CI MUST execute the standing architecture checks on pull requests and the default branch.

## Design

### Approach

- Create an npm package targeting Node.js 20+ with ESM TypeScript and strict compiler settings.
- Use the Tier 1 official TypeScript MCP SDK and a schema library supported by that SDK.
- Add `src/server`, `src/config`, `src/adapters`, `src/http`, and matching test areas without adding feature tools yet.
- Parse the six supported environment variables once during startup.
- Represent each application as an optional singleton adapter.
- Add a common fetch boundary with `X-Api-Key`, timeout, safe errors, URL-prefix preservation, and no raw-body propagation.
- Add sanitized stable-version fixtures for the three researched minimums.

### Decisions

- **Decision:** Use TypeScript, Node.js 20+, npm, ESM, and strict compilation.
  - **Why:** The official TypeScript MCP SDK is Tier 1 and the predecessor project was TypeScript.
  - **Alternatives considered:** Go for a single binary; an implementation-neutral spec. The user selected TypeScript/Node.
- **Decision:** Ship stdio only.
  - **Why:** The server is local and host-launched; remote transport and authorization add no value to the requested deployment.
  - **Alternatives considered:** Streamable HTTP was explicitly excluded.
- **Decision:** Keep runtime state in memory.
  - **Why:** No database or local configuration persistence is required.
  - **Alternatives considered:** SQLite and config files were explicitly excluded.

### Non-Goals

- Domain tools or mutations
- Streamable HTTP, OAuth, RBAC, or multi-user deployment
- More than one instance of an application
- Runtime config files, database, setup UI, or live-instance integration tests

## Tasks

- [x] Scaffold the TypeScript package and stdio process (PR #2)
  - [x] Add package metadata, lockfile, strict compiler config, lint/typecheck/build commands, executable entrypoint, and Node version contract (PR #2)
  - [x] Connect the MCP server through stdio and route all diagnostics to stderr (PR #2)
  - [x] Add process-level startup/shutdown and stdout-framing tests (PR #2)
- [ ] Implement environment and upstream adapter foundations
  - [ ] Parse optional URL/API-key pairs and reject incomplete or empty configuration
  - [ ] Normalize URL prefixes, inject `X-Api-Key`, enforce timeouts, and normalize safe errors
  - [ ] Probe status/version for each configured application and record capability state
- [x] Establish project quality gates and packaging (PR #3)
  - [x] Add unit, fixture-contract, and stdio integration test infrastructure (PR #3)
  - [x] Add sanitized fixtures for the recorded minimum versions (PR #3)
  - [x] Add CI for install, build, typecheck, lint, and tests (PR #3)
  - [x] Document command-plus-environment MCP installation without adding a runtime config file (PR #3)

## Open Questions

None.

## References

- Spec: [Architecture](../specs/architecture/)
- External: [MCP SDKs](https://modelcontextprotocol.io/docs/2026-07-28/sdk)
- External: [Build an MCP Server](https://modelcontextprotocol.io/docs/2026-07-28/develop/build-server)
