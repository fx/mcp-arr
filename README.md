# mcp-arr

An MCP server for Sonarr, Radarr, and Prowlarr, launched locally over stdio or run as a remote service over Streamable HTTP.

## Requirements

- Node.js 20 or newer
- One or more supported applications with a complete base-URL/API-key pair

There is nothing to clone, install, or build. `npx` downloads the published package on first use and runs its executable.

## Configure your host

By default the server speaks MCP over stdio, launched by the host. Point the host at `npx` and let it launch the published package:

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

To run the server once, as a service that MCP clients reach over the network, see [Run as a remote service](#run-as-a-remote-service).

## Instance settings

Pass instance settings through the command environment. Each application is optional, but its URL and API key must be provided together. Configure at least one complete pair. The example hosts above use the reserved `.invalid` domain and the keys are placeholders; replace them with values for your instances.

The URL is the instance's own base URL, including any path prefix a reverse proxy adds — `https://media.example/sonarr`, not the API path. The API key is the one under Settings → General in each application. Instance settings are read once at startup, so changing one means restarting the server.

## Request timeout

`ARR_UPSTREAM_TIMEOUT_MS` sets how long the server waits for any one request to an instance. It is optional, its unit is whole milliseconds, and it defaults to `30000` — thirty seconds. Accepted values run from `1` to `600000`, and anything else — a fraction, a suffix, a value out of range — fails startup with a message naming the variable but never the value you set.

Raise it if a large library or a slow indexer needs longer: a whole-library read or a season release search can take well over the default on a big instance. Like the instance settings, it is read once at startup, so changing it means restarting the server. It belongs in the same `env` block as the instance settings above:

```json
{
  "env": {
    "ARR_UPSTREAM_TIMEOUT_MS": "60000"
  }
}
```

## Run as a remote service

Over stdio, every host that launches the server holds every instance URL and API key. Run it as a service instead and only the server holds them: a client gets a URL and a bearer token, and the token authorizes this server's tools and nothing else. It is not an instance API key and cannot be turned into one.

Select the HTTP transport and give it a token, alongside the instance settings above:

```sh
export ARR_MCP_TRANSPORT=http
export ARR_MCP_AUTH_TOKEN="$(openssl rand -hex 32)"
npx -y mcp-arr
```

On startup it writes one line to stderr naming where it listens, and serves:

- `POST /mcp` — MCP over Streamable HTTP. Every request must carry `Authorization: Bearer <token>`.
- `GET /healthz` — `200` while the process accepts requests. It needs no token, contacts no instance, and names nothing about the deployment, so it is safe for an orchestrator's liveness probe.

Everything else is `404`, OAuth discovery paths included: there is no OAuth here, only the one token.

| Variable | Meaning | Default |
|---|---|---|
| `ARR_MCP_TRANSPORT` | `stdio` or `http` | `stdio` |
| `ARR_MCP_HTTP_HOST` | The IP address the listener binds to; `0.0.0.0` for every IPv4 interface, as inside a container | `127.0.0.1` |
| `ARR_MCP_HTTP_PORT` | The TCP port the listener binds to, from `1` to `65535` | `9797` |
| `ARR_MCP_AUTH_TOKEN` | The bearer token: 32 to 4096 letters, digits, and `-._~+/`, optionally ending in `=` | none; required |

Like every other setting, these are read once at startup. A missing or unusable value fails startup with a message that names the variable but never its value, and so does setting the host, port, or token without selecting `http`, so a deployment that forgot the selection never starts a stdio server nobody intended.

Point a client at the URL and give it the header. Most clients take something of this shape; check your client's documentation for its exact keys:

```json
{
  "type": "http",
  "url": "https://mcp.example.com/mcp",
  "headers": {
    "Authorization": "Bearer replace-with-your-token"
  }
}
```

Every answer is a single JSON body and the server keeps no session, so a client can reconnect at any time. Clients running inside a web browser are not supported: any request that carries an `Origin` header is refused.

Before exposing it:

- **TLS is the deployment's job.** The listener speaks plain HTTP. Anything reachable from another machine belongs behind a TLS-terminating reverse proxy, or the token crosses the network in clear text.
- **Run exactly one process.** Plans, references, receipts, and jobs live in process memory, so two processes behind one URL reject each other's references — and so does a rolling deploy that briefly runs two. Stop the old process before starting the new one.
- **Rotate the token by restarting.** There is one token and no revocation list: change `ARR_MCP_AUTH_TOKEN`, restart, and give clients the new one.
- **Throttling is per proxy.** After 10 refused authentication attempts in a minute, an address is answered `429` until the minute is up. The address is the connection's peer, and forwarded headers are not trusted, so every client behind one reverse proxy shares one throttle. A long random token is the real defense against guessing; limit per client at the proxy if you need to.

On `SIGTERM` or `SIGINT` the server stops accepting connections, lets requests already in progress finish for no longer than the request timeout above, and exits.

## Run with Docker

A container image of the same published package is at `ghcr.io/fx/mcp-arr`:

| Tag | What it is |
|---|---|
| `latest`, `X.Y.Z`, `X.Y` | A release, published when its npm package is |
| `main`, `sha-<commit>` | A development build of the default branch; never a release |

The image runs the remote service above: it selects the HTTP transport and listens on `0.0.0.0:9797`. It holds no token and no instance, so give it both, exactly as the sections above describe:

```sh
export SONARR_API_KEY=replace-with-your-api-key
export ARR_MCP_AUTH_TOKEN="$(openssl rand -hex 32)"
docker run -d --name mcp-arr \
  -p 127.0.0.1:9797:9797 \
  -e SONARR_URL=https://sonarr.example.invalid \
  -e SONARR_API_KEY \
  -e ARR_MCP_AUTH_TOKEN \
  ghcr.io/fx/mcp-arr:latest
```

`-e NAME` with no value passes the variable through from your shell, so the API key and the token stay off the command line and the token is still there to give your clients. The port is published on the host's loopback only, for a reverse proxy on the same host; see the list below before publishing it anywhere else. Without `ARR_MCP_AUTH_TOKEN` and at least one instance pair the container exits at once with a message naming what is missing. Or with Compose, reading the values from the environment it runs in:

```yaml
services:
  mcp-arr:
    image: ghcr.io/fx/mcp-arr:latest
    restart: unless-stopped
    ports:
      - "127.0.0.1:9797:9797"
    environment:
      SONARR_URL: https://sonarr.example.invalid
      SONARR_API_KEY: ${SONARR_API_KEY}
      ARR_MCP_AUTH_TOKEN: ${ARR_MCP_AUTH_TOKEN}
    # Longer than the request timeout, so requests in progress can finish.
    stop_grace_period: 35s
```

- **Health.** The image's health check calls `/healthz` with its own Node.js, so `docker ps` reports the container `healthy` once it is serving.
- **Non-root.** It runs as uid `1000`, the base image's `node` user, under `tini`.
- **TLS and one replica still apply.** Everything in [Before exposing it](#run-as-a-remote-service) holds for the container: put it behind a TLS-terminating reverse proxy, and run exactly one container — never two replicas behind one URL, nor a rolling update that overlaps the old one.
- **Stopping.** `docker stop` sends `SIGTERM` and waits ten seconds by default before killing; give it at least the request timeout (`--stop-timeout`, or `stop_grace_period` as above) so a request in progress is not cut off.
- **HTTP only.** The image is for the remote service. To run over stdio, use `npx -y mcp-arr` as in [Configure your host](#configure-your-host).

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

## Media tools

The server has a second, much smaller toolset for callers that want to find and add movies and TV series without knowing how Sonarr, Radarr, and Prowlarr divide the work. It talks about movies and series rather than applications, and it picks the quality profile and root folder itself. It is opt-in for now: the fourteen `arr` tools stay the default until the `media` toolset is complete and has been verified against live instances.

`ARR_MCP_TOOLSET` selects what the server publishes, and is read once at startup:

- absent, or `arr` — the fourteen `arr_` tools above, exactly as before
- `media` — only the `media_` tools
- `media,arr` in either order, or `all` — both toolsets side by side, each tool exactly as it is on its own

Anything else — an unknown name, a name given twice, an empty entry, or `all` combined with a name — fails startup with a message naming the variable but never the value you set.

With only `media` selected, `arr_capabilities` is not published; a kind whose instance cannot be reached is reported by the `media` tools themselves.

Two tools are published so far:

- `media_find` — takes `text`, 1 to 200 characters, and an optional `kind` of `movie` or `series`, and searches every kind this server serves when `kind` is absent. It returns at most five titles per kind, best match first, each with its `kind`, its `id` (the TMDB id of a movie, the TVDB id of a series), its `title`, its `year` when known, and `in_library`. A kind that cannot be searched — its instance is down, say — is listed under `unavailable` beside the other kind's titles rather than failing the call. It changes nothing.
- `media_add` — takes the `kind` and `id` a find returned, an optional `resolution`, and, for a series only, an optional `episodes` of `all` (the default) or `future`. It adds the title monitored and starts a search for it, and reports `added`. A title already in the library is left exactly as it is and reported `already_in_library`, including when another call added it a moment earlier, so adding twice never creates a duplicate.

`resolution` is one of `480p`, `576p`, `720p`, `1080p`, and `2160p`. A profile's resolution is that of its cutoff quality, or the highest in its cutoff group. The server uses a profile whose resolution is the one asked for or, where none is, the nearest, the lower of two equally near winning; among several it prefers the configured default, then the profile allowing the fewest qualities, then the name that sorts first. The result reports the resolution the title now targets, so you can see when the request was not met exactly.

New titles are added with these defaults, which are accepted only when `media` is selected:

| Variable | Meaning |
|---|---|
| `ARR_MCP_MEDIA_MOVIE_QUALITY_PROFILE` | Quality profile name for new movies |
| `ARR_MCP_MEDIA_MOVIE_ROOT_FOLDER` | Root folder path for new movies |
| `ARR_MCP_MEDIA_SERIES_QUALITY_PROFILE` | Quality profile name for new series |
| `ARR_MCP_MEDIA_SERIES_ROOT_FOLDER` | Root folder path for new series |

Each is optional. Where a variable is absent and the instance has exactly one root folder or quality profile, that one is used; where it has several, an add fails with `deployment_configuration` naming the variable to set — unless the call names a `resolution`, which chooses the profile by itself. A variable that names a profile or folder the instance does not have fails every add of that kind the same way, so a stale setting is reported rather than bypassed. Names and paths are matched exactly as written. The defaults are checked when a title is added rather than at startup, so an instance that is down when the server starts does not stop it from starting.

```json
{
  "env": {
    "ARR_MCP_TOOLSET": "media",
    "ARR_MCP_MEDIA_MOVIE_QUALITY_PROFILE": "HD-1080p",
    "ARR_MCP_MEDIA_SERIES_QUALITY_PROFILE": "HD-1080p",
    "ARR_MCP_MEDIA_SERIES_ROOT_FOLDER": "/tv"
  }
}
```

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

`npm run check` runs the full gate — type check, lint, build, tests, and package verification. The package verifier packs the tarball, installs it into a throwaway consumer, and drives the installed executable over stdio and over HTTP, so it catches packaging regressions the unit tests cannot.

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

Fixtures may be recorded at more than one version of an application. Each application's minimum supported version keeps its full set, and those remain the evidence that the minimum works. A newer recorded version holds only the routes a change has approved there, for a body only a newer instance returns, and a fixture recorded there is evidence for that version alone. Which of them a capture writes is decided by the version the instance reports: it writes under that version's directory, and only a route approved at that version. A test reads the minimum's fixture unless it names the version it wants, as `fixturePathFor(application, route, { version })`.

It refuses rather than writing whenever it cannot stand behind what it read:

- the route is not one the inventory approves for that application;
- the instance is not at a version fixtures are recorded at, or the route is not approved at the version it is at;
- the application answers the route with `404`, or with its web interface instead of JSON — which is what an unrecognized API path is served, with a `200`;
- the sanitized body still trips one of the fixture screens.

Sanitizing drops any key the screens name as secret-bearing or identifying, and replaces any other text they refuse — a URL, an address, a home or host path, whether it arrived as a value or as a key — with a neutral stand-in of the same kind, so the shape survives and the text does not. If a capture is still refused, neutralize what the message names. Never weaken a screen to accommodate what an instance sent.

A provider's settings are the exception, and they are treated more harshly than the screens require. These applications describe an indexer, a download client, an import list, a notification or an application connection as a list of `{ name, value }` pairs, so a credential arrives under the property name `value` with its real name beside it — and no screen that asks what a property is called can see it. Every such value is therefore replaced, whatever the field is called: a private tracker's `passkey` or `rssKey` is no more recognizable by name than an `apiKey`, and a Cardigann definition may call its own anything at all. The field keeps its name and its type, which is the whole of what the fixture's shape needs, and a value that is not text is left alone, so a select field still records its selection. The two texts these applications use as state rather than as content are also kept: a blank value means the credential is unset, and a run of asterisks is the stand-in for one that is set.

A route's records can only be verified against an instance that holds records of that kind: an instance with no tags, import lists, notifications, import-list exclusions or pending renames answers those routes with an empty collection, and a usenet-only indexer set never produces a torrent release. Such a fixture's envelope is recorded from the instance while its records are not, and it stays that way until an instance holds the data. That is a limit of the capture, not a licence to invent a record: a recorded body must still describe a response the application produces.
