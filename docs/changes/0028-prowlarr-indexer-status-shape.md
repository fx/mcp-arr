# 0028: Prowlarr Indexer Status Shape

## Summary

Stop refusing every Prowlarr indexer-status read because the adapter requires a member Prowlarr does not send. `indexerStatusSchema` in `src/adapters/activity/prowlarr.ts` declares a required `id` that no result reads and that Prowlarr 2.5.2.5491 never returns, so `arr_activity_query` with `view: indexer_status` fails with `unexpected_response` against a real instance. The recorded fixture carried the field and hid it. The [Architecture spec](../specs/architecture/#upstream-connection-handling) now states that an upstream payload must not be required to carry a member no result reads.

**Spec:** [Architecture](../specs/architecture/)
**Status:** complete
**Depends On:** —

## Motivation

`arr_activity_query` with `view: indexer_status` fails one hundred percent of the time. Reading `GET /api/v1/indexerstatus` from Prowlarr 2.5.2.5491 returns 200 with one row, whose members are exactly:

```
indexerId, disabledTill, mostRecentFailure, initialFailure
```

The adapter declares five, and the extra one is required:

```ts
const indexerStatusSchema = z.object({
  id: upstreamId,               // required; the instance sends no such member
  indexerId: optionalUpstreamId,
  disabledTill: upstreamText,
  initialFailure: upstreamText,
  mostRecentFailure: upstreamText,
});
```

`readIndexerStatus` parses the body through `z.array(indexerStatusSchema)`, and `parseActivity` in `src/adapters/activity/parse.ts` throws on any failure rather than dropping the offending row, so one absent member destroys the whole view.

Nothing reads it. The mapper builds an `IndexerStatus` from `indexerId`, `disabledTill`, `initialFailure`, and `mostRecentFailure`; `id` appears nowhere else in the source, and `IndexerStatus` has no field it could occupy. The same is true of `escalationLevel`, Prowlarr's backoff counter, which the recorded body also carried and which this schema never declared at all — an unknown member, dropped.

The recorded fixture is what hid it. `test/fixtures/prowlarr/v1/2.5.2.5491/indexerstatus.json` recorded `id` and `escalationLevel` on every row, so the fixture-backed test confirmed the adapter against the adapter's own assumption. That is precisely what the [Architecture spec's fixture-fidelity rule](../specs/architecture/#testing-contract) forbids: a recorded fixture "MUST correspond to a response the application it names genuinely produces at the version and route it names". This one did not, and a required member the instance never sends is the exact failure that rule exists to catch.

The divergence between two declarations of the same concept is the other half of the evidence, and it points the same way. `src/adapters/acquisition/prowlarr.ts` reads the same route to learn which indexers the instance has disabled, declares only the two members it reads — `indexerId` and `disabledTill` — and works correctly against the live instance. One adapter declared what it uses; the other declared more, and only the second one broke. Correcting the fixture reproduces exactly that split: the activity test fails with `unexpected_response` and the acquisition tests stay green.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules (see [Architecture — Testing Contract](../specs/architecture/#testing-contract)). CI enforces these as merge gates:

- Exported behavior MUST have automated tests at the narrowest practical level.
- Adapter tests MUST use sanitized, version-labelled fixtures rather than personal live instances.
- Stdio integration tests MUST verify protocol framing and stdout cleanliness.
- Build, type check, lint, and tests MUST pass without focused or skipped tests.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

Additionally, because the defect is a refused result rather than a wrong value:

- The Prowlarr indexer-status fixture MUST carry the member set its instance sends, so a test fails if a member the instance never sends is required again. Correcting it is this change's own work, not [0021](./0021-live-verified-fixtures.md)'s: it is the red test the adapter fix turns green, and the two MUST land together so the gate holds at every commit.
- A test MUST assert that a row carrying members nothing reads is still read, so the fix is a tolerance rather than a second exact member set that the next version breaks.
- A test MUST assert that the tolerance did not spread to the identity the result is built from.

### Functional requirements

The [Architecture spec](../specs/architecture/#upstream-connection-handling) owns the rule that an upstream payload must not be required to carry a member no result reads, and its scenario is this change's acceptance criterion. Activity Management owns the existence of the indexer-status view, and that requirement is met — the view is declared, routed, and published correctly. What is broken is the adapter's contract with upstream, which Architecture owns, so this change is attached there. What implementing it requires:

- The indexer-status schema MUST NOT require a member the mapped result does not read.
- A row carrying members the mapper does not read MUST be read as well as one that omits them, and no such member may reach the result.
- The tolerance MUST NOT extend to what the result genuinely depends on: a row whose indexer identity is not a whole number MUST still be refused.
- The recorded fixture MUST record the member set Prowlarr 2.5.2.5491 sends on this route.

#### Scenario: A live indexer-status body reaches the adapter

- **GIVEN** Prowlarr returns indexer-status rows carrying only the indexer, the two failure instants, and the disabled-until instant
- **WHEN** the indexer-status view is queried
- **THEN** every row is returned with its indexer reference and instants intact, and none is refused

## Design

### Approach

- Declare the indexer-status schema as exactly the four members the mapper reads, dropping the required `id` rather than making it optional.
- Recapture the fixture so its rows carry the member set the instance sends and neither of the two it does not.
- Add a case for a row that carries the unread members anyway, asserting it is read and that neither member reaches the result.
- Add a case that pins the boundary: a row whose `indexerId` is not a whole number is still refused.

### Decisions

- **Decision:** Remove `id` from the declaration rather than declaring it optional.
  - **Why:** An optional declaration of an unread member still validates it, so a version that sent `"6"` where this expects `6` would refuse the row again — a refusal earned for a value that has no effect on any result. Declaring only what the mapper reads is also the idiom this file already states for `hosts`, `userAgents`, and `escalationLevel`: the schema does not declare them, unknown members are dropped, and the model has no field they could occupy. It is what the acquisition adapter's declaration of this same route already does.
  - **Alternatives considered:** `id: optionalUpstreamId`, rejected for the reason above; keeping the member and making `parseActivity` drop failing rows instead of throwing, rejected because it would silently discard rows across every activity payload to fix one over-declaration, and a genuinely unusable row should still be visible as a failure.
- **Decision:** Leave `indexerId` nullish and keep the zero fallback.
  - **Why:** `indexerRef` documents zero as upstream's own "no indexer", and a row that names no indexer is still a row a caller can see. Tightening it to required would be a second behavior change in the opposite direction, unmotivated by any observed body — every live row carries it.
  - **Alternatives considered:** Requiring `indexerId` to match the acquisition adapter's declaration, rejected because that adapter maps the value into a lookup key while this one maps it into a reference that tolerates absence by design.
- **Decision:** Record two rows in the fixture, though the live body carried one.
  - **Why:** The rule the fixture broke is about the member set a body carries, and both recorded rows now carry exactly the live one. The identifiers and instants stay sanitized and stay as they were, because they are the values the sibling `indexer.json` fixture and the aggregate-search tests are built around — the live row's indexer is not in that sanitized indexer set, and the live `disabledTill` is hours in the future, which would make a recorded fixture change meaning as the clock passed it.
  - **Alternatives considered:** Recording the single live row with its live identifier and instants, rejected for the reason above: it would trade a real fidelity gain in the member set for an incoherent fixture family, a fixture that expires, and the loss of the blocked-indexer coverage the aggregate search depends on.

### Non-Goals

- Changing what the indexer-status view returns, or adding `escalationLevel` to it.
- Changing the acquisition adapter's read of the same route, which is already correct.
- Changing how `parseActivity` reports an unusable payload.
- Repairing any fixture other than the Prowlarr indexer-status one, or adding the capture procedure — that is [0021](./0021-live-verified-fixtures.md). 0021 requires every adapter change its sweep turns up to become one of its own prerequisites; recording that edge is 0021's edit to make in its own change, not this one's.

## Tasks

- [x] Declare the indexer-status schema as what the result reads
  - [x] Drop the required `id`, which no result reads and no instance sends, and state in the declaration why nothing unread is declared there again
  - [x] Confirm a row carrying `id` and `escalationLevel` is still read and that neither member reaches the result
  - [x] Assert that the tolerance does not spread: a row whose `indexerId` is not a whole number is still refused
- [x] Correct the recorded fixture to the member set the instance sends
  - [x] Recapture `GET /api/v1/indexerstatus` from Prowlarr 2.5.2.5491 and record the member set it returns
  - [x] Confirm the corrected fixture fails against the current declaration before the fix lands, and that the acquisition adapter's read of the same route stays green
  - [x] Update the assertion and the comment written against the members the old recording carried

## Class Check

The defect is one over-declared member, and the question worth answering before closing is whether it is one site or a class. Every upstream schema in `src/adapters/` was compared against the mapper that consumes it — the registry, both acquisition adapters, the shared activity payloads, the media activity payloads, the three library modules, the configuration parser, and the import candidates. This was the only site: everywhere else, every required member is read. The queue-status payload is the clearest case in the other direction, since its mapper spreads the parsed record whole, so each of its seven required members is by construction consumed.

The two closest neighbours are worth naming, because both are the same concept declared elsewhere and both were already correct. `src/adapters/acquisition/prowlarr.ts` reads this very route and declares `indexerId` and `disabledTill` and nothing else. `blocklistRecordSchema` in `src/adapters/activity/media.ts` is deliberately exported and shared, so the mutation that re-reads a blocked release cannot drift from the query that listed it.

## Open Questions

None.

## References

- Spec: [Architecture](../specs/architecture/)
- Related changes: [0004-activity-diagnostics](./0004-activity-diagnostics.md), [0021-live-verified-fixtures](./0021-live-verified-fixtures.md), [0022-upstream-field-shape-tolerance](./0022-upstream-field-shape-tolerance.md)
