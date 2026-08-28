# 0017: Grammar-Compilable Input Schemas

## Summary

Stop publishing string length bounds in tool input schemas. A host that compiles a published schema into a constrained-decoding grammar expands a `maxLength` once per admissible character, and the one tool that carried long bounds failed to compile, taking the whole request with it. [0020](./0020-withdraw-configuration-writes.md) removes that tool for unrelated reasons, so this change is what keeps the failure from returning: the bounds stay in validation and move into the generated variant documentation, exactly as cross-property constraints already do.

**Spec:** [Tool Contracts](../specs/tool-contracts/)
**Status:** draft
**Depends On:** [0015](./0015-flat-tool-input-schemas.md), [0020](./0020-withdraw-configuration-writes.md)

## Motivation

A host running llama.cpp compiles each tool's published input schema into a decoding grammar. `arr_config_reconcile` failed to compile and the request died, so the tool had to be excluded from the server's configuration by hand. No other tool failed.

Summing, for each published input schema, every `maxLength` and `maxItems` it declares — a proxy for the repetition a bounded-repeat grammar expands into — shows why it was exactly one tool:

| tool | ~expansion | `maxLength` values |
|---|---|---|
| `arr_config_reconcile` | **10,270** | 128, **4096**, **1024**, 128, 128, **4096** |
| `arr_import_inspect` | 885 | 512, 120, 60, 120 |
| `arr_library_query` | 765 | 512, 200 |
| `arr_library_change` | 570 | 120, 60, 120 |
| every other tool | ≤ 565 | — |

`arr_config_reconcile` is an order of magnitude past the next tool, and 9,216 of its 10,270 comes from three strings:

- the scalar-string arm of a dynamic provider field's value, bounded at 4096
- that field's array arm, whose elements are bounded at 1024
- a transient secret's value, bounded at 4096

The rest is three copies of the 128-character field-name bound and the `maxItems` bounds, which together come to 1,054.

Those ceilings were far above anything real. Across every provider field on all three live instances, the longest value is 294 characters, and the three longest are read-only informational blurbs a caller can never send. The longest *writable* value is a 28-character `baseUrl`. But the size of the ceiling is not the point: lowering all three to 512 would still have left the tool at roughly 2,300, well above `arr_import_inspect`'s known-good 885. A `maxLength` costs nothing to enforce and a great deal to publish, so the fix is to keep enforcing and stop publishing.

[0020](./0020-withdraw-configuration-writes.md) removes `arr_config_reconcile` entirely, which removes the live failure along with it — after that change the largest expansion in the corpus is `arr_import_inspect` at 885, and every tool compiles. That makes this change preventive rather than corrective, and it is worth doing anyway for two reasons. The first is that nothing else stops it recurring: the bound was written the ordinary way, by a schema author with no reason to know that a published length costs a grammar rule per character, and the next such bound will be written the same way. The second is immediate — [0019](./0019-selected-result-fields.md) adds a bounded array of path strings to five tools, and this rule is what keeps those bounds out of publication.

