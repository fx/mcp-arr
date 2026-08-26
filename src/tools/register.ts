import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { type ToolDefinition, toolDefinitions } from "./definitions.js";
import type { ToolContext } from "./dispatch.js";
import { createToolError } from "./errors.js";
import { buildToolResult, summarizeToolResult, type ToolResult } from "./results.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The envelope returned when a handler throws or produces something its own
 * declared output schema rejects. It is built from the shared builders, so it
 * always conforms, and its message is static: a thrown value's own message may
 * carry a URL, a response body, or a configured API key.
 */
function fallbackResult(reason: string): ToolResult<never> {
  return buildToolResult({
    errors: [createToolError({ code: "unexpected_response", message: reason })],
  });
}

function conformingContent(
  definition: ToolDefinition,
  result: ToolResult<unknown>,
): Record<string, unknown> | undefined {
  const parsed = definition.outputSchema.safeParse(result);
  return parsed.success && isRecord(parsed.data) ? parsed.data : undefined;
}

/**
 * Runs one tool and converts its envelope into an MCP result.
 *
 * The envelope is validated against the tool's own declared output schema
 * before it leaves the process, so structured content and the published schema
 * cannot drift apart. Every result carries both the structured envelope and a
 * concise text summary; `isError` is set only when nothing succeeded, so a
 * partial result still reaches a caller that inspects structured content.
 */
export async function runTool(
  definition: ToolDefinition,
  context: ToolContext,
  input: unknown,
): Promise<CallToolResult> {
  let result: ToolResult<unknown>;
  try {
    result = await definition.handle(context, input);
  } catch {
    result = fallbackResult(`${definition.name}: the call failed unexpectedly`);
  }

  let structuredContent = conformingContent(definition, result);
  if (structuredContent === undefined) {
    result = fallbackResult(`${definition.name}: produced a non-conforming result`);
    structuredContent = conformingContent(definition, result);
  }

  const content: CallToolResult["content"] = [
    { type: "text", text: summarizeToolResult(definition.name, result) },
  ];

  return {
    content,
    ...(structuredContent === undefined ? {} : { structuredContent }),
    isError: result.status === "error",
  };
}

export function registerTools(server: McpServer, context: ToolContext): void {
  for (const definition of toolDefinitions) {
    server.registerTool(
      definition.name,
      {
        title: definition.title,
        description: definition.description,
        inputSchema: definition.inputSchema,
        outputSchema: definition.outputSchema,
        annotations: definition.annotations,
      },
      (input: unknown) => runTool(definition, context, input),
    );
  }
}
