# mcp-arr

A local MCP server for Sonarr, Radarr, and Prowlarr.

## Requirements

- Node.js 20 or newer
- One or more supported applications with a complete base-URL/API-key pair

There is nothing to clone, install, or build. `npx` downloads the published package on first use and runs its executable.

## Configure your host

The server supports MCP over stdio only. Point the host at `npx` and let it launch the published package:

```json
{
  "command": "npx",
  "args": ["-y", "mcp-arr"],
  "env": {
    "SONARR_URL": "https://sonarr.example.invalid/sonarr",
    "SONARR_API_KEY": "replace-with-sonarr-api-key",
    "RADARR_URL": "https://radarr.example.invalid/radarr",
    "RADARR_API_KEY": "replace-with-radarr-api-key",
    "PROWLARR_URL": "https://prowlarr.example.invalid/prowlarr",
    "PROWLARR_API_KEY": "replace-with-prowlarr-api-key"
  }
}
```

The package name and its executable are both `mcp-arr`, so `npx -y mcp-arr` resolves the package and runs the server directly. `-y` accepts npx's install prompt up front, which a host launching the server non-interactively cannot answer.

On Windows, a host that spawns the command without a shell needs `npx.cmd` rather than `npx`, or `"command": "cmd"` with `"args": ["/c", "npx", "-y", "mcp-arr"]`.

To run the same command yourself — to check the server starts before wiring up a host — export the instance variables and run:

```sh
npx -y mcp-arr
```

It waits for MCP traffic on stdin and writes nothing to stdout until a client speaks to it. Stop it with Ctrl-C.

## Instance settings

Pass instance settings through the command environment. Each application is optional, but its URL and API key must be provided together. Configure at least one complete pair. The example hosts above use the reserved `.invalid` domain and the keys are placeholders; replace them with values for your instances.

The URL is the instance's own base URL, including any path prefix a reverse proxy adds — `https://media.example/sonarr`, not the API path. The API key is the one under Settings → General in each application. Instance settings are read once at startup, so changing one means restarting the server.

## Verify a connection

Call `arr_capabilities` first. It contacts each configured instance and reports, per application:

- `state` — `available`, `unconfigured`, `unavailable` (configured but not reachable), or `unsupported` (older than the minimum version below)
- `version` — the version the instance reports, when it answered
- `supportedOperations` — the tool calls that work against that instance right now
- `unimplementedOperationCount` — how many tool calls this server publishes but has not implemented yet
- `unsupportedOperationCount` — how many would need a newer release of that application

The report is bounded by default: what an instance can do is listed, and what it cannot do is counted. Pass `detail: "full"` to get `unimplementedOperations` and `unsupportedOperations` enumerated as well — none of it callable, so ask for it only when you want to know what is coming. Both counts are currently zero on a supported release: every published tool call carries behavior.

One unreachable instance never fails the whole report, and an unconfigured application is reported without needing placeholder credentials.

Minimum supported versions are Sonarr 4.0.19.2979 and Radarr 6.3.0.10514 (both API v3) and Prowlarr 2.5.2.5491 (API v1). Newer releases are accepted.

## Implemented surface

All fourteen tools publish every argument they accept as a property of one object schema, with each variant's own required and optional arguments described in that schema's documentation. Output schemas are published broadened — the result envelope's four top-level keys and where each application's payload sits, and nothing below that — because the same envelope repeated once per tool was most of a listing every session pays for before making a call. What a payload contains is published instead as dot-paths generated from the schema the envelope is validated against, carried in that schema's own documentation; that is where to look up the fields a view returns.

Those same paths are what the five collection queries take as an optional `projection`. Name the fields you will actually read and the result carries only those — a page of twenty-five movies asked for a title, a year, and a reference is a fraction of the same page in full. An array contributes no path segment, so one path names that field on every record. The envelope, each application's own outcome, and the field that says which payload it is are always returned, the record counts still describe what the query matched rather than what the projection kept, and a path that matches nothing warns and names the paths that were available instead of failing the call.

