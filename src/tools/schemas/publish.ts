import { z } from "zod";
import { type ReferenceKind, referenceKinds, referencePrefixes } from "./common.js";

/**
 * A converted JSON Schema node. Every node these unions produce is a plain
 * object with no `$ref` and no `$defs`, which is what lets deep equality here
 * be `JSON.stringify` and lets a merged property be assembled by hand.
 */
type JsonSchema = Record<string, unknown>;

function isRecord(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schemaAt(node: JsonSchema, key: string): JsonSchema | undefined {
  const value = node[key];
  return isRecord(value) ? value : undefined;
}

function propertiesOf(branch: JsonSchema): JsonSchema {
  return schemaAt(branch, "properties") ?? {};
}

function requiredOf(branch: JsonSchema): readonly string[] {
  const required = branch.required;
  return Array.isArray(required) ? required.filter((name) => typeof name === "string") : [];
}

/**
 * Every leaf variant of a converted union, in the order the union declares
 * them.
 *
 * A union of unions is flattened through as many levels as it has, because the
 * mutation tools are a discriminated union of intents beside the plan-reference
 * form and convert to an `anyOf` whose first member is itself a `oneOf`.
 *
 * A leaf that is not a closed object throws rather than being published, and it
 * throws at module load: a variant this cannot merge is a variant a caller
 * would silently stop being told about, which is the exact failure this whole
 * mechanism exists to prevent.
 */
function collectBranches(node: JsonSchema, into: JsonSchema[]): JsonSchema[] {
  const alternatives = node.anyOf ?? node.oneOf;
  if (Array.isArray(alternatives)) {
    for (const alternative of alternatives) {
      if (!isRecord(alternative)) {
        throw new Error("A published variant union must offer object alternatives");
      }
      collectBranches(alternative, into);
    }
    return into;
  }
  if (node.type !== "object" || node.additionalProperties !== false) {
    throw new Error(
      "Every variant of a published union must be a closed object; found " +
        `${JSON.stringify(node.type ?? null)} with additionalProperties ` +
        `${JSON.stringify(node.additionalProperties ?? null)}`,
    );
  }
  into.push(node);
  return into;
}

/**
 * Whether a node is nothing but a choice among string values.
 *
 * Only such nodes collapse into one root `enum`. Anything carrying a further
 * constraint — a length, a pattern, a default — would lose it in the collapse,
 * so it is published as an alternative instead.
 */
function isStringChoice(node: JsonSchema): boolean {
  if (node.type !== "string") {
    return false;
  }
  if (!Object.keys(node).every((keyword) => ["type", "const", "enum"].includes(keyword))) {
    return false;
  }
  if (typeof node.const === "string") {
    return true;
  }
  return Array.isArray(node.enum) && node.enum.every((value) => typeof value === "string");
}

function choiceValues(node: JsonSchema): readonly string[] {
  if (typeof node.const === "string") {
    return [node.const];
  }
  return Array.isArray(node.enum) ? node.enum.filter((value) => typeof value === "string") : [];
}

/**
 * One published node for a property several variants declare differently.
 *
 * String choices collapse into a single `enum` so the accepted set reads as one
 * list — which is also what makes a discriminator's complete value set
 * discoverable at the root. Anything else is published as a nested `anyOf`,
 * because a host never inspects a combinator below the root and every shape any
 * variant accepts has to remain admissible. There is no first-branch-wins here:
 * dropping a shape would publish a schema that refuses a call the tool accepts.
 */
function mergeProperty(shapes: readonly JsonSchema[]): JsonSchema {
  const first = shapes[0];
  if (first === undefined) {
    throw new Error("A published property must have at least one variant shape");
  }
  if (shapes.length === 1) {
    return first;
  }
  if (shapes.every(isStringChoice)) {
    const values: string[] = [];
    for (const shape of shapes) {
      for (const value of choiceValues(shape)) {
        if (!values.includes(value)) {
          values.push(value);
        }
      }
    }
    return { type: "string", enum: values };
  }
  return { anyOf: [...shapes] };
}

interface MergedRoot {
  readonly properties: Record<string, JsonSchema>;
  readonly required: readonly string[];
  /** Each property's distinct per-variant shapes, in first-seen order. */
  readonly shapes: ReadonlyMap<string, readonly JsonSchema[]>;
}

function mergeBranches(branches: readonly JsonSchema[]): MergedRoot {
  const shapes = new Map<string, JsonSchema[]>();
  for (const branch of branches) {
    for (const [name, declared] of Object.entries(propertiesOf(branch))) {
      if (!isRecord(declared)) {
        throw new Error(`The published property ${name} is not a schema`);
      }
      const known = shapes.get(name) ?? [];
      if (!known.some((shape) => JSON.stringify(shape) === JSON.stringify(declared))) {
        known.push(declared);
      }
      shapes.set(name, known);
    }
  }

  const properties: Record<string, JsonSchema> = {};
  for (const [name, distinct] of shapes) {
    properties[name] = mergeProperty(distinct);
  }

  // The intersection, so the published root never refuses a call some variant
  // accepts. What each variant requires on its own moves into the generated
  // documentation below.
  const required = branches
    .map(requiredOf)
    .reduce<readonly string[]>(
      (kept, next) => kept.filter((name) => next.includes(name)),
      requiredOf(branches[0] ?? {}),
    );

  return { properties, required, shapes };
}

/**
 * The property whose value identifies which variant a caller is supplying.
 *
 * Inferred from the converted union rather than declared beside it, so the
 * documentation cannot name a property the schema does not actually
 * discriminate on. A property qualifies when at least two variants declare it,
 * every variant that declares it fixes it to string values, and no two of those
 * value sets overlap — which is exactly what makes the value answer "which
 * variant is this". `mode` never qualifies, because the plan-reference form
 * fixes it to a value the direct forms also accept.
 */
function inferDiscriminator(branches: readonly JsonSchema[]): string | undefined {
  let best: { readonly name: string; readonly declaring: number } | undefined;

  for (const name of Object.keys(mergeBranches(branches).properties)) {
    const declared = branches
      .map((branch) => propertiesOf(branch)[name])
      .filter((node): node is JsonSchema => isRecord(node));
    if (declared.length < 2 || !declared.every(isStringChoice)) {
      continue;
    }
    const seen = new Set<string>();
    const values = declared.flatMap((node) => [...choiceValues(node)]);
    for (const value of values) {
      seen.add(value);
    }
    const disjoint = seen.size === values.length;
    if (disjoint && (best === undefined || declared.length > best.declaring)) {
      best = { name, declaring: declared.length };
    }
  }

  return best?.name;
}

/** The reference pattern each reference kind publishes, reversed to its kind. */
const referenceKindsByPattern: ReadonlyMap<string, ReferenceKind> = new Map(
  referenceKinds.map((kind) => [`^${referencePrefixes[kind]}_[A-Za-z0-9_-]{8,64}$`, kind]),
);

function referenceKindOf(node: JsonSchema): ReferenceKind | undefined {
  const pattern = node.pattern ?? schemaAt(node, "items")?.pattern;
  return typeof pattern === "string" ? referenceKindsByPattern.get(pattern) : undefined;
}

/**
 * How one argument reads on one variant's line.
 *
 * A variant that accepts exactly what the root publishes for a property needs
 * no annotation; one that accepts less has to say so, or the narrowing would be
 * discoverable only by triggering a validation error. Fixed values and value
 * sets are named outright, and a reference-typed argument names the kind of
 * reference it takes, which is the only narrowing a value set cannot express.
 */
function describeArgument(name: string, branchNode: JsonSchema, rootNode: JsonSchema): string {
  if (JSON.stringify(branchNode) === JSON.stringify(rootNode)) {
    return name;
  }
  if (typeof branchNode.const === "string") {
    return `${name}=${branchNode.const}`;
  }
  if (Array.isArray(branchNode.enum) && branchNode.enum.every((v) => typeof v === "string")) {
    return `${name}=${branchNode.enum.join("|")}`;
  }
  const kind = referenceKindOf(branchNode);
  if (kind !== undefined) {
    return `${name}=${kind} ${branchNode.type === "array" ? "references" : "reference"}`;
  }
  return name;
}

/**
 * The one thing the flattened root cannot say for itself.
 *
 * Merging the variants into a single object discards which arguments go
 * together: the root requires only what every variant requires, and a property
 * two variants narrow differently is published as the union of both. This
 * sentence is constant, and the lines below it are generated from the same
 * converted union that validates the input, so what the description promises
 * and what the tool accepts cannot come apart.
 */
const exclusivityHeader =
  "Supply exactly one of these forms in full; do not combine properties from two forms. " +
  "The root properties above are the union of every form, so a property optional at the " +
  "root may be required by the form chosen, and a form may accept fewer values than the " +
  "root property lists.";

function discriminatorValues(branch: JsonSchema, discriminator: string | undefined): string[] {
  if (discriminator === undefined) {
    return [];
  }
  const node = propertiesOf(branch)[discriminator];
  return isRecord(node) ? [...choiceValues(node)] : [];
}

/**
 * Prose naming every variant, what it requires, and what it narrows.
 *
 * Variants whose arguments read identically collapse onto one line listing all
 * their discriminator values — sixteen configuration domains that differ only
 * by name are sixteen repetitions of one sentence, and repeating it teaches a
 * reader nothing. A variant that carries no discriminator value at all is named
 * by what it requires rather than by a position in a list the reader cannot
 * see, which is what the plan-reference form is.
 */
function describeVariants(
  branches: readonly JsonSchema[],
  merged: MergedRoot,
  discriminator: string | undefined,
): string {
  const groups = new Map<string, { values: string[]; line: string }>();

  for (const branch of branches) {
    const properties = propertiesOf(branch);
    const required = requiredOf(branch);
    const argument = (name: string): string => {
      const branchNode = properties[name];
      const rootNode = merged.properties[name];
      return isRecord(branchNode) && isRecord(rootNode)
        ? describeArgument(name, branchNode, rootNode)
        : name;
    };

    const requiredArguments = required.filter((name) => name !== discriminator).map(argument);
    const optionalArguments = Object.keys(properties)
      .filter((name) => name !== discriminator && !required.includes(name))
      .map(argument);

    // Both lists, structurally, so no separator character can appear inside an
    // argument and make two different variants look alike.
    const signature = JSON.stringify([requiredArguments, optionalArguments]);
    const group = groups.get(signature);
    if (group !== undefined) {
      for (const value of discriminatorValues(branch, discriminator)) {
        if (!group.values.includes(value)) {
          group.values.push(value);
        }
      }
      continue;
    }

    const tail = optionalArguments.length === 0 ? "" : `optional ${optionalArguments.join(", ")}`;
    groups.set(signature, {
      values: discriminatorValues(branch, discriminator),
      line:
        requiredArguments.length === 0
          ? tail
          : `${requiredArguments.join(", ")}${tail === "" ? "" : `; ${tail}`}`,
    });
  }

  const lines = [...groups.values()].map(({ values, line }) => {
    if (discriminator === undefined || values.length === 0) {
      return `- ${line}`;
    }
    const label = `${discriminator}=${values.join("|")}`;
    return line.startsWith("optional ") || line === ""
      ? `- ${label}${line === "" ? "" : `; ${line}`}`
      : `- ${label}: ${line}`;
  });

  return [exclusivityHeader, ...lines].join("\n");
}

/**
 * Publishes a variant union as the one flat object a host will accept.
 *
 * The protocol requires a published tool input schema to be an object at its
 * root, and a host additionally drops any tool whose input schema carries
 * `anyOf`, `oneOf`, or `allOf` there. Between them, a union cannot be published
 * as alternatives at all: not as the root, and not under a root that merely
 * wraps them. A tool that publishes alternatives is not a tool with a
 * lower-fidelity schema — it is a tool the caller never sees.
 *
 * So the variants are merged into one object. Its properties are the union of
 * every variant's, a property several variants shape differently keeps every
 * shape (as one `enum` where they are all string choices, otherwise as a nested
 * `anyOf`, which a host never inspects), and its `required` list is the
 * intersection, so the published root refuses no call the tool accepts. What
 * merging discards — which arguments belong to which variant, and which values
 * a variant narrows to — is regenerated as prose from the same converted union,
 * carried in the published root's own `description`.
 *
 * The published schema is therefore deliberately looser than what validates,
 * and that prose is what closes the gap. Validation itself is untouched: the
 * wrapper still parses by handing the caller's object to the union and
 * re-raising the union's own finalized issues, and the server SDK validates an
 * incoming call against this Zod schema rather than against the JSON Schema it
 * publishes. Only the metadata payload changes, so every accepted input, every
 * parsed result, and every rejection message is exactly what it was before.
 */
export function variantUnion<TSchema extends z.ZodType>(union: TSchema): TSchema {
  // The document keyword belongs to the published root, which the server SDK
  // emits for the wrapper itself; carrying a second one in the metadata would
  // only restate it.
  const { $schema: _dialect, ...converted } = z.toJSONSchema(union, {
    target: "draft-7",
    io: "input",
  });

  const branches = collectBranches(converted as JsonSchema, []);
  const merged = mergeBranches(branches);
  const discriminator = inferDiscriminator(branches);

  const published = z
    .looseObject({})
    .check((context) => {
      const parsed = union.safeParse(context.value);
      if (parsed.success) {
        context.value = parsed.data as Record<string, unknown>;
        return;
      }
      // Each issue is already finalized, message included, so re-raising it
      // reproduces the union's own wording; only the raw-issue input field has
      // to be restored.
      for (const issue of parsed.error.issues) {
        context.issues.push({ input: context.value, ...issue } as z.core.$ZodRawIssue);
      }
    })
    .meta({
      type: "object",
      properties: merged.properties,
      ...(merged.required.length === 0 ? {} : { required: [...merged.required] }),
      additionalProperties: false,
      description: describeVariants(branches, merged, discriminator),
    });

  // The wrapper parses to whatever the union parses to, so it stands in for the
  // union at the type level as well as at runtime.
  return published as unknown as TSchema;
}
