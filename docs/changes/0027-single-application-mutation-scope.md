# 0027: Single-Application Mutation Scope

## Summary

Stop publishing a search intent the server always refuses. `arr_search_start` accepts `missing` and `cutoff_unmet` with `applications` optional and up to two entries, but a mutation targets exactly one application, so omitting the argument — the documented default — fails every time. The [Tool Contracts spec](../specs/tool-contracts/#plan-and-apply) now states the single-application rule and requires it to be discoverable.

**Spec:** [Tool Contracts](../specs/tool-contracts/)
**Status:** draft
**Depends On:** —

## Motivation

The published variant documentation for `arr_search_start` reads:

```
- target=missing|cutoff_unmet: mode, monitoredOnly; optional applications
"applications": {"items": {"enum": ["sonarr","radarr"]}, "maxItems": 2, "minItems": 1}
```

Following it fails:

| Call | Result |
|---|---|
| `target: "missing"`, no `applications` | `invalid_input` |
| `target: "missing"`, `["sonarr", "radarr"]` | `invalid_input` |
| `target: "cutoff_unmet"`, no `applications` | `invalid_input` |
| `target: "missing"`, `["sonarr"]` | plan returned |
| `target: "cutoff_unmet"`, `["radarr"]` | plan returned |

The refusal is correct and deliberate. A mutation envelope carries one plan reference, one job reference, and one receipt, so fanning a mutation across two instances would produce records the envelope cannot report; the dispatcher refuses with "name one application for this mutation; it currently targets sonarr, radarr". The rule is sound. What is wrong is that the published schema does not express it, and neither does the generated documentation — so the schema advertises a default and a maximum that the server will always reject.

That already violates a standing requirement. [Tool Contracts](../specs/tool-contracts/#stable-typed-surface) requires that where a constraint holds only between properties, it "MUST then be described in the generated variant documentation rather than left discoverable only by triggering a validation error", and that a published schema "MUST NOT admit an intent the server refuses unconditionally". A caller reading this schema cannot learn the constraint any way except by failing.

The scope is exactly these two variants. Every other mutation derives its application from the references it was given, so it is single-application by construction; `arr_search_start` is the only mutation tool that publishes an `applications` argument at all, and its reference-derived targets are unaffected.

There is also a diagnosability cost worth recording. The dispatcher's message names the problem precisely, but the text summary that accompanies a failed result deliberately omits an error's message, carrying only the code and the static remediation. That is a considered decision and this change does not revisit it — but it means a caller seeing only the summary gets "correct the arguments to match the tool's declared input schema" for a schema that declares the call is fine. Publishing the constraint is what closes that gap.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules (see [Architecture — Testing Contract](../specs/architecture/#testing-contract)). CI enforces these as merge gates:

- Exported behavior MUST have automated tests at the narrowest practical level.
- Adapter tests MUST use sanitized, version-labelled fixtures rather than personal live instances.
- Stdio integration tests MUST verify protocol framing and stdout cleanliness.
- Build, type check, lint, and tests MUST pass without focused or skipped tests.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

Additionally, because the defect is in what the schema advertises:

- A test MUST assert that no published input schema admits an application selection the dispatcher refuses for naming more than one, so the class is covered rather than these two variants alone.
- A test MUST assert that the constraint appears in the generated variant documentation, since the documentation is generated from the same union that validates and is the only place a caller can read it.

### Functional requirements

The [Tool Contracts spec](../specs/tool-contracts/#plan-and-apply) owns the single-application mutation rule and its discoverability, and its scenario is this change's acceptance criterion. What implementing them requires of this change:

- The `missing` and `cutoff_unmet` variants MUST require the application they target rather than leaving it optional with a default that is always refused.
- The published property for those variants MUST NOT admit more applications than a mutation can target.
- The generated variant documentation MUST state the requirement, so it is readable without invoking the tool.
- The capability report MUST continue to list the variant for every application that supports it, since each remains individually callable.
- The dispatcher's refusal MUST remain in place as the backstop for any future mutation that names applications.

#### Scenario: Start a wanted search without naming an application

- **GIVEN** a caller reads the published schema for a wanted-media search
- **WHEN** it constructs a call from what the schema and its generated documentation state
- **THEN** the call names exactly one application and is accepted, and no reading of the schema produces a call the server refuses for naming more than one

## Design

### Approach

- Make the application selection required and single-valued on the two wanted-search variants, leaving reference-derived targets untouched.
- Let the generated variant documentation carry the requirement, since it is generated from the validating union and cannot drift from it.
- Add a check across every published input schema that no admitted application selection exceeds what a mutation can target.
- Keep the dispatcher's refusal as the runtime backstop.

### Decisions

- **Decision:** Require one application rather than fanning the search across both.
  - **Why:** Fanning would mean redesigning the mutation envelope to carry several plans, jobs, and receipts, which is a far larger change than the defect warrants and would weaken a contract that exists to keep a mutation's record unambiguous. Two calls cost the caller nothing and report each instance's job separately.
  - **Alternatives considered:** Returning several envelopes from one call, rejected for the reason above; leaving the schema as it is and only documenting the constraint, rejected because it keeps advertising a default that is always refused when the schema can simply express the truth.
- **Decision:** Cover the rule across all published schemas rather than the two variants.
  - **Why:** The defect is a schema advertising a refused intent. A test naming these two variants would pass while the next mutation to publish an application selection repeats it.
- **Decision:** Keep the dispatcher's refusal.
  - **Why:** It is the only enforcement that does not depend on a schema being written correctly, and its message is what makes a mistake legible when the structured result is read.
- **Decision:** Do not revisit the summary's omission of error messages.
  - **Why:** That omission is a deliberate redaction boundary owned by [0013](./0013-result-summary-fidelity.md). Publishing the constraint removes the need to read the message at all, which is the better fix.

### Non-Goals

- Changing the single-application mutation rule itself.
- Changing reference-derived search targets, which already name one application.
- Changing how read-only queries select applications — fanning a read across instances remains correct and unaffected.
- Revisiting what a failed result's text summary carries.

## Tasks

- [ ] Publish the single-application constraint on wanted searches
  - [ ] Require a single application on the `missing` and `cutoff_unmet` variants and confirm the generated variant documentation states it
  - [ ] Confirm the capability report still lists the variant for each supporting application
  - [ ] Confirm a call built from the published schema alone is accepted
- [ ] Guard the class
  - [ ] Assert across every published input schema that no admitted application selection exceeds what a mutation can target, and confirm the assertion fails against the current schema
  - [ ] Confirm the dispatcher's refusal remains as the runtime backstop

## Open Questions

None.

## References

- Spec: [Tool Contracts](../specs/tool-contracts/)
- Related changes: [0012-published-tool-schemas](./0012-published-tool-schemas.md), [0015-flat-tool-input-schemas](./0015-flat-tool-input-schemas.md), [0017-grammar-compilable-input-schemas](./0017-grammar-compilable-input-schemas.md)
