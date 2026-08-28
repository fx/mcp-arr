import { z } from "zod";
import { toolResultStatuses } from "../results.js";

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
 * A converted JSON Schema node. Every node a tool's output schema produces is a
 * plain object with no `$ref` and no `$defs`, so a walk of it needs no
 * resolution step.
 */
type JsonSchema = Record<string, unknown>;

function isRecord(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schemaAt(node: JsonSchema, key: string): JsonSchema | undefined {
  const value = node[key];
  return isRecord(value) ? value : undefined;
}

/** The node one of a schema's properties declares, where it declares one. */
function propertyAt(node: JsonSchema | undefined, name: string): JsonSchema | undefined {
  const declared = node === undefined ? undefined : schemaAt(node, "properties")?.[name];
  return isRecord(declared) ? declared : undefined;
}

/** The alternatives a node offers, or `undefined` where it offers none. */
function alternativesOf(node: JsonSchema): readonly JsonSchema[] | undefined {
  const alternatives = node.anyOf ?? node.oneOf;
  return Array.isArray(alternatives) ? alternatives.filter(isRecord) : undefined;
}

/** The string values a node fixes itself to, empty where it fixes none. */
function fixedValues(node: JsonSchema): readonly string[] {
  if (typeof node.const === "string") {
    return [node.const];
  }
  return Array.isArray(node.enum) ? node.enum.filter((value) => typeof value === "string") : [];
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
 */
function leafPaths(node: JsonSchema, prefix: string, into: string[]): string[] {
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
    for (const [name, declared] of Object.entries(properties)) {
      if (isRecord(declared)) {
        leafPaths(declared, prefix === "" ? name : `${prefix}.${name}`, into);
      }
    }
    return into;
  }
  if (prefix !== "" && !into.includes(prefix)) {
    into.push(prefix);
  }
  return into;
}

/**
 * The property whose value says which payload a result carries.
 *
 * Inferred from the converted schema rather than declared beside it, so the
 * inventory cannot group by a property the payload does not actually
 * discriminate on. A property qualifies when every alternative declares it,
 * every one of them fixes it to a single value, and no two of those values are
 * the same — which is exactly what makes the value answer "which payload is
 * this". A property fixed to a *set* of values does not qualify: it does not
 * name one payload, and `arr_config_observe`'s `domain` is the case in point,
 * where sixteen domain values map onto three payload shapes that `family`
 * names outright.
 *
 * A tie resolves to the first qualifying property in the first alternative's
 * declaration order, which is deterministic for a given schema rather than
 * merely arbitrary.
 */
function inferDiscriminator(alternatives: readonly JsonSchema[]): string | undefined {
  const first = alternatives[0];
  if (first === undefined) {
    return undefined;
  }
  for (const name of Object.keys(schemaAt(first, "properties") ?? {})) {
    const values = alternatives.map((alternative) => {
      const declared = propertyAt(alternative, name);
      return declared === undefined ? [] : fixedValues(declared);
    });
    if (!values.every((fixed) => fixed.length === 1)) {
      continue;
    }
    const named = values.map(([value]) => value);
    if (new Set(named).size === named.length) {
      return name;
    }
  }
  return undefined;
}

/** One payload a tool can return, and the paths that reach into it. */
export interface PayloadPaths {
  /**
   * The value of the payload's discriminator that selects this payload, or
   * `undefined` where the payload has no discriminator to select it by.
   */
  readonly variant: string | undefined;
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
  const converted = z.toJSONSchema(outputSchema, { target: "draft-7", io: "output" }) as JsonSchema;
  const outcomes = propertyAt(converted, "applications");
  const data = propertyAt(outcomes === undefined ? undefined : schemaAt(outcomes, "items"), "data");
  if (data === undefined) {
    return undefined;
  }

  const alternatives = alternativesOf(data);
  if (alternatives === undefined) {
    return {
      discriminator: undefined,
      payloads: [{ variant: undefined, paths: leafPaths(data, "", []) }],
    };
  }

  const discriminator = inferDiscriminator(alternatives);
  const payloads = alternatives.map((alternative) => {
    const declared =
      discriminator === undefined ? undefined : propertyAt(alternative, discriminator);
    return {
      variant: declared === undefined ? undefined : fixedValues(declared)[0],
      paths: leafPaths(alternative, "", []),
    };
  });
  return { discriminator, payloads };
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

  const grouped = new Map<string, { readonly variants: string[]; readonly paths: string }>();
  for (const payload of payloads) {
    const paths = payload.paths.join(", ");
    const group = grouped.get(paths) ?? { variants: [], paths };
    if (payload.variant !== undefined) {
      group.variants.push(payload.variant);
    }
    grouped.set(paths, group);
  }

  const lead =
    discriminator === undefined
      ? `${inventoryHeader} Each line lists the fields of one alternative payload.`
      : `${inventoryHeader} Each line lists the fields of one payload, named by the ` +
        `data.${discriminator} value that selects it.`;
  const lines = [...grouped.values()].map(({ variants, paths }) =>
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
