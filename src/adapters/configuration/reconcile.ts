import type { ApplicationId } from "../../applications.js";
import type { UpstreamClient } from "../../http/client.js";
import { UpstreamError } from "../../http/errors.js";
import type { ApplyReconciliation } from "../../state/apply-records.js";
import {
  compareReadSet,
  fingerprintReadSet,
  type ReadSetFingerprint,
  type ReadSetObservation,
  type SecretRequirement,
} from "../../state/plans.js";
import { createToolError, type ToolError, toolErrorForThrown } from "../../tools/errors.js";
import { readDependencyCatalog, validateDependencies } from "./dependencies.js";
import { type ConfigurationDomain, routeFor } from "./domains.js";
import { readSchemaFingerprint } from "./fingerprints.js";
import { isUpstreamRecord } from "./parse.js";
import { compileConfigurationPatch, type DesiredField } from "./patches.js";
import {
  ConfigurationResourceSet,
  captureUpstreamResource,
  type UpstreamValue,
} from "./resources.js";
import { noTransientSecrets, type TransientSecrets } from "./secrets.js";
import { verifyConfigurationApply } from "./verify.js";
import {
  type ConfigurationDiff,
  configurationObservations,
  dependencyObservations,
  type WriteOutcome,
  writeConfigurationPatch,
} from "./write.js";

/**
 * The desired-state reconciliation runtime.
 *
 * One reconciliation is always the same sequence, whether it is being planned
 * or applied: compile the desired state into typed writes, read the current
 * resource, read only the dependency lists that desired state points at, check
 * the plan's preconditions if one is being applied, validate the pointers, and
 * build the complete resource the write would send. Planning stops there;
 * applying sends it.
 *
 * Running the identical sequence for both is the point. A plan that was
 * produced by different code than the apply would describe something the apply
 * does not do, and a caller would have no way to tell.
 *
 * Two things this deliberately does not do yet, because they belong to later
 * work on this change: it does not accept transient secret values, so a
 * credential can only be cleared rather than set, and it does not re-read the
 * resource afterwards to verify what the instance stored. Neither absence is
 * hidden — a patch naming a credential is refused with the reason, and an apply
 * reports what it sent rather than claiming the instance agreed.
 */

export interface ConfigurationReconcileRequest {
  readonly domain: ConfigurationDomain;
  /** The upstream row this desired state describes. Creation is a later intent. */
  readonly targetId: number;
  readonly fields: readonly DesiredField[];
  readonly removeFields?: readonly string[] | undefined;
  readonly mode: "plan" | "apply";
  /**
   * What a recorded plan captured, supplied when that plan is being applied.
   * Its absence means a direct apply, which validates the same current state
   * but has no earlier observation to be stale against.
   */
  readonly planned?: PlannedApply | undefined;
  /**
   * The credentials supplied for this request.
   *
   * The names in it are the desired state's secret channel: a credential is
   * changed by supplying its value, so the fields this reconciliation writes as
   * secrets are exactly the ones the bundle carries. Deriving them from the
   * bundle rather than from a second list is what keeps the two from
   * disagreeing about which credentials this request is changing.
   *
   * The bundle is erased once the upstream request has been built, so it is
   * good for one reconciliation. Applying a recorded plan therefore always
   * needs the credentials again, which is the rule rather than an inconvenience
   * of it: the plan never held them.
   */
  readonly secrets?: TransientSecrets | undefined;
}

/** What a recorded plan carries into the apply that quotes it. */
export interface PlannedApply {
  readonly readSet: readonly ReadSetFingerprint[];
  /**
   * The credentials the plan validated, by name and by a process-local presence
   * fingerprint. The values were never retained, so each one has to be supplied
   * again for the request this apply builds.
   */
  readonly requiredSecrets?: readonly SecretRequirement[] | undefined;
}

interface ReconcileSuccessBase {
  readonly diff: ConfigurationDiff;
  readonly changed: boolean;
  readonly observations: readonly ReadSetObservation[];
  readonly warnings: readonly string[];
  /**
   * The credentials this reconciliation used, by name and presence only.
   *
   * A plan records these so the apply that quotes it can insist each one is
   * supplied again. There is no field here a value could travel in, and by the
   * time this is returned the bundle that held them has been erased.
   */
  readonly requiredSecrets: readonly SecretRequirement[];
}

export type ConfigurationReconcileOutcome =
  | ({ readonly status: "planned" } & ReconcileSuccessBase)
  | ({
      readonly status: "applied";
      /**
       * Whether an upstream write was dispatched.
       *
       * `false` is a proof, not an inference: it is set only on the paths that
       * return before the request is built, so a caller settling a receipt can
       * distinguish "nothing happened upstream" from "something may have".
       */
      readonly attempted: boolean;
      /**
       * What upstream state says about the write, present only when one was
       * dispatched. `indeterminate` is a real answer: the instance could not be
       * read back, so the outcome stays unknown rather than being guessed.
       */
      readonly verification?: ApplyReconciliation | undefined;
    } & ReconcileSuccessBase)
  | {
      readonly status: "error";
      readonly error: ToolError;
      /** Whether the upstream write had already been dispatched when this failed. */
      readonly attempted: boolean;
    };

function failure(
  application: ApplicationId,
  code: "invalid_input" | "stale_reference" | "stale_plan" | "unsupported_capability",
  message: string,
): ToolError {
  return createToolError({ code, message: `${application}: ${message}`, application });
}

