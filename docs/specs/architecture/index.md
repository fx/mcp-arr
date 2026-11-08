# Architecture

## Overview

This specification defines the project-level contract for a TypeScript MCP server that manages Sonarr, Radarr, and Prowlarr through their HTTP APIs. It runs either as a local process a host launches over stdio, or as a long-lived remote service over Streamable HTTP that holds the instance credentials so its clients never see them.

## Background

The design replaces a prior-art pattern in which every upstream endpoint becomes a separate MCP tool and all behavior accumulates in one source file.

The feature contracts are split across:

- [Tool Contracts](../tool-contracts/)
- [Media Toolset](../media-toolset/)
- [HTTP Transport](../http-transport/)
- [Library Management](../library-management/)
- [Activity Management](../activity-management/)
- [Acquisition and Import](../acquisition-and-import/)
- [Configuration Reconciliation](../configuration-reconciliation/)

## Requirements

### Runtime and Language

- The server MUST be implemented in TypeScript and run on Node.js 20 or newer.
- The server SHOULD use a Tier 1 official MCP SDK and strict TypeScript compilation.

#### Scenario: Start the packaged server

- **GIVEN** a supported Node.js runtime and valid environment configuration with no transport selected
- **WHEN** the configured MCP command is launched
- **THEN** the process starts an MCP server over stdio without requiring any other local service

### Transports

- The server MUST expose MCP through exactly one transport per process, selected at startup by `ARR_MCP_TRANSPORT`, whose accepted values are `stdio` and `http`.
- When `ARR_MCP_TRANSPORT` is absent the server MUST use stdio.
- Over stdio the server MUST NOT open any network listener, and MUST reserve stdout for MCP protocol messages.
- Over HTTP the server MUST behave as [HTTP Transport](../http-transport/) specifies, and MUST NOT open any listener other than the one that specification defines.
- The server MUST NOT open an SSE-only, WebSocket, or other network listener on either transport.
- Diagnostics MAY be written to stderr.

#### Scenario: Diagnostic output

- **GIVEN** an upstream request fails
- **WHEN** the server emits a diagnostic
- **THEN** the diagnostic is written without corrupting stdout protocol framing

#### Scenario: Unknown transport

- **GIVEN** `ARR_MCP_TRANSPORT` is `websocket`
- **WHEN** the server starts
- **THEN** startup fails naming `ARR_MCP_TRANSPORT`, and no MCP session or listener is opened

### Environment-Only Instance Configuration

- The server MUST read instance connection settings exclusively from `SONARR_URL`, `SONARR_API_KEY`, `RADARR_URL`, `RADARR_API_KEY`, `PROWLARR_URL`, and `PROWLARR_API_KEY`.
- Each application MUST support at most one configured instance.
- Each application MAY be omitted by leaving both of its environment variables unset.
- The server MUST reject startup when only one member of an application's URL/API-key pair is set.
- The server MUST reject startup when no application is configured.
- Environment configuration MUST be read at process startup and MUST NOT require a configuration file, database, setup UI, or runtime configuration endpoint.
- Tool inputs MUST NOT select arbitrary upstream base URLs.
- Settings that are not instance connection settings — the transport, the toolset, the HTTP listener and its bearer token, and the `media` toolset's defaults — MUST likewise be read only from the environment at startup. The specification that owns each one owns its name, accepted values, and default: [Transports](#transports), [Tool Contracts — Toolset Selection](../tool-contracts/#toolset-selection), [HTTP Transport — Listener Configuration](../http-transport/#listener-configuration), and [Media Toolset — Deployment Defaults](../media-toolset/#deployment-defaults).
- A required setting that is absent, or any setting whose value is empty or not one the owning specification accepts, MUST reject startup with a problem that names the setting and MUST NOT include its value.
- A setting that applies only to a transport or toolset the process has not selected MUST reject startup in the same way, so a deployment that forgot a selection fails with a diagnostic instead of starting in a mode nobody intended.

#### Scenario: Configure only Sonarr

- **GIVEN** `SONARR_URL` and `SONARR_API_KEY` are set and both variable pairs for the other applications are absent
- **WHEN** the server starts
- **THEN** Sonarr capabilities are available and Radarr/Prowlarr capabilities are reported as unconfigured

#### Scenario: A setting for a transport that is not selected

- **GIVEN** `ARR_MCP_AUTH_TOKEN` is set and `ARR_MCP_TRANSPORT` is absent
- **WHEN** the server starts
- **THEN** startup fails naming `ARR_MCP_AUTH_TOKEN` as a setting that requires the HTTP transport, and its value does not appear

#### Scenario: Reject an incomplete pair

- **GIVEN** `RADARR_URL` is set and `RADARR_API_KEY` is absent
- **WHEN** the server starts
- **THEN** startup fails with the missing variable name and without exposing any configured value

### Upstream Connection Handling

