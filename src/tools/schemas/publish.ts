import { z } from "zod";
import { type ReferenceKind, referenceKinds, referencePattern } from "./common.js";
import { isRecord, type JsonSchema, schemaAt } from "./json-schema.js";

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
        throw new Error(
          "A published variant union must offer object alternatives; found " +
            `${JSON.stringify(alternative ?? null)}`,
        );
      }
      collectBranches(alternative, into);
    }
    return into;
  }
  if (node.type !== "object" || node.additionalProperties !== false) {
    throw new Error(
      "Every variant of a published union must be a closed object; found " +
        `${JSON.stringify(node.type ?? null)} with additionalProperties ` +
        `${JSON.stringify(node.additionalProperties ?? null)}, ` +
        `on the variant declaring ${describeBranch(node)}`,
    );
  }
  into.push(node);
  return into;
}

/**
 * Every keyword a node may carry and still be nothing but a choice among
 * string values. The three that state the choice, plus `description`, which
 * states nothing about the value at all.
 */
const stringChoiceKeywords: ReadonlySet<string> = new Set(["type", "const", "enum", "description"]);

/**
 * Whether a node is nothing but a choice among string values.
 *
 * Only such nodes collapse into one root `enum`. Anything carrying a further
 * constraint — a length, a pattern, a default — would lose it in the collapse,
 * so it is published as an alternative instead. A `description` is not such a
 * constraint: it is an annotation, and counting it as one would mean that
 * describing a property on a single variant is enough to bury that property's
 * whole accepted set under a nested `anyOf` — which is the exact combinator a
 * host never inspects, reintroduced one property at a time.
 */