- `arr_capabilities` — reports the above.
- `arr_library_query` — reads Sonarr series, seasons, episodes, episode files, missing and cutoff-unmet episodes; Radarr movies, collections, movie files, missing and cutoff-unmet movies; the calendar and metadata lookup for both. Results are bounded (default 25 records, maximum 100) and a lookup adds nothing.
- `arr_activity_query` — reads queue status, queue records and details, history, blocklist, health, command activity, disk conditions, and Prowlarr indexer status or sanitized statistics.
- `arr_release_search` — runs an interactive release search for a Sonarr episode or season, a Radarr movie, or across Prowlarr indexers, returning opaque release references instead of protected download URLs.
- `arr_import_inspect` — discovers manual-import candidates from a tracked queue reference or a library context, and reprocesses one with explicit mapping corrections.
- `arr_config_observe` — reads sanitized current configuration for providers, profiles, formats, tags, roots, remote path mappings, lists, and exclusions. Secret fields are reported as configured or unconfigured, never by value. Configuration is read-only: no tool writes it.
- `arr_job_get` and `arr_job_cancel` — read and cancel jobs this server projected.
- `arr_search_start` — starts a supported automatic search and returns a job reference.
- `arr_release_grab` — grabs releases a previous search returned, by reference only.
- `arr_queue_resolve` — applies a typed queue transition, each compiling to one exact upstream flag combination.
- `arr_activity_change` — marks a history record failed or removes a blocklist record.
- `arr_import_execute` — imports validated manual-import candidates with an explicit import mode.
- `arr_library_change` — adds media from a lookup result, sets monitoring, edits typed metadata, deletes records, updates or deletes media files, renames, or moves.

Every mutation tool accepts `mode: "plan"` and `mode: "apply"`. Prowlarr has no media library, so no `arr_library_query` view is offered for it.

Library records are returned with an opaque `reference`. That reference — not an upstream identifier — is what the views that take a parent (`seasons`, `episodes`, `episode_files`, `movie_files`) and the identifier filter (`media`) accept, so read the parent view first and pass the reference back. References are held in memory, expire after fifteen minutes, and do not survive a restart; a stale one is reported as `stale_reference` and is recovered by repeating the query that produced it.

## Development

This section is for working on the server itself. Running it does not require any of it.

Clone the repository, install dependencies, and build:

```sh
git clone https://github.com/fx/mcp-arr.git
cd mcp-arr
npm ci
npm run build
```

Run the local build with the same instance variables a host would pass:

```sh
npm start
```

`npm run check` runs the full gate — type check, lint, build, tests, and package verification. The package verifier packs the tarball, installs it into a throwaway consumer, and drives the installed executable over stdio, so it catches packaging regressions the unit tests cannot.

To point a host at a checkout instead of the published package, install the built package into a dedicated directory and use the installed executable's absolute path:

```sh
mkdir ../mcp-arr-install
cd ../mcp-arr-install
npm init --yes
npm install ../mcp-arr
```

- POSIX: `/absolute/path/to/mcp-arr-install/node_modules/.bin/mcp-arr`
- Windows: `C:\absolute\path\to\mcp-arr-install\node_modules\.bin\mcp-arr.cmd`

### Recording upstream fixtures

The adapter tests read recorded upstream responses from `test/fixtures`, stored per application, per API version, per exact instance version. Every one of them must be a response the application it names genuinely returns at the route it names — a body written to the shape an adapter expects instead confirms that adapter against its own assumption, and the suite stays green while the server is broken against a real instance.

So a fixture is **refreshed, not authored**:

```sh
npm run build
node scripts/capture-fixture.mjs --application sonarr --route manualimport \
  --query folder=/downloads/complete/example
npx biome check --write test/fixtures
```

The capture reads one route from the instance the usual environment variables name, sanitizes what it read, and writes the fixture the inventory approves for that route. Running the test suite never does any of this: the suite needs no instance, no network, and no credentials, and the capture is deliberately outside it.

It refuses rather than writing whenever it cannot stand behind what it read:

- the route is not one the inventory approves for that application;
- the instance is not the version the recorded fixtures name;
- the application answers the route with `404`, or with its web interface instead of JSON — which is what an unrecognized API path is served, with a `200`;
- the sanitized body still trips one of the fixture screens.

Sanitizing drops any key the screens name as secret-bearing or identifying, and replaces any other text they refuse — a URL, an address, a home or host path, whether it arrived as a value or as a key — with a neutral stand-in of the same kind, so the shape survives and the text does not. If a capture is still refused, neutralize what the message names. Never weaken a screen to accommodate what an instance sent.

A route's records can only be verified against an instance that holds records of that kind: an instance with no tags, import lists, notifications, import-list exclusions or pending renames answers those routes with an empty collection, and a usenet-only indexer set never produces a torrent release. Such a fixture's envelope is recorded from the instance while its records are not, and it stays that way until an instance holds the data. That is a limit of the capture, not a licence to invent a record: a recorded body must still describe a response the application produces.
