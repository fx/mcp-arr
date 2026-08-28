import { z } from "zod";
import { toolResultStatuses } from "../results.js";

/**
 * The output schema every tool publishes, in place of its own.
 *
 * A tool's internal output schema describes the whole envelope exactly — the
 * per-application outcome, the item outcomes, the continuation, the closed
 * error vocabulary, and the payload — and it is the same envelope on every
 * tool, so publishing it once per tool repeats one structure fifteen times in a
 * listing every session pays for before making a single call. Almost all of it
 * has exactly one consumer, and that consumer is inside this process: the
 * internal schema validates every envelope in `runTool` before it leaves, so a
 * published error-code enum or item-outcome shape is not checking anything a
 * caller could act on.
 *
 * What is published instead is the four top-level keys and the location of
 * `data`. Those earn their place: a path into a payload is written relative to
 * `data`, so a caller has to be able to see where `data` sits. Below it,
 * nothing — `data` itself is unconstrained, because its fields are published as
 * the generated path inventory rather than as a schema.
 *
 * The root is deliberately open. `mutation` is absent here and present on every
 * mutation tool's envelope, and a host that validates `structuredContent`
 * against what the listing declared has to keep finding it valid.
 */
export const publishedResultSchema: z.ZodType = z.looseObject({
  status: z.enum(toolResultStatuses),
  applications: z.array(z.looseObject({ data: z.unknown().optional() })),
  warnings: z.array(z.unknown()),
  errors: z.array(z.unknown()),
});
