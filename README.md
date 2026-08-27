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

The report is bounded by default: what an instance can do is listed, and what it cannot do is counted. Pass `detail: "full"` to get `unimplementedOperations` and `unsupportedOperations` enumerated as well — several times the payload, and none of it callable, so ask for it only when you want to know what is coming.

One unreachable instance never fails the whole report, and an unconfigured application is reported without needing placeholder credentials.

Minimum supported versions are Sonarr 4.0.19.2979 and Radarr 6.3.0.10514 (both API v3) and Prowlarr 2.5.2.5491 (API v1). Newer releases are accepted.

## Implemented surface

All fifteen tools are published with their full output schemas, and each publishes every argument it accepts as a property of one object schema, with each variant's own required and optional arguments described in that schema's documentation. Only some carry behavior yet:

- `arr_capabilities` — reports the above.
- `arr_library_query` — reads Sonarr series, seasons, episodes, episode files, missing and cutoff-unmet episodes; Radarr movies, collections, movie files, missing and cutoff-unmet movies; the calendar and metadata lookup for both. Results are bounded (default 25 records, maximum 100) and a lookup adds nothing.
- `arr_job_get` and `arr_job_cancel` — read and cancel jobs this server projected.

Every other tool validates its arguments and then answers `unsupported_capability`, which `arr_capabilities` counts under `unimplementedOperationCount` and lists at `detail: "full"`. Prowlarr has no media library, so no `arr_library_query` view is offered for it.

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
