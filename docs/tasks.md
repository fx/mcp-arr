# Tasks

Catch-all task list for work not tracked in a specific [change document](changes/).

## Backlog

## Completed

- [x] Observe a provider field whose `value` key is absent — `providerFieldSchema` in `src/adapters/configuration/parse.ts` declared `value: z.unknown()`, which zod 4 treats as a required key where zod 3 treated it as optional, so any record carrying an unset field was refused as `unexpected_response`. That broke `arr_config_observe` for every provider domain against real instances — confirmed live on Prowlarr `applications` and `indexers` and on Sonarr `download_clients`. The key is now optional, an inline regression case pins the shape, and the two recorded provider fixtures that gave an unconfigured credential an explicit value now omit it the way an instance does.
- [x] Report the package version in `serverInfo` instead of a frozen literal — `src/server.ts` hardcoded `version: "0.1.0"`, which release-please never bumps, so the published `0.1.1` advertised `0.1.0`. The version now comes from the shipped `package.json` at runtime, and both the unit test and `scripts/verify-package.mjs` assert the advertised version against the manifest read independently.
