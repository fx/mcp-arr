# 0024: Manual Import Request Shape

## Summary

Send the manual-import validation request in the shape both applications accept. The reprocess call wraps its row in a `files` object and sends the scan row unchanged; both applications require a bare array of a flat resource, so every reprocess returns 400. Because execution revalidates through the same call, the entire manual-import surface is unreachable on both applications.

**Spec:** [Acquisition and Import](../specs/acquisition-and-import/)
**Status:** complete
**Depends On:** —

## Motivation

Two of the fourteen tools fail one hundred percent of the time on both Sonarr and Radarr:

- `arr_import_inspect` with `source: "candidate_reprocess"` — `upstream_rejection`
- `arr_import_execute` in both plan and apply mode — `upstream_rejection`

Discovery works. Scanning a queue item or a library context returns candidates with mappings, qualities, and rejections. Only correcting a mapping, and importing anything at all, fail.

Sending the current payload to Sonarr and reading the body it returns identifies the cause exactly:

```
POST /api/v3/manualimport   {"files":[<scan row>]}       -> 400
  "The JSON value could not be converted to
   System.Collections.Generic.List`1[Sonarr.Api.V3.ManualImport.ManualImportReprocessResource]"
```

The endpoint takes the list itself, not an object containing one. Removing the wrapper moves the failure to a second, independent problem:

```
POST /api/v3/manualimport   [<scan row>]                 -> 404
  "Series with ID 0 does not exist"
```

The scan row carries the media as a nested `series` object; the reprocess resource wants a flat `seriesId`. Supplying both corrections succeeds:

```
POST /api/v3/manualimport   [{path, folderName, seriesId, seasonNumber,
                              episodeIds, quality, languages,
                              releaseGroup, downloadId}]  -> 200
