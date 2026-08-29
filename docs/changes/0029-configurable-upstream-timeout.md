# 0029: Configurable Upstream Timeout

## Summary

Make the deadline every outbound upstream request is given an operator-settable value, and raise its default from 10 000 ms to 30 000 ms. `defaultUpstreamTimeoutMs` in `src/http/client.ts` is 10 000, and the only way to override it — `AdapterRegistryDependencies.timeoutMs` — has no caller anywhere in `src/`, so the value is unreachable in the running server. Two tool variants fail one hundred percent of the time against real instances because of it. A new `ARR_UPSTREAM_TIMEOUT_MS` environment variable, validated at startup like every other variable, sets the deadline, and the registry reads it from the parsed configuration rather than from a dependency nothing supplies.

**Spec:** [Architecture](../specs/architecture/)
**Status:** complete
**Depends On:** —

## Motivation

The timeout is both too short and unchangeable, and each half is a defect on its own.

**Ten seconds is shorter than the reads these applications genuinely take.** Measured against live instances at the recorded minimum versions:

| Request | Elapsed | Payload |
|---|---|---|
| `GET /api/v3/release?seriesId=3&seasonNumber=1` (Sonarr) | 13.3 s | — |
| `GET /api/v3/history/series?seriesId=93` (Sonarr) | 17.8 s | 2.96 MB |
| `GET /api/v3/movie` (Radarr) | 5.0 s warm, timed out cold | 6.79 MB |

An indexer search is bounded by the slowest indexer that answers, not by the instance; a whole-library read is bounded by the size of the library. Neither is anomalous, and a 10 s deadline aborts both. `arr_release_search` with `target: sonarr_season` and `arr_activity_change` with `intent: mark_history_failed` therefore fail every time on a library of any size — the first waits on the indexer sweep, the second reads the series history before it can select a record to fail.

**And there is no way to raise it.** `AdapterRegistryDependencies` declares `timeoutMs`, `createAdapterRegistry` passes it into every client it builds, and nothing ever sets it: `src/stdio.ts:37` calls `createAdapterRegistry(configuration)` with no dependencies at all, and it is the only production caller. The field is reachable only from a test. So the 10 000 ms literal is not a default an operator can move — it is the value, always, and `dependencies.timeoutMs` is dead code that reads as configurability without being any.

