import type { ApplicationAdapter } from "../../adapters/registry.js";
import { toolErrorCodeForUpstreamKind } from "../errors.js";
import type { MediaContext } from "./context.js";
import { type MediaError, mediaError } from "./errors.js";
import { kindRoutes, type TitleKind } from "./kinds.js";

export type KindAdapter =
  | {
      readonly ok: true;
      readonly adapter: ApplicationAdapter;
      /** The version the instance answered with, for the checks that gate on one. */
      readonly version: string;
    }
  | { readonly ok: false; readonly error: MediaError };

/**
 * The adapter that serves one kind, once its instance has answered as a
 * version this server supports.
 *
 * A kind whose application is not configured is refused without a request,
 * and one whose instance is unreachable or too old is refused before anything
 * else is read from it, so a failure names the kind's own state rather than
 * whichever route happened to answer first.
 */
export async function kindAdapter(context: MediaContext, kind: TitleKind): Promise<KindAdapter> {
  const adapter = context.registry.adapter(kindRoutes[kind].application);
  if (adapter === undefined) {
    return { ok: false, error: mediaError(kind, "unconfigured_application") };
  }
  const capability = await adapter.probe();
  switch (capability.status) {
    case "available":
      return { ok: true, adapter, version: capability.version };
    case "unsupported":
      return { ok: false, error: mediaError(kind, "unsupported_capability") };
    case "unavailable":
      return {
        ok: false,
        error: mediaError(
          kind,
          toolErrorCodeForUpstreamKind(capability.failure.kind, "server_composed"),
        ),
      };
  }
}

/** The kinds this deployment serves, in {@link titleKinds} order. */
export function configuredKinds(context: MediaContext, kinds: readonly TitleKind[]): TitleKind[] {
  return kinds.filter(
    (kind) => context.registry.adapter(kindRoutes[kind].application) !== undefined,
  );
}
