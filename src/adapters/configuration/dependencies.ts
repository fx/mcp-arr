import { z } from "zod";
import type { ApplicationId } from "../../applications.js";
import type { UpstreamClient } from "../../http/client.js";
import { createToolError, type ToolError } from "../../tools/errors.js";
import { routeFor } from "./domains.js";
import { isUpstreamId, parseCollection, parseConfiguration } from "./parse.js";
import type { CompiledPatch, DependencyKind } from "./patches.js";

/**
 * Dependency reading and validation for desired-state patches.
 *
 * A configuration record rarely stands alone: a provider points at tags, an
 * import list points at a quality profile and a root folder, and a full-resource
 * write that named a dependency the instance does not have would either be
 * rejected upstream or — worse — accepted and leave a resource pointing at
 * nothing. So every pointer a patch names is checked against the application's
 * own current list before anything is sent.
 *
 * The check is also what makes a pointer safe to accept from a caller at all. A
 * root folder is named by identifier and the path written upstream is the one
 * the instance itself reported, so no caller-authored filesystem path reaches a
 * write, and no path this server invented can be stored as configuration.
 *
 * Only the kinds a compiled patch actually names are read. Reading every list
 * on every reconciliation would cost requests nobody asked for and would put
 * records in the plan's reasoning that its mutation does not depend on.
 */

/** One dependency record, reduced to what a write and a refusal message need. */
export interface DependencyEntry {
  readonly id: number;
  /** The value the pointing property stores, where it is not the identifier. */
  readonly value?: string | undefined;
}

export type DependencyCatalog = ReadonlyMap<DependencyKind, ReadonlyMap<number, DependencyEntry>>;

export type DependencyRead =
  | { readonly status: "ok"; readonly catalog: DependencyCatalog }
  | { readonly status: "error"; readonly error: ToolError };

/**
 * How each dependency kind is named in a refusal, and what its pointing
 * property stores. `root_folders` is the only kind stored by value: Sonarr and
 * Radarr record an import list's root folder as a path rather than as an
 * identifier, so the instance's own path has to be carried through the write.
 */
const dependencyLabels: Readonly<Record<DependencyKind, string>> = {
  tags: "tag",
  quality_profiles: "quality profile",
  root_folders: "root folder",
};

const maxDependencyValueLength = 200;

/**
 * The dependency payload, kept to identity and the one stored value.
 *
 * Loose, like every other configuration reader: a dependency list carries
 * plenty this server has no use for, and requiring more than it reads would
 * refuse instances that work.
 */
const dependencySchema = z.array(
  z.object({
    id: z.custom<number>(isUpstreamId),
    path: z.string().nullish(),
  }),
);

function dependencyError(
  application: ApplicationId,
  code: "invalid_input" | "unsupported_capability",
  message: string,
): ToolError {
  return createToolError({ code, message: `${application}: ${message}`, application });
}

const controlCharacter = /[\p{Cc}\p{Cf}]/u;

/**
 * The stored value a dependency contributes to a write.
 *
 * A path longer than the reportable bound, or one carrying a control
 * character, is treated as no value at all rather than being written: the
 * property it would land in is one this server later reports, and an instance
 * that answered with something unreadable is not a reason to store it.
 */
function dependencyValue(path: string | null | undefined): string | undefined {
  if (typeof path !== "string") {
    return undefined;
  }
  const trimmed = path.trim();
  if (trimmed === "" || trimmed.length > maxDependencyValueLength) {
    return undefined;
  }
  return controlCharacter.test(trimmed) ? undefined : trimmed;
}

/**
 * Reads every list the patch points at, once each.
 *
 * A kind the selected application does not model is an unsupported capability
 * rather than an empty list: Prowlarr has no root folders, so an import-list
 * pointer there is a request the application cannot answer, and reporting it as
 * "no such record" would send the caller looking for a record that could never
 * exist.
 */
export async function readDependencyCatalog(
  application: ApplicationId,
  client: UpstreamClient,
  patch: CompiledPatch,
): Promise<DependencyRead> {
  const catalog = new Map<DependencyKind, ReadonlyMap<number, DependencyEntry>>();

  for (const requirement of patch.dependencies) {
    const route = routeFor(requirement.kind, application);
    if (route === undefined) {
      return {
        status: "error",
        error: dependencyError(
          application,
          "unsupported_capability",
          `this application has no ${dependencyLabels[requirement.kind]} list`,
        ),
      };
    }

    const body = parseCollection(await client.get(route), application, route);
    const records = parseConfiguration(dependencySchema, body, application, route);
    catalog.set(
      requirement.kind,
      new Map(
        records.map((record) => {
          const value = dependencyValue(record.path);
          return [record.id, { id: record.id, ...(value === undefined ? {} : { value }) }];
        }),
      ),
    );
  }

  return { status: "ok", catalog };
}

export type DependencyValidation =
  | { readonly status: "ok" }
  | { readonly status: "error"; readonly error: ToolError };

/**
 * Refuses a patch that names a record the application does not report.
 *
 * The identifier is echoed because the caller supplied it; nothing read from
 * the instance is. The first missing pointer refuses the whole patch rather
 * than the write proceeding with the pointers that did resolve, because a
 * desired state is one statement and half of it is not a smaller version of it.
 */
export function validateDependencies(
  application: ApplicationId,
  patch: CompiledPatch,
  catalog: DependencyCatalog,
): DependencyValidation {
  for (const requirement of patch.dependencies) {
    const known = catalog.get(requirement.kind);
    for (const id of requirement.ids) {
      if (known?.has(id) !== true) {
        return {
          status: "error",
          error: dependencyError(
            application,
            "invalid_input",
            `this application reports no ${dependencyLabels[requirement.kind]} with identifier ${id}`,
          ),
        };
      }
    }
  }
  return { status: "ok" };
}

/**
 * The value a reference assignment writes, which is the identifier itself
 * unless the pointing property stores something else.
 */
export function referenceValue(
  catalog: DependencyCatalog,
  kind: DependencyKind,
  id: number,
): string | number | undefined {
  const entry = catalog.get(kind)?.get(id);
  if (entry === undefined) {
    return undefined;
  }
  return kind === "root_folders" ? entry.value : entry.id;
}

export function dependencyLabel(kind: DependencyKind): string {
  return dependencyLabels[kind];
}
