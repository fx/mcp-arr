# 0019: Selected Result Fields

## Summary

Let a collection query name which parts of each per-application payload it wants back. A query for twenty-five movies returns 18,296 bytes at the default detail level, roughly 730 per record, when an agent asking what is in the library wants a title, a year, and a reference — about a hundred. The projection is a list of dot-paths resolved against the same generated inventory [0018](./0018-bounded-tool-listing.md) publishes, so a caller can write one from the tool listing without a preparatory call.

**Spec:** [Tool Contracts](../specs/tool-contracts/)
**Status:** draft
**Depends On:** [0018](./0018-bounded-tool-listing.md)

## Motivation

Measured against a live Radarr 6.3.0.10514:

| call | bytes | per record |
|---|---|---|
| `view: movies`, `pageSize: 5` | 3,953 | ~730 |
| `view: movies`, `pageSize: 5`, `detail: "full"` | 7,614 | ~1,500 |
| `view: movies`, `pageSize: 25` | 18,296 | ~730 |

A default-detail movie record carries `kind`, `application`, `reference`, `id`, `title`, `sortTitle`, `year`, `monitoring`, `status`, `added`, `statistics`, `qualityProfile`, `tags`, and a nested `radarr` object with identifiers, availability, studio, collection, and three release dates. All of it is legitimately part of the record and none of it is what a caller asking "what films do I have" needs.

`detail` already exists and already helps — `summary` is half the size of `full` — but it is a closed two-value choice made by the server about which payloads are large, not by the caller about which fields it will read. It cannot get below the summary record, and the summary record is still 730 bytes.

The pressure is real rather than theoretical: harnesses driving this server write full tool outputs to disk and read them back rather than holding them in context, and pay for the round trip on every call. Cutting a records page by 80–85% is the difference between a query being a normal step and being something a harness works around.

