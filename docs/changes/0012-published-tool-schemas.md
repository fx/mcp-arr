# 0012: Published Tool Schemas

## Summary

Publish the argument contract for every tool. Thirteen of the fifteen tools currently advertise an empty input schema, so a calling agent cannot discover any variant or argument without provoking a validation error. This closes the gap the [Tool Contracts spec](../specs/tool-contracts/#stable-typed-surface) now names explicitly.

**Spec:** [Tool Contracts](../specs/tool-contracts/)
**Status:** complete
**Depends On:** —

## Motivation

Testing the merged server against live instances showed `tools/list` publishing `{"type":"object","properties":{}}` for every tool whose input is a typed variant union — thirteen of fifteen. Only `arr_capabilities` and `arr_job_get`, whose inputs are plain objects, publish real arguments.

The runtime is not affected: validation runs against the full union, so every call is checked exactly as intended and a wrong argument is rejected with an accurate message. That divergence is precisely why the defect survived. The server behaves correctly on every call it receives; it simply never tells a caller what to send. A permissive host can still drive it if the caller already knows the shape, and a host that filters arguments against the published schema cannot call the domain surface at all.

Two things let this through and both need closing with the fix:

- The helper intended to solve this attaches metadata that nothing reads. It has no effect on the published schema, and its comment asserts a consequence that does not occur, which made the problem look handled.
- The stdio test named for publishing the tools' schemas asserts only that each input schema's type is `object` — which an empty schema satisfies. The schema-content tests convert the internal schema objects directly and never read what the server actually publishes. Both suites pass while the published contract is empty.

Every remaining change adds more variant tools onto this path, so it is worth fixing before any of them.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules (see [Architecture — Testing Contract](../specs/architecture/#testing-contract)). CI enforces these as merge gates:

- Exported behavior MUST have automated tests at the narrowest practical level.
- Adapter tests MUST use sanitized, version-labelled fixtures rather than personal live instances.
- Stdio integration tests MUST verify protocol framing and stdout cleanliness.
- Build, type check, lint, and tests MUST pass without focused or skipped tests.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

Additionally, because a test that asserted the wrong property is what allowed this defect to ship:

- The regression test MUST read the schema the running server publishes over the protocol, not an in-process conversion of the schema object.
- It MUST assert that each tool accepting arguments publishes them, and MUST fail against the current implementation before the fix.

### Functional Requirements

The [Tool Contracts spec](../specs/tool-contracts/#stable-typed-surface) owns what a published schema must describe, and its scenarios are this change's acceptance criteria. What implementing them requires of this change:

- The published surface MUST carry the variant alternatives while keeping the protocol's requirement that a tool input schema be an object at its root; a typed union cannot be the root of a published schema.
- Runtime validation MUST continue to reject unknown properties and undeclared variants before any upstream request, with the same error text callers see today — this change alters what is published, not what is accepted.
- The helper whose metadata has no effect MUST be removed or replaced by whatever genuinely produces the published schema, so no comment claims an effect that does not occur.
- The stdio assertion that passes against an empty schema MUST be strengthened rather than supplemented, so the weak assertion cannot be relied on again.
- Public tool names, accepted arguments, and accepted variants MUST NOT change; a caller that works against the server today MUST keep working.

#### Scenario: The published schema and the accepted input agree

- **GIVEN** a tool that accepts typed variants
- **WHEN** its published input schema is validated against an argument object the tool accepts, and against one it rejects
- **THEN** the published schema admits the accepted object and refuses the rejected one

## Design

### Approach

- Establish how the variant alternatives reach the published schema while the root stays an object, and apply it uniformly to all thirteen affected tools.
- Keep the existing typed unions as the source of truth for validation so no accepted input changes.
- Replace the ineffective metadata helper.
- Strengthen the stdio test to assert published arguments, and add a round-trip test comparing the published schema against inputs the tool accepts and rejects.

### Decisions

- **Decision:** Treat this as a publication defect rather than a schema redesign.
  - **Why:** The typed unions are correct and validate correctly against live instances. Only their journey to `tools/list` is broken, so the fix should not disturb the accepted input shape.
  - **Alternatives considered:** Flattening each union into one object with optional fields, rejected because it discards the discriminated-variant guarantee the spec requires and would weaken validation. Splitting each variant into its own tool, rejected because it contradicts the fifteen-tool decision in change 0002.
  - **Superseded by [0015-flat-tool-input-schemas](./0015-flat-tool-input-schemas.md):** the flattening rejection was made without knowing that hosts drop a tool whose input schema carries a root `anyOf`, `oneOf`, or `allOf` — thirteen of the fifteen tools were being discarded before a caller ever saw them, so publishing alternatives was never the safer option. Flattening weakens neither the discriminated-variant guarantee nor validation: the unions still validate every call unchanged, and what the merge discards is regenerated as documentation from those same unions.
- **Decision:** Prefer preserving the current call shape over the most convenient publication mechanism.
  - **Why:** The server already works against real instances and a host is configured against it. A mechanism that publishes correctly but renames or nests arguments imposes a breaking change on a working integration to fix a defect callers never caused.
  - **Alternatives considered:** Nesting each union under a single wrapper property publishes cleanly with the least machinery, but changes every call. Treat it as the fallback if the current shape cannot be published, and say so explicitly rather than adopting it silently.
  - **Superseded by [0015-flat-tool-input-schemas](./0015-flat-tool-input-schemas.md):** the current shape could not be published after all, but the pre-authorized wrapper-property fallback was not the way out of it. Merging the variants into one flat object keeps every call shape exactly as it was, which is what that fallback would have cost.
- **Decision:** Publish each union by wrapping it in a loose object whose parse delegates to the union, and carry the union's converted alternatives as that object's root metadata.
  - **Why:** The server SDK refuses to convert a registered schema that is not a Zod object, so a union reached `tools/list` as an empty object and no root metadata could rescue it — the union never reached the conversion. An object wrapper does reach it, and because the wrapper parses by handing the caller's object to the union unchanged and re-raising the union's own finalized issues, the accepted arguments, the parsed result, and every rejection message are byte-identical to before. The fallback was not needed: no call shape changed.
  - **Alternatives considered:** Replacing the SDK's `tools/list` handler with one that publishes schemas this project converts itself, rejected because it duplicates response construction the SDK owns and would drift from it silently.

### Non-Goals

- Changing any tool's name, arguments, variants, or behavior.
- Implementing any domain behavior that is currently unimplemented.
- Changing output schemas, which publish correctly today.
- Upgrading the MCP SDK. If a newer version publishes union roots directly, that is worth knowing, but this change should not turn into a dependency upgrade.

## Tasks

- [x] Publish the variant contract for every tool
  - [x] Establish the publication path that carries variant alternatives under an object root, and apply it to all thirteen affected tools
  - [x] Remove the metadata helper whose effect does not occur, along with its incorrect comment
  - [x] Confirm every accepted input and rejection message is unchanged, including against the live-instance calls already exercised
- [x] Close the test gap that allowed this
  - [x] Strengthen the stdio schema assertion so an empty published schema fails it
  - [x] Add a round-trip test validating accepted and rejected inputs against the published schema
  - [x] Verify both tests fail against the pre-fix implementation

## References

- Spec: [Tool Contracts](../specs/tool-contracts/)
- Related changes: [0002-tool-runtime](./0002-tool-runtime.md), [0003-library-queries](./0003-library-queries.md)
- External: [MCP Tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
