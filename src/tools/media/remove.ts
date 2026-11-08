import { recordResourcePath } from "../../adapters/library/changes.js";
import { deleteRecordResource, recordDeletionQuery } from "../../adapters/library/files.js";
import { readLibraryTitleByExternalId } from "../../adapters/library/titles.js";
import { isUpstreamError } from "../../http/errors.js";
import { toolErrorProvesNoEffect } from "../errors.js";
import type { MediaContext } from "./context.js";
import { mediaErrorFor } from "./errors.js";
import { kindRoutes, type TitleKind } from "./kinds.js";
import type { RemoveOutcome, RemoveResult } from "./schemas.js";
import { namedTitle, resolveTitle } from "./titles.js";

export interface RemoveRequest {
  readonly kind: TitleKind;
  readonly id: number;
  readonly deleteFiles: boolean;
}

/**
 * Removes one title from the library, deleting its files only when asked and
 * never excluding it from being added again.
 *
 * A title that is not there is an answer, not a failure: one that was never
 * added, and one another call removed in the meantime — whose delete this
 * instance answers with a 404 — are both `not_in_library`, and nothing is
 * changed. A delete whose answer was lost is settled by reading the title
 * again: gone means this call removed it, still there means it did not.
 *
 * Removals of one title run one at a time, across every call this process
 * serves, so a second removal reads the library only after the first has
 * settled and finds the title gone, whether or not the instance would have
 * answered its delete with a 404.
 */
export function removeTitle(context: MediaContext, request: RemoveRequest): Promise<RemoveResult> {
  return context.titleLocks.run(`${request.kind}:${request.id}`, () =>
    removeTitleOnce(context, request),
  );
}

async function removeTitleOnce(
  context: MediaContext,
  request: RemoveRequest,
): Promise<RemoveResult> {
  const { kind, id, deleteFiles } = request;
  const route = kindRoutes[kind];
  const resolved = await resolveTitle(context, kind, id);
  if (!resolved.ok) {
    return { warnings: [], errors: [resolved.error] };
  }
  const named = namedTitle(kind, id, resolved.title);
  const done = (outcome: RemoveOutcome): RemoveResult => ({
    ...named,
    outcome,
    files_deleted: deleteFiles && outcome === "removed",
    warnings: [],
    errors: [],
  });
  const record = resolved.record;
  if (record === undefined) {
    return done("not_in_library");
  }
  const client = resolved.adapter.client;

  try {
    await deleteRecordResource(
      client,
      recordResourcePath(route.record, record.id),
      recordDeletionQuery(route.application, { deleteFiles, addImportListExclusion: false }),
    );
    return done("removed");
  } catch (error) {
    if (isUpstreamError(error) && error.kind === "not-found") {
      return done("not_in_library");
    }
    const failure = mediaErrorFor(kind, error);
    if (toolErrorProvesNoEffect(failure.code)) {
      return { ...named, warnings: [], errors: [failure] };
    }
    try {
      const after = await readLibraryTitleByExternalId(client, route.application, id);
      return after === undefined ? done("removed") : { ...named, warnings: [], errors: [failure] };
    } catch {
      return { ...named, warnings: [], errors: [failure] };
    }
  }
}
