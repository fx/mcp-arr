import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { findToolDefinition, type ToolDefinition } from "../../src/tools/definitions.js";
import type { ToolContext } from "../../src/tools/dispatch.js";
import type { ToolName } from "../../src/tools/names.js";
import { runTool } from "../../src/tools/register.js";
import type { ToolResult } from "../../src/tools/results.js";

/**
 * Calling a tool the way its host does while keeping the envelope that call
 * produced before anything was projected out of it.
 *
 * Shared, because the claim a projection has to answer for is the same wherever
 * it is made: a projected result carries only values the *same* call would have
 * returned unprojected. That comparison cannot be made across two calls — every
 * reference this server mints is random, so two calls returning the same records
 * return them under different tokens — so the unprojected envelope has to come
 * out of the one call being examined.
 */

export type Payload = Record<string, unknown>;

export function isRecord(value: unknown): value is Payload {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function definitionOf(name: ToolName): ToolDefinition {
  const definition = findToolDefinition(name);
  if (definition === undefined) {
    throw new Error(`No definition for ${name}`);
  }
  return definition;
}

export interface CalledTool {
  /** What a host receives, projected where the call named a projection. */
  readonly structured: Payload;
  /** The same call's envelope, validated against the tool's own output schema. */
  readonly envelope: Payload;
  readonly summary: string;
  readonly isError: boolean;
}

export async function callTool(
  name: ToolName,
  context: ToolContext,
  args: Record<string, unknown>,
): Promise<CalledTool> {
  const definition = definitionOf(name);
  const parsed = definition.inputSchema.safeParse(args);
  if (!parsed.success) {
    throw new Error(`${name} rejected ${JSON.stringify(args)}: ${parsed.error.message}`);
  }

  let envelope: unknown;
  const recording: ToolDefinition = {
    ...definition,
    async handle(recordingContext: ToolContext, input: unknown): Promise<ToolResult<unknown>> {
      const result = await definition.handle(recordingContext, input);
      envelope = definition.outputSchema.parse(result);
      return result;
    },
  };

  const called: CallToolResult = await runTool(recording, context, parsed.data);
  const structured = called.structuredContent;
  if (!isRecord(structured) || !isRecord(envelope)) {
    throw new Error(`${name} produced no structured content for ${JSON.stringify(args)}`);
  }
  const text = called.content[0];
  return {
    structured,
    envelope,
    summary: text !== undefined && text.type === "text" ? text.text : "",
    isError: called.isError === true,
  };
}

/** The per-application outcomes an envelope carries, as records. */
export function outcomesOf(envelope: Payload): readonly Payload[] {
  const outcomes = envelope.applications;
  return Array.isArray(outcomes) ? outcomes.filter(isRecord) : [];
}

/** The outcomes that actually carry a payload, beside their position. */
export function payloadOutcomes(envelope: Payload): ReadonlyArray<readonly [number, Payload]> {
  return outcomesOf(envelope)
    .map((outcome, index) => [index, outcome] as const)
    .filter((entry): entry is readonly [number, Payload] => isRecord(entry[1].data));
}

/**
 * Every value inside a payload, keyed by where it sits.
 *
 * Array positions are part of the key, so two records are never confused for
 * each other, and an empty object contributes nothing — which is what a record
 * none of the named fields is present on reduces to, and there is no value in it
 * to compare.
 *
 * An `undefined` contributes nothing either, because a host receives JSON and
 * JSON has none. Several adapters build an optional field as an explicit
 * `undefined`, which survives parsing as a key and disappears on serialization,
 * so counting it as a value present would have this call a field returned that
 * nothing on the wire carries.
 */
export function leafValues(
  value: unknown,
  path = "",
  into = new Map<string, unknown>(),
): Map<string, unknown> {
  if (Array.isArray(value)) {
    for (const [index, element] of value.entries()) {
      leafValues(element, `${path}[${index}]`, into);
    }
    return into;
  }
  if (isRecord(value)) {
    for (const [name, child] of Object.entries(value)) {
      leafValues(child, path === "" ? name : `${path}.${name}`, into);
    }
    return into;
  }
  if (path !== "" && value !== undefined) {
    into.set(path, value);
  }
  return into;
}

/** A value's location with its array positions removed, as a projection writes it. */
export function withoutPositions(path: string): string {
  return path.replace(/\[\d+\]/gu, "");
}

/** The paths a payload actually carries a value at, as a projection writes them. */
export function presentPaths(data: Payload): readonly string[] {
  return [...new Set([...leafValues(data).keys()].map(withoutPositions))];
}
