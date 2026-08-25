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