The three intents `arr_config_reconcile` published and refused unconditionally were the other half of this change as originally planned. [0020](./0020-withdraw-configuration-writes.md) subsumes them by removing the tool, so what survives here is the general rule that a published schema may not offer an intent the server always refuses — which no current tool violates, and which is what keeps that from being reintroduced too.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules (see [Architecture — Testing Contract](../specs/architecture/#testing-contract)). CI enforces these as merge gates:

- Every exported behavior MUST have automated tests at the narrowest practical level.
- MCP tools MUST have protocol-level stdio integration tests for schemas, results, errors, and stdout cleanliness.
- Committed tests MUST NOT be focused, skipped, or dependent on live personal *arr instances.
- The full build, type check, lint, and test suite MUST run in CI and failures MUST block merge.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

Additionally, because this change loosens what is published while promising that what is accepted is unchanged:

- The rejection message for an over-length value MUST be pinned to an exact string, captured by running the assertion against the pre-change implementation rather than written from what the new code is expected to produce.
- The guard barring `maxLength` MUST read every published input schema off the wire from a spawned server, and MUST fail against the pre-change implementation.
- Every `safeParse`-based assertion in the existing suite MUST keep passing with no edit. An assertion that needs its expectation changed is evidence validation was weakened.
- A test MUST assert that no published input schema admits a variant the operation registry reports as unimplemented, so the rule is checked against the registry rather than against a list someone maintains by hand.

### Functional Requirements

The [Tool Contracts spec](../specs/tool-contracts/#stable-typed-surface) owns what a published input schema may and may not declare, and its scenarios are this change's acceptance criteria. What implementing them requires of this change:

- The bound is removed from **publication only**. The Zod schemas keep every `min`, `max`, and `regex` they have, so an over-length value is refused with the message it is refused with today.
- The stripping happens on the converted JSON Schema at the single publication site, not by editing the domain schemas, so a bound added to a future schema is handled without anyone remembering this rule.
- Every published input schema is covered, including the two tools whose input is a plain object rather than a variant union and which therefore do not currently pass through that site.
- Each removed bound is restated in the generated variant documentation, so what the schema no longer says the description does.
- `minLength`, `pattern`, `minItems`, and `maxItems` are retained. `pattern` constrains the admissible alphabet far more usefully than a length ever did, and the largest `maxItems` in the corpus is 200 against a known-good tool at 885.
- The unconditionally-refused-intent rule is enforced by a guard rather than by a removal, because after [0020](./0020-withdraw-configuration-writes.md) no tool declares one. The guard is the whole of this change's work on that rule.

## Design

### Approach

- Add a recursive sanitization pass over the converted JSON Schema in `src/tools/schemas/publish.ts` that deletes `maxLength` wherever it appears, and run it before the branches are merged so the merged root and the per-variant documentation both see the sanitized shape.
- Extend the publication site to cover `arr_capabilities` and `arr_job_get`, whose inputs are plain objects today. Neither currently declares a `maxLength`, so this is a guard against the next one rather than a fix for a present defect — which is exactly why it belongs here rather than in a later change that would have to rediscover the rule.
- Generate a sentence naming each bounded property and its accepted length, appended to the variant documentation the same generator already produces.
- Add a guard cross-checking every published input schema's declared variants against the operation registry, so a variant the registry reports as unimplemented cannot be published.

### Decisions

- **Decision:** Strip `maxLength` from publication rather than lowering the values.
  - **Why:** Lowering is not a fix. All three long bounds at 512 still leaves the tool near 2,300, above a tool known to compile at 885, so the tool's fate would rest on a threshold nobody can state and a future schema could cross again. Stripping removes the class of failure rather than the instance.
  - **Alternatives considered:** Lowering the three bounds, rejected above. Splitting `arr_config_reconcile` into smaller tools, rejected because the expansion is per-schema and a split moves the cost rather than removing it, at the price of a public tool-name change.
- **Decision:** Keep `maxItems`.
  - **Why:** It bounds a bulk call at a number the caller genuinely needs — at most 50 references, at most 200 fields — and the evidence says it compiles: `arr_import_inspect` carries `maxItems` totalling 73 inside an 885 expansion and works. Removing a useful published bound to buy headroom nothing is asking for would be trading discovery for nothing.
  - **Alternatives considered:** Stripping both bound kinds for symmetry, rejected because symmetry is not a reason and `maxItems` is the half a caller acts on.
- **Decision:** Sanitize the converted JSON Schema centrally rather than removing `.max()` from the domain schemas.
  - **Why:** The bound must keep validating. Editing the domain schemas would delete the enforcement along with the publication, which is the one thing this change promises not to do. It also keeps the rule in one place, so a schema added later cannot reintroduce the failure by being written the ordinary way.
- **Decision:** Restate each removed bound in the generated documentation rather than dropping it silently.
  - **Why:** This is the same bargain [0015](./0015-flat-tool-input-schemas.md) struck for cross-property constraints, and the spec already requires it: what publication cannot carry, generated prose must. A caller that cannot see the ceiling anywhere discovers it by being rejected.
- **Decision:** Keep the unconditionally-refused-intent rule here as a guard, although [0020](./0020-withdraw-configuration-writes.md) leaves nothing violating it.
  - **Why:** The rule and the length rule are the same defect in two forms — a published schema claiming something the server will not honor — and they are checked by the same wire test over the same schemas. Landing the rule with no violation to fix is the cheapest it will ever be, and it is what makes the next violation fail in CI rather than in a user's session.
  - **Alternatives considered:** Dropping the rule as unnecessary once the violating tool is gone, rejected because it was reintroduced twice already on this surface — [0012](./0012-published-tool-schemas.md) and [0015](./0015-flat-tool-input-schemas.md) are both publication defects that a guard would have caught.
- **Decision:** Check the rule against the operation registry rather than a maintained list.
  - **Why:** The registry already knows which operations are unimplemented — it is what the capability report reads. Deriving the guard from it means the check cannot go stale, and a future unimplemented operation is caught the moment it is registered rather than when someone remembers to add it to a list.

### Non-Goals

- Changing any tool's name, accepted arguments, accepted variants, call shape, or output schema.
- Changing what any accepted input validates to, or the message any rejected input produces.
- Lowering, raising, or otherwise revising any validation bound.
- Removing or reinstating any tool, which is [0020](./0020-withdraw-configuration-writes.md).
- Reducing published output schemas, which is [0018](./0018-bounded-tool-listing.md).
- Verifying compilation against llama.cpp in CI. The guard is the absence of the keyword, not a grammar build.

## Tasks

- [ ] Pin what must not change
  - [ ] Add an over-length rejection-message test with the exact string captured against the unmodified implementation
  - [ ] Extend the wire-reading test to assert no published input schema declares `maxLength` at any depth, and confirm it fails against the pre-change implementation
- [ ] Sanitize the published input schemas
  - [ ] Add the recursive `maxLength` strip in `src/tools/schemas/publish.ts`, applied before branch merging
  - [ ] Route `arr_capabilities` and `arr_job_get` through the same publication site
  - [ ] Extend the generated variant documentation to name each bounded property and its accepted length
  - [ ] Confirm the wire guard is green and every `safeParse`-based assertion passes unedited
- [ ] Guard against publishing a refused intent
  - [ ] Add the cross-check between each published schema's declared variants and the operation registry's unimplemented list
  - [ ] Confirm it is green against the current corpus, and verify it fails when a registry entry is temporarily marked unimplemented
- [ ] Record the contract
  - [ ] Amend the Tool Contracts spec for the length-bound and unconditional-refusal rules, with a changelog row
  - [ ] Tick these tasks and set the status in this document, `docs/index.yml`, and `docs/index.md`

## Open Questions

- [ ] Is the `select` array that [0019](./0019-selected-result-fields.md) adds subject to this rule automatically? It should be, since it passes through the same publication site — but 0019 lands after this change and should confirm rather than assume it.

## References

- Spec: [Tool Contracts](../specs/tool-contracts/)
- Related changes: [0012-published-tool-schemas](./0012-published-tool-schemas.md), [0015-flat-tool-input-schemas](./0015-flat-tool-input-schemas.md), [0020-withdraw-configuration-writes](./0020-withdraw-configuration-writes.md)
- External: [llama.cpp GBNF guide](https://github.com/ggml-org/llama.cpp/blob/master/grammars/README.md)
