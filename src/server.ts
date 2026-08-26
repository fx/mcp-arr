import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./tools/dispatch.js";
import { registerTools } from "./tools/register.js";

/**
 * Reads the package version from the shipped manifest so the advertised
 * `serverInfo.version` cannot drift from what npm installed. The manifest is
 * read at runtime rather than imported, which keeps it out of the build graph:
 * `package.json` sits above `rootDir`, so a compile-time import would move the
 * emitted output and break the packed-file layout. The relative URL resolves
 * from a source checkout (`src/server.ts` and `dist/server.js` both sit one
 * level below the manifest) and from an installed package alike.
 *
 * A manifest that cannot be read or carries no version means a broken install.
 * That throws: reporting a placeholder confidently is the failure this guards
 * against.
 */
function readPackageVersion(): string {
  const manifestUrl = new URL("../package.json", import.meta.url);
  const manifest: unknown = JSON.parse(readFileSync(manifestUrl, "utf8"));
  const version =
    typeof manifest === "object" && manifest !== null
      ? (manifest as { version?: unknown }).version
      : undefined;
  if (typeof version !== "string" || version === "") {
    throw new Error(`package manifest at ${manifestUrl.href} declares no version`);
  }
  return version;
}

const SERVER_INFO = {
  name: "mcp-arr",
  version: readPackageVersion(),
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