- A configured base URL MUST be an absolute HTTP or HTTPS URL and MUST be normalized without changing its path prefix.
- Every upstream request MUST send the configured API key in the `X-Api-Key` header.
- API keys MUST NOT appear in tool results, diagnostics, or upstream error messages returned to the caller.
- Upstream requests MUST use finite timeouts and MUST distinguish unavailable instances, authentication failures, validation failures, rate limits, and unexpected responses.
- The upstream request timeout MUST be configurable through a single environment variable, `ARR_UPSTREAM_TIMEOUT_MS`, that applies to every outbound request.
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
- A process MUST hold exactly one set of this state, shared by every client the process serves on its transport.
- Process-local references MUST become invalid after server restart.
- Upstream application state MUST remain the authority for reconciliation after local state loss.

#### Scenario: Restart invalidates a plan

- **GIVEN** a caller received a plan reference
- **WHEN** the server process restarts before apply
- **THEN** applying that reference fails as expired and the caller can request a new plan

### Testing Contract

- Every exported behavior MUST have automated tests at the narrowest practical level.
- Adapter behavior MUST be covered by sanitized, version-labelled upstream fixtures.
- MCP tools MUST have protocol-level stdio integration tests for schemas, results, errors, and stdout cleanliness, for each toolset.
- The HTTP transport MUST have protocol-level integration tests against a real listener for authentication, origin validation, statelessness, and the absence of every credential from responses and diagnostics.
- `arr` toolset mutations MUST have tests for direct apply, planned apply, stale plans, retries, partial failure, and redaction.
- `media` toolset mutations MUST have tests for repeated and concurrent calls, partial failure, and redaction.
- The full build, type check, lint, and test suite MUST run in CI and failures MUST block merge.
- Committed tests MUST NOT be focused, skipped, or dependent on live personal *arr instances.
- A recorded upstream fixture MUST correspond to a response the application it names genuinely produces at the version and route it names, and MUST NOT be authored from documentation or inferred from another application's shape.
- Refreshing the recorded fixtures against a live instance MUST be a repeatable procedure that sanitizes what it captures, and MUST remain outside the test suite so that running the tests never requires an instance.
- A recorded fixture MUST NOT carry what identifies the library it was captured from or the services behind it — titles, overviews, artwork, metadata ids, ratings, file and folder paths and names, release names, groups, and guids, application messages, tag, disk, profile, and format labels, the names of indexers, download clients, and other providers, and download ids. Every string a recorded body holds, at any depth, MUST be treated as identifying unless an explicit structural rule lists its exact value in a closed set, never a pattern — an enumeration word, a product or contract name, a built-in quality name, a settings-schema descriptor, or a closed vocabulary the application ships — so a field an upstream adds later fails closed; a shape such as a date is structural only when it is the whole string. The capture MUST replace each identifying value with a stand-in of the same type, the same for every recurrence within one capture, and the fixture contract MUST refuse any value there that is not in the exact form the capture writes, except for the legacy values listed against the one minimum-version fixture each was recorded in.
- A capture MUST also replace the facts that place a title — its year, air time, runtime, and language, with every byte count scaled by one factor — and MUST move every date it records by one offset of whole days, chosen afresh for each capture and recorded nowhere, so that order and spacing survive and the real calendar does not. The capture MUST normalize every representation of a fact it accepts — a number, a number written as text, a language by name, record, or id, and lists of them — keeping the original's type. A fixture recorded at a version newer than the minimum MUST hold every fact in its neutral form where that form is checkable — shifted dates and years, the stand-in runtime and air time, example languages, and zeroed ratings and popularity — and MUST carry the provenance mark the capture writes into its metadata, since a scaled byte count cannot be told from a real one.
- Fixtures MAY be recorded at more than one version of an application. Each fixture MUST be labelled with the exact version it was captured from, and one fixture MUST exist for at most one combination of application, version, and route.
- The fixtures recorded at an application's minimum supported version MUST remain the evidence for that minimum. Recording a fixture at a newer version MUST NOT replace or remove a minimum-version fixture, and MUST NOT by itself raise the minimum supported version.
- A fixture recorded at a newer version MUST be treated as evidence only for the version it names; a test that relies on it MUST name that version rather than reading it as the application's recorded contract.

#### Scenario: A recorded fixture contradicts the instance it names

- **GIVEN** a recorded fixture declares an application, a version, and a route
- **WHEN** that route is read from a real instance of that application at that version
- **THEN** the recorded body carries the same field shapes the instance returns, so a shape the instance never sends cannot stand as the recorded contract

#### Scenario: Record a route at a newer version

- **GIVEN** an application's fixtures are recorded at its minimum supported version, and a route is approved at a newer version
- **WHEN** that route is captured from an instance reporting the newer version
- **THEN** the fixture is written under and labelled with the newer version, every minimum-version fixture is left unchanged, and the minimum supported version is unchanged

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
- Publishing a release MUST require an explicit human action; automation MUST NOT publish a release on its own.
- Publishing MUST NOT depend on a long-lived registry credential stored in the repository.
- The server MUST also be distributed as a container image in the project's container registry, built by installing the same packed package the npm registry receives, so the image runs the published artifact and contains no sources, tests, or fixtures.
- An image tagged with a release version or as the latest release MUST be published only for a release a maintainer merged, and only after that release's standing quality gates have passed.
- Images built from the default branch MAY be published automatically as development images; a development image is not a release, and MUST NOT carry a release version tag or the latest tag.
- An image MUST NOT be published unless those exact image bytes, for every platform it is published for, first passed a smoke test of the running container; publication MUST NOT rebuild the image it tested. A pull request MUST NOT publish an image.
- The image MUST run the server as a non-root user and MUST default to the HTTP transport listening on every interface of the container.
- The image MUST NOT contain a bearer token, an instance URL, an API key, or any other credential; the operator supplies them when the container starts, and the server's startup rejections apply unchanged.

