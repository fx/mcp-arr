# PR Review

## Task Cross-Reference

Cross-reference every PR against task lists in `docs/changes/` and `docs/tasks.md`. If the PR completes work tracked in those files, the task checkboxes MUST be updated in this same PR. Request changes if missing.

## Fixtures Are Referenced By Route, Never By File Name

A test never names a fixture file. It calls `activityFixture(application, route)` or `fixtureBody(application, route)` with the **upstream route** — `"config/downloadclient"`, `"history/series"` — and `fixturePathFor` in `test/support/fixtures.ts` resolves that to the recorded path. The file name therefore appears in exactly two places for every fixture in the repository: the approved inventory in `test/fixture-contract.test.ts` and the file itself.

Grepping for a fixture's **file name** and finding only the inventory is therefore not evidence that the fixture is unused, and reporting one as dead scaffolding on that basis is a false positive. To check whether a fixture is read, grep for its **route string**, or delete it and run the suite: a fixture that is genuinely read fails its `beforeAll` with `ENOENT`.

## Retained Reference Fields: Null and Undefined Are Both Absent

`storedWord` and `storedId` in `src/tools/activity-references.ts` deliberately classify both `undefined` and `null` as **absent** rather than as corrupt, and every resolver that reads a retained field relies on that. Absence is a legitimate answer for an optional retained field — a pending release has no tracked state, a Prowlarr history record has no media association — while a value of the wrong type or range is `invalid` and is refused. Asking for `null` to be rejected as corruption is a false positive: references live only in process memory and are never serialized, so `null` cannot arrive from outside, and the two helpers must keep answering alike or the queue and history resolvers drift apart.
## Queue Delete Flags Are Sent Explicitly

`src/adapters/activity/transitions.ts` sends all four queue-delete query flags — `removeFromClient`, `blocklist`, `skipRedownload`, `changeCategory` — on every compiled transition, including the ones whose value is `false`. This is deliberate and MUST NOT be "fixed" by omitting the false ones.

`removeFromClient` defaults to **true** upstream on both Sonarr and Radarr, so a request that omitted it would ask the download client to delete the download and its payload. For `ignore_tracking`, whose whole promise is that the download and its data stay where they are, that would be the opposite of the requested effect and a false disclosure.

The Activity Management spec's requirement that `ignore_tracking` be "compiled without removal, blocklist, or category-change flags" is a requirement about the effects requested, not about which query parameters appear in the URL. Reporting an explicit `flag=false` as a violation of it is a false positive.

## Read-Set Fingerprints Cover What a Plan Discloses

A mutation's read set observes what its plan **disclosed**, which is not the same as what its request **sends**. A plan that names a record in a disclosed effect — "add “X” to the library", "move the files of “X”" — fingerprints that name, so applying the plan cannot act on a record that has since become a different one than the plan described, even though the name is not part of the payload. Reporting such an observation as unrelated to the mutation, on the grounds that the value is not sent upstream, is a false positive.

The converse is a real finding and is worth reporting: a read set that observes something the plan neither disclosed nor depends on makes a valid plan expire for an unrelated reason, and that is a defect.
## A Secret Field's Name Is Published; Its Value and a Withheld Field's Name Are Not

The configuration adapter draws the line at values, not at names of credentials. `ConfiguredSecret.name` in `src/adapters/configuration/model.ts` carries the upstream field name — including one a Prowlarr Cardigann definition chose — and `serializeProvider` reports those names for every provider, dynamically defined ones included. `SecretDisposition.name` in `src/adapters/configuration/write.ts` does the same for a diff, because saying which credentials a full-resource write preserved is the promise that write has to make.

What is deliberately withheld is different and is enforced elsewhere: a secret's **value** never leaves, and the names of **withheld** fields are reported only as `WithheldFields.count`. Asking for a secret field's name to be redacted, counted, or restricted to a static list is a false positive — it would make the diff disagree with an observation of the same record, and it closes nothing, since any caller that can plan a reconciliation can already call `arr_config_observe`.

## Zod 4 Schema Conventions

This repository pins zod 4 (see `zod` in `package.json`). In zod 4 the custom-message key for `.refine`, `.check`, and the schema factories is `error`; `message` is the legacy zod 3 alias. Both produce the custom message — verified against the pinned version — so `{ error: ... }` is correct and the message is not lost or ignored. Reporting `error` as a mistake, or asking for it to be changed to `message`, is a false positive.
