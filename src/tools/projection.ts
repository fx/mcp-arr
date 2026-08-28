import { z } from "zod";
import { isRecord, type JsonSchema } from "./schemas/json-schema.js";
import { type PayloadInventory, payloadInventory } from "./schemas/publish-results.js";

/**
 * Returning only the parts of a payload a caller named.
 *
 * A projection is resolved against the same generated inventory the tool
 * publishes, so the paths a caller is told about and the paths that resolve are
 * one list rather than two that can drift. It runs after `runTool` has validated
 * the envelope against the tool's own output schema, which is what makes every
 * projected result provably a subset of one already known to conform: nothing
 * here can add a value, reshape one, or reach anything the unprojected call
 * would not have returned.
 *
 * What it never removes is the envelope, a per-application outcome's own fields,
 * and the payload's discriminating field. Those are what makes a result
 * interpretable — which application answered, whether it partly failed, whether
 * more pages exist, and which payload this is — and they are small and fixed, so
 * nothing is gained by allowing their removal.
 */

/** The input property a projection arrives in. */
const projectionProperty = "projection";

/**
 * Reads the projection an already-validated input carried.
 *
 * Re-narrowed rather than cast, exactly as the dispatcher re-narrows the variant
 * and the application filter: a schema change can then never feed this a value
 * it did not expect, and a caller that reached `runTool` some other way is
 * answered as though it named none.
 */
export function readProjection(input: unknown): readonly string[] | undefined {
  if (!isRecord(input)) {
    return undefined;
  }
  const declared = input[projectionProperty];
  if (!Array.isArray(declared) || declared.length === 0) {
    return undefined;
  }
  return declared.every((path): path is string => typeof path === "string" && path !== "")
    ? declared
    : undefined;
}

/**
 * Whether a tool takes a projection at all, read off the schema it publishes
 * rather than from a list of the tools that do today.
 *
 * The distinction is not decoration. A mutation's payload is a diff, a receipt,
 * or a job projection — small, and every part of it is the answer — so a
 * projected receipt is a hazard rather than a saving, and this is the check that
 * says so at the projecting site instead of trusting that validation elsewhere
 * refused the argument. A tool that gains the shared query shape gains the
 * projection here too, with nothing to remember.
 *
 * Weak because the key is the schema itself, and answered once per schema: the
 * conversion is the same one publication performs, and every call to a tool asks
 * this same question of the same module-level object.
 */
const projectionAcceptance = new WeakMap<z.ZodType, boolean>();

export function acceptsProjection(inputSchema: z.ZodType): boolean {
  const known = projectionAcceptance.get(inputSchema);
  if (known !== undefined) {
    return known;
  }
  const converted = z.toJSONSchema(inputSchema, { target: "draft-7", io: "input" }) as JsonSchema;
  const properties = converted.properties;
  const accepts = isRecord(properties) && properties[projectionProperty] !== undefined;
  projectionAcceptance.set(inputSchema, accepts);
  return accepts;
}

/**
 * The paths the payload in hand publishes.
 *
 * A discriminated payload is chosen by the value it carries, so a projection
 * against a movies page is matched against the movies paths and not against the
 * union of everything the tool can return. A payload the inventory does not
 * discriminate — and one carrying a value no alternative claims, which a
 * validated envelope cannot produce — falls back to the union: it offers more
 * than one call can use, but every path it offers is one some payload of this
 * tool really publishes, and a path that names nothing present is simply not
 * copied.
 */
function availablePaths(inventory: PayloadInventory, data: Record<string, unknown>): string[] {
  const discriminator = inventory.discriminator;
  const value = discriminator === undefined ? undefined : data[discriminator];
  const selected =
    typeof value === "string"
      ? inventory.payloads.filter((payload) => payload.variants.includes(value))
      : [];
  const payloads = selected.length > 0 ? selected : inventory.payloads;
  return [...new Set(payloads.flatMap((payload) => [...payload.paths]))];
}

