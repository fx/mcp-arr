import type { ApplicationId } from "../../applications.js";
import type { UpstreamClient } from "../../http/client.js";
import { isUpstreamError, type UpstreamErrorKind } from "../../http/errors.js";
import type { ReadSetObservation } from "../../state/plans.js";
import { fingerprint } from "../../state/tokens.js";
import { type ConfigurationDomain, isProviderDomain, providerSchemaRouteFor } from "./domains.js";
import type { ProviderTemplate } from "./model.js";
import { isUpstreamRecord, parseCollection } from "./parse.js";
import type { UpstreamResource } from "./resources.js";
import { serializeProviderTemplate } from "./serialize.js";

/**
 * The provider-schema fingerprint.
 *
 * A provider's field list does not live in this server and does not live in the
 * resource either: it comes from the instance's schema endpoint, and on Prowlarr
 * it ultimately comes from a tracker definition file an operator can update
 * without touching any configuration. So a plan can be built against one field
 * list and applied against another while the record itself sits untouched —
 * every value the plan named still reads exactly as it did, and the plan is
 * nonetheless describing a provider that no longer exists in that shape.
 *
 * Fingerprinting the schema is what makes that visible. The digest covers the
 * template this resource's implementation is built from: its field names, their
 * types, and — the one that matters most — whether each is a credential. A
 * definition that reclassifies a field from a plain setting to a password has
 * changed what a write to it means, and a plan made before that
 * reclassification must not be applied after it.
 *
 * What is digested is the *serialized* template rather than the raw payload,
 * because the serializer already drops the default values a schema endpoint
 * echoes back — for a configured template those are current settings, and a
 * plan must not expire because someone edited a default it never used.
 *
 * From that template only the semantics are digested, and the read-set rule
 * decides which those are: a fingerprint has to move when the plan's meaning
 * moves and must not move for anything else, or valid plans expire and callers
 * learn to re-plan reflexively. A field's name, its type, and whether it is a
 * credential all change what writing to it means. A display label, a template's
 * own display name, and the advanced flag change how an interface renders it
 * and nothing else, so they are left out — as is the order the instance happens
 * to list its fields in.
 */

/** The schema half of a plan's read set, and anything the caller should know. */
export interface SchemaFingerprint {
  readonly observations: readonly ReadSetObservation[];
  readonly warnings: readonly string[];
}

const empty: SchemaFingerprint = { observations: [], warnings: [] };

/** The observation key both a plan and its apply compare under. */
const schemaKey = "provider-schema";

/**
 * What is digested when the instance answers but has nothing to say about this
 * implementation. It is a value like any other, so a template that disappears
 * between plan and apply expires the plan rather than being read as "no change".
 */
const missingTemplate = "template-absent";

/**
 * What is digested when the instance does not answer at all.
 *
 * Older instances do not expose a schema route for every provider domain, and a
 * reconciliation that failed outright there would refuse work this server can
 * otherwise do safely. So an unreadable schema is recorded as its own value and
 * disclosed: the plan is still comparable — it goes stale if the schema becomes
 * readable, or stops being so — while the caller is told plainly that a schema
 * change cannot invalidate it.
 */
const unreadableSchema = "schema-unreadable";

/** What is digested when the instance offers more than one matching template. */
const ambiguousTemplate = "template-ambiguous";

const degradableSchemaFailures: ReadonlySet<UpstreamErrorKind> = new Set([
  "not-found",
  "validation",
  "unexpected-response",
]);

function implementationOf(resource: UpstreamResource): string | undefined {
  const payload = resource.payload();
  if (!isUpstreamRecord(payload) || typeof payload.implementation !== "string") {
    return undefined;
  }
  const trimmed = payload.implementation.trim();
  return trimmed === "" ? undefined : trimmed.toLowerCase();
}

/**
 * The template this record is built from, or why there is not exactly one.
 *
 * An instance that offers the same implementation twice has not said which
 * definition a write is against, so the answer is `ambiguous` rather than
 * whichever matched first: a fingerprint taken from one of two candidates would
 * claim a certainty the schema does not support.
 */
function templateFor(
  templates: readonly ProviderTemplate[],
  implementation: string | undefined,
): ProviderTemplate | "ambiguous" | undefined {
  if (implementation === undefined) {
    return undefined;
  }
  const matched = templates.filter(
    (template) => template.implementation.toLowerCase() === implementation,
  );
  return matched.length > 1 ? "ambiguous" : matched[0];
}

/**
 * The part of a template a write's meaning actually depends on.
 *
 * The two identifiers are folded to lower case because that is how they are
 * matched: {@link templateFor} finds this template by a case-insensitive
 * implementation, so an instance that re-cased its own name selects the same
 * template and produces the same write, and a digest that moved for it would
 * expire every plan over a spelling. A field name keeps its case, because the
 * writer matches one exactly.
 */
function semanticsOf(template: ProviderTemplate): unknown {
  return {
    implementation: template.implementation.toLowerCase(),
    configContract: template.configContract?.toLowerCase(),
    fields: template.fields
      .map((field) => ({ name: field.name, type: field.type, secret: field.secret }))
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)),
  };
}

/**
 * Reads the schema this resource's provider is defined by and digests it.
 *
 * Only a provider domain has one. A profile, a tag, or a root folder has a
 * shape the application itself compiles in, so there is no second document that
 * can move underneath a plan and nothing here to observe.
 */
export async function readSchemaFingerprint(
  application: ApplicationId,
  client: UpstreamClient,
  domain: ConfigurationDomain,
  resource: UpstreamResource,
): Promise<SchemaFingerprint> {
  if (!isProviderDomain(domain)) {
    return empty;
  }
  const route = providerSchemaRouteFor(domain, application);
  if (route === undefined) {
    return empty;
  }

  let templates: readonly ProviderTemplate[];
  try {
    const body = parseCollection(await client.get(route), application, route);
    templates = body.flatMap((value) => {
      if (!isUpstreamRecord(value)) {
        return [];
      }
      const template = serializeProviderTemplate(
        { application, domain, route, detail: "full" },
        value,
      );
      return template === undefined ? [] : [template];
    });
  } catch (error) {
    // Only an instance that could not answer *this question*: the route is not
    // there, it refused the request, or it answered with something this server
    // cannot read as a schema. A timeout, an unreachable instance, a rejected
    // credential, or a rate limit is a failure of the whole reconciliation and
    // is left to the caller's own error handling — carrying on would build a
    // plan against an instance this server is not reliably talking to.
    if (!isUpstreamError(error) || !degradableSchemaFailures.has(error.kind)) {
      throw error;
    }
    return {
      observations: [{ key: schemaKey, value: unreadableSchema }],
      warnings: [
        "this instance did not answer with a readable provider schema, so a schema change cannot make this plan stale",
      ],
    };
  }

  const template = templateFor(templates, implementationOf(resource));
  if (template === undefined || template === "ambiguous") {
    return {
      observations: [
        { key: schemaKey, value: template === undefined ? missingTemplate : ambiguousTemplate },
      ],
      warnings: [
        template === undefined
          ? "this instance offers no provider template for this record's implementation"
          : "this instance offers more than one provider template for this record's implementation, so which definition a write is against cannot be established",
      ],
    };
  }
  return {
    observations: [{ key: schemaKey, value: fingerprint(semanticsOf(template)) }],
    warnings: [],
  };
}
