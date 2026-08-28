/**
 * The little that both publication sites need to read a converted schema.
 *
 * `publish.ts` and `publish-results.ts` each walk the output of
 * `z.toJSONSchema`, and both walks start from the same three facts: what a node
 * is, how to reach a nested one, and that neither ever has to resolve a `$ref`.
 * Kept here so the two sides cannot drift into disagreeing about what a node is
 * — a divergence that would show up as one side publishing a shape the other
 * refuses.
 */

/**
 * A converted JSON Schema node. Every node these schemas produce is a plain
 * object with no `$ref` and no `$defs`, which is what lets deep equality be
 * `JSON.stringify` and lets a merged property be assembled by hand.
 */
export type JsonSchema = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The schema one keyword holds, where it holds a schema at all. */
export function schemaAt(node: JsonSchema, key: string): JsonSchema | undefined {
  const value = node[key];
  return isRecord(value) ? value : undefined;
}