function isStringChoice(node: JsonSchema): boolean {
  if (node.type !== "string") {
    return false;
  }
  if (!Object.keys(node).every((keyword) => stringChoiceKeywords.has(keyword))) {
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
 * How one branch of a union reads, for a message that has to name which branch
 * went wrong.
 *
 * A converted branch carries no name of its own, so what identifies it to a
 * reader is what it declares: its property names, and — for a property it fixes
 * to string values — the values that fix it, which is what a discriminator is.
 * That is enough to find the branch in the source union without bisecting the
 * thirteen this server publishes.
 */
function describeBranch(node: JsonSchema): string {
  const declared = Object.entries(propertiesOf(node)).map(([name, shape]) => {
    if (!isRecord(shape)) {
      return name;
    }
    const values = choiceValues(shape);
    return values.length === 0 ? name : `${name}=${values.join("|")}`;
  });
  return declared.length === 0 ? "no properties" : declared.join(", ");
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
    // The collapse builds a node by hand rather than keeping one, so anything
    // the collapsed shapes carried has to be carried across deliberately or it
    // is gone. `description` is the whole of that: a string choice may hold
    // nothing but the three keywords stating the choice — which the collapse
    // reproduces — plus this one annotation, and dropping it would delete text a
    // variant wrote with nowhere else to appear. The first non-empty one wins,
    // in variant order, because the shapes describe the same property and
    // concatenating two phrasings of one sentence reads as neither.
    const description = shapes
      .map((shape) => shape.description)
      .find((text): text is string => typeof text === "string" && text !== "");
    return {
      type: "string",
      enum: values,
      ...(description === undefined ? {} : { description }),
    };
  }
  // Published verbatim, so each alternative keeps its own annotations; there is
  // nothing to carry across.
  return { anyOf: [...shapes] };
}

interface MergedRoot {
  readonly properties: Record<string, JsonSchema>;
  readonly required: readonly string[];
}

/** A property's distinct shapes, beside the serialized form each was kept by. */
interface DistinctShapes {
  readonly shapes: JsonSchema[];
  readonly keys: Set<string>;
}

function mergeBranches(branches: readonly JsonSchema[]): MergedRoot {
  const distinct = new Map<string, DistinctShapes>();
  for (const branch of branches) {
    for (const [name, declared] of Object.entries(propertiesOf(branch))) {
      if (!isRecord(declared)) {
        throw new Error(`The published property ${name} is not a schema`);
      }
      // Serialized once and remembered, rather than once per shape already
      // kept: deep equality here is what decides whether a variant's shape is
      // new, and every variant asks it of every shape before it.
      const key = JSON.stringify(declared);
      let known = distinct.get(name);
      if (known === undefined) {
        known = { shapes: [], keys: new Set() };
        distinct.set(name, known);
      }
      if (!known.keys.has(key)) {
        known.keys.add(key);
        known.shapes.push(declared);
      }
    }
  }

  const properties: Record<string, JsonSchema> = {};
  for (const [name, known] of distinct) {
    properties[name] = mergeProperty(known.shapes);
  }

  // The intersection, so the published root never refuses a call some variant
  // accepts. What each variant requires on its own moves into the generated
  // documentation below.
  const required = branches
    .slice(1)
    .map(requiredOf)
    .reduce<readonly string[]>(
      (kept, next) => kept.filter((name) => next.includes(name)),
      requiredOf(branches[0] ?? {}),
    );

  return { properties, required };
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
function inferDiscriminator(
  branches: readonly JsonSchema[],
  merged: MergedRoot,
): string | undefined {
  let best: { readonly name: string; readonly declaring: number } | undefined;

  for (const name of Object.keys(merged.properties)) {
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
    // Strictly greater, so a tie resolves to the first qualifying property in
    // the merged root's key order — which is the order the converted union
    // declares its properties in, and so is deterministic for a given union
    // rather than merely arbitrary.
    if (disjoint && (best === undefined || declared.length > best.declaring)) {
      best = { name, declaring: declared.length };
    }
  }

  return best?.name;
}

/** The reference pattern each reference kind publishes, reversed to its kind. */
const referenceKindsByPattern: ReadonlyMap<string, ReferenceKind> = new Map(
  referenceKinds.map((kind) => [referencePattern(kind), kind]),
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
 *
 * The root's shape arrives already serialized, because it is the same shape for
 * every variant that declares the property and only the variant's own side of
 * the comparison changes.
 */
function describeArgument(name: string, branchNode: JsonSchema, publishedRoot: string): string {
  if (JSON.stringify(branchNode) === publishedRoot) {
    return name;
  }
  const values = choiceValues(branchNode);
  if (values.length > 0) {
    return `${name}=${values.join("|")}`;
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
  // One serialization of each published shape for the whole union: every
  // variant compares its own node against the same root node, so serializing
  // the root inside that comparison would repeat it once per variant.
  const publishedRoots = new Map(
    Object.entries(merged.properties).map(([name, node]) => [name, JSON.stringify(node)]),
  );

  interface VariantGroup {
    readonly values: string[];
    readonly required: readonly string[];
    readonly optional: readonly string[];
  }

  const groups = new Map<string, VariantGroup>();

  for (const branch of branches) {
    const properties = propertiesOf(branch);
    const required = requiredOf(branch);
    const argument = (name: string): string => {
      const branchNode = properties[name];
      const publishedRoot = publishedRoots.get(name);
      return isRecord(branchNode) && publishedRoot !== undefined
        ? describeArgument(name, branchNode, publishedRoot)
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

    groups.set(signature, {
      values: discriminatorValues(branch, discriminator),
      required: requiredArguments,
      optional: optionalArguments,
    });
  }

  // Assembled once, from the two lists rather than from a half-built string.
  // Whether a form has required arguments decides both how its label joins on
  // and where the optional ones go, and that is a fact about the lists — an
  // annotation that happened to begin with the word this used to look for would
  // otherwise relabel the line it appears on.
  const lines = [...groups.values()].map(({ values, required, optional }) => {
    const tail = optional.length === 0 ? "" : `optional ${optional.join(", ")}`;
    const body =
      required.length === 0 ? tail : `${required.join(", ")}${tail === "" ? "" : `; ${tail}`}`;
    if (discriminator === undefined || values.length === 0) {
      return `- ${body}`;
    }
    const label = `${discriminator}=${values.join("|")}`;
    if (required.length > 0) {
      return `- ${label}: ${body}`;
    }
    return body === "" ? `- ${label}` : `- ${label}; ${body}`;
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
  const discriminator = inferDiscriminator(branches, merged);

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
