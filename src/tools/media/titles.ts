import { type LibraryTitle, readLibraryTitleByExternalId } from "../../adapters/library/titles.js";
import type { ApplicationAdapter } from "../../adapters/registry.js";
import type { MediaContext } from "./context.js";
import { type MediaError, mediaErrorFor } from "./errors.js";
import { kindRoutes, type TitleKind } from "./kinds.js";
import { kindAdapter } from "./probe.js";
import { publishedText } from "./published-text.js";

/**
 * A title named by kind and id, resolved to the library record it is filed
 * as — or to nothing, for a title that is not in the library.
 */
export type ResolvedTitle =
  | {
      readonly ok: true;
      readonly adapter: ApplicationAdapter;
      /** The version the instance answered with. */
      readonly version: string;
      readonly record: LibraryTitle | undefined;
      /** The record's title as a result may carry it, where anything publishable is left. */
      readonly title: string | undefined;
    }
  | { readonly ok: false; readonly error: MediaError };

/**
 * Resolves one title within this call.
 *
 * The id is the metadata source's, so it survives a restart, and the library
 * record it stands for is found again on every call rather than remembered.
 */
export async function resolveTitle(
  context: MediaContext,
  kind: TitleKind,
  id: number,
): Promise<ResolvedTitle> {
  const served = await kindAdapter(context, kind);
  if (!served.ok) {
    return served;
  }
  try {
    const record = await readLibraryTitleByExternalId(
      served.adapter.client,
      kindRoutes[kind].application,
      id,
    );
    const title = record?.title === undefined ? undefined : publishedText(context, record.title);
    return { ok: true, adapter: served.adapter, version: served.version, record, title };
  } catch (error) {
    return { ok: false, error: mediaErrorFor(kind, error) };
  }
}

/** The title fields a result names a title with. */
export function namedTitle(
  kind: TitleKind,
  id: number,
  title: string | undefined,
): { readonly kind: TitleKind; readonly id: number; readonly title?: string } {
  return { kind, id, ...(title === undefined ? {} : { title }) };
}
