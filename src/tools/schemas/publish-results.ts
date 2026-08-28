import { z } from "zod";
import { payloadSchemaOf, toolResultStatuses } from "../results.js";
import { isRecord, type JsonSchema, schemaAt } from "./json-schema.js";

/**
 * The envelope every tool publishes, in place of its own output schema.
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
 * {@link describePayloadPaths} rather than as a schema.
 *
 * The root is deliberately open. `mutation` is absent here and present on every
 * mutation tool's envelope, and a host that validates `structuredContent`
 * against what the listing declared has to keep finding it valid.
 */
const publishedEnvelope = z.looseObject({
  status: z.enum(toolResultStatuses),
  applications: z.array(z.looseObject({ data: z.unknown().optional() })),
  warnings: z.array(z.unknown()),
  errors: z.array(z.unknown()),
});

/**
 * The node one of a schema's properties declares, where it declares one.
 *
 * Every node a tool's output schema produces is a plain object with no `$ref`
 * and no `$defs`, so a walk of it needs no resolution step — and {@link
 * refuseReference} holds it to that rather than leaving it asserted, because
 * the walk's output is the only place a caller can read what a payload
 * contains.
 */
function propertyAt(node: JsonSchema, name: string): JsonSchema | undefined {
  const declared = schemaAt(node, "properties")?.[name];
  return isRecord(declared) ? declared : undefined;
}

/**
 * The alternatives a node offers, or `undefined` where it offers none.
 *
 * A node that declares alternatives and offers none usable is refused rather
 * than reported as a union of nothing: a walk of an empty list names no field,
 * so the payload would publish a line promising a caller its fields and listing
 * none. `publish.ts` refuses the same shape on the input side.
 */
function alternativesOf(node: JsonSchema): readonly JsonSchema[] | undefined {
  const alternatives = node.anyOf ?? node.oneOf;
  if (!Array.isArray(alternatives)) {
    return undefined;
  }
  if (alternatives.length === 0 || !alternatives.every(isRecord)) {
    throw new Error(
      "A published payload union must offer object alternatives; found " +
        `${JSON.stringify(alternatives).slice(0, 200)}`,
    );
  }
  return alternatives;
}

/**
 * The keywords that make a converted node a pointer at something else.
 *
 * `z.toJSONSchema` extracts a self-referential payload into `definitions` and
 * leaves a `$ref` behind, and a `$ref` node declares no type, no properties and
 * no alternatives — so every structural test this module makes passes it
 * through as though it held nothing, and its whole subtree would disappear from
 * the inventory without a word.
 */
const referenceKeywords = ["$ref", "$defs", "definitions"] as const;

function refuseReference(node: JsonSchema, where: string): void {
  const keyword = referenceKeywords.find((candidate) => node[candidate] !== undefined);
  if (keyword !== undefined) {
    throw new Error(
      `A payload must convert to a self-contained schema; found ${keyword} at ${where}: ` +
        `${JSON.stringify(node).slice(0, 200)}`,
    );
  }
}

/** The string values a node fixes itself to, empty where it fixes none. */
function fixedValues(node: JsonSchema): readonly string[] {
  if (typeof node.const === "string") {
    return [node.const];
  }
  return Array.isArray(node.enum) ? node.enum.filter((value) => typeof value === "string") : [];
}

/** The types a path may bottom out at. Everything else still holds fields. */
const leafTypes: ReadonlySet<string> = new Set(["string", "number", "integer", "boolean", "null"]);

/**
 * Whether a node is a value rather than something still holding fields.
 *
 * Recognised positively rather than by refusing a list of known structures. The
 * ways a converted node can hold fields without saying so are exactly the ones
 * a refuse-what-we-know-about check has never heard of: an intersection is a
 * bare `allOf` with no type, and a recursive payload is a bare `$ref`. Both
 * would pass every "is this an object?" test and publish as a leaf naming
 * nothing inside them.
 *
 * An empty node is the one thing with no type that really is a value:
 * `z.unknown()` constrains nothing and holds nothing to descend into.
 */
function isValue(node: JsonSchema): boolean {
  if (Object.keys(node).length === 0) {
    return true;
  }
  if (node.const !== undefined || Array.isArray(node.enum)) {
    return true;
  }
  const declared = Array.isArray(node.type) ? node.type : [node.type];
  return (
    declared.length > 0 && declared.every((type) => typeof type === "string" && leafTypes.has(type))
  );
}

