# 0025: Job Projection Refresh

## Summary

Refresh a job projection from the upstream command when it is read, and keep a terminal result once it has been seen. Nothing in the server ever refreshes a job today, so `arr_job_get` reports forever whatever status the job held when its reference was minted. The [Tool Contracts spec](../specs/tool-contracts/#job-projection) now states both rules.

**Spec:** [Tool Contracts](../specs/tool-contracts/)
**Status:** complete
**Depends On:** —

## Motivation

Starting an episode search returns a job reference with `status: "queued"`. Ten seconds later the command has finished; ten minutes later `arr_job_get` still answers `queued`:

```
arr_job_get   -> {"status":"queued","cancellable":false,
                  "command":{"name":"EpisodeSearch","upstreamId":"887726"}}
GET /api/v3/command/887726
              -> {"status":"completed","result":"successful",
                  "ended":"2026-08-28T16:10:10Z","duration":"00:00:10.32"}
```

The job store has an `observe` method that normalizes an upstream reading into a record, merges warnings, and captures a terminal snapshot. It is complete and it is dead: no production code calls it. Its only callers are tests, which is why a projection that can never advance passes its own unit suite. `arr_job_get`'s documented contract — normalized status, progress, terminal result, per-item outcomes — is unreachable, and so is [Activity Management](../specs/activity-management/#commands-and-jobs)'s scenario of polling a command for queued, running, terminal, failed, or unknown state.

Probing the three applications established what a refresh can rely on, and one finding directly changes the design:

- All three serve a single-command read — Sonarr and Radarr at `/api/v3/command/{id}`, Prowlarr at `/api/v1/command/{id}` — returning `status`, `result`, `queued`, `started`, `ended`, `duration`, and `stateChangeTime`.
- An unknown or aged-out identifier returns **404** on all three.
- **A finished command's `result` was observed to degrade.** Reading command 887726 shortly after it finished returned `completed / "successful"`. Reading the same identifier later returned `completed / "unknown"` — the status held, the result did not. By then the command had also aged out of the `/command` list, where recent commands still report `completed / "successful"`. The trigger was not established beyond that the two readings are minutes apart and the record aged in between; what is established is that a later reading of the same command can be less definite than an earlier one.

That last point is the trap. A refresh that re-reads on every call and overwrites what it holds would take a job that correctly reported success and silently downgrade it to an indefinite result, purely because the caller polled again later. The spec's no-degradation rule exists because of that observation, not in the abstract.

Polling a real command through its whole life — a manual import, watched from `queued` to `completed / successful` — established one more thing that shapes what this change can promise. The only progress signal any of the three applications offers is a free-text `message`:

```
started   | Processing file 1 of 1
started   | Manually imported 1 files
completed | successful
```

Sonarr sends that field; Radarr and Prowlarr sent no message at all across every command observed. The published projection models progress as a `{completed, total}` pair of integers, and nothing upstream supplies those numbers. So a refresh can report status transitions faithfully and must leave progress absent, rather than parsing counts out of an English sentence that is not a contract.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules (see [Architecture — Testing Contract](../specs/architecture/#testing-contract)). CI enforces these as merge gates:

- Exported behavior MUST have automated tests at the narrowest practical level.
- Adapter tests MUST use sanitized, version-labelled fixtures rather than personal live instances.
- Stdio integration tests MUST verify protocol framing and stdout cleanliness.
- Build, type check, lint, and tests MUST pass without focused or skipped tests.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

Additionally, because the defect is unreachable code rather than wrong code:

- A test MUST assert that reading a non-terminal job issues the upstream read, since the existing unit tests pass while nothing calls the refresh at all.
- A test MUST cover a second read whose upstream answer has lost the result, asserting the observed terminal result survives.
- A test MUST cover a 404 on refresh, asserting the job degrades to unknown rather than the read failing.

### Functional requirements

The [Tool Contracts spec](../specs/tool-contracts/#job-projection) owns job refresh, terminal retention, and safe degradation, and its scenarios are this change's acceptance criteria. What implementing them requires of this change:

- Reading a job that has not reached a terminal state MUST consult the upstream command record for that job's application before answering.
- A job already in a terminal state MUST be answered from the held snapshot without an upstream read.
- A refresh that cannot find the command MUST leave the job resolvable and report it as unknown rather than failing the read.
- A refresh MUST NOT replace an observed terminal status or result with a less definite one.
- Cancellation MUST continue to report its own outcome, and a refresh MUST NOT overwrite an outcome cancellation established.
- A refresh MUST NOT return the upstream command body, its trigger, or any other value outside the published projection.
- Progress MUST be reported only from values an application actually supplies as counts, and MUST remain absent rather than being derived from an application's free-text progress message.

#### Scenario: Poll a job whose command has gone

- **GIVEN** a job reference whose upstream command record no longer exists
- **WHEN** the caller reads that job
- **THEN** the job resolves and reports unknown state, and the read does not fail

## Design

### Approach

- Have the job read consult the upstream command for its application when the held record is not terminal, and feed the reading through the existing observation path rather than a second normalization.
- Treat a 404 as the command being gone, mapping it to unknown state instead of an error.
- Guard the observation so a terminal status and result already held are never replaced by a weaker reading.
- Answer terminal jobs from the snapshot, without an upstream call.
- Answer a refresh that failed from the held projection as well, disclosing what failed as a warning that separates an outage from a refusal.
- Leave the command's free-text message out of the reading a refresh produces.

### Decisions

- **Decision:** Refresh on read rather than polling in the background.
  - **Why:** The server is a local stdio process with no scheduler, and a background poller would keep contacting instances for jobs nobody is watching. Refreshing on read costs one request exactly when the answer is wanted.
  - **Alternatives considered:** A background poller, rejected for the reason above; refreshing at mutation time only, rejected because it leaves the read — the tool whose whole purpose is the current state — still stale.
- **Decision:** Never refresh a terminal job.
  - **Why:** The terminal snapshot is the answer, it cannot improve, and re-reading it is precisely what would degrade a `successful` result to `unknown` once the command ages out. Not asking is what keeps the answer true.
- **Decision:** Keep the observed terminal result even when a later reading is less definite.
  - **Why:** Observed behavior, not a hypothetical: the same Sonarr command reported `successful` and then `unknown` minutes apart. The first reading is the more definite one and the one the caller is entitled to. Holding it also makes the rule independent of why the degradation happens, which is what keeps the fix correct even though the trigger was not pinned down.
  - **Alternatives considered:** Trusting the newest reading, rejected because it makes a job's reported outcome depend on when it was polled.
- **Decision:** Report a completed command whose result is present but indefinite as unknown state, not as a terminal one.
  - **Why:** The no-degradation rule above protects an earlier definite reading. It does nothing when the *first* reading is the indefinite one, and in that case mapping `completed / "unknown"` onto the terminal `completed` publishes `succeeded` — a definite success the application explicitly declined to state, made permanent by the fact that a terminal job is never re-read. A result an application never sends at all is a different answer and still completes, which is what keeps Prowlarr's result-less commands working.
  - **Consequence:** such a job never settles. Every read of it issues an upstream request, and once the command record is trimmed the 404 pins it at unknown, so a caller polling for a terminal state never gets one. That is accepted: an unsettled job reports what this server knows, and a fabricated success does not.
  - **Alternatives considered:** A published job result meaning "ended, verdict unstated", rejected because `jobResults` is a public contract and this change document does not authorize extending it; trusting the state and ignoring the result, rejected as the fabrication described above.
- **Decision:** Map a 404 to unknown rather than to an error.
  - **Why:** [Tool Contracts](../specs/tool-contracts/#job-projection) already requires job state to degrade safely when the upstream command record expires, and all three applications express expiry as 404. A failed read would turn ordinary expiry into an error the caller cannot act on.
- **Decision:** Answer a failed refresh from the held record, but say whether the failure was an outage or a refusal.
  - **Why:** `arr_job_get` is a local-first read: the identity, the status, and the per-item outcomes are already held here, and an operator who rotated an API key mid-job should not lose them to an error. But an outage and a refused credential call for opposite responses — one is worth polling through and the other will never resolve on its own — so a single "could not reach the instance" warning would leave a caller polling a job that can never advance. The warning names which happened.
  - **Alternatives considered:** Raising a refused key as an error, rejected because it destroys a read the caller is entitled to and contradicts the operation's `local_first` declaration; treating every failure as an outage, rejected because it makes a rejected credential indistinguishable from a blip and therefore invisible.
- **Decision:** Do not carry the command's free-text message into the projection on a refresh.
  - **Why:** The same reasoning that keeps counts from being parsed out of prose. A job is refreshed on every read, so a message that changes per poll — "Processing file 1 of 4", then 2, then 3 — would file one line of narration at a time under a channel that means something needs attention, walk the projection's warning cap, and evict the warnings that do. The start path reads the command once and carries its message; that is not licence for a path that reads it repeatedly.
- **Decision:** Use the existing observation path rather than adding a second one.
  - **Why:** It already normalizes status, captures the terminal snapshot, bounds and de-duplicates warnings, and carries per-item outcomes. A parallel path would be a second place for the projection to disagree with itself.

### Non-Goals

- Adding progress reporting beyond what the applications actually report, and in particular deriving counts from a command's free-text message.
- Making job references survive a restart.
- Changing cancellation semantics or the outcomes cancellation distinguishes.
- Refreshing jobs on any call other than a job read.
- Exposing the upstream command body or trigger.

## Tasks

- [x] Refresh a non-terminal job on read
  - [x] Consult the upstream command for the job's application on each of the three applications' command routes, feeding the reading through the existing observation path
  - [x] Answer a terminal job from its snapshot without an upstream read
  - [x] Assert the upstream read happens, since the current tests pass with no caller at all
- [x] Keep a terminal answer once observed
  - [x] Refuse to replace an observed terminal status or result with a less definite reading
  - [x] Settle a job only on a result an application actually stated, so a reading that is indefinite from the start cannot publish a success — while a result no application sends at all still completes
  - [x] Cover a second read whose answer has lost the result, and a read after cancellation established an outcome
- [x] Degrade safely when the command is gone
  - [x] Map a 404 to unknown state and confirm the job stays resolvable
  - [x] Answer every failed refresh from the held projection, while telling a refused API key or a rejected request apart from an outage in the warning it discloses
  - [x] Confirm no command body, trigger, or other unpublished value reaches the caller
- [x] Report progress only where an application supplies counts
  - [x] Populate progress solely from numeric counts an application reports, and leave it absent otherwise
  - [x] Assert that a refresh of a command carrying a free-text progress message — "Processing file 1 of 1" — reports no progress, so counts cannot be parsed out of prose
  - [x] Assert that the message itself does not travel either, so repeated polling of a narrating command cannot fill the projection's warning list with prose

## Open Questions

None.

## References

- Spec: [Tool Contracts](../specs/tool-contracts/)
- Related changes: [0002-tool-runtime](./0002-tool-runtime.md), [0004-activity-diagnostics](./0004-activity-diagnostics.md), [0026-plan-mode-mutation-envelopes](./0026-plan-mode-mutation-envelopes.md)
