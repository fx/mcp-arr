import type { AdapterRegistry } from "../../adapters/registry.js";
import type { MediaDefaults } from "../../config/environment.js";
import type { Clock } from "../../state/clock.js";
import type { DownloadClaims } from "../../state/download-claims.js";

/**
 * Everything a `media` tool handler may reach: the adapters, the defaults
 * the operator configured for new titles, the downloads this process is
 * fixing, and the clock status windows are measured from.
 *
 * Deliberately not the `arr` toolset's context. The operation registry, the
 * dispatcher, and the reference, plan, and receipt stores exist for that
 * toolset's plan and apply, and a `media` call acts once and names titles by
 * stable ids, so it has no use for any of them. The claims are the exception
 * that proves the rule: they are the process's, not the call's, so they come
 * from the workflow state every call shares.
 */
export interface MediaContext {
  readonly registry: AdapterRegistry;
  readonly defaults: MediaDefaults;
  readonly claims: DownloadClaims;
  readonly clock: Clock;
}
