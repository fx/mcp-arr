# mcp-arr

A local MCP server for Sonarr, Radarr, and Prowlarr.

## Requirements

- Node.js 20 or newer
- One or more supported applications with a complete base-URL/API-key pair

## Install

Install the package so your MCP host can launch its `mcp-arr` executable:

```sh
npm install --global mcp-arr
```

The server supports MCP over stdio only. Configure the host command as `mcp-arr` and pass instance settings through the command environment. For example:

```json
{
  "command": "mcp-arr",
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
