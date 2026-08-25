import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const SERVER_INFO = {
  name: "mcp-arr",
  version: "0.1.0",
} as const;

export function createServer(): McpServer {
  return new McpServer(SERVER_INFO);
}
