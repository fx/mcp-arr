# HTTP Transport

## Overview

This specification defines the optional Streamable HTTP transport, which lets an operator run the server as a long-lived remote service. Remote MCP clients reach it over HTTP with a single static bearer token. The Sonarr, Radarr, and Prowlarr API keys stay in the server's own environment and never reach a client. Stdio remains the default transport; the selection rule and everything common to both transports are owned by [Architecture](../architecture/).

**Status:** unimplemented. [0030-streamable-http-transport](../../changes/0030-streamable-http-transport.md) implements this specification.

## Background

Over stdio, every MCP host that wants this server has to hold the instance URLs and API keys itself, because it launches the process with them in its environment. That rules out hosted clients, clients on another machine, and any setup where the person using the tools should not hold the keys.

Over HTTP, the server becomes a gateway that holds the credentials. The operator deploys it once next to the *arr applications and gives clients a URL and a bearer token. The token authorizes calling this server's published tools and nothing else. It is not an *arr API key and cannot be turned into one.

Authentication is deliberately one static token configured at deployment. The MCP authorization specification is OAuth-based and needs an authorization server, which this project does not run. Authorization is optional for HTTP servers in MCP, so a static bearer credential with standard semantics is a conforming choice that sits outside that specification rather than a partial implementation of it.

Related behavior:

- [Architecture](../architecture/) owns transport selection, environment-only configuration, ephemeral state, and the testing contract.
- [Tool Contracts](../tool-contracts/) owns the published tool surface, which is identical on both transports.

## Requirements

### Listener Configuration

- The HTTP transport MUST be configured exclusively through these environment variables, read once at startup:

  | Variable | Meaning | Default |
  |---|---|---|
  | `ARR_MCP_HTTP_HOST` | Address the listener binds to | `127.0.0.1` |
  | `ARR_MCP_HTTP_PORT` | TCP port the listener binds to | `9797` |
  | `ARR_MCP_AUTH_TOKEN` | The bearer token every MCP request must present | none; required |

