# Tasks

Catch-all task list for work not tracked in a specific [change document](changes/).

## Backlog

## Completed

- [x] Report the package version in `serverInfo` instead of a frozen literal — `src/server.ts` hardcoded `version: "0.1.0"`, which release-please never bumps, so the published `0.1.1` advertised `0.1.0`. The version now comes from the shipped `package.json` at runtime, and both the unit test and `scripts/verify-package.mjs` assert the advertised version against the manifest read independently.
