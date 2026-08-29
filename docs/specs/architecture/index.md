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
- The upstream request timeout MUST be configurable through a single environment variable that applies to every outbound request.
- The upstream request timeout MUST default to 30 000 milliseconds when that variable is absent.
- An unusable timeout value MUST reject startup with a problem that names the variable and MUST NOT include the configured value.
- The accepted timeout range MUST be bounded so that the configured delay is one a single `setTimeout` can honor without being clamped.
- A result MUST NOT be refused because a value the answer does not depend on arrived in a shape this server does not model; the unusable value MUST be omitted and the rest of the result returned.
- An upstream payload MUST NOT be required to carry a member the result does not read.

#### Scenario: An advisory field changes shape

- **GIVEN** a supported application sends an advisory field in a shape this server does not model
- **WHEN** a query that does not depend on that field runs
- **THEN** the query succeeds, the unusable value is absent from the result, and no other record is lost

#### Scenario: An unread member is absent

- **GIVEN** a supported application omits a member no mapped result reads
- **WHEN** a query over that payload runs
- **THEN** the query succeeds and every record is returned

#### Scenario: Configure a longer upstream timeout

- **GIVEN** the upstream timeout variable is set to a whole number of milliseconds in the accepted range
- **WHEN** an upstream request takes longer than the default deadline but less than the configured one
- **THEN** the request completes rather than being aborted, and a value outside the accepted range would have rejected startup without appearing in the diagnostic

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
- A recorded upstream fixture MUST correspond to a response the application it names genuinely produces at the version and route it names, and MUST NOT be authored from documentation or inferred from another application's shape.
- Refreshing the recorded fixtures against a live instance MUST be a repeatable procedure that sanitizes what it captures, and MUST remain outside the test suite so that running the tests never requires an instance.

#### Scenario: A recorded fixture contradicts the instance it names

- **GIVEN** a recorded fixture declares an application, a version, and a route
- **WHEN** that route is read from a real instance of that application at that version
- **THEN** the recorded body carries the same field shapes the instance returns, so a shape the instance never sends cannot stand as the recorded contract

#### Scenario: Protocol output remains clean

- **GIVEN** integration tests invoke the server over stdio while diagnostics are produced
- **WHEN** the test parses stdout
- **THEN** every stdout message is valid MCP protocol output

### Packaging and Release

- The server MUST be distributed as a public package on the npm registry that a host can install and launch without cloning the repository.
- The published package MUST contain the executable build output and the documents required to configure it, and MUST NOT contain sources, tests, or fixtures.
- The project documentation MUST present running the published package as the default path, so a reader can configure a host without cloning or building the project.
- The published package MUST declare its license and the repository it was built from.
- Release versions MUST be derived from the merged commit history rather than edited by hand, and the version, changelog, and git tag MUST agree.
- A release MUST NOT be published from a commit whose standing quality gates have not passed.
- Publishing MUST require an explicit human action; automation MUST NOT publish a release on its own.
- Publishing MUST NOT depend on a long-lived registry credential stored in the repository.

#### Scenario: Install and run without the repository

- **GIVEN** a host with a supported Node.js runtime and no checkout of this project
- **WHEN** the host installs the published package and launches its command with instance environment variables
- **THEN** the MCP server starts over stdio exactly as it does from a local build

#### Scenario: Release awaits a human

- **GIVEN** the automated release process has prepared a pending release for the accumulated commits
- **WHEN** no maintainer has approved it
- **THEN** nothing is published to the registry and the pending release remains available for review

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
| 2026-08-26 | Packaging and release contract added for npm distribution | [0011-npm-publishing](../../changes/0011-npm-publishing.md) |
| 2026-08-28 | Recorded fixtures required to match the instance they name, with a repeatable capture procedure | [0021-live-verified-fixtures](../../changes/0021-live-verified-fixtures.md) |
| 2026-08-28 | Unmodelled shapes in fields a result does not depend on required to be dropped rather than fail the result | [0022-upstream-field-shape-tolerance](../../changes/0022-upstream-field-shape-tolerance.md) |
| 2026-08-28 | Upstream payloads barred from being required to carry a member no result reads | [0028-prowlarr-indexer-status-shape](../../changes/0028-prowlarr-indexer-status-shape.md) |
| 2026-08-29 | Upstream request timeout required to be configurable, defaulted to 30 000 ms, and bounded | [0029-configurable-upstream-timeout](../../changes/0029-configurable-upstream-timeout.md) |
