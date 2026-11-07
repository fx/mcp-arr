import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import type { ToolsetSelection } from "../config/environment.js";
import { type ToolDefinition, toolDefinitions } from "./definitions.js";
import type { ToolContext } from "./dispatch.js";
import { createToolError } from "./errors.js";
import type { MediaContext } from "./media/context.js";
import {
  type MediaResult,
  type MediaToolDefinition,
  mediaToolDefinitions,
} from "./media/definitions.js";
import { callError } from "./media/errors.js";
import { publishedMediaToolNames } from "./names.js";
import { acceptsProjection, projectEnvelope, readProjection } from "./projection.js";
import { buildToolResult, summarizeToolResult, type ToolResult } from "./results.js";
import { publishedResultSchema } from "./schemas/publish-results.js";

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
  outputSchema: z.ZodType,
  result: unknown,
): Record<string, unknown> | undefined {
  const parsed = outputSchema.safeParse(result);
  return parsed.success && isRecord(parsed.data) ? parsed.data : undefined;
}

interface Settled<TResult> {
  readonly result: TResult;
  readonly structuredContent: Record<string, unknown> | undefined;
}

/**
 * Runs one handler and holds what it returns to the tool's own declared output
 * schema, shared by both toolsets.
 *
 * A handler that throws, or returns something its schema rejects, is replaced
 * by the tool's fallback envelope, whose message is static: a thrown value's
 * own message may carry a URL, a response body, or a configured API key.
 */
async function settle<TResult>(
  name: string,
  outputSchema: z.ZodType,
  run: () => Promise<TResult>,
  fallback: (reason: string) => TResult,
): Promise<Settled<TResult>> {
  let result: TResult;
  try {
    result = await run();
  } catch {
    result = fallback(`${name}: the call failed unexpectedly`);
  }

  let structuredContent = conformingContent(outputSchema, result);
  if (structuredContent === undefined) {
    result = fallback(`${name}: produced a non-conforming result`);
    structuredContent = conformingContent(outputSchema, result);
  }
  return { result, structuredContent };
}

/**
 * Runs one tool and converts its envelope into an MCP result.
 *
 * The envelope is validated against the tool's own declared output schema
 * before it leaves the process, so structured content and the published schema
 * cannot drift apart. Every result carries both the structured envelope and a
 * concise text summary; `isError` is set only when nothing succeeded, so a
 * partial result still reaches a caller that inspects structured content.
 *
 * A caller-supplied projection is applied after that validation and never
 * before, so what is projected is always a subset of something already known to
 * conform. Omitting one leaves the envelope exactly as it was.
 */
export async function runTool(
  definition: ToolDefinition,
  context: ToolContext,
  input: unknown,
): Promise<CallToolResult> {
  const settled = await settle<ToolResult<unknown>>(
    definition.name,
    definition.outputSchema,
    () => definition.handle(context, input),
    fallbackResult,
  );
  let result = settled.result;
  let structuredContent = settled.structuredContent;

  const projection = readProjection(input);
  if (
    projection !== undefined &&
    structuredContent !== undefined &&
    acceptsProjection(definition.inputSchema)
  ) {
    const projected = projectEnvelope(definition.outputSchema, structuredContent, projection);
    structuredContent = projected.content;
    // Carried into the summarized result as well, so the count the text reports
    // and the list the structured half carries describe the same call. The
    // record counts themselves are untouched: they say what the query matched,
    // which is what a caller pages on, not what the projection kept.
    if (projected.warning !== undefined) {
      result = { ...result, warnings: [...result.warnings, projected.warning] };
    }
  }

  const content: CallToolResult["content"] = [
    { type: "text", text: summarizeToolResult(definition.name, result, definition.summary) },
  ];

  return {
    content,
    ...(structuredContent === undefined ? {} : { structuredContent }),
    isError: result.status === "error",
  };
}

/**
 * Runs one `media` tool through the same settle path.
 *
 * A `media` result has no overall status of its own: each tool says when
 * nothing succeeded, and a result that names what it could not reach beside
 * what it could is a success. Its summary is one line.
 */
export async function runMediaTool(
  definition: MediaToolDefinition,
  context: MediaContext,
  input: unknown,
): Promise<CallToolResult> {
  const { result, structuredContent } = await settle<MediaResult>(
    definition.name,
    definition.outputSchema,
    () => definition.handle(context, input),
    (reason) => definition.failure(callError("unexpected_response", reason)),
  );
  return {
    content: [{ type: "text", text: definition.summarize(result) }],
    ...(structuredContent === undefined ? {} : { structuredContent }),
    isError: definition.failed(result),
  };
}

/** What a `media` deployment adds titles with when nothing was configured. */
const noMediaDefaults: MediaContext["defaults"] = { movie: {}, series: {} };

/**
 * Registers every tool of each selected toolset, `arr` first, so a listing of
 * both is the `arr` listing followed by the `media` one. The two name lists
 * carry different prefixes, so registering both needs no conflict handling.
 */
export function registerTools(
  server: McpServer,
  context: ToolContext,
  toolsets: ToolsetSelection,
): void {
  if (toolsets.names.includes("arr")) {
    for (const definition of toolDefinitions) {
      server.registerTool(
        definition.name,
        {
          title: definition.title,
          description: definition.description,
          inputSchema: definition.inputSchema,
          // Broadened for publication only. The tool's own schema keeps
          // validating every envelope above, and is what the payload's published
          // path inventory is generated from.
          outputSchema: publishedResultSchema(definition.outputSchema),
          annotations: definition.annotations,
        },
        (input: unknown) => runTool(definition, context, input),
      );
    }
  }

  if (toolsets.names.includes("media")) {
    const mediaContext: MediaContext = {
      registry: context.registry,
      defaults: toolsets.media ?? noMediaDefaults,
      claims: context.state.downloadClaims,
      clock: context.state.clock,
    };
    // `media_remove` is published only where the operator enabled it, so no
    // deployment lists a tool that refuses unconditionally.
    const published = publishedMediaToolNames(toolsets.mediaAllowRemove === true);
    for (const definition of mediaToolDefinitions) {
      if (!published.includes(definition.name)) {
        continue;
      }
      server.registerTool(
        definition.name,
        {
          title: definition.title,
          description: definition.description,
          inputSchema: definition.inputSchema,
          outputSchema: definition.publishedOutputSchema,
          annotations: definition.annotations,
        },
        (input: unknown) => runMediaTool(definition, mediaContext, input),
      );
    }
  }
}
