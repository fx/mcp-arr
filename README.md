# mcp-arr

A local MCP server for Sonarr, Radarr, and Prowlarr.

## Requirements

- Node.js 20 or newer
- One or more supported applications with a complete base-URL/API-key pair

## Install

Until a registry package is available, install the executable from a source checkout. Replace `REPOSITORY_URL` with this repository's checkout URL, then build it and install the resulting local package into a dedicated directory:

```sh
git clone REPOSITORY_URL mcp-arr
cd mcp-arr
npm ci
npm run build
cd ..
mkdir mcp-arr-install
cd mcp-arr-install
npm init --yes
npm install ../mcp-arr
```

The server supports MCP over stdio only. Configure the host command using the installed executable's absolute path:

- POSIX: `/absolute/path/to/mcp-arr-install/node_modules/.bin/mcp-arr`
- Windows: `C:\absolute\path\to\mcp-arr-install\node_modules\.bin\mcp-arr.cmd`

Pass instance settings through the command environment. The following host example uses the POSIX command path:

```json
{
  "command": "/absolute/path/to/mcp-arr-install/node_modules/.bin/mcp-arr",
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

Each application is optional, but its URL and API key must be provided together. Configure at least one complete pair. The example hosts use the reserved `.invalid` domain and the keys are placeholders; replace them with values for your instances.

The URL is the instance's own base URL, including any path prefix a reverse proxy adds — `https://media.example/sonarr`, not the API path. The API key is the one under Settings → General in each application. Instance settings are read once at startup, so changing one means restarting the server.

## Verify a connection

Call `arr_capabilities` first. It contacts each configured instance and reports, per application:

- `state` — `available`, `unconfigured`, `unavailable` (configured but not reachable), or `unsupported` (older than the minimum version below)
- `version` — the version the instance reports, when it answered
- `supportedOperations` — the tool calls that work against that instance right now
- `unimplementedOperations` — tool calls this server publishes but has not implemented yet

One unreachable instance never fails the whole report, and an unconfigured application is reported without needing placeholder credentials.

Minimum supported versions are Sonarr 4.0.19.2979 and Radarr 6.3.0.10514 (both API v3) and Prowlarr 2.5.2.5491 (API v1). Newer releases are accepted.

## Implemented surface

All fifteen tools are published with their full input and output schemas, but only some carry behavior yet:

- `arr_capabilities` — reports the above.
- `arr_library_query` — reads Sonarr series, seasons, episodes, episode files, missing and cutoff-unmet episodes; Radarr movies, collections, movie files, missing and cutoff-unmet movies; the calendar and metadata lookup for both. Results are bounded (default 25 records, maximum 100) and a lookup adds nothing.
- `arr_job_get` and `arr_job_cancel` — read and cancel jobs this server projected.

Every other tool validates its arguments and then answers `unsupported_capability`, which `arr_capabilities` lists under `unimplementedOperations`. Prowlarr has no media library, so no `arr_library_query` view is offered for it.

Library records are returned with an opaque `reference`. That reference — not an upstream identifier — is what the views that take a parent (`seasons`, `episodes`, `episode_files`, `movie_files`) and the identifier filter (`media`) accept, so read the parent view first and pass the reference back. References are held in memory, expire after fifteen minutes, and do not survive a restart; a stale one is reported as `stale_reference` and is recovered by repeating the query that produced it.