- `ARR_MCP_HTTP_PORT` MUST be a whole number from 1 to 65535.
- `ARR_MCP_AUTH_TOKEN` MUST be required when the HTTP transport is selected, and MUST consist of at least 32 and at most 4096 characters drawn only from the RFC 6750 `b64token` alphabet.
A missing token, an unusable value, or any of these variables set while stdio is selected rejects startup as [Architecture — Environment-Only Instance Configuration](../architecture/#environment-only-instance-configuration) requires.

- A listener that cannot bind MUST reject startup with a diagnostic naming the address and port, and the process MUST exit with a nonzero status.

#### Scenario: Start without a token

- **GIVEN** the HTTP transport is selected and `ARR_MCP_AUTH_TOKEN` is absent
- **WHEN** the server starts
- **THEN** startup fails naming `ARR_MCP_AUTH_TOKEN`, and no listener is opened

#### Scenario: Reject a short token without echoing it

- **GIVEN** the HTTP transport is selected and `ARR_MCP_AUTH_TOKEN` is set to a 20-character value
- **WHEN** the server starts
- **THEN** startup fails naming the variable, and the diagnostic does not contain the value

### MCP Endpoint

- The server MUST serve MCP on exactly one endpoint path, `/mcp`, and MUST conform there to the Streamable HTTP binding of the protocol revisions the server negotiates.
- The endpoint MUST be stateless: it MUST NOT mint, require, or echo a protocol session identifier.
- Clients perform the initialization exchange the negotiated revision requires, and the server MUST answer it; but no later request MUST be refused because the server instance answering it did not itself see that exchange, since each request is answered by an instance built for that request alone.
- Every response to a JSON-RPC request MUST be a single `application/json` body; the server MUST NOT open a server-sent event stream.
- `GET` and `DELETE` on the endpoint MUST be answered with `405 Method Not Allowed`.
- A request body larger than 1 MiB MUST be refused with `413 Content Too Large` without being parsed.
- Any path other than `/mcp` and the health path MUST be answered with `404 Not Found`, including every `/.well-known/oauth-*` discovery path, so a client never begins an OAuth flow this server cannot complete.

#### Scenario: Call a tool without a session

- **GIVEN** an authenticated client
- **WHEN** it posts an initialization request, and then, in separate requests on new connections, `tools/list` and `tools/call`
- **THEN** each request is answered with a JSON body, and no response carries a session identifier

#### Scenario: A client probes for OAuth metadata

- **GIVEN** an MCP client that tries OAuth discovery after an authentication challenge
- **WHEN** it requests `/.well-known/oauth-protected-resource`
- **THEN** the server answers `404`, and the client falls back to its configured bearer header

### Refusal Order

- A request that fails more than one check MUST be answered by the first check it fails, in this order: path and method, origin, failed-authentication throttle, credential, body size.
- Each requirement in [Bearer Authentication](#bearer-authentication), [Failed-Authentication Throttling](#failed-authentication-throttling), [Origin Validation](#origin-validation), and the body bound in [MCP Endpoint](#mcp-endpoint) MUST be read as stating the answer for a request that passed every earlier check.
- The origin, throttle, credential, and body checks MUST apply only to `POST /mcp`.

#### Scenario: Wrong method and no token

- **GIVEN** the server is running with a configured token
- **WHEN** a client sends `GET /mcp` with no credential
- **THEN** the server answers `405`, not `401`

#### Scenario: Disallowed origin and wrong token

- **GIVEN** the server is running with a configured token
- **WHEN** a browser posts to `/mcp` with an `Origin` header and a wrong bearer token
- **THEN** the server answers `403`, and the failure is not counted toward the throttle

### Bearer Authentication

- Every request to the MCP endpoint MUST present the configured token as `Authorization: Bearer <token>` and MUST be refused before its body is read or any tool runs when it does not.
- A request with no `Authorization` header MUST be answered with `401 Unauthorized` and `WWW-Authenticate: Bearer realm="mcp-arr"`.
- A request presenting a bearer token that does not equal the configured token MUST be answered with `401 Unauthorized` and `WWW-Authenticate: Bearer realm="mcp-arr", error="invalid_token"`.
- A request whose `Authorization` header is not a single well-formed bearer credential MUST be answered with `400 Bad Request` and `WWW-Authenticate: Bearer realm="mcp-arr", error="invalid_request"`.
- A token supplied in the query string or the request body MUST NOT be accepted.
- The token comparison MUST take time independent of where a presented token first differs from the configured one.
- The configured token and any presented credential MUST NOT appear in a response, a diagnostic, or a tool result.

#### Scenario: Wrong token

- **GIVEN** the server is running with a configured token
- **WHEN** a client posts a `tools/call` request with a different bearer token
- **THEN** the server answers `401` with `error="invalid_token"`, no upstream request is sent, and neither token appears in the response or in stderr

#### Scenario: Token in the query string

- **GIVEN** the server is running with a configured token
- **WHEN** a client posts to `/mcp?access_token=<the configured token>` with no `Authorization` header
- **THEN** the server answers `401` exactly as for a request with no credential

### Failed-Authentication Throttling

- After 10 refused authentication attempts from one client address within 60 seconds, every further request from that address MUST be answered with `429 Too Many Requests` and a `Retry-After` header until the window ends, without comparing any presented token.
- An authenticated request MUST NOT count toward that limit.
- The client address MUST be the address of the connection's peer; forwarded-address headers MUST NOT be trusted.

#### Scenario: Repeated guesses are throttled

- **GIVEN** one client address has sent 10 requests with wrong tokens in the last 60 seconds
- **WHEN** it sends an eleventh request carrying the correct token
- **THEN** the server answers `429` with `Retry-After`, and the token is not evaluated

### Origin Validation

- A request carrying an `Origin` header MUST be answered with `403 Forbidden`.
- A request without an `Origin` header MUST NOT be refused for its absence.

MCP clients that run as native processes or on a hosted service's own servers send no `Origin`; only a page running in a browser does. Refusing every origin-bearing request is therefore the protocol's DNS-rebinding guard with no setting to get wrong, and it makes clients that run inside a browser unsupported: such a client would also need cross-origin preflight handling, which this endpoint does not provide.

#### Scenario: A web page tries to reach the server

- **GIVEN** the server is running with a configured token
- **WHEN** a browser page posts to `/mcp` with `Origin: https://attacker.example`
- **THEN** the server answers `403`, and no tool runs even if the request carried the correct token

### Health Endpoint

- `GET /healthz` MUST answer `200 OK` without authentication while the process is accepting requests.
- The health response MUST NOT disclose configured applications, instance URLs, versions, tool names, or any upstream state, and MUST NOT contact any upstream instance.

#### Scenario: Liveness probe

- **GIVEN** the server is running and every configured instance is unreachable
- **WHEN** an orchestrator requests `/healthz` with no credential
- **THEN** the server answers `200` with a body that names nothing about the deployment

### Shared Process State

- Every authenticated request MUST be served from the one set of process state the server holds, so a reference, plan, receipt, or job minted in answer to one request MUST resolve in a later request from any authenticated client within the same process lifetime.
- Requests MUST be served concurrently, and concurrent requests MUST observe the same apply-record and retry guarantees [Tool Contracts](../tool-contracts/#mutation-receipts-and-retry) gives sequential ones.

#### Scenario: Plan in one request, apply in another

- **GIVEN** an authenticated client plans a mutation and receives a plan reference
- **WHEN** a second HTTP request, on a new connection, applies that plan reference
- **THEN** the plan resolves and is applied exactly as it would be within one stdio session

### Lifecycle and Diagnostics

- On startup the server MUST write one diagnostic to stderr naming the address and port it listens on and the selected toolset.
- On `SIGINT` or `SIGTERM` the server MUST stop accepting connections, MUST let requests already in progress finish for no longer than the upstream request timeout, and MUST then exit.
- Diagnostics MUST NOT contain the bearer token, an `Authorization` header, an instance API key, or a request body.

#### Scenario: Orderly shutdown during a request

- **GIVEN** a tool call is waiting on an upstream response
- **WHEN** the process receives `SIGTERM`
- **THEN** new connections are refused, the in-progress call completes or is abandoned at the upstream deadline, and the process exits

## Design

### Architecture

The HTTP transport is a second way to carry the same server. Each request builds the published tool set over the process-wide adapter registry, operation inventory, and workflow state, answers that one request, and is discarded. Nothing about a request outlives it except what the workflow state records, which is exactly what a stdio session would have recorded.

Authentication, origin validation, throttling, and the body bound all run before the MCP layer sees the request. A refused request never reaches a tool, so no tool needs to know which transport called it.

### API Surface

| Method and path | Authentication | Answer |
|---|---|---|
| `POST /mcp` | Bearer token | MCP Streamable HTTP, JSON responses only |
| `GET /mcp`, `DELETE /mcp` | — | `405` |
| `GET /healthz` | none | `200`, no deployment detail |
| anything else | — | `404` |

### Business Logic

The checks run in the order [Refusal Order](#refusal-order) fixes, and only a request that passes all of them reaches MCP handling. Origin is checked before the token so a page in a browser learns nothing about whether its guess was right. Throttling is checked before the token so a throttled address cannot keep testing guesses. The body is bounded last, so an unauthenticated client cannot make the server read a large body.

## Constraints

- **Single operator.** Every authenticated client acts with the full authority of the configured instances, within the published toolset. There are no per-client identities, scopes, or audit trail; rotating the token, by changing the variable and restarting, is the only revocation.
- **Single replica.** Workflow state is process memory, so the service runs as one process. Two processes behind one URL would each reject the other's references, and a rolling deploy briefly runs two. Deployments stop the old process before starting the new one.
- **TLS is the deployment's job.** The listener speaks plain HTTP. A deployment reachable from anywhere other than the same host puts it behind a TLS-terminating reverse proxy; otherwise the bearer token crosses the network in clear text.
- **Throttling behind a proxy is per proxy.** Because forwarded headers are not trusted, every client behind one reverse proxy shares one peer address and one throttle. Token entropy, not throttling, is the defense against guessing; throttling only bounds the noise. A proxy in front can do its own per-client limiting.
- OAuth, OAuth discovery metadata, dynamic client registration, multiple tokens, per-client permissions, sessions, server-sent event streams, clients running inside a browser, cross-origin preflight handling, and persistent state are outside scope.

## Open Questions

- **Protocol revision 2026-07-28.** The pinned SDK negotiates revisions up to 2025-11-25, which use an initialization exchange. Revision 2026-07-28 removes protocol sessions and the initialization exchange from Streamable HTTP and adds required `Mcp-Method` and `Mcp-Name` headers with header–body validation. The endpoint's statelessness is compatible with that revision, but serving it requires an SDK release that implements it. Default: serve what the pinned SDK negotiates, and adopt 2026-07-28 when the SDK is upgraded.
- **Trusted proxy addresses.** Trusting `X-Forwarded-For` from a configured proxy address would give per-client throttling behind a proxy. Default: not trusted, per the throttling requirement, until a deployment needs it.

## References

- [MCP Transports — Streamable HTTP (2025-11-25)](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#streamable-http)
- [MCP Transports — Streamable HTTP (2026-07-28)](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)
- [RFC 6750 — OAuth 2.0 Bearer Token Usage](https://www.rfc-editor.org/rfc/rfc6750)
- [RFC 9110 — HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110)
- [Architecture](../architecture/)
- [Tool Contracts](../tool-contracts/)

## Changelog

| Date | Change | Document |
|------|--------|----------|
| 2026-11-07 | Initial desired-state specification created | [0030-streamable-http-transport](../../changes/0030-streamable-http-transport.md) |
