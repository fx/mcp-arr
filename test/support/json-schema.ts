/**
 * A draft-7 validator narrow enough to read, wide enough for what the server
 * publishes.
 *
 * The published schemas are the contract a host filters arguments against, so
 * checking them needs an independent reader rather than the Zod schema that
 * produced them — validating a schema with its own source would only restate
 * it. The subset covers every keyword the fifteen published input schemas
 * actually use, and any keyword outside that subset throws instead of being
 * ignored, so a schema change can never quietly slip past an unimplemented
 * constraint.
 */

type Schema = Record<string, unknown>;

/**
 * Keywords that carry no constraint here. `$schema` names the dialect, and
 * `default` and `format` are annotations in draft-7 rather than assertions.
 */
const annotationKeywords = new Set(["$schema", "default", "format"]);

const supportedKeywords = new Set([
  "additionalProperties",
  "anyOf",
  "const",
  "enum",
  "items",
  "maxItems",
  "maxLength",
  "maximum",
  "minItems",
  "minLength",
  "minimum",
  "oneOf",
  "pattern",
  "properties",
  "required",
  "type",
  ...annotationKeywords,
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(path: string): string {
  return path === "" ? "the argument object" : path;
}

function child(path: string, segment: string): string {
  return path === "" ? segment : `${path}.${segment}`;
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "object":
      return isRecord(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number";
    case "null":
      return value === null;
    default:
      throw new Error(`Unsupported JSON Schema type: ${type}`);
  }
}

function checkObject(schema: Schema, value: Record<string, unknown>, path: string): string[] {
  const failures: string[] = [];
  const properties = isRecord(schema.properties) ? schema.properties : {};

  for (const name of (schema.required as string[] | undefined) ?? []) {
    if (!(name in value)) {
      failures.push(`${describe(path)} is missing the required property ${name}`);
    }
  }

  for (const [name, held] of Object.entries(value)) {
    const declared = properties[name];
    if (declared !== undefined) {
      failures.push(...collectFailures(declared as Schema, held, child(path, name)));
      continue;
    }
    const additional = schema.additionalProperties;
    if (additional === false) {
      failures.push(`${describe(path)} carries the undeclared property ${name}`);
    } else if (isRecord(additional)) {
      failures.push(...collectFailures(additional, held, child(path, name)));
    }
  }

  return failures;
}

function checkArray(schema: Schema, value: readonly unknown[], path: string): string[] {
  const failures: string[] = [];
  const minItems = schema.minItems as number | undefined;
  const maxItems = schema.maxItems as number | undefined;

  if (minItems !== undefined && value.length < minItems) {
    failures.push(`${describe(path)} holds fewer than ${minItems} items`);
  }
  if (maxItems !== undefined && value.length > maxItems) {
    failures.push(`${describe(path)} holds more than ${maxItems} items`);
  }
  if (isRecord(schema.items)) {
    for (const [index, item] of value.entries()) {
      failures.push(...collectFailures(schema.items, item, child(path, `[${index}]`)));
    }
  }

  return failures;
}

function checkScalar(schema: Schema, value: unknown, path: string): string[] {
  const failures: string[] = [];

  if (typeof value === "string") {
    const minLength = schema.minLength as number | undefined;
    const maxLength = schema.maxLength as number | undefined;
    const pattern = schema.pattern as string | undefined;
    if (minLength !== undefined && value.length < minLength) {
      failures.push(`${describe(path)} is shorter than ${minLength} characters`);
    }
    if (maxLength !== undefined && value.length > maxLength) {
      failures.push(`${describe(path)} is longer than ${maxLength} characters`);
    }
    if (pattern !== undefined && !new RegExp(pattern, "u").test(value)) {
      failures.push(`${describe(path)} does not match ${pattern}`);
    }
  }

  if (typeof value === "number") {
    const minimum = schema.minimum as number | undefined;
    const maximum = schema.maximum as number | undefined;
    if (minimum !== undefined && value < minimum) {
      failures.push(`${describe(path)} is below ${minimum}`);
    }
    if (maximum !== undefined && value > maximum) {
      failures.push(`${describe(path)} is above ${maximum}`);
    }
  }

  return failures;
}

function collectFailures(schema: Schema, value: unknown, path: string): string[] {
  for (const keyword of Object.keys(schema)) {
    if (!supportedKeywords.has(keyword)) {
      throw new Error(`Unsupported JSON Schema keyword at ${describe(path)}: ${keyword}`);
    }
  }

  const failures: string[] = [];
  const type = schema.type as string | undefined;
  if (type !== undefined && !matchesType(value, type)) {
    return [`${describe(path)} is not of type ${type}`];
  }

  if ("const" in schema && value !== schema.const) {
    failures.push(`${describe(path)} is not ${JSON.stringify(schema.const)}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    failures.push(`${describe(path)} is not one of ${JSON.stringify(schema.enum)}`);
  }

  if (Array.isArray(schema.anyOf)) {
    const matched = schema.anyOf.some(
      (alternative) => collectFailures(alternative as Schema, value, path).length === 0,
    );
    if (!matched) {
      failures.push(`${describe(path)} matches none of the published alternatives`);
    }
  }
  if (Array.isArray(schema.oneOf)) {
    const matched = schema.oneOf.filter(
      (alternative) => collectFailures(alternative as Schema, value, path).length === 0,
    );
    if (matched.length !== 1) {
      failures.push(
        `${describe(path)} matches ${matched.length} of the published alternatives, not exactly one`,
      );
    }
  }

  if (isRecord(value)) {
    failures.push(...checkObject(schema, value, path));
  } else if (Array.isArray(value)) {
    failures.push(...checkArray(schema, value, path));
  } else {
    failures.push(...checkScalar(schema, value, path));
  }

  return failures;
}

/**
 * Validates a value against a published JSON Schema, answering every way it
 * fails. An empty result means the schema admits the value.
 */
export function schemaFailures(schema: Schema, value: unknown): readonly string[] {
  return collectFailures(schema, value, "");
}

/**
 * The argument names a published schema declares, gathered from its own
 * properties and from every alternative it offers. A schema that publishes no
 * argument yields an empty set, which is exactly the state this is used to
 * detect.
 */
export function publishedPropertyNames(node: unknown, found: Set<string> = new Set()): Set<string> {
  if (Array.isArray(node)) {
    for (const entry of node) {
      publishedPropertyNames(entry, found);
    }
    return found;
  }
  if (!isRecord(node)) {
    return found;
  }
  if (isRecord(node.properties)) {
    for (const name of Object.keys(node.properties)) {
      found.add(name);
    }
  }
  for (const value of Object.values(node)) {
    publishedPropertyNames(value, found);
  }
  return found;
}
