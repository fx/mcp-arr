# 0026: Plan-Mode Mutation Envelopes

## Summary

Let `arr_job_cancel` be planned. Its output schema requires an `outcome` that only an applied cancellation can have, so plan mode returns a projection the server then rejects as non-conforming and reports as `unexpected_response`. The [Tool Contracts spec](../specs/tool-contracts/#plan-and-apply) now requires a mutation tool's published output schema to admit its own plan-mode envelope.

**Spec:** [Tool Contracts](../specs/tool-contracts/)
**Status:** complete
**Depends On:** —

## Motivation

Planning a cancellation fails every time, on every job:

```
arr_job_cancel {mode: "plan", job: "job_…"}
  -> unexpected_response
     "Check the application version against arr_capabilities and report the mismatch."
```

Nothing is wrong with the application or its version, and the remediation sends the caller to look at one. The handler's plan branch returns a job projection with the requested and predicted effects, which is exactly what [Tool Contracts](../specs/tool-contracts/#plan-and-apply) asks plan mode for. The output schema then extends that projection with a required `outcome` drawn from the cancelled, requested, uncancellable, completed, and unknown set — outcomes that exist only once a cancellation has actually been attempted. Plan mode has no outcome to report, omits the field, and the envelope fails its own tool's declared output.

Applying is unaffected and correct: `arr_job_cancel` in apply mode reports `uncancellable` for a running search exactly as the spec requires. So the tool works, and only the mode whose entire purpose is to look before acting is unreachable.

The repository already solves this shape elsewhere. `arr_release_grab` and `arr_search_start` both discriminate their result on a `stage`, with a planned variant and an applied variant carrying different fields; both plan cleanly. `arr_job_cancel` is the single mutation tool that instead extends one flat shape with an apply-only field, and it is the single one whose plan mode fails. The fix is to adopt the pattern the codebase already uses rather than to invent one.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules (see [Architecture — Testing Contract](../specs/architecture/#testing-contract)). CI enforces these as merge gates:

- Exported behavior MUST have automated tests at the narrowest practical level.
- Adapter tests MUST use sanitized, version-labelled fixtures rather than personal live instances.
- Stdio integration tests MUST verify protocol framing and stdout cleanliness.
- Build, type check, lint, and tests MUST pass without focused or skipped tests.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

Additionally, because the defect is a result rejected by its own declared schema:

- Every mutation tool MUST have a test that plans it and validates the envelope against that tool's published output schema, since the existing tests assert handler returns rather than published conformance.
- The plan-mode test for cancellation MUST cover both a cancellable and an uncancellable job, because the two produce different predicted effects.

### Functional requirements

The [Tool Contracts spec](../specs/tool-contracts/#plan-and-apply) owns the rule that a mutation tool's published output schema must admit its plan-mode envelope, and its scenario is this change's acceptance criterion. What implementing them requires of this change:

- The cancellation result MUST distinguish the planned envelope from the applied one, so the applied outcome is required exactly where it exists.
- Plan mode MUST continue to disclose the requested effect, to predict no cancellation for a job it believes uncancellable, and to warn that applying will report it as uncancellable.
- Apply mode MUST continue to report its outcome and to leave an unconfirmed request reconcilable rather than receipted as succeeded.
- The published schema MUST remain closed; admitting the planned envelope MUST NOT be achieved by making the applied outcome optional and thereby permitting an applied result that reports none.

#### Scenario: Plan a cancellation for an uncancellable job

- **GIVEN** a job the server believes cannot be cancelled
- **WHEN** the caller plans its cancellation
- **THEN** the plan returns the requested effect, predicts no cancellation, warns that applying will report it uncancellable, and conforms to the tool's published output schema

## Design

### Approach

- Discriminate the cancellation result by stage, matching the grab and search-start results, with the outcome required on the applied variant only.
- Leave both handler branches' behavior as they are; only what they are validated against changes.
- Add published-schema conformance to the plan-mode test for every mutation tool, so the class is covered rather than the instance.

### Decisions

- **Decision:** Discriminate by stage rather than making the outcome optional.
  - **Why:** An optional outcome would let an applied cancellation report none and still validate, which is the one thing the field exists to prevent. A discriminated result keeps it required exactly where it is meaningful.
  - **Alternatives considered:** Making `outcome` optional, rejected for the reason above; giving plan mode a placeholder outcome, rejected because it would state a cancellation result for a cancellation that has not been attempted.
- **Decision:** Follow the existing stage-discriminated pattern.
  - **Why:** Two mutation tools already model exactly this, they work, and a third shape for the same problem is a third thing to keep consistent.
- **Decision:** Cover every mutation tool's plan mode against its published schema, not just this one.
  - **Why:** The defect is that a published schema and a handler disagreed with nothing checking. Fixing only the tool that was caught leaves the check absent for the rest.
- **Decision:** Treat this as a defect fix rather than a contract change.
  - **Why:** Plan mode has never returned a conforming result for this tool, so no caller depends on the current behavior. The applied envelope keeps every field it had, including its required outcome, and gains only the stage that names which variant it is.

### Non-Goals

- Changing what cancellation does or which outcomes it distinguishes.
- Changing what any mutation tool's apply mode reports, beyond the stage that names the variant an applied cancellation is.
- Revisiting the `unexpected_response` code, which correctly described a non-conforming result.
- Adding new plan-mode warnings beyond the one already produced.

## Tasks

- [x] Admit the planned cancellation envelope
  - [x] Discriminate the cancellation result by stage, with the outcome required only on the applied variant
  - [x] Confirm plan mode still discloses the requested effect, predicts nothing for an uncancellable job, and warns accordingly
  - [x] Confirm apply mode still reports its outcome and still leaves an unconfirmed request reconcilable
- [x] Cover plan-mode conformance across mutation tools
  - [x] Validate each mutation tool's planned envelope against its own published output schema
  - [x] Confirm the cancellation case fails against the current flat schema

## Open Questions

None.

## References

- Spec: [Tool Contracts](../specs/tool-contracts/)
- Related changes: [0002-tool-runtime](./0002-tool-runtime.md), [0012-published-tool-schemas](./0012-published-tool-schemas.md), [0025-job-projection-refresh](./0025-job-projection-refresh.md)
