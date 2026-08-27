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
 * `default`, `description`, and `format` are annotations in draft-7 rather
 * than assertions.
 *
 * `description` is here rather than absent because the throw-on-unknown guard
 * below exists to catch a *constraint* this validator has not implemented, and
 * an annotation asserts nothing there is to implement. Every published input
 * root now carries the generated variant documentation, and one nested
 * property already carried a description that no sample happened to reach.
 */
const annotationKeywords = new Set(["$schema", "default", "description", "format"]);

/**
 * The keywords this module actually enforces.
 *
 * Adding a name here is a claim that {@link matchesType}, {@link checkObject},
 * {@link checkArray}, or {@link checkScalar} implements it, and the guard below
 * has no way to check that claim — it reads membership as proof. So a keyword
 * dropped in here to get a new schema past {@link assertWellFormed}, without
 * the matching check, does not merely go unenforced: every {@link
 * schemaFailures} assertion over it silently starts passing. That is why the
 * two halves are separate sets rather than one list where an annotation and a
 * constraint are indistinguishable.
 */
const implementedKeywords = new Set([
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
]);

/** The closed vocabulary: what is enforced, plus what asserts nothing. */
const supportedKeywords = new Set([...implementedKeywords, ...annotationKeywords]);

/**
 * The one enforcement point for the closed vocabulary, shared by the value
 * check and the meta-schema check so a keyword can never be unknown to one and
 * accepted by the other.
 */
function assertSupportedKeywords(schema: Schema, path: string): void {
  for (const keyword of Object.keys(schema)) {
    if (!supportedKeywords.has(keyword)) {
      throw new Error(`Unsupported JSON Schema keyword at ${describe(path)}: ${keyword}`);
    }
  }
}

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
  assertSupportedKeywords(schema, path);

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

/** The `type` values this dialect defines. Anything else is not a schema. */
const schemaTypes = new Set(["object", "array", "string", "boolean", "integer", "number", "null"]);

/** Keywords whose value must be a number wherever they appear. */
const numericKeywords = ["maxItems", "maxLength", "maximum", "minItems", "minLength", "minimum"];

function fail(path: string, reason: string): never {
  throw new Error(`${describe(path)} ${reason}`);
}

/**
 * Checks that a published schema is a well-formed schema at every depth.
 *
 * This is the meta-schema check, reduced to the closed vocabulary these
 * schemas actually use. The vocabulary half is already here — {@link
 * assertSupportedKeywords} throws on any keyword this module has not
 * implemented — and what this adds is the other half: that every keyword
 * present carries a value of the JSON type the dialect defines for it. Over a
 * fixed keyword set
 * that reduction is exact, so a validator dependency would add a package
 * without adding coverage.
 */
export function assertWellFormed(schema: Schema, path = ""): void {
  assertSupportedKeywords(schema, path);

  if ("type" in schema && !(typeof schema.type === "string" && schemaTypes.has(schema.type))) {
    fail(path, `declares an unknown type ${JSON.stringify(schema.type)}`);
  }
  if ("required" in schema) {
    const required = schema.required;
    if (!Array.isArray(required) || required.some((name) => typeof name !== "string")) {
      fail(path, "declares a required list that is not an array of names");
    }
  }
  if ("enum" in schema && !(Array.isArray(schema.enum) && schema.enum.length > 0)) {
    fail(path, "declares an enum that is not a non-empty array");
  }
  if ("description" in schema && typeof schema.description !== "string") {
    fail(path, "declares a description that is not a string");
  }
  for (const keyword of numericKeywords) {
    if (keyword in schema && typeof schema[keyword] !== "number") {
      fail(path, `declares a ${keyword} that is not a number`);
    }
  }
  if ("pattern" in schema) {
    if (typeof schema.pattern !== "string") {
      fail(path, "declares a pattern that is not a string");
    }
    try {
      new RegExp(schema.pattern, "u");
    } catch {
      fail(path, `declares a pattern that does not compile: ${schema.pattern}`);
    }
  }

  if ("properties" in schema) {
    if (!isRecord(schema.properties)) {
      fail(path, "declares properties that are not an object");
    }
    for (const [name, declared] of Object.entries(schema.properties)) {
      if (!isRecord(declared)) {
        fail(child(path, name), "is not a schema");
      }
      assertWellFormed(declared, child(path, name));
    }
  }
  if ("additionalProperties" in schema) {
    const additional = schema.additionalProperties;
    if (typeof additional !== "boolean" && !isRecord(additional)) {
      fail(path, "declares additionalProperties that is neither a boolean nor a schema");
    }
    if (isRecord(additional)) {
      assertWellFormed(additional, child(path, "*"));
    }
  }
  if ("items" in schema) {
    if (!isRecord(schema.items)) {
      fail(child(path, "[]"), "is not a schema");
    }
    assertWellFormed(schema.items, child(path, "[]"));
  }
  for (const keyword of ["anyOf", "oneOf"] as const) {
    if (!(keyword in schema)) {
      continue;
    }
    const alternatives = schema[keyword];
    if (!Array.isArray(alternatives) || alternatives.length === 0) {
      fail(path, `declares a ${keyword} that is not a non-empty array`);
    }
    for (const [index, alternative] of alternatives.entries()) {
      if (!isRecord(alternative)) {
        fail(child(path, `${keyword}[${index}]`), "is not a schema");
      }
      assertWellFormed(alternative, child(path, `${keyword}[${index}]`));
    }
  }
}

/**
 * The values a published schema fixes one of its own properties to, in the
 * order it lists them, or none where it fixes no set.
 *
 * A flat published root states a discriminator's whole accepted set on the
 * property itself, so this is a lookup rather than a search — and one lookup,
 * shared, so the set the documentation is checked against and the set a
 * rejection message is expected to name are read the same way.
 */
export function declaredPropertyValues(schema: Schema, name: string): readonly string[] {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const node = properties[name];
  if (!isRecord(node)) {
    return [];
  }
  if (typeof node.const === "string") {
    return [node.const];
  }
  return Array.isArray(node.enum)
    ? node.enum.filter((value): value is string => typeof value === "string")
    : [];
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
