import type { ApplicationId } from "../../applications.js";
import type { UpstreamClient } from "../../http/client.js";
import { UpstreamError } from "../../http/errors.js";
import {
  compareReadSet,
  fingerprintReadSet,
  type ReadSetFingerprint,
  type ReadSetObservation,
} from "../../state/plans.js";
import { createToolError, type ToolError, toolErrorForThrown } from "../../tools/errors.js";
import { readDependencyCatalog, validateDependencies } from "./dependencies.js";
import { type ConfigurationDomain, routeFor } from "./domains.js";
import { isUpstreamRecord } from "./parse.js";
import { compileConfigurationPatch, type DesiredField } from "./patches.js";
import {
  ConfigurationResourceSet,
  captureUpstreamResource,
  type UpstreamValue,
} from "./resources.js";
import {
  type ConfigurationDiff,
  configurationObservations,
  dependencyObservations,
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
   * The read set a recorded plan captured, supplied when that plan is being
   * applied. Its absence means a direct apply, which validates the same current
   * state but has no earlier observation to be stale against.
   */
  readonly planned?: readonly ReadSetFingerprint[] | undefined;
}

interface ReconcileSuccessBase {
  readonly diff: ConfigurationDiff;
  readonly changed: boolean;
  readonly observations: readonly ReadSetObservation[];
  readonly warnings: readonly string[];
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

  const compilation = compileConfigurationPatch(
    application,
    request.domain,
    request.fields,
    request.removeFields ?? [],
  );
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

    const observations = [
      ...configurationObservations(resource, patch),
      ...dependencyObservations(patch, catalog),
    ];

    // Before the dependency check, deliberately. A pointer that has since been
    // deleted makes a recorded plan stale, and reporting that as an invalid
    // argument would tell the caller to fix arguments it cannot fix.
    if (request.planned !== undefined) {
      const comparison = compareReadSet(request.planned, fingerprintReadSet(observations));
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

    const written = writeConfigurationPatch({
      application,
      resource,
      patch,
      catalog,
      id: request.targetId,
    });
    if (written.status === "error") {
      return refuse(written.error);
    }
    const { diff, changed, warnings, payload } = written.write;

    if (request.mode === "plan") {
      return { status: "planned", diff, changed, observations, warnings };
    }
    if (!changed) {
      return {
        status: "applied",
        attempted: false,
        diff,
        changed: false,
        observations,
        warnings: [...warnings, "this record already matches the desired state; nothing was sent"],
      };
    }

    dispatched = true;
    await client.put(resourceRoute, payload);
    return { status: "applied", attempted: true, diff, changed, observations, warnings };
  } catch (error) {
    return {
      status: "error",
      error: toolErrorForThrown(error, application),
      attempted: dispatched,
    };
  }
}