/**
 * Whether a path names something the payload publishes.
 *
 * Either a leaf the inventory lists, or an interior node the paths below it
 * descend through — `items` and `items.radarr` are both legitimate ways to ask
 * for everything underneath, and recognising them positively is what keeps the
 * two forms from needing separate handling. Nothing else is a match, including a
 * path that merely shares a textual prefix with one: the separator is part of
 * the test, so `item` never names `items`.
 */
function names(available: readonly string[], path: string): boolean {
  return (
    available.includes(path) || available.some((candidate) => candidate.startsWith(`${path}.`))
  );
}

/**
 * The longest prefix of an unmatched path that still names something, which is
 * where reading it stopped. The empty string means it stopped at the payload
 * itself, so the first segment was already wrong.
 */
function stoppedAt(available: readonly string[], path: string): string {
  const segments = path.split(".");
  for (let depth = segments.length - 1; depth > 0; depth -= 1) {
    const prefix = segments.slice(0, depth).join(".");
    if (available.some((candidate) => candidate.startsWith(`${prefix}.`))) {
      return prefix;
    }
  }
  return "";
}

/**
 * What the payload offers one step past a stopping point.
 *
 * One step rather than every leaf beneath it, because the whole list is both
 * more than a caller needs to fix a wrong segment and, on a wide payload,
 * several kilobytes of warning inside a change whose purpose is fewer bytes.
 * Each answer is itself a projectable path — an interior one selects everything
 * below it — so a caller can correct the guess by copying one, and read further
 * from the inventory the listing already carries.
 */
function offeredUnder(available: readonly string[], prefix: string): readonly string[] {
  const depth = prefix === "" ? 0 : prefix.split(".").length;
  const under =
    prefix === "" ? available : available.filter((path) => path.startsWith(`${prefix}.`));
  return [
    ...new Set(
      under.map((path) =>
        path
          .split(".")
          .slice(0, depth + 1)
          .join("."),
      ),
    ),
  ];
}

/**
 * The fields to copy, as a tree.
 *
 * A node mapping to `undefined` is taken whole, which is how a leaf and an
 * interior node a caller named end up meaning the same thing to {@link pick}. A
 * path arriving below one already taken whole changes nothing — the wider
 * selection already includes it — so the wider one wins rather than being
 * narrowed by a later, more specific sibling.
 */
type Selection = Map<string, Selection | undefined>;

function select(into: Selection, segments: readonly string[]): void {
  const [head, ...rest] = segments;
  if (head === undefined) {
    return;
  }
  if (rest.length === 0) {
    into.set(head, undefined);
    return;
  }
  const below = into.get(head);
  if (below === undefined && into.has(head)) {
    return;
  }
  const next = below ?? new Map<string, Selection | undefined>();
  into.set(head, next);
  select(next, rest);
}

/**
 * One payload, reduced to the selection.
 *
 * An array contributes no path segment, so the same selection is applied to
 * every element — which is how one path names a field on every record. Elements
 * are mapped rather than filtered: a projection selects fields, never rows, so a
 * record none of the named fields is present on stays in place as an empty
 * object and the page still reports what the query matched.
 *
 * A property that selected nothing is left out rather than written as an empty
 * object, and this is the difference between narrowing a result and inventing
 * one. The inventory publishes a path for every field the schema declares,
 * optional ones and the ones only `detail: "full"` fills in included, so a
 * legitimate projection routinely names a field a given record does not carry —
 * and an object written where the record had nothing selected under it is a
 * value the unprojected call would never have returned. Absence is answered as
 * absence, at whichever depth it is found: a key missing from the source, a key
 * whose value is the explicit `undefined` an optional field is built as, a
 * nested object none of whose selected fields were there, and — unreachably,
 * since the selection only ever holds inventory paths — a value with no fields
 * below it at all.
 *
 * The one absence that is still written down is a row. An array element that
 * selected nothing stays in place as an empty object, because a projection
 * selects fields and never rows, and dropping the element would make a page
 * disagree with the count beside it about how much the query matched.
 */