function refuse(error: ToolError): ConfigurationReconcileOutcome {
  return { status: "error", error, attempted: false };
}

/**
 * Answers one reconciliation.
 *
 * The current resource is read as a single row rather than as the domain's
 * collection: this is a read-modify-write, and the resource it modifies has to
 * be the one the instance reports now, not one element of a page that was
 * assembled for a different purpose.
 */
export async function runConfigurationReconciliation(
  application: ApplicationId,
  client: UpstreamClient,
  request: ConfigurationReconcileRequest,
): Promise<ConfigurationReconcileOutcome> {
  const route = routeFor(request.domain, application);
  if (route === undefined) {
    return refuse(
      failure(
        application,
        "unsupported_capability",
        `the ${request.domain} configuration domain is not available on this application`,
      ),
    );
  }
  if (!Number.isSafeInteger(request.targetId) || request.targetId < 1) {
    return refuse(failure(application, "invalid_input", "that is not a configuration identifier"));
  }

  const secrets = request.secrets ?? noTransientSecrets();

  // First, and before the desired state is even compiled. A plan applied
  // without its credentials is not a stale plan and must not be reported as
  // one: the credential is the desired state's secret channel, so a patch
  // compiled without it is missing that assignment entirely — it would refuse
  // as naming nothing, or the read-set comparison would blame the record for a
  // field this call never asked about.
  const resupply = secrets.check(request.planned?.requiredSecrets ?? []);
  if (resupply.status === "missing") {
    return refuse(
      failure(
        application,
        "invalid_input",
        `this plan changes ${resupply.names.join(", ")}, so each value must be supplied again with the apply`,
      ),
    );
  }
  const requiredSecrets = secrets.requirements();

  const compilation = compileConfigurationPatch(application, request.domain, {
    fields: request.fields,
    removeFields: request.removeFields ?? [],
    secretNames: secrets.names(),
  });
  if (compilation.status === "error") {
    return refuse(compilation.error);
  }
  const patch = compilation.patch;
  const resourceRoute = `${route}/${request.targetId}`;

  let dispatched = false;
  try {
    const body = await client.get(resourceRoute);
    if (!isUpstreamRecord(body)) {
      throw new UpstreamError("unexpected-response", { application, operation: resourceRoute });
    }
    const resource = captureUpstreamResource(application, request.domain, body as UpstreamValue);
    const resources = new ConfigurationResourceSet(application, request.domain, [resource]);
    if (resources.find(request.targetId) === undefined) {
      return refuse(
        failure(
          application,
          "stale_reference",
          "this application no longer reports that configuration record",
        ),
      );
    }

    const catalogRead = await readDependencyCatalog(application, client, patch);
    if (catalogRead.status === "error") {
      return refuse(catalogRead.error);
    }
    const catalog = catalogRead.catalog;

    // The provider schema is read for its own sake: a plan can be made against
    // one dynamic field list and applied against another while the record it
    // names sits untouched, and nothing in the resource would show it.
    const schema = await readSchemaFingerprint(application, client, request.domain, resource);

    const observations = [
      ...configurationObservations(resource, patch),
      ...dependencyObservations(patch, catalog),
      ...schema.observations,
    ];

    // Before the dependency check, deliberately. A pointer that has since been
    // deleted makes a recorded plan stale, and reporting that as an invalid
    // argument would tell the caller to fix arguments it cannot fix.
    if (request.planned !== undefined) {
      const comparison = compareReadSet(request.planned.readSet, fingerprintReadSet(observations));
      if (comparison.status === "changed") {
        const moved = [...comparison.changed, ...comparison.missing].sort().join(", ");
        return refuse(
          failure(
            application,
            "stale_plan",
            `this record changed since the plan was made (${moved})`,
          ),
        );
      }
    }

    const validation = validateDependencies(application, patch, catalog);
    if (validation.status === "error") {
      return refuse(validation.error);
    }

    // Erased the moment the request has been built, which is the whole of what
    // this server ever does with a credential. The `finally` is load-bearing: a
    // write that refused halfway has still read the values it needed, and they
    // must not outlive it either.
    let written: WriteOutcome;
    try {
      written = writeConfigurationPatch({
        application,
        resource,
        patch,
        catalog,
        id: request.targetId,
        secrets,
      });
    } finally {
      secrets.erase();
    }
    if (written.status === "error") {
      return refuse(written.error);
    }
    const { diff, changed, payload } = written.write;
    const warnings = [...written.write.warnings, ...schema.warnings, ...resupply.warnings];

    if (request.mode === "plan") {
      return { status: "planned", diff, changed, observations, warnings, requiredSecrets };
    }
    if (!changed) {
      return {
        status: "applied",
        attempted: false,
        diff,
        changed: false,
        observations,
        requiredSecrets,
        warnings: [...warnings, "this record already matches the desired state; nothing was sent"],
      };
    }

    dispatched = true;
    const answered = await client.put(resourceRoute, payload);
    return {
      status: "applied",
      attempted: true,
      diff,
      changed,
      observations,
      warnings,
      requiredSecrets,
      verification: await verifyConfigurationApply(client, {
        application,
        route: resourceRoute,
        patch,
        sent: payload,
        answered,
      }),
    };
  } catch (error) {
    return {
      status: "error",
      error: toolErrorForThrown(error, application),
      attempted: dispatched,
    };
  }
}
