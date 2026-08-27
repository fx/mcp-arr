# 0015: Flat Tool Input Schemas

## Summary

Publish every tool input as a single flat object whose properties are the union of every variant's arguments, and move the per-variant structure into documentation generated from the same union that validates the input. Thirteen of the fifteen tools currently publish a root `oneOf` or `anyOf`, and a host that refuses a root combinator drops them all. Runtime validation is untouched: the same discriminated unions accept and reject exactly what they do today, with byte-identical messages.

**Spec:** [Tool Contracts](../specs/tool-contracts/)
**Status:** complete
**Depends On:** [0012](./0012-published-tool-schemas.md)

## Motivation

Change 0012 fixed the published schemas so that every tool finally advertises its arguments. Testing the merged server against a host that filters tool definitions showed the next failure on the same path: the host skipped thirteen of the fifteen tools outright, logging for each one that its input schema uses a top-level `oneOf`, which the model API does not accept. Only `arr_capabilities` and `arr_job_get` — the two tools whose input is a plain object rather than a variant union — survived.

Reading the host's own tool-definition filter establishes the exact rule, and it is narrower than it first appears:

- A tool is dropped when its input schema carries `anyOf`, `oneOf`, or `allOf` **at the root**. All three are dropped, so the conditional-required `allOf` + `if`/`then` construction is not a way out either.
- A combinator nested under a property is never inspected. Nested alternatives are safe.
- The only other checks are a draft-2020-12 meta-schema validation and a property-key regex, `^[a-zA-Z0-9_.-]{1,64}$`. Both are already satisfied, and the two surviving tools prove a `$schema` of draft-07 is accepted.
- A normalizer for exactly this case does exist in the host, but it is gated on a remote-hostname allowlist. A stdio server has no URL in its configuration, so the gate can never open for this server. Waiting for the host to fix it is not an option that exists.

So the published root cannot be alternatives at all. Since the protocol also requires the root to be an object, there is exactly one shape left: one object carrying every argument, with the correlations between them stated in prose.

