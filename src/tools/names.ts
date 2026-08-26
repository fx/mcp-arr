/**
 * The public tool names. This list is a stable contract: hosts and calling
 * agents bind to these names, so a name is never renamed or reused for a
 * different meaning. Read tools observe upstream state; mutation tools can
 * change it and therefore all accept `mode`.
 */
export const readToolNames = [
  "arr_capabilities",
  "arr_library_query",
  "arr_activity_query",
  "arr_release_search",
  "arr_import_inspect",
  "arr_config_observe",
  "arr_job_get",
] as const;

export const mutationToolNames = [
  "arr_search_start",
  "arr_release_grab",
  "arr_queue_resolve",
  "arr_activity_change",
  "arr_import_execute",
  "arr_library_change",
  "arr_config_reconcile",
  "arr_job_cancel",
] as const;

export const toolNames = [...readToolNames, ...mutationToolNames] as const;

export type ReadToolName = (typeof readToolNames)[number];
export type MutationToolName = (typeof mutationToolNames)[number];
export type ToolName = (typeof toolNames)[number];

const mutationToolNameSet: ReadonlySet<string> = new Set(mutationToolNames);

export function isMutationToolName(name: ToolName): name is MutationToolName {
  return mutationToolNameSet.has(name);
}
