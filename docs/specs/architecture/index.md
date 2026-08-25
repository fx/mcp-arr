# Architecture

## Overview

This specification defines the project-level contract for a local TypeScript MCP server that manages Sonarr, Radarr, and Prowlarr through their HTTP APIs. The server does not yet exist; this document describes the desired architecture that the linked change documents will implement.

## Background

The repository currently contains only documentation scaffolding. The design replaces a prior-art pattern in which every upstream endpoint becomes a separate MCP tool and all behavior accumulates in one source file.

The feature contracts are split across:

- [Tool Contracts](../tool-contracts/)
- [Library Management](../library-management/)
- [Activity Management](../activity-management/)
- [Acquisition and Import](../acquisition-and-import/)
- [Configuration Reconciliation](../configuration-reconciliation/)

## Requirements

### Runtime and Language

- The server MUST be implemented in TypeScript and run on Node.js 20 or newer.
- The server SHOULD use a Tier 1 official MCP SDK and strict TypeScript compilation.

#### Scenario: Start the packaged server

- **GIVEN** a supported Node.js runtime and valid environment configuration
- **WHEN** the configured MCP command is launched
- **THEN** the process starts an MCP server over stdio without requiring any other local service

### Stdio-Only Transport

- The initial server MUST expose MCP exclusively through stdio.
- The initial server MUST NOT open an HTTP, SSE, WebSocket, or other network listener.
- The server MUST reserve stdout for MCP protocol messages.
- Diagnostics MAY be written to stderr.

#### Scenario: Diagnostic output

- **GIVEN** an upstream request fails
- **WHEN** the server emits a diagnostic
- **THEN** the diagnostic is written without corrupting stdout protocol framing

### Environment-Only Instance Configuration

- The server MUST read instance connection settings exclusively from `SONARR_URL`, `SONARR_API_KEY`, `RADARR_URL`, `RADARR_API_KEY`, `PROWLARR_URL`, and `PROWLARR_API_KEY`.
- Each application MUST support at most one configured instance.
- Each application MAY be omitted by leaving both of its environment variables unset.
- The server MUST reject startup when only one member of an application's URL/API-key pair is set.
- The server MUST reject startup when no application is configured.
- Environment configuration MUST be read at process startup and MUST NOT require a configuration file, database, setup UI, or runtime configuration endpoint.
- Tool inputs MUST NOT select arbitrary upstream base URLs.

#### Scenario: Configure only Sonarr

- **GIVEN** `SONARR_URL` and `SONARR_API_KEY` are set and both variable pairs for the other applications are absent
- **WHEN** the server starts
- **THEN** Sonarr capabilities are available and Radarr/Prowlarr capabilities are reported as unconfigured

#### Scenario: Reject an incomplete pair

- **GIVEN** `RADARR_URL` is set and `RADARR_API_KEY` is absent
- **WHEN** the server starts
- **THEN** startup fails with the missing variable name and without exposing any configured value

### Upstream Connection Handling

- A configured base URL MUST be an absolute HTTP or HTTPS URL and MUST be normalized without changing its path prefix.
- Every upstream request MUST send the configured API key in the `X-Api-Key` header.
- API keys MUST NOT appear in tool results, diagnostics, or upstream error messages returned to the caller.
- Upstream requests MUST use finite timeouts and MUST distinguish unavailable instances, authentication failures, validation failures, rate limits, and unexpected responses.

#### Scenario: Upstream authentication failure

- **GIVEN** a configured instance rejects its API key
- **WHEN** a tool calls that instance
- **THEN** the result identifies an authentication failure without returning the key or raw response body

### Version Compatibility

- The initial minimum supported versions MUST be Sonarr 4.0.19.2979 using API v3, Radarr 6.3.0.10514 using API v3, and Prowlarr 2.5.2.5491 using API v1.
- The server MUST allow connection to versions newer than the recorded minimum.
- A newer version MUST NOT be rejected solely because it has not been previously observed.
- The recorded minimum MUST be raised only when the implementation knowingly depends on behavior unavailable in an older supported version.
- Capabilities unavailable on an instance MUST be reported as unsupported rather than emulated through an arbitrary API escape hatch.

#### Scenario: Connect a newer patch release

- **GIVEN** a configured application reports a version newer than its recorded minimum and retains the required API behavior
- **WHEN** capabilities are detected
- **THEN** the application remains usable

### Ephemeral Local State

- MCP-owned plans, opaque references, job projections, and receipts MUST be held in process memory only.
- The server MUST NOT require a database or write runtime state to configuration files.
- Process-local references MUST become invalid after server restart.
- Upstream application state MUST remain the authority for reconciliation after local state loss.

#### Scenario: Restart invalidates a plan

- **GIVEN** a caller received a plan reference
- **WHEN** the server process restarts before apply
- **THEN** applying that reference fails as expired and the caller can request a new plan

### Testing Contract

- Every exported behavior MUST have automated tests at the narrowest practical level.
- Adapter behavior MUST be covered by sanitized, version-labelled upstream fixtures.
- MCP tools MUST have protocol-level stdio integration tests for schemas, results, errors, and stdout cleanliness.
- Mutations MUST have tests for direct apply, planned apply, stale plans, retries, partial failure, and redaction.
- The full build, type check, lint, and test suite MUST run in CI and failures MUST block merge.
- Committed tests MUST NOT be focused, skipped, or dependent on live personal *arr instances.

#### Scenario: Protocol output remains clean

- **GIVEN** integration tests invoke the server over stdio while diagnostics are produced
- **WHEN** the test parses stdout
- **THEN** every stdout message is valid MCP protocol output

## Design

### Architecture

The server is organized around transport, typed tool handlers, workflow services, an internal semantic operation registry, application adapters, and an upstream HTTP boundary. The semantic registry is an implementation inventory and policy source; it is not exposed as a generic dispatcher tool.

All local state is ephemeral. Long-running upstream commands are projected into process-local job records while the upstream application remains authoritative.

### Data Models

The cross-cutting model includes configured application identity, application version, opaque process-local references, normalized errors, plan snapshots, and job status. Domain-specific models are owned by the linked feature specifications.

### API Surface

The only inbound runtime surface is MCP over stdio. Outbound calls target the configured Sonarr API v3, Radarr API v3, or Prowlarr API v1 base path.

### Business Logic

Startup validates environment pairs, probes each configured instance, and registers a stable tool set. Tool handlers select only configured instances and delegate to typed workflows rather than accepting endpoints or command names.

## Constraints

- The initial deployment is local and single-user.
- Multi-instance applications, remote MCP transport, OAuth, RBAC, databases, local configuration files, and configuration UI are outside scope.
- Runtime state does not survive process restart.
- Upstream APIs contain dynamic and occasionally incomplete contracts, so OpenAPI alone is not authoritative.

## Open Questions

None.

## References

- [MCP SDKs](https://modelcontextprotocol.io/docs/2026-07-28/sdk)
- [Build an MCP Server](https://modelcontextprotocol.io/docs/2026-07-28/develop/build-server)
- [MCP Tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
- [Tool Contracts](../tool-contracts/)

## Changelog

| Date | Change | Document |
|------|--------|----------|
| 2026-08-25 | Initial desired-state specification created | [0001-project-foundation](../../changes/0001-project-foundation.md) |
