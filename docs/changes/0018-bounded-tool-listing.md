# 0018: Bounded Tool Listing

## Summary

Publish a loose output schema per tool and move each payload's selectable paths into generated documentation. At the baseline this change was measured against, `tools/list` is 165,839 bytes, of which 135,490 is output schemas — 59,302 of that being one near-identical copy of the same result envelope per tool. Every session pays the whole thing before making a single call. This does for output what [0015](./0015-flat-tool-input-schemas.md) did for input: publish the shape a host needs, and carry what publication cannot afford as prose generated from the same schemas that validate.

**Spec:** [Tool Contracts](../specs/tool-contracts/)
**Status:** draft
**Depends On:** [0015](./0015-flat-tool-input-schemas.md)

## Motivation

**Baseline.** Every figure below was read off the wire from a spawned server against the tree as it stood when this document was written: fifteen tools, before any of [0016](./0016-bounded-provider-schema-observation.md), [0017](./0017-grammar-compilable-input-schemas.md), [0019](./0019-selected-result-fields.md), or [0020](./0020-withdraw-configuration-writes.md) had landed. They establish the size of the problem, not a target to reproduce. [0020](./0020-withdraw-configuration-writes.md) removes a tool, so a listing measured after it lands is smaller and the counts below read one lower — that is expected and does not invalidate the argument, which is about repetition per tool rather than about any total.

At that baseline `tools/list` is 165,839 bytes. Names, descriptions, and input schemas account for roughly 21,000 of that. The rest is output schemas, split as follows:

| | bytes | what it is |
|---|---|---|
| envelope | **59,302** | one near-identical copy per tool, at 3,186 bytes per read tool and 4,628 per mutation tool |
| data | 76,188 | the per-application payload, of which **62,384** is on the five collection-query tools |

Three tools declare no payload at all, so their entire 4,620-byte output schema is envelope. `arr_library_query`'s is the largest single item in the listing at 40,630 bytes, 37,444 of it a union of twelve view payloads.

The envelope half is pure repetition. It describes the same four top-level keys, the same per-application outcome, the same item outcome, the same continuation, and the same closed error vocabulary, once per tool, and a caller learns it once. The data half is not repetition — it is the only place a caller can find out that a movie record has a `title` — but JSON Schema is an expensive way to carry a field list, and a twelve-view union is a poor way to answer "what fields does a movie have".

