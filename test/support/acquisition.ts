import type { ReleaseSearchItem } from "../../src/adapters/acquisition/model.js";
import type { ReleasePaging } from "../../src/adapters/acquisition/requests.js";
import type { ReleaseSearchOutcome } from "../../src/adapters/acquisition/service.js";

/**
 * Release-search test support.
 *
 * The upstream harness itself is shared with the library tests: it is the real
 * upstream client with the network replaced, which is exactly what an adapter
 * test needs whichever adapter it exercises. Only the release-shaped helpers
 * live here.
 */
export {
  type HarnessOptions,
  jsonResponse,
  libraryHarness as searchHarness,
  type UpstreamCall,
} from "./library.js";

/**
 * The paging a search carries. The default matches the page size the published
 * tool schema applies when a caller omits one.
 */
export function releasePaging(pageSize = 25, cursor?: string): ReleasePaging {
  return { pageSize, cursor };
}

export function expectOk(outcome: ReleaseSearchOutcome) {
  if (outcome.status !== "ok") {
    throw new Error(`Expected an ok outcome, got ${outcome.error.code}: ${outcome.error.message}`);
  }
  return outcome;
}

export function expectError(outcome: ReleaseSearchOutcome) {
  if (outcome.status !== "error") {
    throw new Error("Expected an error outcome");
  }
  return outcome.error;
}

/** The release titles a page returned, in the order the adapter produced them. */
export function titlesOf(items: readonly ReleaseSearchItem[]): readonly string[] {
  return items.map((item) => item.release.title);
}