/**
 * Every dot-path from `node` down to a leaf, in declaration order.
 *
 * A leaf is a node with no properties and no alternatives left to descend
 * into — a string, a number, an enum. Stopping there rather than at an interior
 * node is what makes a path directly usable: `items.radarr.tmdbId` is copied
 * verbatim, and once every path bottoms out the structure is implicit in the
 * paths themselves, so no type annotation is needed to say what to descend
 * into next.
 *
 * An array contributes no segment of its own. One path therefore names that
 * field on every element, which is how a payload is actually read.
 *
 * Alternatives below the top of a payload are merged rather than grouped: a
 * calendar entry holds either a Sonarr episode or a Radarr movie, and both
 * their fields belong to the calendar view. Only the payload's own
 * discriminator groups, because that is the one a caller has already chosen by
 * the time a result exists.
 *
 * A node that still holds fields this walk cannot name — an object declaring no
 * properties, a tuple, a map keyed by a value, an intersection, a recursive
 * reference — throws when the tool is registered rather than being published as
 * a leaf or dropped. Either would silently stop telling a caller about
 * everything inside it, which is the same failure `publish.ts` refuses on the
 * input side and for the same reason: a field a caller is never told about is
 * worse than a server that will not start.
 */
function refuseUnnamable(node: JsonSchema, prefix: string, holding: string): Error {
  return new Error(
    `A payload field must bottom out at a value; ${holding} at ` +
      `${prefix === "" ? "the payload itself" : prefix} does not: ` +
      `${JSON.stringify(node).slice(0, 200)}`,
  );
}

function leafPaths(node: JsonSchema, prefix: string, into: string[]): string[] {
  refuseReference(node, prefix === "" ? "the payload itself" : prefix);
  const alternatives = alternativesOf(node);
  if (alternatives !== undefined) {
    for (const alternative of alternatives) {
      leafPaths(alternative, prefix, into);
    }
    return into;
  }
  const items = schemaAt(node, "items");
  if (items !== undefined) {
    return leafPaths(items, prefix, into);
  }
  const properties = schemaAt(node, "properties");
  if (properties !== undefined) {
    const declared = Object.entries(properties).filter((entry) => isRecord(entry[1]));
    if (declared.length === 0) {
      // Descending would produce no path at all, which is the one outcome worse
      // than a wrong one: the field vanishes from the inventory silently.
      throw refuseUnnamable(node, prefix, "an object declaring no properties");
    }
    for (const [name, child] of declared) {
      leafPaths(child as JsonSchema, prefix === "" ? name : `${prefix}.${name}`, into);
    }
    return into;
  }
  if (!isValue(node)) {
    throw refuseUnnamable(node, prefix, "the node");
  }
  if (prefix !== "" && !into.includes(prefix)) {
    into.push(prefix);
  }
  return into;
}

/** One payload a tool can return, and the paths that reach into it. */
export interface PayloadPaths {
  /**
   * Every discriminator value that selects this payload, in declaration order,
   * and empty where the payload has no discriminator to select it by. Plural
   * because a discriminated union admits an alternative that answers to a set
   * of values rather than to one, and labelling such a payload with the first
   * of them would leave the rest selecting a payload nothing describes.
   */
  readonly variants: readonly string[];
  /** Every dot-path from the payload down to one of its leaves. */
  readonly paths: readonly string[];
}

/** Every payload one tool can return, and how a caller tells them apart. */
export interface PayloadInventory {
  /**
   * The payload property whose value chooses among {@link payloads}, or
   * `undefined` where the payloads carry nothing that distinguishes them.
   */
  readonly discriminator: string | undefined;
  readonly payloads: readonly PayloadPaths[];
}

/**
 * Every path into a tool's per-application payload, generated from the same
 * output schema its envelope is validated against.
 *
 * This is the whole discovery surface for a payload now that the published
 * output schema leaves `data` unconstrained, and it is deliberately the one
 * generator: what a caller is told a payload contains and what a projection
 * later resolves against are read off the same walk, so they cannot come apart.
 *
 * Answers `undefined` for a tool that declares no payload — there is nothing to
 * reach into, and publishing an empty inventory would advertise a surface the
 * tool does not have.
 */
export function payloadInventory(outputSchema: z.ZodType): PayloadInventory | undefined {
  if (inventories.has(outputSchema)) {
    return inventories.get(outputSchema);
  }
  const generated = generateInventory(outputSchema);
  inventories.set(outputSchema, generated);
  return generated;
}

/**
 * Each envelope's inventory, beside the schema it was generated from.
 *
 * Generating one converts the whole payload union and walks it, and the answer
 * is a pure function of a module-level schema — so it is computed once at
 * registration and then read again on every call that projects a result. Weak
 * because the key is the schema itself, exactly as `results.ts` keys its
 * payloads: an envelope nothing holds any more takes its entry with it.
 *
 * Caching a refusal cannot hide one. Every throw below fires on the first
 * generation, which happens while the tool is being registered, so a payload
 * this walk cannot name still stops the server from starting.
 */
