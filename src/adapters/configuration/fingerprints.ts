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
 * types, whether each is advanced, and — the one that matters most — whether
 * each is a credential. A definition that reclassifies a field from a plain
 * setting to a password has changed what a write to it means, and a plan made
 * before that reclassification must not be applied after it.
 *
 * What is digested is the *serialized* template rather than the raw payload,
 * which is deliberate twice over: the serializer already drops the default
 * values a schema endpoint echoes back — for a configured template those are
 * current settings — and it is the same shape the observation publishes, so the
 * fingerprint moves exactly when what a caller was told moves.
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

function templateFor(
  templates: readonly ProviderTemplate[],
  implementation: string | undefined,
): ProviderTemplate | undefined {
  if (implementation === undefined) {
    return undefined;
  }
  return templates.find((template) => template.implementation.toLowerCase() === implementation);
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
  return {
    observations: [
      { key: schemaKey, value: template === undefined ? missingTemplate : fingerprint(template) },
    ],
    warnings:
      template === undefined
        ? ["this instance offers no provider template for this record's implementation"]
        : [],
  };
}
