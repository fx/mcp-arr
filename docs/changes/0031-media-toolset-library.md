# 0031: Media Toolset — Selection, Find, and Add

## Summary

Introduce the startup toolset selection and the first two `media` tools, `media_find` and `media_add`. A deployment can then opt into a surface that finds and adds movies and series without knowing Sonarr, Radarr, quality profiles, or root folders. `arr` stays the default here; [0033](./0033-media-default-toolset.md) flips it. [Media Toolset](../specs/media-toolset/) owns the tools' behavior, and [Tool Contracts — Toolset Selection](../specs/tool-contracts/#toolset-selection) owns the selection.

**Spec:** [Media Toolset](../specs/media-toolset/)
**Status:** draft
**Depends On:** —

## Motivation

Adding one show through the `arr` toolset takes five calls and three decisions the caller is badly placed to make:

1. Look the show up.
2. Observe quality profiles and pick one.
3. Observe root folders and pick one.
4. Plan the add.
5. Apply the plan.

Every reference involved expires within fifteen minutes, so a slow conversation starts over. The [Media Toolset spec](../specs/media-toolset/#background) explains why most requests do not need that model. This change delivers the library half of the replacement: find a title, add it, done.

The selection lands with it because a `media` tool has nowhere to be published without one. Selecting `media` stays opt-in until the whole toolset has been verified against live instances in 0033, so this change breaks no existing host.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules (see [Architecture — Testing Contract](../specs/architecture/#testing-contract)). CI enforces these as merge gates:

- Exported behavior MUST have automated tests at the narrowest practical level.
- Adapter behavior MUST be covered by sanitized, version-labelled fixtures that the application they name genuinely produces. A fixture this change needs MUST be captured with the repeatable capture procedure, never authored.
- MCP tools MUST have protocol-level stdio integration tests for schemas, results, errors, and stdout cleanliness, for each toolset.
- Committed tests MUST NOT be focused, skipped, or dependent on live personal *arr instances.
- Build, type check, lint, tests, and package verification MUST pass in CI.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

Additionally:

- A test MUST assert the [Minimal Footprint](../specs/media-toolset/#minimal-footprint) listing over stdio against a measured, recorded ceiling, in the way `test/tool-stdio.test.ts` records the `arr` listing's. The ceiling's margin over the measurement MUST be smaller than the smallest single `media` tool's published definition, so a regression that republishes one tool cannot hide beneath it.
- A test MUST scan every published `media` tool's name, title, description, and input and output schemas for the terms [Published Tools](../specs/media-toolset/#published-tools) forbids, case-insensitively. Its word list MUST be written out in the test rather than derived from code.
- A test MUST prove `media_add` cannot create a duplicate. An add of a title already in the library MUST send no write request upstream.
- A test MUST prove that an add the application refuses because the title was added between this call's check and its create reports `already_in_library`.

### Functional requirements

[Media Toolset](../specs/media-toolset/) owns these sections, whose scenarios are this change's acceptance criteria and are not restated here:

- [Published Tools](../specs/media-toolset/#published-tools), for `media_find` and `media_add`
- [Minimal Footprint](../specs/media-toolset/#minimal-footprint)
- [Media Identity](../specs/media-toolset/#media-identity)
- [Deployment Defaults](../specs/media-toolset/#deployment-defaults), apart from `ARR_MCP_MEDIA_ALLOW_REMOVE`, which [0032](./0032-media-toolset-activity.md) adds with `media_remove`
- [Find](../specs/media-toolset/#find)
- [Add](../specs/media-toolset/#add)

[Tool Contracts — Toolset Selection](../specs/tool-contracts/#toolset-selection) and [Error Contract](../specs/tool-contracts/#error-contract) own the selection and the two new error codes.

What implementing them requires of this change:

- **Interim default.** Until [0033](./0033-media-default-toolset.md) lands, an absent `ARR_MCP_TOOLSET` MUST select `arr`. This deliberately departs from the spec's stated default, and that section's status note records it. A process with no selection MUST publish exactly what it publishes today.
- **No change to `arr`.** The `arr` toolset's published names, schemas, and listing size MUST NOT change, except that the shared error-code enum gains `not_found` and `deployment_configuration`. The recorded `arr` listing ceiling MUST be re-measured for that addition.
- **Partial toolset.** While only part of it exists, the `media` toolset MUST publish only the tools this change implements, so a `media` deployment is never offered a tool that refuses unconditionally.
- **Environment filters.** The new variables MUST be added to the environment filters the spawned-server tests and the package verifier use.

## Design

### Approach

- **Selection.** Add `ARR_MCP_TOOLSET` and the four profile and folder variables to `src/config/environment.ts` as `configuration.toolset`. That is either `{ kind: "arr" }` or `{ kind: "media", defaults }`, and media variables under `arr` are rejected as problems. `registerTools` in `src/tools/register.ts` takes the toolset and registers that toolset's definitions only. The `arr` definitions stay in `src/tools/definitions.ts`, and the `media` ones go in a new `src/tools/media/` directory with a `definitions.ts` of its own. `src/tools/names.ts` keeps the `arr` names unchanged and gains a separate `mediaToolNames` list.
- **Shared plumbing.** The `media` tools reuse `runTool`'s output validation and summary path, `createToolError` and its remediation policy, and the adapter registry's probe. They do not use the operation registry, the dispatcher, plan stores, or reference minting: those exist for the `arr` toolset's plan/apply contract, which the `media` toolset does not have.
- **`media_find`.** Turn kind into an application (movie to Radarr, series to Sonarr) and run the existing lookup view through `runLibraryQuery` with the search text, for each configured kind in parallel. Keep the first five results per kind in upstream order. Map each result to the spec's five fields: the TMDB or TVDB id, and `in_library` from the lookup's existing-record marker. A kind whose read fails becomes an `unavailable` entry with its normalized error.
- **`media_add`.**
  1. Read the candidate with `readLookupCandidate`, which already looks up by `tmdb:` or `tvdb:` and matches the exact id.
  2. If it already has a library record, return `already_in_library` and send nothing.
  3. Otherwise resolve the profile and folder through `readConfigurationRecords`, matching by name or path the way `matchConfiguration` already does: the configured value if set, the only record if there is one, otherwise `deployment_configuration`.
  4. Build the payload with `addMediaPayload` and send it with `createMedia`, setting search-on-add to true. Monitoring maps `all` and `future` onto Sonarr's monitor options, and movies always use the movie-only option.
  5. If the application refuses the create, re-read the candidate. If it now has a library record, another call added it in the meantime, so report `already_in_library`. Otherwise report the refusal.
- **Error codes.** Add `not_found` and `deployment_configuration` to `toolErrorCodes` in `src/tools/errors.ts`, with remediation policies. `deployment_configuration`'s remediation tells the caller that the operator must set the named variable.

### Decisions

- **Decision:** Call the adapters directly rather than wrapping `arr_library_change`.
  - **Why:** Going through the `arr` tool would make every add a plan, a reference, and an apply internally, only to hide all three. Its preconditions read configuration through references a caller observed, which is exactly the dependency the `media` toolset removes. The duplicate check and payload builder are plain adapter functions, so reusing them keeps the one rule that matters, never duplicate a record, in one place.
  - **Alternatives considered:** Composing the `arr` handlers with internally minted references. Rejected: the references are a caller-facing mechanism, and minting them internally would hold store entries nobody can use.
- **Decision:** Resolve defaults when a title is added, not at startup.
  - **Why:** The server already starts while an instance is unreachable, and capabilities report it unavailable. Probing defaults at startup would make an unreachable instance fatal. That swaps a recoverable condition for an outage.
  - **Alternatives considered:** Validating at startup when reachable and deferring otherwise. Rejected: one diagnostic path is simpler than two that disagree about when a typo is reported.
- **Decision:** Ship the selection with `arr` as the default, and flip it separately.
  - **Why:** Flipping is the breaking change, and it should land only after every `media` tool exists and has passed a live sweep. Earlier sweeps found defects that a green suite missed, so the flip waits for the same evidence.
  - **Alternatives considered:** Flipping in this change. Rejected: a host that upgraded would lose the `arr` tools for a toolset that cannot yet report status or fix anything.

### Non-Goals

- `media_status`, `media_fix`, `media_search_again`, `media_remove`, and `ARR_MCP_MEDIA_ALLOW_REMOVE`, which belong to [0032](./0032-media-toolset-activity.md).
- Making `media` the default, which belongs to [0033](./0033-media-default-toolset.md).
- Any change to the `arr` toolset's behavior.

## Tasks

- [ ] Select a toolset at startup and publish `media_find` and `media_add`
  - [ ] Parse `ARR_MCP_TOOLSET` and the four profile and folder variables in `src/config/environment.ts`, with an interim default of `arr`. Cover every accepted and rejected value and the cross-toolset rejection in `test/environment.test.ts`.
  - [ ] Thread the toolset through `createServer` and `registerTools`, and add `mediaToolNames` to `src/tools/names.ts`.
  - [ ] Add `not_found` and `deployment_configuration` to `src/tools/errors.ts` with their remediation policies and tests, then re-measure and update the `arr` listing ceiling in `test/tool-stdio.test.ts`.
  - [ ] Implement `media_find` in `src/tools/media/`, with its input and output schemas, summary, and per-kind unavailability.
  - [ ] Implement `media_add` in `src/tools/media/`, with default resolution, duplicate short-circuit, and search on add.
  - [ ] Capture any fixture these tools read that the inventory does not already hold. Candidates are `series/lookup` and `movie/lookup` by `tvdb:` and `tmdb:` term, and `qualityprofile` and `rootfolder` with more than one record. Use `scripts/capture-fixture.mjs` and register each in `test/fixture-contract.test.ts`.
  - [ ] Add unit tests for both tools over fixtures, covering every scenario in [Find](../specs/media-toolset/#find), [Add](../specs/media-toolset/#add), [Media Identity](../specs/media-toolset/#media-identity), and [Deployment Defaults](../specs/media-toolset/#deployment-defaults).
  - [ ] Add `test/media-stdio.test.ts`. It spawns the built server with `ARR_MCP_TOOLSET=media`, lists tools, asserts the forbidden-term scan and a recorded listing ceiling at or under 12 000 bytes, and calls both tools.
  - [ ] Add the new variables to `configurationVariables` in `test/support/spawned-stdio.ts` and to the filter list in `scripts/verify-package.mjs`, and add every new `dist/**` file to the packed-file inventory.
- [ ] Document the opt-in toolset
  - [ ] Add a "Media tools" section to `README.md`. It explains `ARR_MCP_TOOLSET=media`, the two tools, and the default variables, and states that `arr` is the default until the toolset is complete.
  - [ ] Update the status notes in [Media Toolset](../specs/media-toolset/) and [Tool Contracts — Toolset Selection](../specs/tool-contracts/#toolset-selection) to say what has landed.

## Open Questions

None.

## References

- Spec: [Media Toolset](../specs/media-toolset/)
- Spec: [Tool Contracts](../specs/tool-contracts/)
- Related changes: [0018-bounded-tool-listing](./0018-bounded-tool-listing.md), [0021-live-verified-fixtures](./0021-live-verified-fixtures.md), [0032-media-toolset-activity](./0032-media-toolset-activity.md), [0033-media-default-toolset](./0033-media-default-toolset.md)