const inventories = new WeakMap<z.ZodType, PayloadInventory | undefined>();

function generateInventory(outputSchema: z.ZodType): PayloadInventory | undefined {
  const payload = payloadSchemaOf(outputSchema);
  if (payload === undefined) {
    return undefined;
  }
  // The declared discriminator, not one inferred back out of the conversion: a
  // discriminated union already records which property answers "which payload
  // is this", and re-deriving it would mean guessing between properties that
  // happen to look alike once converted. A plain union declares none, and its
  // payloads are published as alternatives rather than labelled with a value no
  // result carries.
  const discriminator =
    payload instanceof z.ZodDiscriminatedUnion ? payload.def.discriminator : undefined;

  const converted = z.toJSONSchema(payload, { target: "draft-7", io: "output" }) as JsonSchema;
  // Checked here rather than left to the walk. `leafPaths` refuses a reference
  // at every node it visits, but a union payload never hands it the root — each
  // alternative is walked on its own — and the root is exactly where a
  // self-referential payload's `definitions` are hoisted to. Every discriminated
  // payload this server publishes takes that branch, so a guard that only lives
  // inside the walk is a guard most payloads never reach.
  refuseReference(converted, "the payload itself");

  const alternatives = alternativesOf(converted);
  const payloads: PayloadPaths[] =
    alternatives === undefined
      ? [{ variants: [], paths: leafPaths(converted, "", []) }]
      : alternatives.map((alternative) => {
          const declared =
            discriminator === undefined ? undefined : propertyAt(alternative, discriminator);
          return {
            variants: declared === undefined ? [] : fixedValues(declared),
            paths: leafPaths(alternative, "", []),
          };
        });

  // A payload naming nothing is not a smaller inventory — it is a line in the
  // description promising a caller some fields and listing none. It means the
  // payload is a bare value, or a union whose alternatives this walk never
  // reached.
  if (payloads.some((entry) => entry.paths.length === 0)) {
    throw new Error(
      "A published payload must name at least one field; found none in " +
        `${JSON.stringify(converted).slice(0, 200)}`,
    );
  }

  return { discriminator: alternatives === undefined ? undefined : discriminator, payloads };
}

const inventoryHeader =
  "Fields of applications[].data, as dot-paths to each leaf. An array contributes no path " +
  "segment, so one path names that field on every element.";

/**
 * The inventory as the prose the published schema carries.
 *
 * Payloads whose paths read identically collapse onto one line naming every
 * value that selects them: `missing_episodes` and `cutoff_unmet_episodes`
 * differ in the value of `items.wanted.reason` and in nothing a path can show,
 * and printing the same forty-four paths twice teaches a reader nothing.
 */
export function describePayloadPaths(inventory: PayloadInventory): string {
  const { discriminator, payloads } = inventory;
  if (discriminator === undefined && payloads.length === 1) {
    return `${inventoryHeader}\n${(payloads[0]?.paths ?? []).join(", ")}`;
  }

  // Keyed on the paths themselves, so payloads that read identically arrive at
  // the same line and bring their own selecting value with them.
  const grouped = new Map<string, string[]>();
  for (const payload of payloads) {
    const paths = payload.paths.join(", ");
    grouped.set(paths, [...(grouped.get(paths) ?? []), ...payload.variants]);
  }

  const lead =
    discriminator === undefined
      ? `${inventoryHeader} Each line lists the fields of one alternative payload.`
      : `${inventoryHeader} Each line lists the fields of one payload, named by the ` +
        `data.${discriminator} value that selects it.`;
  const lines = [...grouped].map(([paths, variants]) =>
    variants.length === 0 ? `- ${paths}` : `- ${discriminator}=${variants.join("|")}: ${paths}`,
  );
  return [lead, ...lines].join("\n");
}

/**
 * What one tool publishes in place of its own output schema.
 *
 * The broadened envelope, carrying the payload's generated path inventory in
 * its root `description`. Generated here and nowhere else: nothing about it is
 * plumbed through the tool definitions, so a payload cannot acquire a shape the
 * published documentation does not name.
 */
export function publishedResultSchema(outputSchema: z.ZodType): z.ZodType {
  const inventory = payloadInventory(outputSchema);
  return inventory === undefined
    ? publishedEnvelope
    : publishedEnvelope.meta({ description: describePayloadPaths(inventory) });
}