function pick(source: unknown, selection: Selection): unknown {
  if (Array.isArray(source)) {
    return source.map((element) => pick(element, selection) ?? {});
  }
  if (!isRecord(source)) {
    return undefined;
  }
  const projected: Record<string, unknown> = {};
  for (const [name, below] of selection) {
    if (!(name in source)) {
      continue;
    }
    const value = below === undefined ? source[name] : pick(source[name], below);
    if (value !== undefined) {
      projected[name] = value;
    }
  }
  return Object.keys(projected).length === 0 ? undefined : projected;
}

/**
 * The one warning an unmatched projection produces.
 *
 * It names every path that matched nothing and, beside it, the paths that were
 * available where each stopped. That is what makes a wrong guess self-correcting
 * inside the same call: the caller reads the alternatives and re-sends, rather
 * than paying a round trip for a rejection and then a second one for the
 * listing. The call itself still succeeds and still returns its matched
 * selection.
 */
function describeUnmatched(
  unmatched: readonly string[],
  offered: ReadonlyMap<string, readonly string[]>,
): string {
  const where = [...offered].map(([prefix, paths]) => {
    const at = prefix === "" ? "the payload" : prefix;
    return paths.length === 0 ? `${at} offers no field` : `${at} offers ${paths.join(", ")}`;
  });
  return `these projection paths matched nothing and were ignored: ${unmatched.join(", ")}; ${where.join("; ")}`;
}

export interface ProjectedEnvelope {
  /** The envelope with each payload reduced, and the warning already in it. */
  readonly content: Record<string, unknown>;
  /** What to add to the summarized result, or `undefined` when all matched. */
  readonly warning: string | undefined;
}

/**
 * Reduces every per-application payload in a validated envelope to what the
 * projection named.
 *
 * Only `applications[].data` is touched. The envelope's own keys, an outcome's
 * own fields, and an outcome that carries no payload at all are copied through
 * untouched, so no projection — including one naming those paths outright, or a
 * prefix of them, or nothing that matches — can remove them.
 */
export function projectEnvelope(
  outputSchema: z.ZodType,
  content: Record<string, unknown>,
  projection: readonly string[],
): ProjectedEnvelope {
  const inventory = payloadInventory(outputSchema);
  const outcomes = content.applications;
  if (inventory === undefined || !Array.isArray(outcomes)) {
    return { content, warning: undefined };
  }

  // Collected across applications, so a path missing from both of two payloads
  // is named once rather than once per instance that could not offer it.
  const unmatched = new Set<string>();
  const offered = new Map<string, readonly string[]>();

  const projected = outcomes.map((outcome) => {
    if (!isRecord(outcome) || !isRecord(outcome.data)) {
      return outcome;
    }
    const available = availablePaths(inventory, outcome.data);
    const selection: Selection = new Map();
    if (inventory.discriminator !== undefined) {
      selection.set(inventory.discriminator, undefined);
    }
    for (const path of projection) {
      if (names(available, path)) {
        select(selection, path.split("."));
        continue;
      }
      const prefix = stoppedAt(available, path);
      unmatched.add(path);
      if (!offered.has(prefix)) {
        offered.set(prefix, offeredUnder(available, prefix));
      }
    }
    // An outcome that carried a payload still carries one, even where nothing
    // in it was selected: `data` is part of what the outcome says about the
    // call, and dropping it would report that the application answered without
    // one.
    return { ...outcome, data: pick(outcome.data, selection) ?? {} };
  });

  const warning = unmatched.size === 0 ? undefined : describeUnmatched([...unmatched], offered);
  const warnings = Array.isArray(content.warnings) ? content.warnings : [];
  return {
    content: {
      ...content,
      applications: projected,
      ...(warning === undefined ? {} : { warnings: [...warnings, warning] }),
    },
    warning,
  };
}
