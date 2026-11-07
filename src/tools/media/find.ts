import type { LookupResult } from "../../adapters/library/model.js";
import { runLibraryQuery } from "../../adapters/library/service.js";
import { maxPageSize } from "../schemas/common.js";
import type { MediaContext } from "./context.js";
import { type MediaError, mediaError, mediaErrorForCode } from "./errors.js";
import { kindRoutes, type TitleKind, titleKinds } from "./kinds.js";
import { configuredKinds, kindAdapter } from "./probe.js";
import type { FindResult, FoundTitle } from "./schemas.js";

/** The most titles `media_find` returns for one kind. */
export const maxFoundTitlesPerKind = 5;

export interface FindRequest {
  readonly text: string;
  readonly kind?: TitleKind | undefined;
}

type KindSearch =
  | { readonly ok: true; readonly titles: readonly FoundTitle[] }
  | { readonly ok: false; readonly error: MediaError };

/** The metadata identifier a lookup result carries for its kind. */
function metadataId(result: LookupResult): number | undefined {
  const id = result.application === "sonarr" ? result.sonarr.tvdbId : result.radarr.tmdbId;
  return id !== undefined && Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

function foundTitle(kind: TitleKind, result: LookupResult): FoundTitle | undefined {
  const id = metadataId(result);
  if (id === undefined || result.title.trim() === "") {
    return undefined;
  }
  return {
    kind,
    id,
    title: result.title,
    ...(result.year !== undefined && Number.isSafeInteger(result.year) && result.year > 0
      ? { year: result.year }
      : {}),
    in_library: result.existing !== undefined,
  };
}

/**
 * Searches one kind through the existing lookup view.
 *
 * A result with no metadata identifier is dropped before the bound is applied,
 * because nothing could be done with it: every other tool names a title by
 * exactly that id. What is left keeps the order the metadata source ranked it
 * in.
 */
async function searchKind(
  context: MediaContext,
  kind: TitleKind,
  text: string,
): Promise<KindSearch> {
  const served = await kindAdapter(context, kind);
  if (!served.ok) {
    return served;
  }
  const outcome = await runLibraryQuery(kindRoutes[kind].application, served.adapter.client, {
    view: "lookup",
    term: text,
    detail: "summary",
    paging: { pageSize: maxPageSize },
  });
  if (outcome.status === "error") {
    return { ok: false, error: mediaErrorForCode(kind, outcome.error.code) };
  }
  if (outcome.data.view !== "lookup") {
    return { ok: false, error: mediaError(kind, "unexpected_response") };
  }
  const titles = outcome.data.items
    .map((result) => foundTitle(kind, result))
    .filter((title): title is FoundTitle => title !== undefined)
    .slice(0, maxFoundTitlesPerKind);
  return { ok: true, titles };
}

/**
 * Finds titles of the requested kind, or of every kind this deployment serves.
 *
 * Each kind is searched in parallel and fails on its own: a kind that could
 * not be searched is named as unavailable beside the titles the others found,
 * and the call fails only when no kind could be searched at all. Nothing here
 * writes anything upstream.
 */
export async function findTitles(context: MediaContext, request: FindRequest): Promise<FindResult> {
  const kinds = request.kind === undefined ? configuredKinds(context, titleKinds) : [request.kind];
  if (kinds.length === 0) {
    // Nothing this toolset serves is configured; each kind says so for itself.
    return {
      titles: [],
      unavailable: [],
      warnings: [],
      errors: titleKinds.map((kind) => mediaError(kind, "unconfigured_application")),
    };
  }

  const searches = await Promise.all(
    kinds.map(async (kind) => ({ kind, search: await searchKind(context, kind, request.text) })),
  );
  const failed = searches.flatMap(({ kind, search }) =>
    search.ok ? [] : [{ kind, error: search.error }],
  );
  if (failed.length === searches.length) {
    return { titles: [], unavailable: [], warnings: [], errors: failed.map(({ error }) => error) };
  }
  return {
    titles: searches.flatMap(({ search }) => (search.ok ? search.titles : [])),
    unavailable: failed,
    warnings: [],
    errors: [],
  };
}