That second point is what ties this change to [0019](./0019-selected-result-fields.md). A projection is only writable by a caller that knows which paths exist, so the naive reading is that `select` needs the verbose output schemas kept. The opposite is true: what `select` needs is a *list of paths*, which is roughly 300 bytes per view against 37,444 for the schema that implies them. Generating that list is both the cheaper publication and the better discovery surface, and it is the same generator `select` resolves against — so the paths a caller is told about and the paths that resolve cannot come apart.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules (see [Architecture — Testing Contract](../specs/architecture/#testing-contract)). CI enforces these as merge gates:

- Every exported behavior MUST have automated tests at the narrowest practical level.
- MCP tools MUST have protocol-level stdio integration tests for schemas, results, errors, and stdout cleanliness.
- Committed tests MUST NOT be focused, skipped, or dependent on live personal *arr instances.
- The full build, type check, lint, and test suite MUST run in CI and failures MUST block merge.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

Additionally, because this change loosens a published schema while promising the returned envelope is unchanged:

- Every existing assertion on returned structured content MUST keep passing with no edit. This change alters what is published, never what is produced.
- A test MUST assert that every envelope the server returns still validates against the tool's own internal output schema, so loosening publication does not loosen the check that runs before a result leaves the process.
- A test MUST assert that every path named in the generated documentation resolves against the internal output schema it was generated from, and that no payload field is reachable that the documentation does not name.
- The listing size MUST be asserted against a recorded ceiling read off the wire, so a later change that reintroduces bulk fails rather than merely being regrettable.

### Functional Requirements

The [Tool Contracts spec](../specs/tool-contracts/#bounded-structured-results) owns what a published output schema must admit and what the generated documentation must name, and its scenarios are this change's acceptance criteria. What implementing them requires of this change:

- The internal output schemas are unchanged and keep validating every envelope before it leaves the process. Only what is published changes.
- The published envelope is broadened rather than removed: a host that validates `structuredContent` against the declared schema MUST still find it valid, including for an envelope a later projection has reduced.
- The selectable-path inventory is generated from the same output schemas the envelope is validated against, at one site, with nothing plumbed through the tool definitions.
- A payload that is a discriminated union publishes its paths per discriminator value, so a caller reading `arr_library_query` learns which paths belong to `movies` rather than a merged list belonging to no view.
- The three tools that declare no payload publish no path inventory, because there is nothing to select.

## Design

### Approach

- Keep every internal output schema exactly as it is; they remain the authority for envelope validation in `runTool`.
- At registration, publish a derived output schema carrying only what a consumer needs: the four top-level keys, and `applications` as an array of objects declaring `data`. Nothing below that — not the closed error vocabulary, not the item-outcome shape, not the continuation shape, and no type for `data` itself.
- Generate the selectable-path inventory by walking each tool's internal output schema down to its **leaves**, grouping by the payload's discriminator where it has one, and carry it in the published output schema root's `description`.
- Publish no inventory for a tool that accepts no projection.
- Record the listing's byte size as a ceiling in the wire test.

### Decisions

- **Decision:** Broaden the published output schema rather than omitting it.
  - **Why:** `outputSchema` is optional in the protocol, and omitting it would be the largest single saving. But a host that keys structured-content handling off its presence would stop receiving structured content, and the saving over a broadened envelope is a few hundred bytes across the whole listing. Publishing something small and true costs almost nothing and breaks nothing.
  - **Alternatives considered:** Omitting `outputSchema` entirely, rejected above. Keeping the precise schemas and accepting the size, rejected because the repetition is 59,302 bytes that teaches a caller nothing after the first tool.
- **Decision:** Publish nothing in the envelope below `applications[].data`.
  - **Why:** Everything under it has exactly one consumer, and that consumer is inside this process. The internal output schema validates every envelope before it leaves, so a published error-code enum, item-outcome shape, or continuation shape is not checking anything — it is one restatement per tool of a structure the Tool Contracts spec already owns and the tool descriptions already imply. The four top-level keys and the location of `data` are the exception, and they earn their place: a projection path is written relative to `data`, so a caller has to be able to see where `data` is.
  - **Alternatives considered:** Publishing the per-application outcome's fields by name and type, rejected because naming `warnings`, `continuation`, and `error` without their shapes tells a caller only that they exist, which the spec says already. Publishing `{ "type": "object" }` and nothing else, rejected because it hides where `data` sits and makes the path convention unreadable from the schema alone.
- **Decision:** The inventory names leaf paths and carries no types.
  - **Why:** A leaf path is directly usable — a caller copies `items.radarr.tmdbId` into a projection verbatim. Once every path bottoms out at a leaf, the structure is implicit in the paths themselves and a type annotation restates what the path already shows. Types would only be necessary if the inventory listed interior nodes, leaving the caller to guess what to descend into; listing leaves removes the question rather than answering it.
  - **Alternatives considered:** Annotating each path with its type, rejected above — roughly 30% more bytes to restate what leaf paths already convey. Listing interior nodes with types so a caller can select a whole subtree, rejected because resolution can accept an interior path and return its subtree anyway, so the convenience costs nothing to support and nothing to publish.
- **Decision:** A tool that accepts no projection publishes no inventory.
  - **Why:** An inventory is a list of paths a caller may select. Publishing one where nothing can be selected advertises a capability the tool does not have, which is the same defect [0017](./0017-grammar-compilable-input-schemas.md) removes from the input side.
- **Decision:** Carry the payload's field inventory as generated paths rather than as JSON Schema.
  - **Why:** A path list is roughly two orders of magnitude smaller than the schema implying it, and it is the form a projection is actually written in. Publishing the schema would make a caller derive the paths; publishing the paths makes the derivation the server's job, once, correctly.
  - **Alternatives considered:** Keeping precise `data` schemas only on the five collection-query tools, which saves the envelope repetition but leaves `arr_library_query` at 37,444 bytes and still leaves the caller deriving paths from a twelve-view union.
- **Decision:** Group the inventory by discriminator value.
  - **Why:** `arr_library_query` returns twelve different payloads. A flat union of every field across all of them would name paths that resolve for no single call, which is worse than saying less — a caller would write a projection that silently matches nothing.
- **Decision:** Generate the inventory from the internal output schemas rather than maintaining it beside them.
  - **Why:** The same reasoning [0015](./0015-flat-tool-input-schemas.md) applied to variant documentation. A hand-written list is a second copy of the payload shape and will drift; a generated one cannot, and the same generator feeds [0019](./0019-selected-result-fields.md)'s resolution so that what is advertised and what resolves are one thing.
- **Decision:** Land this before `select` rather than after.
  - **Why:** Two things about it are prerequisites. A projected envelope would not validate against today's precise published `data`, so the broadened schema is what makes projection publishable at all; and the path inventory is what a caller reads in order to write a projection in the first place. Landing `select` first would mean shipping a feature whose discovery surface and whose schema conformance both arrive later.

### Non-Goals

- Changing any envelope the server returns, or any internal output schema.
- Changing the text summary that accompanies every result.
- Removing `outputSchema` from publication.
- Adding the projection itself, which is [0019](./0019-selected-result-fields.md).
- Reducing input schemas or tool descriptions, which together are the remaining ~21,000 bytes and are already proportionate.
- Introducing cross-tool schema sharing; the protocol's listing has no mechanism for it, and `$ref` within one tool's schema would not deduplicate across the listing.

## Tasks

- [ ] Pin the listing before changing it
  - [ ] Add a wire test recording `tools/list` byte size and asserting a ceiling, taking the pre-change size by measurement at implementation time rather than from this document's baseline figure, which a differing landing order makes unreproducible
  - [ ] Add a test asserting every returned envelope validates against its tool's internal output schema, green today
- [ ] Publish a broadened output schema
  - [ ] Derive the published envelope at registration, with `data` unconstrained, leaving internal schemas untouched
  - [ ] Confirm every existing structured-content assertion passes unedited and the new ceiling is met
- [ ] Generate the selectable-path inventory
  - [ ] Walk each internal output schema down to its leaves to produce paths, grouped by payload discriminator where one exists, with no type annotations
  - [ ] Carry the inventory in the published output schema root's `description`, generated at one site, and emit none for a tool that accepts no projection
  - [ ] Assert every generated path resolves to a leaf of the schema it came from, and that no payload leaf goes unnamed
- [ ] Record the contract
  - [ ] Amend the Tool Contracts spec for broadened output schemas and the generated path inventory, with a changelog row
  - [ ] Tick these tasks and set the status in this document, `docs/index.yml`, and `docs/index.md`

## Open Questions

None.

## References

- Spec: [Tool Contracts](../specs/tool-contracts/)
- Related changes: [0015-flat-tool-input-schemas](./0015-flat-tool-input-schemas.md), [0019-selected-result-fields](./0019-selected-result-fields.md)
- External: [MCP Tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
