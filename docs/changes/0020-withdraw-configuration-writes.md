# 0020: Withdraw the Configuration Write Surface

## Summary

Remove `arr_config_reconcile` and everything that exists only to serve it. Configuration becomes read-only through `arr_config_observe`. The tool publishes nine intents, refuses three of them outright, and of the six it implements the only ones with a real use case are provider edits the project has decided not to support. Roughly 5,000 lines of adapter and tool code go with it, along with the transient-secret plumbing that nothing else produces.

**Spec:** [Configuration Reconciliation](../specs/configuration-reconciliation/)
**Status:** draft
**Depends On:** —

## Motivation

`arr_config_reconcile` is the write half of the configuration surface, and it is the most expensive tool in the server by every measure that matters: the largest published input schema at 3,869 bytes, a 7,443-byte output schema, the only input schema that fails to compile into a decoding grammar, and the only tool whose input carries 4096-character bounds.

Asked live, the three configured instances report what it can actually do:

```
sonarr / radarr   supported:      reconcile_provider, force_provider_save, test_provider,
                                  reconcile_profile, reconcile_resource
                  UNIMPLEMENTED:  delete_provider, delete_profile, delete_resource
prowlarr          supported:      ...same, plus reconcile_application_sync
```

Three of the nine declared intents are refused unconditionally with `<intent> is declared but not implemented yet`, discoverable only by calling the tool or by separately reading the capability report at full detail. A fourth form — creating a provider — is refused the same way.

Of the six that work, the substantive ones are the provider intents: enabling and disabling an indexer, changing its priority, retagging it, editing its dynamic fields, and testing it. Those are exactly what this project has decided not to support for now. What that leaves is thin enough not to carry a tool:

- `reconcile_profile` writes five scalars on a quality profile — its name, `upgradeAllowed`, and three score thresholds. The quality tree and the format scores are preserved untouched by design, and they are the only reason anyone edits a quality profile.
- `reconcile_resource` renames a tag. That is its entire surface.
- `reconcile_application_sync` sets Prowlarr sync levels and optionally starts a sync — real, but infrequent enough that it does not justify keeping the surface alive on its own.

Seven of the sixteen observable configuration domains were never writable anyway: custom formats, release profiles, delay profiles, app profiles, root folders, remote path mappings, and import list exclusions.

