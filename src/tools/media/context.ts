import type { AdapterRegistry } from "../../adapters/registry.js";
import type { MediaDefaults } from "../../config/environment.js";

/**
 * Everything a `media` tool handler may reach: the adapters, and the defaults
 * the operator configured for new titles.
 *
 * Deliberately not the `arr` toolset's context. The operation registry, the
 * dispatcher, and the reference, plan, and receipt stores exist for that
 * toolset's plan and apply, and a `media` call acts once and names titles by
 * stable ids, so it has no use for any of them.
 */
export interface MediaContext {
  readonly registry: AdapterRegistry;
  readonly defaults: MediaDefaults;
}