This is the third and smallest of the three size problems on this server, and deliberately the last of them. The first is a single unbounded payload ([0016](./0016-bounded-provider-schema-observation.md), 1,044,260 bytes on one call); the second is a fixed per-session cost ([0018](./0018-bounded-tool-listing.md), 165,839 bytes before any call). Projection only pays off once those are gone, and one of them is its prerequisite.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules (see [Architecture — Testing Contract](../specs/architecture/#testing-contract)). CI enforces these as merge gates:

- Every exported behavior MUST have automated tests at the narrowest practical level.
- MCP tools MUST have protocol-level stdio integration tests for schemas, results, errors, and stdout cleanliness.
- Committed tests MUST NOT be focused, skipped, or dependent on live personal *arr instances.
- The full build, type check, lint, and test suite MUST run in CI and failures MUST block merge.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

Additionally, because a projection removes data from a result that has already been validated:

- A test MUST assert that for every payload variant, a projected result contains only values the same call returns unprojected — compared value by value against the unprojected envelope rather than against an expected literal.
- A test MUST assert that omitting the projection returns byte-identical structured content to what the tool returns today, for every tool that accepts one.
- A test MUST assert that no projection, however written, can remove the envelope, a per-application outcome's own fields, or a payload's discriminating field — including projections naming those paths explicitly, naming a prefix of them, or naming nothing that matches.
- Redaction coverage MUST be repeated under projection. A projection selecting a secret-adjacent path MUST return exactly what the unprojected call returns for it, so projection cannot become a second channel past the output allowlists.

### Functional Requirements

The [Tool Contracts spec](../specs/tool-contracts/#bounded-structured-results) owns what a projection may name, what it may never remove, and how an unmatched path is reported, and its scenarios are this change's acceptance criteria. What implementing them requires of this change:

- The projection argument is added to the shape every bounded collection query already shares, so the five query tools gain it from one definition rather than five.
- Paths are resolved against the generated inventory from [0018](./0018-bounded-tool-listing.md), so the paths a caller is told about and the paths that resolve are the same list by construction.
- Projection happens after the envelope has been validated against the internal output schema, so what is projected is always a subset of something already known to conform.
- The projection argument is bounded in count and in path length, and — per [0017](./0017-grammar-compilable-input-schemas.md) — those bounds validate without being published.
- The text summary's record counts continue to describe what the query matched, not what the projection kept, because a caller uses them to decide whether to page.

## Design

### Approach

- Add an optional projection array to `queryBaseShape`, which `arr_library_query`, `arr_activity_query`, `arr_config_observe`, `arr_release_search`, and `arr_import_inspect` already spread into their variants.
- Resolve each path against the per-application payload after `runTool` has validated the envelope, walking objects by key and applying the remainder of a path to every element of an array it crosses.
- Always retain the payload's discriminating field, the per-application outcome's own fields, and the envelope.
- Collect unmatched paths and emit one warning naming them beside the paths that were available at the point resolution stopped.

### Decisions

- **Decision:** Paths are dot-paths relative to the per-application payload, and crossing an array applies the remainder to every element.
  - **Why:** The container differs across domains — library and activity payloads carry `items`, configuration carries `records`, release search carries `releases` — and naming it keeps the caller explicit about where it is rather than relying on the server to guess which array is the interesting one. It also allows selecting a field that sits *beside* the array, such as a search's completeness, which a record-relative syntax could not express.
  - **Alternatives considered:** Record-relative paths with the server locating the record array, rejected because the heuristic breaks on a payload with two arrays and cannot name anything outside the one it picked. A closed per-view enum of selectable field names, rejected because it would add a large enum per view to the input schema, working directly against [0018](./0018-bounded-tool-listing.md).
- **Decision:** An unmatched path warns rather than fails.
  - **Why:** A projection is written by a caller working from a list, and a first attempt that misses costs a whole round trip if it errors. Warning with the available paths makes the wrong guess self-correcting within the same call, and the call still returns something useful.
  - **Alternatives considered:** Rejecting as `invalid_input`, rejected above. Silently ignoring the path, rejected because a projection that quietly matches nothing looks exactly like a payload that legitimately has no such value.
- **Decision:** Project after validation rather than filtering during serialization.
  - **Why:** The envelope's conformance is checked before it leaves the process and that check is what makes structured content trustworthy. Projecting first would mean validating a shape the schema was never written for; projecting after means every projected result is provably a subset of a conforming one. It buys no upstream saving, which is not what this change is for.
- **Decision:** The envelope, the per-application outcome's fields, and the payload discriminator are never projectable away.
  - **Why:** They are what makes a result interpretable — which application answered, whether it partly failed, whether more pages exist, and which of twelve payloads this is. They are also small and fixed, so nothing is gained by allowing their removal, and a caller that removed them by accident would get a result it could not read.
- **Decision:** Do not project mutation results.
  - **Why:** A mutation's payload is a diff, a receipt, or a job projection — small, and every part of it is the answer. There is nothing to trim and a projected receipt is a hazard, not a saving.
- **Decision:** Bound the projection array in validation, at a number chosen for consistency rather than for safety, and publish neither the bound nor a path-length bound.
  - **Why:** A projection can only ever shrink a result, so an over-long one protects against nothing a caller could exploit — the work it causes is still bounded by the page size. What the bound is actually for is that every other array on this input surface is bounded, and an unbounded one would be the single exception a reader has to notice. Set it well above any real projection and it never binds. Publishing it is barred by [0017](./0017-grammar-compilable-input-schemas.md) anyway, so the number carries no discovery cost.

### Non-Goals

- Filtering or sorting records; a projection selects fields, never rows.
- Computing, renaming, or reshaping values — no aliases, no aggregates, no nesting changes.
- Reducing upstream requests or upstream response size.
- Projecting mutation, job, or capability results.
- Replacing or reinterpreting `detail`, which stays a separate and coarser lever.
- Changing the text summary or the record counts it reports.

## Tasks

- [ ] Pin the unprojected behavior
  - [ ] Assert that omitting the projection returns byte-identical structured content today, for every tool that will accept one
  - [ ] Extend redaction coverage with projected equivalents, green before projection exists by asserting the unprojected values they will be compared against
- [ ] Accept and resolve a projection
  - [ ] Add the bounded projection argument to `queryBaseShape` and confirm it publishes without a length bound per [0017](./0017-grammar-compilable-input-schemas.md)
  - [ ] Resolve paths against the payload after envelope validation, crossing arrays element-wise
  - [ ] Always retain the envelope, the per-application outcome's own fields, and the payload discriminator
- [ ] Report what did not match
  - [ ] Emit one warning naming unmatched paths and the paths available where resolution stopped
  - [ ] Assert the call still succeeds and still returns its matched selection
- [ ] Cover every payload
  - [ ] Compare projected against unprojected value by value for every payload variant of all five tools
  - [ ] Assert no projection can remove the envelope, outcome fields, or discriminator, including by naming them or a prefix of them
- [ ] Record the contract
  - [ ] Amend the Tool Contracts spec for the projection argument and its guarantees, with a changelog row
  - [ ] Tick these tasks and set the status in this document, `docs/index.yml`, and `docs/index.md`

## Open Questions

- [ ] Should a projection be accepted on `arr_capabilities`? Its report is already bounded by its own detail level, so the case is weaker than for the five collection queries. Left out of scope here, which under [0018](./0018-bounded-tool-listing.md) also means it publishes no path inventory.

## References

- Spec: [Tool Contracts](../specs/tool-contracts/)
- Related changes: [0016-bounded-provider-schema-observation](./0016-bounded-provider-schema-observation.md), [0018-bounded-tool-listing](./0018-bounded-tool-listing.md)