This is a publication defect for the second time on the same surface, and for the second time the runtime is correct throughout. The server validates a call against the Zod union, never against the published JSON Schema, so a caller that already knows the shape is served correctly. It is discovery that is broken — and this time so completely that the tools do not appear at all.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules (see [Architecture — Testing Contract](../specs/architecture/#testing-contract)). CI enforces these as merge gates:

- Exported behavior MUST have automated tests at the narrowest practical level.
- Adapter tests MUST use sanitized, version-labelled fixtures rather than personal live instances.
- Stdio integration tests MUST verify protocol framing and stdout cleanliness.
- Build, type check, lint, and tests MUST pass without focused or skipped tests.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

Additionally, because this change deliberately loosens what is published while promising that nothing about what is accepted changes:

- The rejection message of every class of refused input MUST be pinned to an exact string, and those strings MUST be captured by running the assertions against the pre-change implementation rather than written from what the new code is expected to produce. A message-identity test authored after the fix proves nothing.
- The root-combinator guard MUST read the schema off the wire from a spawned server and MUST fail against the pre-change implementation.
- Every `safeParse`-based assertion in the existing suite MUST keep passing with no edit. If one needs its expectation changed, that is evidence validation was weakened, not that the assertion was wrong.
- Coverage MUST reach every branch of every union rather than one sample per tool, because the published `required` list shrinks to the intersection of the branches and a single sample cannot detect a branch that stopped validating.

### Functional Requirements

The [Tool Contracts spec](../specs/tool-contracts/#stable-typed-surface) owns what a published schema must describe, and its scenarios are this change's acceptance criteria. What implementing them requires of this change:

- A published input schema MUST NOT rely on a root-level `anyOf`, `oneOf`, or `allOf`. Every published input schema MUST carry `type: "object"` and `additionalProperties: false` at its root.
- Every argument any variant accepts MUST appear as a property of that one object, and the discriminator MUST publish the complete set of accepted values as a single enum.
- The root `required` list MUST be the intersection of the variants' required lists, so no accepted call is refused by the published schema.
- Where a property's schema differs between variants, the published property MUST admit every shape any variant admits — no variant may be silently dropped in favor of whichever branch happened to be first.
- Each variant's own required and optional arguments, and any value set narrower than the merged property publishes, MUST be described in documentation generated from the same union that validates the input, so the description cannot drift from what is accepted.
- Runtime validation MUST continue to accept exactly what it accepts today and reject exactly what it rejects today, with identical messages. Public tool names, accepted arguments, accepted variants, call shape, and output schemas MUST NOT change.

#### Scenario: A host that refuses a root combinator lists every tool

- **GIVEN** a host that drops a tool whose input schema carries `anyOf`, `oneOf`, or `allOf` at its root
- **WHEN** it lists this server's tools
- **THEN** all fifteen are listed, each publishing every argument its variants accept

#### Scenario: Discovering a variant's own requirements without calling the tool

- **GIVEN** a tool whose variants require different arguments, and whose published root therefore requires only the discriminator
- **WHEN** its published input schema is read
- **THEN** the schema's own documentation names every variant, the arguments each one requires and accepts, and any value set a variant narrows, so no per-variant requirement is discoverable only by triggering a validation error

## Design

### Approach

- Merge each union's converted branches into one flat object schema — properties unioned, `required` intersected, per-property shapes deduplicated — and publish that as the wrapper's root metadata in place of the alternatives.
- Generate the per-variant documentation from the same converted branches and carry it in the published schema's root `description`.
- Move `variantUnion` out of `src/tools/schemas/common.ts` into a new `src/tools/schemas/publish.ts`, since the flattener needs `referencePattern` from `common.ts` and delegating in the other direction would be an import cycle.
- Leave the wrapper's parse delegation completely untouched, which is what makes acceptance and every rejection message byte-identical.
- Pin the rejection messages first, in their own commit against the unmodified source; land the root-combinator guard second, red; land the fix third.

### Decisions

- **Decision:** Publish one flat object per tool rather than the union's alternatives.
  - **Why:** The host drops a root `anyOf`, `oneOf`, and `allOf` alike, and the protocol requires an object root. There is no third shape. A tool that is not listed is worse in every respect than one whose published schema is broader than what it validates.
  - **Alternatives considered:** A root `allOf` with `if`/`then` conditional requirements, rejected because root `allOf` is dropped by the same rule. Waiting for the host's own normalizer, rejected because it is gated on a remote-hostname allowlist that structurally excludes an stdio server.
- **Decision:** The published schema is deliberately looser than what validates, and the generated documentation is what closes the gap.
  - **Why:** Cross-property correlations — a variant's required arguments, a value set scoped by the discriminator, two forms that may not be combined — cannot be expressed in a single flat object without a root combinator. Stating them in prose generated from the union keeps them discoverable without a call, and keeps them from drifting, because the same conversion produces both the schema and the sentence.
  - **Alternatives considered:** Leaving the correlations undocumented and discoverable only by triggering a validation error, rejected because that is precisely what the spec forbids.
- **Decision:** The generated variant documentation lives in the published schema root's `description`, not in the tool description.
  - **Why:** It is argument-filling information, so it belongs with the arguments; and it keeps generation at one site inside `variantUnion` with nothing plumbed through the tool definitions, which is what makes drift impossible rather than merely unlikely.
- **Decision:** Collapse variants whose required and optional signature is identical into one documentation line naming all their discriminator values, and label a form that carries no discriminator value by what it requires rather than by an index.
  - **Why:** `arr_config_observe`'s sixteen domains otherwise produce sixteen identical lines differing only in a name — over a kilobyte carrying no information. And the plan-reference form on the eight mutation tools has no discriminator value at all, so an index-based label ("form 10") would name it after a position no reader can see.
- **Decision:** Where a variant's schema for a property is narrower than the merged published property, annotate it in the documentation with the variant's own `const`, `enum`, or reference kind.
  - **Why:** This is the largest thing flattening discards. `arr_config_reconcile` scopes `domain` by `intent` across three disjoint sets, and `arr_activity_change` requires history references for one intent and blocklist references for the other. Without the annotation both are discoverable only by triggering a validation error.
  - **Alternatives considered:** Hoisting `arr_config_reconcile`'s three repeated `domain` value sets into a trailing legend, rejected and recorded here so it is not re-litigated: it saves a few hundred bytes on one tool and costs every reader an indirection to resolve. Repetition that is predictable and local is cheaper to read than a reference.
- **Decision:** Move `variantUnion` into its own module rather than leaving it in `common.ts`.
  - **Why:** `common.ts` holds shared domain field schemas; the flattener is pure JSON Schema mechanism and needs `referencePattern` from `common.ts`. Moving it makes the dependency one-way. The five importing modules are repointed rather than served by a re-export shim, because two import paths for one symbol is worse than five edits.
- **Decision:** The rejection-message test lands first, green against the unmodified source.
  - **Why:** The promise is that messages are *unchanged*. Inline literals written after the fix would only restate whatever the new code produces. Captured before it, they are evidence — and a reviewer can check out that commit on top of the base branch and watch it pass.
- **Decision:** Widen the throw-on-unknown-keyword guard in `test/support/json-schema.ts` to allow `description`.
  - **Why:** That guard exists so a schema change cannot slip past a constraint the test validator has not implemented. `description` carries no constraint — it is an annotation in draft-7, exactly like `default` and `format`, which the guard already allows. Every published root gains one with this change, and `arr_search_start.monitoredOnly` already carries a nested one that no current sample happens to reach. Allowing it is widening the annotation list, not weakening the assertion half of the guard.
- **Decision:** Check structural well-formedness against the existing closed keyword set rather than adding a meta-schema validator.
  - **Why:** These schemas use a small, closed vocabulary the test support already enumerates and already throws on departures from. A new dependency to validate fifteen schemas whose every keyword is known is cost without coverage.
- **Decision:** Accept that the documentation cannot say which of `arr_library_change.changes`' two object shapes belongs to which intent.
  - **Why:** `edit_media` takes media metadata and `update_file_metadata` takes file metadata. Both shapes publish in full as the property's nested `anyOf`, so neither is hidden. Both are all-optional closed objects, so no required-field summary separates them, and rendering either inline would dominate the description. Recorded as an accepted residual rather than solved with a notation invented mid-implementation.

### Non-Goals

- Changing any tool's name, accepted arguments, accepted variants, call shape, or output schema.
- Changing what any input validates to, or the message any rejected input produces.
- Publishing exact per-variant schemas under a root `$defs` as a machine-readable mirror. That is unverified against the host's schema check, and being dropped again is the risk this change exists to remove. It is a follow-up, gated on this change first being confirmed against a live host.
- A notation attributing `arr_library_change.changes`' two object shapes to their intents.
- A trailing legend for the repeated `domain` value sets in `arr_config_reconcile`.
- Adding a meta-schema library.
- Upgrading the MCP SDK, which keeps owning `tools/list`.
- Implementing any domain behavior that is currently unimplemented.

## Supersedes

Change [0012](./0012-published-tool-schemas.md) recorded two decisions this change reverses, and both are superseded here rather than quietly contradicted:

- **0012 rejected flattening.** Its first decision considered "flattening each union into one object with optional fields" and rejected it "because it discards the discriminated-variant guarantee the spec requires and would weaken validation." That rejection was correct on the evidence available and is wrong on the evidence now available. It was made without knowing that a host drops a root combinator outright, so the choice it weighed — alternatives versus a flat object — was not the real one. The real choice is a flat object versus not being listed.

  The stated cost does not materialize either. Validation is not weakened: the discriminated unions remain the only thing that parses a call, and the wrapper still delegates to them and re-raises their finalized issues. What flattening loosens is *publication*. The discriminated-variant guarantee is preserved in validation rather than in publication, and what publication loses is recovered as documentation generated from the same union, so it cannot drift from what is accepted.

- **0012 pre-authorized wrapper-property nesting as the fallback.** Its second decision named "nesting each union under a single wrapper property" as the fallback "if the current call shape cannot be published, and say so explicitly rather than adopting it silently." That fallback is explicitly not taken. It publishes cleanly, but it renames every call on a working integration to fix a defect callers never caused. Flattening publishes cleanly *and* keeps every call shape identical, so the fallback is no longer the cheapest path and is withdrawn as the pre-authorized one.

## Tasks

- [x] Pin what must not change before changing anything
  - [x] Add a rejection-message test to `test/tool-schemas.test.ts` covering each message-producing mechanism — unknown property, undeclared discriminator value, a variant-required property omitted, a wrong reference kind, a plan reference combined with a restated intent, and a `.refine`-backed rejection — with the exact strings captured by running against the unmodified implementation
  - [x] Extend the wire-reading test in `test/tool-stdio.test.ts` to assert for all fifteen tools that the published root carries no `anyOf`, `oneOf`, or `allOf`, that its `type` is `object`, and that `additionalProperties` is `false`, and confirm it fails against the unmodified implementation
  - [x] Add the property-key regex and structural well-formedness assertions over the existing closed keyword set, without adding a meta-schema dependency
- [x] Publish a flat object root for every variant union
  - [x] Create `src/tools/schemas/publish.ts`, move `variantUnion` into it with a rewritten doc comment, and implement branch collection, property merging, `required` intersection, and the generated variant documentation
  - [x] Repoint the thirteen call sites and register the new module in `scripts/verify-package.mjs`
  - [x] Allow `description` in the test validator's annotation keywords, and remove the per-tool published-contract block in `test/library-change-stdio.test.ts` that the generic coverage replaces
  - [x] Confirm the root-combinator guard is now green and that every `safeParse`-based assertion still passes unedited
- [x] Cover every union branch against the published schema
  - [x] Add a per-branch sample-argument table to `test/support/tool-context.ts` and round-trip every entry against both the published schema and the tool's own input schema
  - [x] Add the completeness guard that ties the table to the published discriminator enum and to the plan-reference form
  - [x] Assert the generated documentation names every discriminator value, every branch's arguments, the exclusivity header, and the discriminator-scoped value sets
- [x] Record the contract
  - [x] Amend the Tool Contracts spec for the flat published root, the generated variant documentation, and the deliberate looseness, with a changelog row
  - [x] Add the supersession pointers to `docs/changes/0012-published-tool-schemas.md` and soften the README's claim about published input schemas
  - [x] Tick these tasks and set the status to complete in the change document, `docs/index.yml`, and `docs/index.md`

## Open Questions

None.

## References

- Spec: [Tool Contracts](../specs/tool-contracts/)
- Related changes: [0002-tool-runtime](./0002-tool-runtime.md), [0012-published-tool-schemas](./0012-published-tool-schemas.md)
- External: [MCP Tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
