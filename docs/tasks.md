# Tasks

Catch-all task list for work not tracked in a specific [change document](changes/).

## Backlog

Both entries come from change [0021](changes/0021-live-verified-fixtures.md)'s
sweep, which recorded them in its [Findings](changes/0021-live-verified-fixtures.md#findings)
and left them alone: correcting a fixture is that change's work, and changing an
adapter because a corrected fixture revealed something is not. Each needs its own
change document before it is implemented.

- [ ] Report an already-held file from what the instance actually says — `src/adapters/import/candidates.ts` decides `existingLibraryFile` from `episodeFileId`/`movieFileId` on a manual-import row, and neither Sonarr 4.0.19.2979 nor Radarr 6.3.0.10514 sends either field, so the `existing_file` refusal is unreachable against a real instance. Sonarr says it in a rejection instead — "Episode file already imported at this quality". Both tests covering the refusal supply the identifier themselves, so the guard is held to its behavior while the fixtures stay truthful.
- [ ] Give a Prowlarr history record a title and a download identity, or stop declaring them — `src/adapters/activity/prowlarr.ts` maps `title` from `sourceTitle` and `downloadIdentity` from `downloadId`, and a Prowlarr 2.5.2.5491 history row carries neither, so both are absent from every mapped record. Whether the answer is another source for them or a narrower model is the change's to decide.

## Completed

- [x] Observe a provider field whose `value` key is absent — `providerFieldSchema` in `src/adapters/configuration/parse.ts` declared `value: z.unknown()`, which zod 4 treats as a required key where zod 3 treated it as optional, so any record carrying an unset field was refused as `unexpected_response`. That broke `arr_config_observe` for every provider domain against real instances — confirmed live on Prowlarr `applications` and `indexers` and on Sonarr `download_clients`. The key is now optional, an inline regression case pins the shape, and the two recorded provider fixtures now carry the absent-`value` shape on the fields an instance genuinely omits — Prowlarr's `authUsername` and `authPassword`, Sonarr's `additionalParameters` — while keeping the masked and empty-string `apiKey` values those instances always send.
- [x] Report the package version in `serverInfo` instead of a frozen literal — `src/server.ts` hardcoded `version: "0.1.0"`, which release-please never bumps, so the published `0.1.1` advertised `0.1.0`. The version now comes from the shipped `package.json` at runtime, and both the unit test and `scripts/verify-package.mjs` assert the advertised version against the manifest read independently.