The remedy is one environment variable, because that is the only configuration surface this server has: [Architecture](../specs/architecture/#environment-only-instance-configuration) requires configuration to be read from the process environment at startup, with no file, database, or runtime endpoint. Raising the default alone would leave the second half of the defect in place — a slower library or a slower indexer would hit the new wall exactly as it hits this one, and the operator would again have nothing to turn.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules (see [Architecture — Testing Contract](../specs/architecture/#testing-contract)). CI enforces these as merge gates:

- Exported behavior MUST have automated tests at the narrowest practical level.
- Adapter tests MUST use sanitized, version-labelled fixtures rather than personal live instances.
- Stdio integration tests MUST verify protocol framing and stdout cleanliness.
- Build, type check, lint, and tests MUST pass without focused or skipped tests.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

Additionally, because the defect is that a configured value never reached the request:

- A test MUST prove the configured number travels the whole path — environment variable, parsed configuration, registry, client, abort — rather than only that each end of it holds a number. Asserting the parse result and asserting the client's default separately would both have passed while the value was dead.
- A test MUST pin the default to 30 000 ms, so raising or lowering it is a deliberate edit rather than a drift.
- A test MUST assert that a rejected value is never echoed into the startup diagnostic, in the same way the existing redaction test does for a base URL and an API key.
- A test MUST assert that a bad timeout in an environment with no configured application reports both problems, since the missing-application diagnostic is emitted only when nothing else has been reported.

### Functional requirements

- The deadline applied to every outbound upstream request MUST be settable through a single environment variable.
- The variable MUST be optional; when it is absent the server MUST use a default of 30 000 ms.
- The value MUST be read as a whole number of milliseconds.
- A value that is not usable — empty, not a whole number, zero or negative, or outside the accepted range — MUST reject startup with a problem that names the variable and never its value, exactly as every other configuration problem does.
- The accepted range MUST be bounded above, so that the configured delay is one a single timer can honor.
- The configured value MUST reach the client every adapter calls through, rather than only the configuration record.
- The value MUST be read once at process startup, like every other environment setting.

#### Scenario: A slow library read completes

- **GIVEN** an operator has set the upstream timeout variable to a whole number of milliseconds larger than the default
- **WHEN** a tool issues an upstream request that takes longer than the default deadline but less than the configured one
- **THEN** the request completes and returns its result rather than being aborted as a timeout

#### Scenario: An unusable timeout rejects startup

- **GIVEN** the upstream timeout variable is set to a value that is not a whole number of milliseconds in the accepted range
- **WHEN** the server starts
- **THEN** startup fails with a problem naming the variable, the configured value does not appear in the diagnostic, and no MCP session is opened

## Design

### Approach

- Raise the single `defaultUpstreamTimeoutMs` literal in `src/http/client.ts` to 30 000 and import it where the environment is parsed, so the default has one definition.
- Add `ARR_UPSTREAM_TIMEOUT_MS` to `src/config/environment.ts`, parsed by the same `readVariable` the instance pairs use and accumulated into the same `problems` list, and return it as a required `upstreamTimeoutMs` field on `EnvironmentConfiguration`.
- Delete the unreachable `AdapterRegistryDependencies.timeoutMs` and have `createAdapterRegistry` pass `configuration.upstreamTimeoutMs` into every client it builds.
- Add the variable to the environment filters the spawned-server tests and the package verifier use, so a developer's own setting cannot decide what those observe.

### Decisions

- **Decision:** Read the timeout from the parsed configuration rather than resurrecting `AdapterRegistryDependencies.timeoutMs`.
  - **Why:** The dead field is the bug, not the missing wiring around it. Keeping it and adding a caller would give the same value two paths into the same client — one from the environment and one from a dependency object — and nothing would say which wins, so the next reader would have to work it out from `??` precedence. The dependencies object exists to replace the network in a test, which is what `fetch` is for; a configured deadline is configuration and belongs where the other configuration is. Deleting the field costs nothing outside this repository: `package.json` publishes `bin` and `files: ["dist"]` with no `main`, `exports`, or `types`, so no consumer can name the type.
  - **Alternatives considered:** Keeping `timeoutMs` on the dependencies and having `src/stdio.ts` pass `configuration.upstreamTimeoutMs` through it, rejected because it threads a value through a seam whose purpose is test substitution and leaves the precedence question open; giving the registry both and preferring the dependency, rejected for the same reason plus an override no production path can reach.
- **Decision:** Keep the single `30_000` literal in `src/http/client.ts` and import it into `src/config/environment.ts`.
  - **Why:** The client is where the value is used and where it already lived, and `defaultUpstreamTimeoutMs` is already exported and already asserted by `test/upstream-client.test.ts`. A second literal in the configuration module could drift from it silently — the parser would hand back one number while a directly constructed client used another — and only a test that compared the two would notice.
  - **Alternatives considered:** A new `src/config/timeouts.ts` holding the constant, rejected because it buys nothing over an import and costs a new entry in the exhaustive `dist/**` inventory in `scripts/verify-package.mjs` (`:35-117`), which every packaging run compares byte for byte; defining the default in the configuration module and having the client import it, rejected because it inverts the dependency — the client would then depend on configuration parsing to know its own fallback.
- **Decision:** Bound the accepted range at 600 000 ms.
  - **Why:** This is a correctness bound rather than a policy about how long an operator may wait. `setTimeout` stores its delay in a signed 32-bit integer, and a delay above 2 147 483 647 ms is clamped to 1 ms — so a configured value large enough to overflow would abort every request almost immediately, the exact inverse of what was asked for. The client's own guard (`Number.isFinite(timeoutMs) && timeoutMs > 0`) cannot see this: an overflowing value is finite and positive, and passes. Ten minutes is comfortably above the slowest measured request and comfortably below the overflow, so the bound is enforced where the value is read and the failure mode is unreachable.
  - **Alternatives considered:** No upper bound, rejected for the silent inversion above; `2_147_483_647` as the bound, rejected because a value near it is not a deadline an operator meant and the diagnostic would be less useful than a plausible one; clamping a too-large value to the maximum instead of rejecting it, rejected because this project rejects unusable configuration rather than quietly substituting for it — every other environment problem fails startup.
- **Decision:** Test the digit string before converting it, and say so in the code.
  - **Why:** `Number` accepts far more than a decimal integer: `" "` becomes `0`, `"1e4"` becomes `10000`, `"0x7530"` becomes `30000`, and `"+30000"` becomes `30000`. Each of those would be a value an operator did not write, silently accepted. A `/^\d+$/` test before the conversion admits exactly one spelling. It also covers magnitude for free — a digit string long enough to exceed `Number.MAX_SAFE_INTEGER` converts to a number above the cap and is refused by the same range branch, so no separate guard is needed.
  - **Alternatives considered:** `Number.parseInt`, rejected because it reads a prefix and silently discards the rest, so `"30s"` would become `30`; `Number.isInteger` alone on the converted value, rejected because it accepts every one of the spellings above.
- **Decision:** Parse the timeout after the missing-application check, and before the throw.
  - **Why:** `describeMissingConfiguration()` is pushed only when `problems.length === 0 && instances.length === 0`. A timeout problem recorded earlier would make that condition false, so an environment with no application *and* a bad timeout would report only the timeout and silently lose the more important diagnostic. Parsing after the check preserves both, and parsing before the throw keeps an unusable value fatal. It also places the timeout problem last, which is the accumulation order the existing tests pin.
  - **Alternatives considered:** Parsing first, alongside the instance pairs, rejected because it suppresses the missing-application diagnostic as described; parsing after the throw, rejected because an invalid value would then be ignored whenever the instances happened to be valid.
- **Decision:** One global variable rather than a per-application or per-operation setting.
  - **Why:** The failing operations are slow for reasons that are not per-application — an indexer sweep and a large payload — and a per-application knob would ask the operator to know which of three applications is slow before they can fix a timeout. One value is also the smallest thing that closes the defect, and a narrower one can be added later without changing what this one means.
  - **Alternatives considered:** A variable per application, and a longer deadline for known-slow routes; both rejected as unmotivated by the evidence and as configuration surface no observation asks for yet.

The spec's rule that instance connection settings are read exclusively from the six named variables (`docs/specs/architecture/index.md:47`) is not weakened by this change. The timeout is not an instance connection setting: it selects no instance, addresses none, and authenticates to none. It is a property of how this server issues a request, and it is stated in the Upstream Connection Handling section, which is where the finite-timeout rule it refines already lives.

### Non-Goals

- Per-application or per-operation timeouts.
- Retry or backoff behavior of any kind; a request that exhausts its deadline still fails as a timeout.
- The error-summary defect that drops `error.message` from the one-line result text.
- The `timeout` remediation wording in `src/tools/errors.ts:97`, which advises a caller about a timeout and is unchanged by this.

## Tasks

- [x] Make the upstream timeout configurable and raise the default
  - [x] Raise `defaultUpstreamTimeoutMs` in `src/http/client.ts` to 30 000, leaving the client's own finite-positive guard as it is
  - [x] Parse `ARR_UPSTREAM_TIMEOUT_MS` in `src/config/environment.ts` as a whole number of milliseconds in the accepted range, defaulting to the client's constant, and return it as a required field
  - [x] Accumulate an unusable value as a problem that names the variable only, recorded after the missing-application check so both diagnostics survive
  - [x] Delete the unreachable `AdapterRegistryDependencies.timeoutMs` and pass `configuration.upstreamTimeoutMs` into every client the registry builds
- [x] Prove the configured value reaches the request
  - [x] Cover acceptance, the default, both boundaries, every rejected spelling, and the accumulation order in `test/environment.test.ts`, including that a rejected value never appears in the error
  - [x] Pin the default to 30 000 ms in `test/upstream-client.test.ts`
  - [x] Build a registry from a parsed environment carrying a tiny timeout and assert the resulting abort reports that number, so the whole path is covered by one test with no network
  - [x] Spawn the built server with an unusable value and assert it exits before opening a session without echoing the value
  - [x] Add the variable to the environment filters in `test/support/spawned-stdio.ts`, `test/stdio-process.test.ts`, and `scripts/verify-package.mjs`, and correct the comments that describe them as instance variables
- [x] Record the rule the change establishes
  - [x] State the configurability, the default, the redaction, and the bounded range in [Architecture — Upstream Connection Handling](../specs/architecture/#upstream-connection-handling), with a scenario and a changelog row
  - [x] Document the variable in `README.md` beside the instance settings

## Open Questions

None.

## References

- Spec: [Architecture](../specs/architecture/)
- Related changes: [0001-project-foundation](./0001-project-foundation.md), [0011-npm-publishing](./0011-npm-publishing.md)
