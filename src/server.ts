import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./tools/dispatch.js";
import { registerTools } from "./tools/register.js";

const SERVER_INFO = {
  name: "mcp-arr",
  version: "0.1.0",
} as const;

/**
 * Builds a server with the full published tool set already registered. The
 * tool context is injected so a test can supply its own adapter registry and
 * operation inventory without a network.
 */
export function createServer(context: ToolContext): McpServer {
  const server = new McpServer(SERVER_INFO);
  registerTools(server, context);
  return server;
}
