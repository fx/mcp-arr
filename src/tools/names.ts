/**
 * The public tool names. This list is a stable contract: hosts and calling
 * agents bind to these names, so a name is never renamed or reused for a
 * different meaning. Read tools observe upstream state; mutation tools can
 * change it and therefore all accept `mode`.
 */
/**
 * The meta tool. It reports the internal operation inventory rather than being
 * an entry in it, so it is named separately and every projected list is built
 * around it instead of hand-excluding it.
 */
export const capabilitiesToolName = "arr_capabilities";

const projectedReadToolNames = [
  "arr_library_query",
  "arr_activity_query",
  "arr_release_search",
  "arr_import_inspect",
  "arr_config_observe",
  "arr_job_get",
] as const;

export const readToolNames = [capabilitiesToolName, ...projectedReadToolNames] as const;

export const mutationToolNames = [
  "arr_search_start",
  "arr_release_grab",
  "arr_queue_resolve",
  "arr_activity_change",
  "arr_import_execute",
  "arr_library_change",
  "arr_job_cancel",
] as const;

/**
 * The tools a capability report can name: every tool the internal operation
 * registry is allowed to declare an operation for. Derived from the same lists
 * as {@link toolNames}, so adding a tool cannot leave the two out of step.
 */
export const projectedToolNames = [...projectedReadToolNames, ...mutationToolNames] as const;

export const toolNames = [capabilitiesToolName, ...projectedToolNames] as const;

export type ReadToolName = (typeof readToolNames)[number];
export type MutationToolName = (typeof mutationToolNames)[number];
export type ProjectedToolName = (typeof projectedToolNames)[number];
export type ToolName = (typeof toolNames)[number];

const mutationToolNameSet: ReadonlySet<string> = new Set(mutationToolNames);

/**
 * The `media` toolset's names, kept apart from the `arr` lists above.
 *
 * Nothing about the operation registry or the capability report applies to
 * them, so {@link ToolName} stays the `arr` names alone and every structure
 * keyed by it is unaffected. `media_remove` is listed with the rest and
 * published only when the operator enables it, so a deployment is never
 * offered a tool that refuses unconditionally.
 */
export const mediaToolNames = [
  "media_find",
  "media_add",
  "media_status",
  "media_fix",
  "media_search_again",
  "media_remove",
] as const;

export type MediaToolName = (typeof mediaToolNames)[number];

/** The `media` tools a deployment publishes, `media_remove` only where the operator enabled it. */
export function publishedMediaToolNames(allowRemove: boolean): readonly MediaToolName[] {
  return mediaToolNames.filter((name) => allowRemove || name !== "media_remove");
}

/** Every name either toolset can publish. The two prefixes keep them disjoint. */
export type PublishedToolName = ToolName | MediaToolName;

export function isMutationToolName(name: ToolName): name is MutationToolName {
  return mutationToolNameSet.has(name);
}
