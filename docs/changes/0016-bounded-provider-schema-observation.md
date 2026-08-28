# 0016: Bounded Provider Schema Observation

## Summary

Stop returning the instance's provider template catalogue from `arr_config_observe`. Observing Prowlarr's `indexers` domain at `detail: "full"` returns 1,044,260 bytes, of which 1,043,460 is a `schema.templates` list of 624 Cardigann definitions sitting outside the page bound, while the records the caller asked for are 1,366 bytes. Nothing reads it: reconciliation re-reads the schema route itself, and the only caller-facing use it was built for is provider creation, which the server refuses.

**Spec:** [Configuration Reconciliation](../specs/configuration-reconciliation/)
**Status:** draft
**Depends On:** —

## Motivation

Measured against live Sonarr 4.0.19.2979, Radarr 6.3.0.10514, and Prowlarr 2.5.2.5491 instances:

| call | bytes |
|---|---|
| `domain: indexers`, `prowlarr`, `detail: "summary"`, `pageSize: 1` | 778 |
| `domain: indexers`, `prowlarr`, `detail: "full"`, `pageSize: 1` | **1,044,260** |
| `domain: indexers`, `prowlarr`, `detail: "full"`, `pageSize: 10` | **1,044,260** |

A 1,342× cliff on one flag, and `pageSize` does not move it, because `schema` sits beside `records` in the observation payload and only `records` is paged. The same call against Sonarr's `indexers` is 12,249 bytes and against Prowlarr's `download_clients` 14,739, so this is specific to the domain whose catalogue is a tracker-definition list.

What the extra megabyte buys is nothing. Diffing the two detail levels for one record:

```
summary:  reference, name, secrets, withheld{count:37}, family,
          implementation, configContract, protocol, priority, enabled, tags
full:     ...identical..., plus  "fields": []
```

One extra key, and it is empty — every one of that record's 37 fields is withheld at both levels, because the field classifier suppresses values outright for a provider whose fields a tracker definition named rather than the application. So `detail: "full"` on this domain adds an empty array and a second upstream request, and carries the catalogue along for the ride.

Three separate reasons say the catalogue is not needed:

- **Reconciliation does not read it.** `reconcile.ts` calls `readSchemaFingerprint`, which fetches the schema route itself and digests the single template matching the record's implementation. The staleness check is self-sufficient and never consults an observation result.
- **Its caller-facing purpose serves an unimplemented operation.** The templates exist so a caller can discover the `implementation` and field names a *new* provider needs. `config-reconcile.ts` refuses that outright: `creating a configuration record is not implemented; name an existing record to reconcile`. The change document that built this surface said as much — creating a provider needs a schema-driven template it did not assemble.
- **Even as reference material the shape is wrong.** 624 templates are returned to answer a question about one.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules (see [Architecture — Testing Contract](../specs/architecture/#testing-contract)). CI enforces these as merge gates:

- Every exported behavior MUST have automated tests at the narrowest practical level.
- Adapter behavior MUST be covered by sanitized, version-labelled upstream fixtures rather than live personal instances.
- MCP tools MUST have protocol-level stdio integration tests for schemas, results, errors, and stdout cleanliness.
- The full build, type check, lint, and test suite MUST run in CI, with no focused or skipped tests, and failures MUST block merge.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

Additionally, because this change removes a published field:

- A regression test MUST assert that no observation payload carries a provider template catalogue at any detail level, for every provider domain, so the field cannot return unnoticed as a side effect of a later change.
- Where the schema-fingerprint staleness path still exists, its coverage MUST remain unedited: a stale-plan test needing its expectation changed is evidence reconciliation was reading the observation payload after all. [0020](./0020-withdraw-configuration-writes.md) deletes that path outright, so this requirement is discharged rather than violated if 0020 has already landed — see the ordering note below.

### Functional Requirements

The [Configuration Reconciliation spec](../specs/configuration-reconciliation/#observe-configuration) owns what an observation returns, how every part of it is bounded, and the rule that a provider-schema read stays internal to the operation needing it rather than being published. Those scenarios are this change's acceptance criteria and are not restated here. What implementing them requires of this change:

- The observation request no longer carries a flag asking for templates, so the second upstream request disappears rather than becoming an unused response.
- The observation payload type loses its optional template member, so a payload carrying one stops type-checking rather than merely stopping being produced.
- `detail: "full"` retains its meaning for the record itself — it is the level at which a record's readable field values appear — and only stops implying the catalogue.
- Recorded provider fixtures that exist solely to feed the removed schema route are removed with it; fixtures the staleness path still reads are kept.

## Design

### Approach

- Drop `includeSchema` from the observation request and the branch in the observation service that populates the payload's `schema` member.
- Remove the template member from the provider observation view and its published result schema, along with the template and provider-schema shapes if nothing else references them. `readSchemaFingerprint` keeps its own serialization of a template, which is what the staleness path reads.
- Leave `readProviderTemplates` in place only if the fingerprint path shares it; otherwise remove it with its caller.
- Keep `detail` as it is. It still selects whether a record's readable field values are serialized, which is a real distinction on the applications whose fields are not definition-driven.

### Ordering against 0020

This change and [0020](./0020-withdraw-configuration-writes.md) touch disjoint code — 0016 removes a member of the observation payload, 0020 removes the write surface — so neither depends on the other and either order works. What differs is what the schema-fingerprint staleness path means at the time:

- **0016 first.** `readSchemaFingerprint` still exists, and the requirement above binds as written: its coverage must survive untouched, which is exactly the evidence that reconciliation never read the observation payload.
- **0020 first.** `reconcile.ts` and `fingerprints.ts` are already gone, so there is no staleness path and no coverage to preserve. The requirement is discharged with nothing to check, and 0016's first motivating argument — that reconciliation re-reads the schema route itself — is superseded by the stronger fact that nothing reads the catalogue at all.

Neither order makes this change unimplementable, and neither leaves the catalogue published. `arr_config_observe` and the observation service survive 0020 untouched, so the member this change removes is there to remove either way.

### Decisions

- **Decision:** Remove the catalogue outright rather than gating it behind an explicit argument.
  - **Why:** An argument would have to be designed for a consumer that does not exist. The only use is provider creation, which is refused; when creation lands it will need one template for one named implementation, which is a different shape from "the whole catalogue, optionally". Designing that surface now would mean guessing at a contract the implementing change is better placed to state, and shipping a second megabyte-capable path in the meantime.
  - **Alternatives considered:** An opt-in `providerSchema: <implementation>` argument returning one template, deferred to the change that implements creation. Subjecting `schema` to the page bound, rejected because a paged catalogue is still a catalogue nobody reads, and it keeps the second upstream request on every full observation.
- **Decision:** Keep `detail: "full"` rather than collapsing the two levels.
  - **Why:** The levels are indistinguishable *on Prowlarr's Cardigann indexers*, because that provider's values are suppressed wholesale. On a provider whose application named its own fields, `full` is what returns the allowlisted values. Collapsing on the evidence of the one domain where the distinction is invisible would remove a real capability.
- **Decision:** Treat the catalogue's removal as a payload change, not a detail-level change.
  - **Why:** A caller asking for `full` is asking about the records. Nothing about "more detail" implies "and also everything this instance could theoretically be configured as", and it is that conflation which put an unbounded value inside a bounded query.

### Non-Goals

- Implementing provider creation, or designing the scoped template lookup it will need.
- Changing what `detail` means for a record, or which fields the classifier allows out.
- Changing the staleness contract, the schema fingerprint, or when a plan goes stale.
- Reducing any other tool's result size — `select` is [0019](./0019-selected-result-fields.md) and the published listing is [0018](./0018-bounded-tool-listing.md).
- Removing the reconciliation surface that reads the schema route, which is [0020](./0020-withdraw-configuration-writes.md). This change leaves every write path exactly as it finds it.
- Removing the `withheld` count, which is what tells a caller values exist that it did not receive.

## Tasks

- [ ] Pin the bound before removing anything
  - [ ] Add a test asserting that a provider-domain observation carries no template catalogue at any detail level, across every provider domain, and confirm it fails against the unmodified implementation
  - [ ] Add a test asserting a full-detail provider observation issues one upstream request rather than two
- [ ] Remove the catalogue from observation
  - [ ] Drop `includeSchema` from the observation request type and the tool's call site, and remove the population branch in the observation service
  - [ ] Remove the template member from the provider view and from the published configuration result schema, with the template and provider-schema shapes if they become unreferenced
  - [ ] Confirm `readSchemaFingerprint` still compiles against its own template serialization and that the stale-plan suite passes unedited
- [ ] Settle the fixtures and the record
  - [ ] Remove recorded schema-route fixtures that only fed the removed path, keeping those the fingerprint path reads
  - [ ] Amend the Configuration Reconciliation spec's observation and provider-schema sections with a changelog row
  - [ ] Tick these tasks and set the status in this document, `docs/index.yml`, and `docs/index.md`

## Open Questions

- [ ] Should `arr_capabilities` gain a way to say that provider creation is unimplemented *because* no template lookup exists, or is the existing unimplemented-operation count sufficient? The count is already accurate; the question is only whether the reason is worth publishing.

## References

- Spec: [Configuration Reconciliation](../specs/configuration-reconciliation/)
- Related changes: [0008-configuration-reconciliation](./0008-configuration-reconciliation.md)