#### Scenario: Install and run without the repository

- **GIVEN** a host with a supported Node.js runtime and no checkout of this project
- **WHEN** the host installs the published package and launches its command with instance environment variables
- **THEN** the MCP server starts over stdio exactly as it does from a local build

#### Scenario: Run the published package as a remote service

- **GIVEN** a host with a supported Node.js runtime and no checkout of this project
- **WHEN** an operator launches the published package's command with instance variables, the HTTP transport, and a bearer token
- **THEN** the server listens for MCP over HTTP exactly as it does from a local build

#### Scenario: Release awaits a human

- **GIVEN** the automated release process has prepared a pending release for the accumulated commits
- **WHEN** no maintainer has approved it
- **THEN** nothing is published to the registry and the pending release remains available for review

#### Scenario: A merged release publishes its image

- **GIVEN** a maintainer merges the pending release and its package is published to the npm registry
- **WHEN** the release's container image passes its smoke test
- **THEN** the image is published tagged with the release version and as the latest release, and reports the same version as the npm package

#### Scenario: A development image is never a release

- **GIVEN** a commit lands on the default branch without a release
- **WHEN** its container image passes its smoke test and is published
- **THEN** it is tagged with the branch and the commit only, and no release version tag or latest tag moves

#### Scenario: A pull request builds but never publishes

- **GIVEN** a pull request changes the image or the package
- **WHEN** its image is built and smoke-tested
- **THEN** nothing is pushed to the container registry and no registry credential is used

#### Scenario: The image starts only with operator credentials

- **GIVEN** the container image is started without a bearer token
- **WHEN** the server starts inside it
- **THEN** startup fails naming the missing variable without echoing any configured value, and no listener is opened

## Design

### Architecture

The server is organized around transport, typed tool handlers, workflow services, an internal semantic operation registry, application adapters, and an upstream HTTP boundary. The semantic registry is an implementation inventory and policy source; it is not exposed as a generic dispatcher tool.

Transport and toolset are independent choices made at startup. Either toolset, or both together, runs over either transport, and every tool sits over the same adapters, upstream client, and workflow state.

All local state is ephemeral. Long-running upstream commands are projected into process-local job records while the upstream application remains authoritative.

### Data Models

The cross-cutting model includes configured application identity, application version, opaque process-local references, normalized errors, plan snapshots, and job status. Domain-specific models are owned by the linked feature specifications.

### API Surface

The inbound runtime surface is MCP over stdio, or MCP over the HTTP endpoint plus its health path defined by [HTTP Transport](../http-transport/#api-surface). Outbound calls target the configured Sonarr API v3, Radarr API v3, or Prowlarr API v1 base path.

### Business Logic

Startup validates environment pairs, probes each configured instance, and registers a stable tool set. Tool handlers select only configured instances and delegate to typed workflows rather than accepting endpoints or command names.

## Constraints

- Every deployment serves a single operator. Over HTTP, every client holding the bearer token acts with the same authority.
- A deployment runs as one process, because runtime state is process memory; see [HTTP Transport — Constraints](../http-transport/#constraints).
- Multi-instance applications, OAuth, multiple users, RBAC, databases, local configuration files, and configuration UI are outside scope.
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
| 2026-11-07 | Stdio-only transport replaced by a startup transport selection with Streamable HTTP; state shared across a process's clients; single-operator and single-process constraints stated | [0030-streamable-http-transport](../../changes/0030-streamable-http-transport.md) |
| 2026-11-07 | Non-instance settings, including the toolset and its defaults, required to come from the environment | [0031-media-toolset-library](../../changes/0031-media-toolset-library.md) |
| 2026-11-07 | Container image distribution added: built from the packed package, published only as the exact bytes that were smoke-tested, release images only from a merged release, development images never tagged as a release, non-root, and no credentials baked in | [0034-container-image](../../changes/0034-container-image.md) |
| 2026-11-08 | Fixtures allowed at more than one version per application, each labelled with the version it was captured from; minimum-version fixtures kept as the evidence for the minimum, and a newer-version fixture made evidence only for the version it names | [0035-fixtures-at-newer-versions](../../changes/0035-fixtures-at-newer-versions.md) |
| 2026-11-08 | Recorded fixtures barred from carrying what identifies a library or the services behind it; the capture replaces it with consistent stand-ins, replaces the facts that place a title, and moves every date by one secret per-capture offset, and the fixture contract refuses anything else | [0032-media-toolset-activity](../../changes/0032-media-toolset-activity.md) |
