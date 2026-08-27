import type { ApplicationId } from "../../applications.js";
import type { UpstreamBody, UpstreamClient } from "../../http/client.js";
import { createToolError, type ToolError, toolErrorForThrown } from "../../tools/errors.js";
import type { ReleaseCacheIdentity } from "./model.js";

/**
 * The release-grab adapter.
 *
 * All three applications resolve a grab out of their own short-lived search
 * cache, keyed by the indexer and the release GUID that search filed the result
 * under — which is exactly what {@link ReleaseCacheIdentity} holds. So the
 * request this module sends carries nothing else: no download URL, no magnet
 * link, no release payload, and nothing a caller authored. A cache that has
 * since dropped the entry answers `404`, which the shared upstream boundary
 * already normalizes into the `stale_reference` a caller recovers from by
 * repeating the search.
 *
 * Each selected release is grabbed by its own request rather than through a
 * bulk endpoint, for the same reason the Prowlarr aggregate search asks each
 * indexer separately: it is what makes a per-item outcome a real observation
 * instead of an all-or-nothing HTTP status split back apart by guesswork.
 */

/**
 * How long an application holds an interactive search result.
 *
 * Sonarr, Radarr, and Prowlarr each keep the releases one search produced in a
 * short-lived in-memory cache and resolve a later grab out of it; thirty
 * minutes is the window all three ship with. It is recorded here because it is
 * the ceiling a release reference's own lifetime has to stay under — a
 * reference that outlived the cache would offer a grab this server already
 * knows cannot resolve — and `tools/acquisition.ts` holds the two to each other.
 */
export const upstreamSearchCacheMs = 30 * 60_000;

/** The route each application accepts a cache-resolved grab on. */
export const releaseGrabRoutes: Readonly<Record<ApplicationId, string>> = {
  sonarr: "release",
  radarr: "release",
  prowlarr: "search",
};

/**
 * How many grabs are in flight at once.
 *
 * The published schema already bounds one call to a reviewable number of
 * references; this bounds how hard that call may hit one instance and its
 * download client at a moment.
 */
export const grabConcurrency = 4;

export interface ReleaseGrabRequest {
  /** The opaque release reference, echoed so an outcome names what the caller sent. */
  readonly reference: string;
  readonly identity: ReleaseCacheIdentity;
  /**
   * Re-checked immediately before this release's own request, and returning a
   * {@link ToolError} cancels it.
   *
   * A bulk grab resolves every reference up front but sends the requests in
   * bounded batches, so a later batch runs some time after that check — long
   * enough for a reference to expire while the earlier batches were in flight.
   * The spec requires expiry to be rechecked immediately before the grab, and
   * "immediately" has to mean before *this* request rather than before the
   * first one, so the check travels with the request it guards.
   */
  readonly recheck?: (() => ToolError | undefined) | undefined;
}

export const releaseGrabStates = ["accepted", "failed"] as const;

export type ReleaseGrabState = (typeof releaseGrabStates)[number];

export interface ReleaseGrabOutcome {
  readonly reference: string;
  readonly state: ReleaseGrabState;
  /** Present for a failed grab, already normalized and redacted. */
  readonly error?: ToolError | undefined;
}

/**
 * The body one grab carries.
 *
 * Declared as its own type so what leaves this process for a mutation route is
 * a fixed pair of fields rather than whatever an object literal happened to
 * pick up. `indexerId` is omitted when the search result never reported one;
 * the instance then simply fails to find the entry and answers as it would for
 * any other cache miss, which is a better outcome than inventing an identifier.
 *
 * It is a type alias rather than an interface so it satisfies the client's
 * {@link UpstreamBody} — an interface has no implicit index signature, and
 * widening the declaration is the honest fix, since this really is a plain
 * record of two JSON-representable fields.
 */
type GrabRequestBody = {
  readonly guid: string;
  readonly indexerId?: number;
};

function grabBody(identity: ReleaseCacheIdentity): GrabRequestBody {
  return {
    guid: identity.guid,
    ...(identity.indexerId === undefined ? {} : { indexerId: identity.indexerId }),
  };
}

/**
 * Re-words the one failure whose upstream phrasing understates what happened.
 *
 * A `404` from a grab route does not mean the release vanished from the
 * indexer; it means this instance's search cache no longer holds the entry the
 * reference stands for. The code and its remediation are already right — repeat
 * the query that produced the reference — so only the message changes, and it
 * is composed here rather than taken from the instance.
 */
function grabError(error: unknown, application: ApplicationId): ToolError {
  const normalized = toolErrorForThrown(error, application);
  if (normalized.code !== "stale_reference") {
    return normalized;
  }
  return createToolError({
    code: "stale_reference",
    message: `${application}: the instance no longer holds this release in its search cache`,
    application,
  });
}

/**
 * Runs one grab, turning its own failure into that release's outcome.
 *
 * The answer is discarded rather than mapped: every application echoes the
 * release resource back, protected download URL included, and this server has
 * no use for a single field of it. Acceptance is the `2xx` itself.
 */
async function grabOne(
  application: ApplicationId,
  client: UpstreamClient,
  request: ReleaseGrabRequest,
): Promise<ReleaseGrabOutcome> {
  const stale = request.recheck?.();
  if (stale !== undefined) {
    return { reference: request.reference, state: "failed", error: stale };
  }

  try {
    await client.post(releaseGrabRoutes[application], grabBody(request.identity));
  } catch (error) {
    return { reference: request.reference, state: "failed", error: grabError(error, application) };
  }
  return { reference: request.reference, state: "accepted" };
}

/**
 * Runs the requests in bounded batches, preserving the caller's order.
 *
 * Nothing here rejects: {@link grabOne} converts its own failure into an
 * outcome, so a batch always settles and one release's failure cannot abandon
 * the requests beside it.
 */
async function inBatches(
  requests: readonly ReleaseGrabRequest[],
  size: number,
  run: (request: ReleaseGrabRequest) => Promise<ReleaseGrabOutcome>,
): Promise<ReleaseGrabOutcome[]> {
  const outcomes: ReleaseGrabOutcome[] = [];
  for (let index = 0; index < requests.length; index += size) {
    outcomes.push(...(await Promise.all(requests.slice(index, index + size).map(run))));
  }
  return outcomes;
}

export interface ReleaseGrabResult {
  readonly outcomes: readonly ReleaseGrabOutcome[];
  readonly accepted: number;
}

/**
 * Grabs every selected release from one application.
 *
 * A mixed result is the normal outcome rather than an error: the caller learns
 * which releases the instance took and why each of the others did not, and
 * nothing is retried here — a retry is the caller's decision, and the apply
 * receipt is what keeps it from becoming a duplicate.
 */
export async function runReleaseGrab(
  application: ApplicationId,
  client: UpstreamClient,
  requests: readonly ReleaseGrabRequest[],
): Promise<ReleaseGrabResult> {
  const outcomes = await inBatches(requests, grabConcurrency, (request) =>
    grabOne(application, client, request),
  );
  return {
    outcomes,
    accepted: outcomes.filter((outcome) => outcome.state === "accepted").length,
  };
}