Reading configuration remains valuable and is unaffected. An agent driving search, grab, queue triage, import, and library management consults `arr_config_observe` constantly — which indexers exist, which are enabled, which are failing. It writes configuration approximately never.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules (see [Architecture — Testing Contract](../specs/architecture/#testing-contract)). CI enforces these as merge gates:

- Every exported behavior MUST have automated tests at the narrowest practical level.
- Adapter behavior MUST be covered by sanitized, version-labelled upstream fixtures rather than live personal instances.
- MCP tools MUST have protocol-level stdio integration tests for schemas, results, errors, and stdout cleanliness.
- The full build, type check, lint, and test suite MUST run in CI, with no focused or skipped tests, and failures MUST block merge.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

Additionally, because this change removes a public tool and a large body of code:

- A wire test MUST assert the published tool list is exactly the fourteen remaining names, so the removal is verified against what a host sees rather than against a source constant.
- Coverage of every retained tool MUST pass unedited. A retained tool whose test needs changing is evidence something shared was removed with the tool rather than only what belonged to it.
- The observation path MUST keep its full existing coverage, including the schema-route reads the staleness path used to make, so nothing that survives loses its tests along with its only other caller.
- Deletion MUST NOT be verified by the absence of a test. Every removed capability MUST be covered by a test asserting the server refuses or no longer offers it, not merely by the removal of the test that used to exercise it.

### Functional Requirements

The [Configuration Reconciliation spec](../specs/configuration-reconciliation/#observe-configuration) owns the observation surface that remains, and its [withdrawn-surface section](../specs/configuration-reconciliation/#configuration-writes-are-not-exposed) owns the statement that no write tool is exposed. The [Tool Contracts spec](../specs/tool-contracts/#stable-typed-surface) owns the tool list. Those scenarios are this change's acceptance criteria and are not restated here. What implementing them requires of this change:

- The tool name is removed from the published list, the tool-name union, the operation registry, and the capability report, so no application reports a configuration write as supported, unsupported, or unimplemented.
- The observation half of the configuration adapter is untouched, including the parse, serialize, model, domains, resources, and fields modules that `arr_config_observe` depends on.
- The transient-secret plumbing in shared plan and apply state is removed with the tool, because nothing else produces a secret.
- The generic plan/apply, receipt, and job machinery is untouched; seven mutation tools still use it.
- Recorded fixtures serving only the removed write paths are removed; every fixture the observation path reads is kept.

## Design

### Approach

- Remove `src/tools/config-reconcile.ts` and the configuration adapter modules that exist only for writes: `reconcile`, `write`, `patches`, `secrets`, `sync`, `tests`, `verify`, `dependencies`, and `fingerprints`.
- Remove the reconcile input and output schemas from `src/tools/schemas/configuration.ts` and the reconcile result payloads from `src/tools/schemas/configuration-results.ts`, keeping the observation view and its records.
- Remove the tool from `names.ts`, `definitions.ts`, and `operations.ts`, and drop its registry entries entirely rather than leaving them as unimplemented — an operation nobody plans to implement is not a roadmap entry.
- Remove the transient-secret handling from `state/plans.ts`, `state/apply-records.ts`, and `tools/dispatch.ts`, along with the secret-presence fingerprint in `state/tokens.ts` if nothing else reads it.
- Restructure the Configuration Reconciliation spec so the observation requirements stand as the current surface and the write requirements are retained, clearly marked, as the design for reinstatement.

### Decisions

- **Decision:** Remove the tool rather than reducing it to its non-provider intents.
  - **Why:** What survives the removal of provider management is renaming a quality profile, renaming a tag, and setting Prowlarr sync levels. A public tool with the largest input schema in the server, nine declared intents, and a documented plan/apply contract is a great deal of surface to keep for that. Keeping it would also keep every schema, adapter, and test that makes it work, so nearly none of the cost would actually come off.
  - **Alternatives considered:** Dropping only the four provider intents, which leaves the thin remainder above. Dropping provider writes but keeping `test_provider` as a diagnostic, which is genuinely useful but keeps the transient-secret schema, its 4096-character bound, and the whole provider test adapter alive to serve one read-shaped operation.
- **Decision:** Remove the transient-secret plumbing rather than retaining it for a future reinstatement.
  - **Why:** Nothing produces a secret once this tool is gone, so what would be retained is machinery no call can reach and no test can exercise honestly. Unexercised code with no caller is what rots, and a reinstatement would want to re-derive it against whatever the write surface looks like then rather than inherit whatever it looked like now. This change document and the history record the contract; that is a better reinstatement path than dead code.
  - **Alternatives considered:** Keeping it because the Tool Contracts spec specifies it, rejected by moving the specification of it to the withdrawn-surface section, where it belongs alongside everything else the reinstatement will need.
- **Decision:** Drop the removed operations from the registry rather than marking them unimplemented.
  - **Why:** The unimplemented list is how a caller learns what is planned. These are not planned; leaving them there would make the capability report say the opposite of the decision this change records.
- **Decision:** Retain the write requirements in the spec rather than deleting them.
  - **Why:** The decision is "not for now", not "never", and the requirements encode real design work — the scoped read-modify-write, explicit removal, staleness on a changed provider schema, secret handling that never retains a value. Deleting them would throw that away to save a page. Marking them as describing no current surface keeps the spec honest without discarding the design.
  - **Alternatives considered:** Deleting the sections outright, rejected above. Leaving them unmarked, rejected because a spec that describes a tool the server does not expose is exactly the drift the spec corpus exists to prevent.

### Non-Goals

- Changing `arr_config_observe` in any way. Its bounding is [0016](./0016-bounded-provider-schema-observation.md).
- Removing any other tool, or changing the plan/apply, receipt, or job contracts the seven remaining mutation tools depend on.
- Implementing provider creation, provider deletion, or the dependent-migration behavior.
- Deciding when or whether the write surface returns.
- Making the configuration spec into an observation-only document by renaming it or its directory; the name stays so existing links keep resolving.

## Tasks

- [ ] Pin the surface before removing it
  - [ ] Add a wire test asserting the published tool list is exactly the fourteen remaining names, and confirm it fails today
  - [ ] Add a test asserting no application reports a configuration write operation in any capability list
- [ ] Remove the tool and its schemas
  - [ ] Delete `src/tools/config-reconcile.ts`, and remove the tool from `names.ts`, `definitions.ts`, and `operations.ts`
  - [ ] Remove the reconcile input and output schemas and the reconcile result payloads, keeping the observation view and its records
  - [ ] Confirm `arr_config_observe` compiles, behaves, and tests identically
- [ ] Remove the write adapters
  - [ ] Delete the nine write-only configuration adapter modules
  - [ ] Remove the fixtures that served only the removed write paths, keeping every fixture the observation path reads
  - [ ] Update `scripts/verify-package.mjs` for the removed modules
- [ ] Remove the transient-secret plumbing
  - [ ] Remove secret handling from `state/plans.ts`, `state/apply-records.ts`, and `tools/dispatch.ts`, and the secret-presence fingerprint if unreferenced
  - [ ] Confirm the plan, apply-record, and stale-plan suites for the seven remaining mutation tools pass unedited
- [ ] Record the contract
  - [ ] Amend the Tool Contracts spec for the fourteen-tool list and relocate the transient-secret requirements, with a changelog row
  - [ ] Restructure the Configuration Reconciliation spec into the current observation surface and the retained withdrawn design, with a changelog row
  - [ ] Update the README's tool list and any count it states
  - [ ] Tick these tasks and set the status in this document, `docs/index.yml`, and `docs/index.md`

## Open Questions

None.

## References

- Spec: [Configuration Reconciliation](../specs/configuration-reconciliation/), [Tool Contracts](../specs/tool-contracts/)
- Related changes: [0008-configuration-reconciliation](./0008-configuration-reconciliation.md), [0016-bounded-provider-schema-observation](./0016-bounded-provider-schema-observation.md), [0017-grammar-compilable-input-schemas](./0017-grammar-compilable-input-schemas.md)

## Supersedes

Change [0008](./0008-configuration-reconciliation.md) built the reconciliation surface this change withdraws. It is superseded in scope rather than in reasoning: what it built works, and the decision here is that the surface is not worth its cost, not that it was built wrongly. Its design remains the reference for any reinstatement, which is why the spec keeps the requirements rather than deleting them.
