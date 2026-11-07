# 0030: Streamable HTTP Transport

## Summary

Let an operator run the server as a remote service over Streamable HTTP, protected by one static bearer token, so MCP clients can use the configured Sonarr, Radarr, and Prowlarr instances without ever holding their API keys. Stdio remains the default. The [HTTP Transport spec](../specs/http-transport/) owns the endpoint's behavior; [Architecture](../specs/architecture/#transports) owns the transport selection.

**Spec:** [HTTP Transport](../specs/http-transport/)
**Status:** complete
**Depends On:** —

## Motivation

Today every MCP host that wants this server launches it as a subprocess with all six instance variables in its environment, so every host holds every API key. That rules out:

- hosted MCP clients, which cannot launch a local subprocess;
- clients on a machine other than the one next to the *arr applications;
- giving someone the tools without giving them the keys.

A remote deployment fixes all three by making the server the only place the keys live. What a client gets instead is a URL and a token that authorizes this server's published tools and nothing else.

The architecture forbids this today: [Architecture](../specs/architecture/) required stdio exclusively and barred any network listener, and listed remote transport as out of scope. This change replaces that requirement with a startup transport selection; the spec edits are already made and marked unimplemented.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules (see [Architecture — Testing Contract](../specs/architecture/#testing-contract)). CI enforces these as merge gates:

- Exported behavior MUST have automated tests at the narrowest practical level.
- MCP tools MUST keep their protocol-level stdio integration tests, and the HTTP transport MUST have protocol-level integration tests against a real listener.
- Committed tests MUST NOT be focused, skipped, or dependent on live personal *arr instances.
- Build, type check, lint, tests, and package verification MUST pass in CI.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

Additionally, because this change opens a network listener guarding credentials:

- Every refusal in [HTTP Transport — Bearer Authentication](../specs/http-transport/#bearer-authentication), [Origin Validation](../specs/http-transport/#origin-validation), and [Failed-Authentication Throttling](../specs/http-transport/#failed-authentication-throttling) MUST be tested over a real socket, and each test MUST also assert that no upstream request was sent.
- A test MUST capture the complete response bodies and stderr of a run that exercises every refusal, a successful tool call, and an upstream authentication failure, and MUST assert that neither the bearer token nor any instance API key appears anywhere in them.
- A test MUST plan a mutation in one HTTP request and apply it in another, on a new connection, to prove the shared process state.
- The package verifier MUST start the installed executable in HTTP mode, so a packaging regression in the new runtime fails the gate the way a stdio one does.

### Functional requirements

The [HTTP Transport spec](../specs/http-transport/) owns the variables, defaults, endpoint behavior, refusal order, health path, and scenarios. [Architecture — Transports](../specs/architecture/#transports) and [Environment-Only Instance Configuration](../specs/architecture/#environment-only-instance-configuration) own the selection and the startup rejections. Those scenarios are this change's acceptance criteria and are not restated here. What implementing them requires of this change:

- The stdio runtime's behavior MUST NOT change: a process with no transport selected starts exactly as it does today, and every existing stdio test passes unmodified except for the environment filters below.
- The HTTP runtime MUST build each request's server over the one adapter registry, operation inventory, and workflow state the process created at startup.
- Every new environment variable MUST be added to the environment filters the spawned-server tests and the package verifier use, so a developer's own setting cannot change what those observe.
- The package's description and keywords MUST stop describing it as stdio-only.

## Design

### Approach

- **Configuration.** Extend `EnvironmentConfiguration` in `src/config/environment.ts` with a `transport` discriminated union: `{ kind: "stdio" }` or `{ kind: "http", host, port, token }`. Each variable follows the `parseUpstreamTimeout` pattern: an exported name constant, `readVariable`, and problems accumulated into the shared list. HTTP variables found under stdio push one problem each. Like the timeout, all of this is parsed after the missing-application check, so no new problem hides that diagnostic.
- **Runtime.** Add `src/http-transport.ts` beside `src/stdio.ts`. It exports `createHttpRuntime(configuration, dependencies)`, which returns the same `start()`/`close()` shape. Rename `StdioRuntime` to `Runtime` and have `src/process.ts` choose a runtime by `configuration.transport.kind`. `src/http/` keeps its current meaning, the upstream client, so the inbound listener does not go there.
- **Request pipeline.** A `node:http` server runs the checks in the spec's [refusal order](../specs/http-transport/#refusal-order), and only a request that passes all of them reaches MCP handling. That step creates a fresh SDK Streamable HTTP server transport with no session id generator and JSON responses enabled, and a fresh `createServer(context)`. It connects the two, hands over the already-read body, and closes both when the response finishes.
- **Token comparison.** Hash the configured token and the presented one with SHA-256 and compare the digests with `crypto.timingSafeEqual`. Equal-length digests make the comparison constant-time whatever the presented length.
- **Throttle.** Keep an in-memory map from peer address to `{ failures, windowStart }`. Prune entries whose window has ended. Cap the map size and evict the oldest entry, so a flood of distinct addresses cannot grow memory without bound.
- **Body bound.** Refuse when `Content-Length` exceeds 1 MiB. Otherwise count bytes while reading, and abort at the bound when no length was declared.
- **Lifecycle.** `start()` binds the listener and then writes the one startup diagnostic. It also unrefs stdin, so a closed or absent stdin in a container neither keeps the process alive nor ends it. `close()` stops accepting connections, closes idle ones, and waits for in-flight requests until the upstream timeout, then closes the rest.

### Decisions

- **Decision:** Build a new MCP server and transport for every request, over shared state.
  - **Why:** The pinned SDK refuses to reuse a stateless transport across requests, and a protocol instance cannot connect to a second transport. One server per request is what stateless mode requires. The tool context is the only thing that must persist, and it already does.
  - **Alternatives considered:** Stateful sessions with one server per session. Rejected: it needs session bookkeeping and idle eviction, and it would break a client that reconnects. It would also tie references to a session the spec does not have.
- **Decision:** Measure per-request server construction before optimizing it.
  - **Why:** `registerTools` builds every published schema each time it runs. If the measured cost per request matters next to the upstream calls a tool makes, precompute the published definitions once at startup and register those. Until a measurement says so, the simpler code wins.
  - **Alternatives considered:** Precomputing up front, deferred until a measurement justifies it.
  - **Measurement:** Building a server with the full `arr` toolset over a context for all three applications took 0.21 to 0.26 ms per construction (Node.js 24, warm, five runs of 2,000 constructions each). That is noise beside the upstream calls a tool makes, which take milliseconds to seconds, so each request keeps building its own server and nothing is precomputed.
- **Decision:** Use `node:http` with the SDK's Node transport, and add no direct dependency.
  - **Why:** The pipeline is five checks and one handoff. Express is installed only as a dependency of the SDK, and building on it would make it this package's dependency without declaring it. A declared dependency is a new supply-chain surface the request does not need.
  - **Alternatives considered:**
    - The SDK's Express app helper and bearer-auth middleware. Rejected: they pull in Express, and the middleware is shaped around OAuth token verification and resource metadata, which the spec forbids publishing.
    - The SDK transport's own `allowedOrigins` and DNS-rebinding options. Rejected: they are deprecated in the pinned SDK in favor of external middleware.
- **Decision:** Default the port to 9797.
  - **Why:** It avoids the ports the supported applications use by default (8989, 7878, 9696) and the ports common neighbors in a media stack use (8080 for download clients' web interfaces, 5055, 6767, 8686, 8787). This prevents a collision on a host that runs the whole stack.
  - **Alternatives considered:** 3000 and 8080. Rejected: both are among the most commonly occupied ports on such hosts.
- **Decision:** Refuse every origin-bearing request, offer no origin allow-list, and do not validate `Host`.
  - **Why:** Non-browser MCP clients send no `Origin`, so this refuses only browsers. An allow-list would be useless without cross-origin preflight handling too, which is surface no supported client needs. That is exactly the DNS-rebinding vector the protocol requires servers to guard against. Every MCP request also needs the bearer token, which a rebinding page does not have. A `Host` allow-list would only add a setting that breaks deployments behind proxies that rewrite `Host`.
  - **Alternatives considered:** A required public-URL setting validating both `Host` and `Origin`. Rejected for the proxy breakage and the extra required setting. An origin allow-list with preflight handling, for clients running in a browser, was also rejected: it is surface no supported client needs.
- **Decision:** Answer every request with JSON, never server-sent events.
  - **Why:** No tool emits progress or server-to-client requests, so an event stream would carry exactly one message and only add proxy buffering problems.
  - **Alternatives considered:** The SDK's SSE default. Rejected for that reason.

### Non-Goals

- OAuth, OAuth discovery metadata, dynamic client registration, multiple tokens, or per-client permissions.
- Protocol revision 2026-07-28, which needs an SDK upgrade; see the spec's open question.
- TLS termination, a container image, or deployment manifests.
- Trusting forwarded-address headers.
- Persistent or shared-across-replica state.

## Tasks

- [x] Serve MCP over Streamable HTTP
  - [x] Parse `ARR_MCP_TRANSPORT`, `ARR_MCP_HTTP_HOST`, `ARR_MCP_HTTP_PORT`, and `ARR_MCP_AUTH_TOKEN` in `src/config/environment.ts`. Reject HTTP settings under stdio. Cover every accepted and rejected value in `test/environment.test.ts`, including that no rejected value is echoed.
  - [x] Rename `StdioRuntime` to `Runtime` and select the runtime in `src/process.ts` by transport, keeping `test/process.test.ts` and `test/stdio.test.ts` green.
  - [x] Add `src/http-transport.ts` with the request pipeline, per-request server construction over shared context, the throttle, the body bound, the health path, and the lifecycle.
  - [x] Add `test/http-transport.test.ts`. It starts the runtime on an ephemeral port through its dependencies and covers every requirement and scenario in the spec over real sockets, with an upstream stub that records whether any request was sent.
  - [x] Add a spawned-process test that starts the built server with the HTTP transport, calls a tool with the token, sends `SIGTERM` during a call, and asserts that the process exits. Assert that stderr carries only the startup diagnostic and holds no credential.
  - [x] Measure per-request server construction on the full `arr` toolset, and record the measurement and the resulting decision in this document.
  - [x] Add the new variables to `configurationVariables` in `test/support/spawned-stdio.ts` and to the filter list in `scripts/verify-package.mjs`.
  - [x] Add `dist/http-transport.js` to the packed-file inventory in `scripts/verify-package.mjs`.
- [x] Verify and document the packaged HTTP mode
  - [x] Extend `scripts/verify-package.mjs` to launch the installed executable with the HTTP transport on an ephemeral port. It asserts `200` from `/healthz`, `401` without a token, a successful initialization with the token, and a clean exit on `SIGTERM`.
  - [x] Add a "Run as a remote service" section to `README.md`. It covers:
    - the variables and their defaults;
    - a client configuration that sends the bearer header;
    - TLS at a reverse proxy;
    - the single-replica, stop-then-start constraint;
    - token rotation by restart.
  - [x] Change the README's "supports MCP over stdio only" statement, and update `description` and `keywords` in `package.json`.
  - [x] Remove the unimplemented status notes from [HTTP Transport](../specs/http-transport/) and [Architecture — Transports](../specs/architecture/#transports).

## Open Questions

None.

## References

- Spec: [HTTP Transport](../specs/http-transport/)
- Spec: [Architecture](../specs/architecture/)
- Related changes: [0029-configurable-upstream-timeout](./0029-configurable-upstream-timeout.md), whose environment-parsing pattern this follows
- External: [MCP Streamable HTTP (2025-11-25)](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#streamable-http), [RFC 6750](https://www.rfc-editor.org/rfc/rfc6750)
