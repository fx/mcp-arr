# 0013: Result Summary Fidelity

## Summary

Make what a caller actually reads match what the server actually found. Error summaries currently discard the error code and remediation hint the structured result carries, and `arr_capabilities` returns an unbounded enumeration dominated by operations that do not work. Both are now named by the [Tool Contracts spec](../specs/tool-contracts/#error-contract).

**Spec:** [Tool Contracts](../specs/tool-contracts/)
**Status:** complete
**Depends On:** —

## Motivation

Two findings from testing the merged server against live instances, both about the gap between what the server computes and what reaches the caller.

An unimplemented tool returns a structured error carrying `unsupported_capability`, a precise message, and the remediation `Call arr_capabilities to list the operations this instance supports.` Its text summary is `arr_activity_query: error; sonarr error, radarr error`. When a result reports failure, hosts commonly surface only the text — the host used for testing did — so the remediation the spec mandates is computed, attached, and never seen. The requirement was satisfiable while being invisible, which is why nothing flagged it.

Separately, `arr_capabilities` enumerates every unimplemented operation for every configured application. Against three live instances that is roughly eight thousand tokens, the large majority describing operations that cannot be called. It is the first call an agent makes to orient itself, and it is the most expensive one on the surface. The proportion improves as later changes land, but the unbounded shape is wrong independently of how many operations are implemented.

An earlier fix in change 0003 corrected the capability summary from reporting `ok` when nothing was reachable. This is the same class one layer down: the summary is derived from the wrong thing.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules (see [Architecture — Testing Contract](../specs/architecture/#testing-contract)). CI enforces these as merge gates:

- Exported behavior MUST have automated tests at the narrowest practical level.
- Adapter tests MUST use sanitized, version-labelled fixtures rather than personal live instances.
- Stdio integration tests MUST verify protocol framing and stdout cleanliness.
- Build, type check, lint, and tests MUST pass without focused or skipped tests.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

Additionally, because the defect is in text a caller reads rather than in structured data:

- Tests MUST assert the summary text itself, not only the structured result beside it.

### Functional Requirements

The [Tool Contracts spec](../specs/tool-contracts/#error-contract) owns what a summary must convey, and the [Capabilities section](../specs/tool-contracts/#capabilities) owns bounded capability reporting. Their scenarios are this change's acceptance criteria. What implementing them requires of this change:

- The summary builder MUST derive an error summary from the error the result carries, rather than from the envelope status alone.
- Summaries MUST remain concise and MUST NOT become a serialization of the structured result; the requirement is that the code and remediation survive, not that everything does.
- Redaction MUST hold: moving error detail into text MUST NOT move an upstream body, URL, header, or API key with it.
- The capability detail level MUST default to the bounded form, so an existing caller that passes no detail argument gets the bounded result rather than today's enumeration.
- Structured content MUST continue to carry the full error detail it carries today; this change adds to what the summary conveys and MUST NOT remove anything from the structured result.

#### Scenario: A partial result is not summarized as a success

- **GIVEN** a query spanning two configured applications where one succeeds and one fails
- **WHEN** the caller reads the text summary
- **THEN** it reports both the successful application and the failure with its code, rather than describing the call as successful

## Design

### Approach

- Derive error summaries from the carried error, naming the stable code and the remediation hint.
- Add a detail level to the capability tool that bounds the report by default, summarizing operations an instance cannot perform as counts and enumerating them only on request.
- Assert summary text in tests for each shape: total failure, partial failure, unsupported variant, and success.

### Decisions

- **Decision:** Bound the capability report by default rather than adding an opt-out.
  - **Why:** The expensive shape should be the one a caller asks for, not the one it receives by surprise on its first orienting call.
  - **Alternatives considered:** Keeping the enumeration and documenting its cost, rejected because documentation does not reduce a payload. Removing unimplemented operations entirely, rejected because knowing an operation is declared but unavailable is genuinely useful — it is the enumeration by default that is wrong, not the information.
- **Decision:** Treat the default change as acceptable rather than breaking.
  - **Why:** The tool is days old, has one known consumer, and the enumeration remains available on request. Recording it as a deliberate default change is proportionate.
  - **Alternatives considered:** Preserving the current default and adding a bounded opt-in, rejected because it leaves the bad default in place for every caller that does not know to opt out.

### Non-Goals

- Changing structured content, error codes, or remediation text.
- Changing which operations are supported or implemented.
- Reformatting summaries for tools that already summarize correctly, beyond what the error path requires.
- Adding a general verbosity or detail level to tools other than the capability tool.

## Tasks

- [x] Carry the error code and remediation into result summaries
  - [x] Derive error summaries from the carried error rather than the envelope status
  - [x] Assert summary text for total failure, partial failure, unsupported variant, and success
  - [x] Confirm no upstream body, URL, header, or API key can reach a summary
- [x] Bound the capability report
  - [x] Add a detail level that defaults to the bounded form and enumerates only on request
  - [x] Verify the bounded default against configured, unconfigured, unavailable, and unsupported applications
  - [x] Update `README.md` where it describes what the capability report returns

## Open Questions

None.

## References

- Spec: [Tool Contracts](../specs/tool-contracts/)
- Related changes: [0002-tool-runtime](./0002-tool-runtime.md), [0003-library-queries](./0003-library-queries.md)
