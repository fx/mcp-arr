# 0033: Media as the Default Toolset

## Summary

Make `media` the toolset a process publishes when `ARR_MCP_TOOLSET` is absent, and keep the fourteen `arr` tools available behind `ARR_MCP_TOOLSET=arr`. Before the flip, every `media` tool is swept against live instances at the newest recorded versions. This is a breaking change for every existing host. [Tool Contracts — Toolset Selection](../specs/tool-contracts/#toolset-selection) owns the default.

**Spec:** [Tool Contracts](../specs/tool-contracts/)
**Status:** complete
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

- **Live sweep gate.** Every `media` tool, and every row of the [download-state and remedy tables](../specs/media-toolset/#download-states) that a live instance can be brought into, MUST be exercised against live Sonarr, Radarr, and Prowlarr instances at a recorded, supported version before the default changes: the newest version recorded for each application, as the decisions below explain. The minimum versions are covered by their recorded fixtures and the test suite, not by the sweep.
  - The sweep runs against a real personal library, so it MUST NOT send a call that changes that library beyond the searches its Findings record. A tool is exercised live through the paths that leave the library as it is; each path that would change it is named in the decisions below and is proven by the fixture-backed and protocol tests instead.
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
- Assert the same default in `scripts/verify-image.mjs`, the container smoke test [0034](./0034-container-image.md) added, together with the image selecting no toolset of its own, so the image publishes what the package does.

### Decisions

- **Decision:** Release the flip as a breaking `feat` at 0.x.
  - **Why:** `release-please-config.json` sets `bump-minor-pre-major`, so a breaking change below 1.0 bumps the minor version, and its footer lands in the changelog's breaking-changes section. That is how 0.3.0 shipped its breaking changes. It is the signal an operator reading the changelog looks for.
  - **Alternatives considered:** A 1.0.0 release, rejected as a separate decision about API stability that this change does not need to make. Keeping `arr` as the default forever, rejected for the reason in Motivation.
- **Decision:** Satisfy the live sweep gate at the newest recorded versions — Sonarr 4.0.20.3014, Radarr 6.4.4.10685, and Prowlarr 2.7.0.5723 — rather than at the minimum versions.
  - **Why:** These are the only live instances available; no instance at a minimum version exists to sweep. Change [0035](./0035-fixtures-at-newer-versions.md) made them recorded, supported versions, and [Architecture — Version Compatibility](../specs/architecture/#version-compatibility) supports every version newer than the minimum. The minimum versions were not swept. They remain covered by the fixtures recorded at them, which stay the evidence for the minimum, and by the suite that runs against those fixtures.
  - **Alternatives considered:** Standing up instances at the minimum versions, rejected because none is available. Holding the flip until one exists, rejected because the gate exists to find the defects a green suite hides, which a sweep at a supported version does, and holding it would leave the spec's default unimplemented.
- **Decision:** Exercise every `media` tool live, but only through the paths that leave the library unchanged, and prove the paths that would change it with the fixture-backed and protocol tests.
  - **Why:** The only live instances hold a real personal library, and an add, a fix, or a removal sent to it cannot be taken back cleanly: a removed title loses its history, a replaced download is blocklisted and deleted from the client, and an added title starts a search that may grab a release. So the sweep sends no call that would change the library beyond the one movie search its Findings record. The paths not driven live are:
    - `media_add`'s `added` path, with the `deployment_configuration` failure and the resolution-based choice of profile for a new title, proven by `test/media-add.test.ts` and `test/media-resolution.test.ts`;
    - `media_fix`'s `replace` and `import` remedies, proven by `test/media-fix.test.ts` and `test/media-downloads.test.ts`;
    - `media_remove`'s actual removal, `removed` with and without `delete_files`, proven by `test/media-remove.test.ts`.
    Over the protocol, against recorded instances, `test/media-stdio.test.ts` drives `added` and `removed` over stdio, `test/http-transport.test.ts` drives `removed` over HTTP, and both call `media_fix`. Every tool was still called live, on the paths a personal library allows: `media_add` and `media_remove` on titles where the spec requires a no-op, and `media_fix` on titles with nothing stuck.
  - **Alternatives considered:** Driving the changing paths on titles added for the purpose, rejected because adding one is itself a change to the library, and its search may grab a release. A disposable instance at a recorded version, rejected because none exists, and the recorded fixtures already describe a real instance's answers on these paths.
- **Decision:** Pin `arr` in the shared spawn helper rather than in each test.
  - **Why:** Eleven spawned test files exercise `arr` tools. Setting the variable once in the helper they all share changes one line instead of eleven, and a future `arr` test inherits it.
  - **Alternatives considered:** Per-file settings, rejected as eleven copies of one decision.

### Non-Goals

- Removing or deprecating the `arr` toolset.
- Any new `media` behavior; a defect the sweep finds is fixed against the spec as written.

## Findings

### Live sweep (2026-11-08)

Swept at the head of the 0032 implementation branch, before it merged, against live Sonarr 4.0.20.3014, Radarr 6.4.4.10685, and Prowlarr 2.7.0.5723. These are the newest recorded versions, which [0035](./0035-fixtures-at-newer-versions.md) approved; they are not the minimum versions, and no instance at a minimum version was swept (see Decisions). The sweep ran over stdio with `ARR_MCP_TOOLSET=all`, so that each media result could be cross-checked against the `arr` read tools, and once over Streamable HTTP with a bearer token and `ARR_MCP_TOOLSET=media`. The library is a real personal one, so every call that could change state was limited to titles where the spec requires a no-op, with one exception, listed under Mutations sent; the paths that would change the library are named in Decisions. The `media_remove` calls were made in a second session the same day, against the same instances, from the built head of this change.

Checks made on every call: the result matches the spec's fields, bounds, states, remedies, and `episodes` labels; summaries are single-line; no output carries an *arr application name, configuration vocabulary, URL, host, path, or key (machine-scanned against the configured values); stderr stays empty; values match the `arr` tools' view of the same records.

#### Per tool

| Tool | Exercised | Apps | Outcome |
|---|---|---|---|
| `media_find` | Both kinds, each kind alone, a title that exists as both a film and a show, ambiguous titles, a nonsense string, symbols, padding whitespace, 1 and 200 characters, empty, 201 characters, whitespace only; one kind unconfigured; one kind unreachable | Sonarr, Radarr | Up to 5 per kind, in the metadata source's order; `in_library` matched the library for every returned title; year omitted when unknown; length bounds refused by schema validation; unconfigured kind refused with `unconfigured_application` without naming an application; unreachable kind reported `unavailable` beside the other kind's titles in one successful result. Whitespace-only text failed with a misleading `unexpected_response` (defect 3). |
| `media_add` | Titles already in the library only: movies and series, with and without `resolution` (including one that differs from the existing profile and a nearest-match one), with `episodes: "future"`; unknown ids of both kinds; `episodes` on a movie | Sonarr, Radarr | `already_in_library` with the existing profile's resolution; records unchanged, no command posted, queue unchanged (compared before and after); unknown ids `not_found`; `episodes` on a movie refused by schema validation. No new title was added, so the `added` path, the `deployment_configuration` failure, and resolution-based profile choice were not exercised live. |
| `media_status` | Overview (stdio and HTTP, both kinds, movies only, series unreachable); several in-library titles of each kind, covering every profile in use, titles with and without files, titles with upcoming dates, a title with a stuck season pack, a series with no episodes; titles not in the library; unknown ids | Sonarr, Radarr | have/missing, next due date, monitored, profile resolution, and file resolutions matched the episode, file, and movie records; a season pack listed once per episode was reported as one download with one `episodes` label; imports of the last 7 days matched history; series due dates matched the calendar, grouped one entry per title per day. Movies due in the window were missing from the overview (defect 1), and missing counts included unmonitored episodes (defect 2). Titles not in the library returned `in_library: false` and nothing else. |
| `media_fix` | Titles with nothing stuck, of both kinds; a title not in the library | Sonarr, Radarr | Empty list, `remaining: 0`, no upstream change; not in library `conflict`. Not called on the title with a stuck download. |
| `media_search_again` | A whole series, a season, and an episode with nothing missing; a non-existent season and episode; a series with no episodes; a movie with its file; a movie not yet available; titles not in the library; invalid scope combinations; one missing, released movie | Sonarr, Radarr | `searched: 0` and no command posted wherever nothing was missing; a warning for a non-existent scope; not in library `conflict` pointing to `media_add`; invalid scopes refused by schema validation; the missing movie gave `searched: 1` and exactly one movie search command, which completed. |
| `media_remove` | Listing: published with `ARR_MCP_MEDIA_ALLOW_REMOVE=true` under `media` and `all`, absent when the variable is absent or `false`; schema checked; `yes`, and `true` without the media toolset, both rejected at startup. Calls: one movie and one series, each first confirmed outside the library by `media_status`, removed with `delete_files` omitted, under `ARR_MCP_TOOLSET=all` with removal enabled | Sonarr, Radarr | Conforms. Each call returned `not_in_library` with no files deleted and no error, in a one-line summary. The library and both instances' command lists were identical before and after, read through the `arr` tools, so no deletion and no command was sent. Never called on a title in the library, so the `removed` path was not exercised live (see Decisions). |

The whole `media` toolset `tools/list` response with `media_remove` published was 11 790 bytes, within the 12 000-byte limit. Over HTTP an unauthenticated `POST /mcp` got 401, and the authenticated listing and calls matched stdio.

#### Download-state and remedy table rows

| Row | Live |
|---|---|
| Delayed or fallback pending release → `waiting` | Unreachable: no pending release existed |
| Queued or paused in the client → `queued` | Unreachable |
| Downloading with no warning or error → `downloading` | Unreachable: no active download |
| Downloaded and importing, or pending import with no warning → `importing` | Unreachable |
| An import this process started → `importing` | Unreachable: needs a `media_fix` import, not sent |
| Failed or failed pending → `stuck`, `replace` | Unreachable |
| Client warning such as stalled → `stuck`, `replace` | Unreachable |
| Import blocked, importable, library has no file → `stuck`, `import` | Observed: a season pack, blocked because the release was matched to its series by id, was predicted `import` with reason "finished downloading but its files were not moved into the library", consistent with the queue evidence and the library records. Left untouched; the fix was not applied. |
| Import blocked for another reason → `stuck`, `none` | Unreachable |
| Client unavailable → `stuck`, `none` | Unreachable |

Every row a live instance could not be brought into without changing a personal library remains covered by the recorded fixtures and the suite.

#### Defects found

All three are fixed on `main`; none is left open.

1. **The overview dropped movies due in the next 14 days.** The overview passed full ISO instants as the calendar window, while Radarr's calendar anchoring parses date-only bounds. The window parsed as invalid, each movie was anchored to its earliest release date, which was usually past, and the movie was discarded. Movies whose digital or physical release fell inside the window never appeared. Fixed in [0032](./0032-media-toolset-activity.md).
2. **Missing counts and search-again included unmonitored media.** `missing` counted every released episode without a file, including unmonitored seasons and specials, and a whole-title `media_search_again` would have searched for all of them. A user-invoked episode search does not skip unmonitored episodes, so it could have downloaded media the operator had deliberately unmonitored. Fixed in [0032](./0032-media-toolset-activity.md), with an amendment to [Media Toolset](../specs/media-toolset/) that counts and searches only monitored, released media.
3. **Whitespace-only `media_find` text failed with `unexpected_response`.** Both instances answer such a lookup with an HTTP error, which the tool reported with an instruction to check the instance's version. Fixed in [0031](./0031-media-toolset-library.md), with an amendment to [Media Toolset](../specs/media-toolset/) that refuses such text.

#### Observed, not fixed

None of these is a defect against the spec, so the gate that every defect is fixed or tracked is met by the three above.

- **The season pack stays blocked.** It was the only stuck download and was left for the operator, so the `import` remedy was predicted but never run live. Specified behavior: `media_status` changes nothing, and `media_fix` acts only when called.
- **No media profile defaults are set on the swept deployment.** Both instances have several quality profiles and none of the `ARR_MCP_MEDIA_*_QUALITY_PROFILE` variables is set, so on that deployment a `media_add` that names no `resolution` would fail with `deployment_configuration`. Root folders need no setting: each instance has exactly one. Specified behavior, per [Deployment Defaults](../specs/media-toolset/#deployment-defaults); the README now tells an operator to set the variables before relying on the new default.
- **Radarr 1080p picks a narrow profile.** Among the instance's 1080p profiles, the fewest-qualities rule chooses one that allows only WEB and HDTV qualities, not Bluray. The 2160p and Sonarr choices pick the instances' standard profiles. Specified behavior: it follows [Resolution](../specs/media-toolset/#resolution) as written.
- **A profile with an SD cutoff reports 480p** for titles whose files are higher resolution. Specified behavior: a profile's resolution is its cutoff's, per [Resolution](../specs/media-toolset/#resolution), though it can surprise a caller.
- **Latency.** No spec sets a latency bound, and every call finished well inside the upstream request timeout.
  - An overview took about 4.5 to 5 s, and the status of a title with a stuck download about 4 s. Both are dominated by the import scan the `import` prediction needs; the overview without that download took about 0.5 s.
  - A movie-title call took about 0.45 s, against about 0.1 s for a series. Resolving a title by id reads the instance's whole library list each call.
  - Other calls took 0.01 to 1 s.
- **Not media behavior:** `arr_library_query` mints different opaque configuration references for the same record across two reads in one process. No spec requires a record to keep one reference across reads: [Tool Contracts — Opaque References](../specs/tool-contracts/#opaque-references) binds every reference to the state it was created from and to its own expiration, which a reference minted per read satisfies. It is `arr` behavior, outside this change, and is recorded only as an observation.

#### Mutations sent

- One movie search command, for one missing, released, monitored movie, started by `media_search_again`. It completed, and nothing was grabbed.
- Nothing else. No title was added or removed, no download was fixed, and no `arr` mutation tool was called. Diffs of the instances' command lists confirmed that no status, add, fix, remove, or no-op search call posted a command.

## Tasks

- [x] Sweep the `media` toolset against live instances
  - [x] Exercise each `media` tool, and each reachable table row, against live instances at the newest recorded versions, through the paths that leave the library unchanged, and record the results in Findings.
  - [x] Fix, or file a change document for, every defect found.
- [x] Make `media` the default
  - [x] Change the default in `src/config/environment.ts` and pin it with a test.
  - [x] Select `arr` explicitly in `test/support/spawned-stdio.ts`, `test/stdio-process.test.ts`, `test/tool-protocol.test.ts`, any other test the new default breaks, and `scripts/verify-package.mjs`, and assert the default listing in the package verifier and the image verifier.
  - [x] Reorder the README to lead with the `media` toolset, with `ARR_MCP_TOOLSET=arr` documented as the way to keep only the previous tools and `all` (or `media,arr`) as the way to have both.
  - [x] Remove the interim-default status note from [Tool Contracts — Toolset Selection](../specs/tool-contracts/#toolset-selection) and the remaining status note from [Media Toolset](../specs/media-toolset/).
  - [x] Commit the default change as a breaking `feat` whose footer carries the migration instruction.

## Open Questions

None.

## References

- Spec: [Tool Contracts](../specs/tool-contracts/)
- Spec: [Media Toolset](../specs/media-toolset/)
- Related changes: [0021-live-verified-fixtures](./0021-live-verified-fixtures.md), [0031-media-toolset-library](./0031-media-toolset-library.md), [0032-media-toolset-activity](./0032-media-toolset-activity.md), [0034-container-image](./0034-container-image.md), [0035-fixtures-at-newer-versions](./0035-fixtures-at-newer-versions.md)