```

Radarr behaves identically — `{"files":[…]}` returns 400 naming `Radarr.Api.V3.ManualImport.ManualImportReprocessResource`, and a bare array with a flat `movieId` returns 200. So both defects are shared, and neither is application-specific.

Two findings bound the work and were worth establishing rather than assuming:

- **The import command itself is already correct.** Posting the entry shape the execute path builds — flat `seriesId`, `episodeIds`, `quality`, `languages`, `releaseGroup`, and a numeric `indexerFlags` — to `POST /api/v3/command` as a `ManualImport` returns 201 accepted. Execution fails only because it revalidates through the broken reprocess first. Fixing reprocess fixes both tools.
- **The nested media object in the scan response is correct.** The scan genuinely returns `series` and `movie` objects; only the reprocess *request* wants the flat identifier. The response mapping needs no change.

### The corrected sequence, run end to end

The whole workflow was then executed against Sonarr 4.0.19.2979 in exactly the shapes this change prescribes, resolving a real stuck queue item — one of twenty-one tracked downloads held at "Found matching series via grab history, but release was matched to series by ID. Automatic import is not possible."

| Step | Request | Result |
|---|---|---|
| Scan | `GET manualimport?folder=…&downloadId=…&filterExistingFiles=false` | 200, one row, mapped to series 93 / season 2 / episode 9187, no rejections |
| Reprocess | `POST manualimport` — bare array, named fields, flat `seriesId`, download identity restored | 200, re-decided, no rejections, `downloadId` echoed back |
| Execute | `POST command` — `ManualImport`, `importMode: "auto"`, one file entry | 201, then `completed / successful`, "Manually imported 1 files" |

The target episode went from `hasFile: false` to carrying an episode file whose recorded size matched the scan's byte for byte; the queue fell from 28 items to 27 and the blocked set from 21 to 20; and the instance recorded a `download_folder_imported` history event, which this server's own `arr_activity_query` reads back correctly.

So the prescribed shapes are not inferred from an error message — they are the shapes that actually completed an import. Nothing in the guard path had to be relaxed to get there: the candidate carried no rejections at either stage, and the mapping submitted was the mapping the reprocess validated.

The sequence was then run five more times across distinct episodes. All six succeeded, each reporting `completed / successful` and "Manually imported 1 files", taking the queue from 28 items to 22 and the blocked set from 21 to 15. The shapes are repeatable, not a single lucky case.

### What the rest of the queue exercised

Selecting deliberately varied items surfaced six distinct blocked reasons and, more usefully, three separate causes that all reach the caller looking identical:

| Tracked downloads | The instance's reason | Folder on disk | Scan result |
|---|---|---|---|
| two, different series | matched to series by ID | **gone** | 0 candidates |
| one | "Caution: Found executable file" | present | 0 candidates |
| one | "No files found are eligible for import" | present | 0 candidates |
| one | "Not an upgrade for existing episode file(s)" | present | 1 candidate, **permanent** rejection |

The last confirms the guard works as designed: the candidate is returned with a permanent rejection naming the higher-quality file already in the library, so execution refuses a real downgrade rather than performing it.

The first three do not fare as well. A download whose folder no longer exists, a download the application refuses to scan, and a folder holding nothing importable are three different situations with three different remedies — retry the grab, inspect a suspicious release, remove a bad one — and all three arrive as an empty candidate page. The scan already distinguishes `absent` and `unmapped` refusals for a queue row that has gone or names no location, but a queue row that still exists and still names a folder that does not is not one of those, so it falls through to an ordinary empty result.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules (see [Architecture — Testing Contract](../specs/architecture/#testing-contract)). CI enforces these as merge gates:

- Exported behavior MUST have automated tests at the narrowest practical level.
- Adapter tests MUST use sanitized, version-labelled fixtures rather than personal live instances.
- Stdio integration tests MUST verify protocol framing and stdout cleanliness.
- Build, type check, lint, and tests MUST pass without focused or skipped tests.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

Additionally, because the defect is in a request this project sends rather than in a response it reads:

- Tests MUST assert the shape of the outgoing reprocess body — a bare array whose element carries the flat media identifier — for both applications, since a response fixture alone cannot catch a wrong request.
- A test MUST cover execution reaching the import command after a successful revalidation, so the two tools' shared dependency is exercised rather than assumed.

### Functional requirements

The [Acquisition and Import spec](../specs/acquisition-and-import/#candidate-reprocessing) owns reprocessing and execution behavior and their scenarios — this change's acceptance criteria, not restated here. What implementing them requires of this change:

- The reprocess request MUST be sent as the list the endpoint accepts rather than an object wrapping it.
- Each element MUST carry the media as the flat identifier each application names, derived from the scan row or from the caller's correction.
- The element MUST continue to carry the download identity the scan answer omits, since that is what ties an imported file back to its queue row.
- Corrections MUST keep their current precedence over the instance's own values, so what is validated remains what a caller selected.
- The guards that depend on reprocessing — a blocking rejection, a changed fingerprint — MUST remain effective once the call succeeds, and MUST NOT be weakened to make the path work.
- No filesystem path, download identifier, or other internal value may reach the caller as a result of this change.

#### Scenario: Correct a mapping and import it

- **GIVEN** a candidate discovered from a tracked download
- **WHEN** the caller reprocesses it with an explicit mapping correction and then executes the import
- **THEN** the corrected mapping is validated upstream, the re-decided candidate is returned without importing, and execution submits the import only after that revalidation passes

## Design

### Approach

- Send the reprocess body as the bare list the endpoint accepts.
- Build the element from named fields rather than spreading the scan row, replacing the nested media object with the flat identifier the resource expects.
- Keep the download identity, the correction precedence, and the redaction boundary exactly as they are.
- Add outgoing-request assertions for both applications, and a test that execution reaches the command once revalidation succeeds.

### Decisions

- **Decision:** Build the reprocess element field by field rather than spreading the scan row and patching it.
  - **Why:** Spreading is what carried the nested `series` object into a request that wanted `seriesId`, and it also carries every other field the scan returns into a resource that does not declare them. Naming the fields keeps the request to what the endpoint accepts and keeps a future field from reaching it unreviewed.
  - **Alternatives considered:** Spreading and deleting the nested keys, rejected because it stays open by default and the next added scan field repeats this defect.
- **Decision:** Fix only the reprocess request, not the import command.
  - **Why:** The command shape was verified accepted as it stands. Changing it would be an unverified edit to the one part of this path that is known good.
- **Decision:** Assert the outgoing request, not only the parsed response.
  - **Why:** Every existing test on this path passes while the request is malformed, because the fixtures describe responses. A request defect is invisible to a response fixture, and this is the second such defect on this surface.
- **Decision:** Read the reprocess *answer* as the narrower resource it is, completing the file's own facts from the scan the same call just ran.
  - **Why:** Found once the call succeeded and it could be read at all: the answer restates the decision and says nothing about the file, so it carries no size, no row identifier, no relative path and no existing-file identity, and Sonarr names its media flat where the scan names it nested. Mapping it as though it were a scan row leaves the candidate with no media and no size, which the fingerprint comparison reads as two facts having moved and the free-space check reads as a size it cannot verify — so every import would still be refused, and the change would not have restored anything. The scan is re-run inside this same call, milliseconds earlier and against the same folder, so it is both the freshest thing the instance says about the file and the only thing that says it.
  - **Alternatives considered:** Comparing fewer retained facts, rejected because that is the guard this change is required not to weaken.
- **Decision:** Treat this as a defect fix rather than a contract change.
  - **Why:** Both tools have never succeeded against a real instance, so no caller can depend on current behavior.

### Non-Goals

- Changing what the scan returns or how candidates are mapped.
- Changing the import command's own shape, name, or allowlisting.
- Relaxing any import guard, rejection check, or fingerprint comparison.
- Accepting a filesystem path anywhere on this surface.

## Tasks

- [x] Send the reprocess request in the accepted shape
  - [x] Send the body as the bare list the endpoint accepts on both applications
  - [x] Build each element from named fields, carrying the flat media identifier, the download identity, and the caller's corrections in their current precedence
  - [x] Add tests asserting the outgoing body for both applications, confirming they fail against the wrapped, nested form
- [x] Restore manual import end to end
  - [x] Confirm reprocessing returns a re-decided candidate and imports nothing
  - [x] Confirm execution revalidates and then submits the import command, and still stops on a blocking rejection or a changed fingerprint
  - [x] Confirm no path, download identifier, or other internal value appears in either tool's result

## Open Questions

- Should an empty candidate scan distinguish its causes? Three situations with three different remedies — the download's folder no longer exists, the application refuses to scan it, and the folder holds nothing importable — are currently indistinguishable to a caller, which leaves it with no way to choose between retrying a grab, inspecting a suspicious release, and removing a bad one. This was found while verifying the change and is **not** part of it; closing it would mean deciding what the adapter may infer about a folder it deliberately never discloses, which is a contract question rather than a defect. It needs its own change document if it is worth doing.

## References

- Spec: [Acquisition and Import](../specs/acquisition-and-import/)
- Related changes: [0007-manual-import](./0007-manual-import.md), [0021-live-verified-fixtures](./0021-live-verified-fixtures.md)
