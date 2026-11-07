# 0033: Media as the Default Toolset

## Summary

Make `media` the toolset a process publishes when `ARR_MCP_TOOLSET` is absent, and keep the fourteen `arr` tools available behind `ARR_MCP_TOOLSET=arr`. Before the flip, every `media` tool is swept against live instances at the recorded minimum versions. This is a breaking change for every existing host. [Tool Contracts — Toolset Selection](../specs/tool-contracts/#toolset-selection) owns the default.

**Spec:** [Tool Contracts](../specs/tool-contracts/)
**Status:** draft
**Depends On:** 0031, 0032

## Motivation

The `media` toolset is the surface most deployments want, and a default should be what most deployments want. Leaving it opt-in means every new user meets the fourteen-tool model first and has to know to switch away from it.

The flip is a separate change for two reasons:

- **It is the breaking part.** A host that upgrades without setting the variable loses the `arr` tools, so the upgrade has to carry a migration note and a version bump that says so.
- **It needs evidence the test suite cannot give.** Change [0021](./0021-live-verified-fixtures.md) found six defects in a green suite by sweeping the tools against live instances. A toolset that acts without a plan should meet at least that bar before it becomes the default.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules (see [Architecture — Testing Contract](../specs/architecture/#testing-contract)). CI enforces these as merge gates:

- Exported behavior MUST have automated tests at the narrowest practical level.
- MCP tools MUST have protocol-level stdio integration tests for schemas, results, errors, and stdout cleanliness, for each toolset.
- Committed tests MUST NOT be focused, skipped, or dependent on live personal *arr instances.
- Build, type check, lint, tests, and package verification MUST pass in CI.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

Additionally:

- A test MUST pin the default: a process started with no `ARR_MCP_TOOLSET` publishes exactly the `media` tools, and one started with `arr` publishes exactly the fourteen `arr` tools.
- Every existing test that exercises an `arr` tool MUST select `arr` explicitly, so none of them depends on the default.

### Functional requirements

[Tool Contracts — Toolset Selection](../specs/tool-contracts/#toolset-selection) owns the default and its scenarios. They are this change's acceptance criteria and are not restated here. What implementing them requires of this change:

- **Live sweep gate.** Every `media` tool, and every row of the [download-state and remedy tables](../specs/media-toolset/#download-states) that a live instance can be brought into, MUST be exercised against live Sonarr, Radarr, and Prowlarr instances at the recorded minimum versions before the default changes.
  - The sweep's results MUST be recorded in this document's Findings.
  - Every defect it finds MUST be fixed, or tracked by its own change document, before this change merges.
- **Breaking-change commit.** The commit that changes the default MUST be marked breaking. Its footer MUST tell an upgrading operator to set `ARR_MCP_TOOLSET=arr` to keep the previous tools, or `all` to add the new ones beside them.
- **README order.** The README MUST present the `media` toolset first. The `arr` toolset becomes the advanced option, with the variable that selects it.

## Design

### Approach

- Change the absent-value default in `src/config/environment.ts` from `arr` to `media`, and remove the interim-default note from [Tool Contracts](../specs/tool-contracts/#toolset-selection).
- Set `ARR_MCP_TOOLSET=arr` inside `serverEnvironment()` in `test/support/spawned-stdio.ts`, the one helper every `arr`-exercising spawned test uses. Set it in the same way wherever `test/stdio-process.test.ts` and `scripts/verify-package.mjs` build an environment.
- Pass the `arr` toolset explicitly in every in-process test that calls `createServer` and asserts `arr` names. `test/tool-protocol.test.ts` is the one known today; the implementing PR finds the rest by running the suite with the new default.
- Leave `test/configuration-writes-withdrawn.test.ts` asserting its hand-written fourteen names under an explicit `arr` selection, since that list is deliberately independent of `src/tools/names.ts`.
- Extend `scripts/verify-package.mjs`'s installed-executable smoke test to assert that the default listing is the `media` toolset.

### Decisions

- **Decision:** Release the flip as a breaking `feat` at 0.x.
  - **Why:** `release-please-config.json` sets `bump-minor-pre-major`, so a breaking change below 1.0 bumps the minor version, and its footer lands in the changelog's breaking-changes section. That is how 0.3.0 shipped its breaking changes. It is the signal an operator reading the changelog looks for.
  - **Alternatives considered:** A 1.0.0 release, rejected as a separate decision about API stability that this change does not need to make. Keeping `arr` as the default forever, rejected for the reason in Motivation.
- **Decision:** Pin `arr` in the shared spawn helper rather than in each test.
  - **Why:** Eleven spawned test files exercise `arr` tools. Setting the variable once in the helper they all share changes one line instead of eleven, and a future `arr` test inherits it.
  - **Alternatives considered:** Per-file settings, rejected as eleven copies of one decision.

### Non-Goals

- Removing or deprecating the `arr` toolset.
- Any new `media` behavior; a defect the sweep finds is fixed against the spec as written.

## Findings

To be recorded by the live sweep.

## Tasks

- [ ] Sweep the `media` toolset against live instances
  - [ ] Exercise each `media` tool, and each reachable table row, against live instances at the recorded minimum versions, and record the results in Findings.
  - [ ] Fix, or file a change document for, every defect found.
- [ ] Make `media` the default
  - [ ] Change the default in `src/config/environment.ts` and pin it with a test.
  - [ ] Select `arr` explicitly in `test/support/spawned-stdio.ts`, `test/stdio-process.test.ts`, `test/tool-protocol.test.ts`, any other test the new default breaks, and `scripts/verify-package.mjs`, and assert the default listing in the package verifier.
  - [ ] Reorder the README to lead with the `media` toolset, with `ARR_MCP_TOOLSET=arr` documented as the way to keep only the previous tools and `all` (or `media,arr`) as the way to have both.
  - [ ] Remove the interim-default status note from [Tool Contracts — Toolset Selection](../specs/tool-contracts/#toolset-selection) and the remaining status note from [Media Toolset](../specs/media-toolset/).
  - [ ] Commit the default change as a breaking `feat` whose footer carries the migration instruction.

## Open Questions

None.

## References

- Spec: [Tool Contracts](../specs/tool-contracts/)
- Spec: [Media Toolset](../specs/media-toolset/)
- Related changes: [0021-live-verified-fixtures](./0021-live-verified-fixtures.md), [0031-media-toolset-library](./0031-media-toolset-library.md), [0032-media-toolset-activity](./0032-media-toolset-activity.md)
