import {
  type ReleaseGrabRequest,
  runReleaseGrab,
  upstreamSearchCacheMs,
} from "../adapters/acquisition/grab.js";
import {
  type ReleaseCacheIdentity,
  type ReleaseCandidate,
  type ReleaseIndexer,
  type ReleaseProtocol,
  type ReleaseSearchItem,
  releaseProtocols,
} from "../adapters/acquisition/model.js";
import {
  digestPartsFor,
  type ReleaseSearchRequest,
  type ReleaseSearchTarget,
  releaseSearchTargets,
} from "../adapters/acquisition/requests.js";
import { type ReleaseSearchData, runReleaseSearch } from "../adapters/acquisition/service.js";
import { mediaRef, mediaRefKey, seasonRef } from "../adapters/library/model.js";
import { queryDigest } from "../adapters/library/paging.js";
import type { ApplicationId } from "../applications.js";
import type { PreconditionRead } from "../state/plans.js";
import { type ReferenceEntry, referenceLifetimes } from "../state/references.js";
import { createToolError, type ToolError, toolErrorForReferenceFailure } from "./errors.js";
import { type Resolved, resolveUpstreamId } from "./library.js";
import type { OperationHandler, OperationInvocation, PreconditionReader } from "./operations.js";
import type { Effect, ItemOutcome } from "./results.js";
import {
  type ReleaseGrabInput,
  type ReleaseSearchInput,
  releaseGrabInputSchema,
  releaseSearchInputSchema,
} from "./schemas/acquisition.js";
import type {
  PublishedReleaseCandidate,
  ReleaseGrabResultData,
  ReleaseSearchResult,
} from "./schemas/acquisition-results.js";

/**
 * The `arr_release_search` and `arr_release_grab` operation handlers.
 *
 * Together they are one short-lived transaction, and the reference is what
 * joins its two halves. Search resolves the caller's media references into
 * upstream identifiers, runs the bounded search, and publishes each result
 * behind a freshly minted opaque release reference; grab accepts nothing but
 * such a reference and turns it back into the upstream cache identity the
 * application files its own search cache under. Neither half lets the caller
 * name a download URL, a magnet link, a GUID, or an indexer cache key, and
 * neither builds an envelope or normalizes an error — the shared dispatcher
 * owns both.
 */

/**
 * How long a release reference stays usable, restated here as an invariant
 * rather than as a comment.
 *
 * The spec requires a release reference to expire no later than the upstream
 * search cache it stands for; a reference that outlived that cache would offer
 * a caller a grab this server already knows cannot resolve. The lifetime lives
 * with every other reference kind in `state/references.ts`, so the check is
 * made here, at module load, where the two facts finally meet.
 */
if (referenceLifetimes.release > upstreamSearchCacheMs) {
  throw new Error("A release reference must expire no later than the upstream search cache");
}

function invalid(invocation: OperationInvocation, message: string): ToolError {
  return createToolError({
    code: "invalid_input",
    message: `${invocation.application}: ${message}`,
    application: invocation.application,
  });
}

/** Copies a readonly list into the mutable form the published schemas declare. */
function list<TValue>(values: readonly TValue[] | undefined): TValue[] | undefined {
  return values === undefined ? undefined : [...values];
}

/**
 * What a release reference stands for, beyond the upstream cache key itself.
 *
 * Everything here is process-local and reached only through the reference
 * store: a caller receives the random token and nothing else, so none of these
 * values is readable from, or forgeable into, a reference. `search` and `media`
 * are the binding the change document calls for — the search cache identity and
 * the application-and-media context the result came from — and they are digests
 * or normalized identifiers rather than free text an instance or a caller
 * composed.
 */
interface ReleaseSnapshotDetail {
  readonly kind: "release";
  readonly target: ReleaseSearchTarget;
  /** The digest of the search that produced this result. */
  readonly search: string;
  /** The media identity the search ran for, as a stable normalized key. */
  readonly media: string;
  readonly title: string;
  readonly protocol: ReleaseProtocol;
  readonly indexerId?: number | undefined;
  readonly indexerName?: string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The member of a closed set a value equals, or `undefined` for none of them. */
function memberOf<TValue extends string>(
  values: readonly TValue[],
  candidate: unknown,
): TValue | undefined {
  return values.find((value) => value === candidate);
}

/**
 * Reads a stored release snapshot back out of the reference store.
 *
 * The store's detail is deliberately untyped — every domain change attaches its
 * own — so it is narrowed here rather than asserted: an entry that is not a
 * release snapshot yields `undefined` and the caller reports it as the wrong
 * kind of reference instead of grabbing whatever the fields happened to hold.
 */
function readReleaseDetail(entry: ReferenceEntry): ReleaseSnapshotDetail | undefined {
  if (entry.payload.kind !== "domain") {
    return undefined;
  }
  const detail = entry.payload.snapshot.detail;
  if (!isRecord(detail) || detail.kind !== "release") {
    return undefined;
  }

  // Every closed field is matched against its own declared set rather than
  // asserted. The values were written by this server, so a mismatch is a bug
  // here rather than caller input — but a snapshot that has drifted must fail
  // as an unusable reference, not as a payload the published output schema
  // quietly rejects one layer later.
  const target = memberOf(releaseSearchTargets, detail.target);
  const protocol = memberOf(releaseProtocols, detail.protocol);
  if (
    target === undefined ||
    protocol === undefined ||
    typeof detail.search !== "string" ||
    typeof detail.media !== "string" ||
    typeof detail.title !== "string"
  ) {
    return undefined;
  }

  return {
    kind: "release",
    target,
    search: detail.search,
    media: detail.media,
    title: detail.title,
    protocol,
    indexerId: typeof detail.indexerId === "number" ? detail.indexerId : undefined,
    indexerName: typeof detail.indexerName === "string" ? detail.indexerName : undefined,
  };
}

/**
 * The media context one search ran for, as a stable key.
 *
 * The three library targets reuse the library model's own identity key, so a
 * release found for an episode is bound to exactly the identity a media
 * reference for that episode resolves to. A Prowlarr aggregate search has no
 * library identity at all, so its term is bound as a digest — enough to tell
 * two searches apart, and not the caller's free text kept in server state.
 */
function mediaContextKey(request: ReleaseSearchRequest): string {
  switch (request.target) {
    case "sonarr_episode":
      return mediaRefKey(mediaRef("sonarr", "episode", request.episodeId));
    case "sonarr_season":
      return mediaRefKey(seasonRef("sonarr", request.seriesId, request.seasonNumber));
    case "radarr_movie":
      return mediaRefKey(mediaRef("radarr", "movie", request.movieId));
    case "prowlarr_aggregate":
      return `prowlarr:term:${queryDigest([request.term])}`;
  }
}

/**
 * Digests one release as it looked when its reference was minted.
 *
 * The parts are listed here in a fixed, code-authored order and exclude
 * everything the caller's detail level changes, so the same release
 * fingerprints alike whether it was read at `summary` or at `full`.
 */
function releaseFingerprint(item: ReleaseSearchItem): string {
  const release = item.release;
  return queryDigest([
    item.identity.application,
    item.identity.guid,
    item.identity.indexerId,
    release.title,
    release.protocol,
    release.sizeBytes,
    release.publishedAt,
    release.decision?.approved,
  ]);
}

function publishIndexer(indexer: ReleaseIndexer) {
  return { id: indexer.id, name: indexer.name };
}

/**
 * Publishes one release candidate under its freshly minted reference.
 *
 * The switch is exhaustive over the model's closed application union, so a
 * namespaced extension added there without a published shape fails to compile
 * rather than reaching a caller as a payload the declared output schema rejects.
 */
function publishRelease(release: ReleaseCandidate, reference: string): PublishedReleaseCandidate {
  const base = {
    reference,
    title: release.title,
    indexer: publishIndexer(release.indexer),
    protocol: release.protocol,
    quality: release.quality,
    languages: list(release.languages),
    sizeBytes: release.sizeBytes,
    publishedAt: release.publishedAt,
    ageMinutes: release.ageMinutes,
    seeders: release.seeders,
    leechers: release.leechers,
    releaseGroup: release.releaseGroup,
    decision:
      release.decision === undefined
        ? undefined
        : { approved: release.decision.approved, rejections: [...release.decision.rejections] },
    detail:
      release.detail === undefined
        ? undefined
        : {
            customFormats: list(release.detail.customFormats),
            customFormatScore: release.detail.customFormatScore,
            indexerFlags: list(release.detail.indexerFlags),
            categories: list(release.detail.categories),
          },
  };

  switch (release.application) {
    case "sonarr":
      return {
        ...base,
        application: "sonarr",
        sonarr: {
          seriesTitle: release.sonarr.seriesTitle,
          seasonNumber: release.sonarr.seasonNumber,
          episodeNumbers: list(release.sonarr.episodeNumbers),
          absoluteEpisodeNumbers: list(release.sonarr.absoluteEpisodeNumbers),
          fullSeason: release.sonarr.fullSeason,
        },
      };
    case "radarr":
      return {
        ...base,
        application: "radarr",
        radarr: {
          movieTitles: list(release.radarr.movieTitles),
          year: release.radarr.year,
          edition: release.radarr.edition,
        },
      };
    case "prowlarr":
      return {
        ...base,
        application: "prowlarr",
        prowlarr: { grabs: release.prowlarr.grabs, files: release.prowlarr.files },
      };
  }
}

/**
 * Publishes one search's results, minting a reference for each release.
 *
 * The mint is where the substitution happens: the upstream cache identity goes
 * into the store, keyed by a random token, and the caller receives the token.
 * The identity itself — the release GUID and its indexer — never appears in the
 * published payload, which is why the grab tool can accept only a reference.
 */
function publishSearch(
  invocation: OperationInvocation,
  request: ReleaseSearchRequest,
  data: ReleaseSearchData,
): ReleaseSearchResult {
  const search = queryDigest(digestPartsFor(invocation.application, request));
  const media = mediaContextKey(request);

  const releases = data.items.map((item) => {
    const entry = invocation.state.references.mint({
      kind: "release",
      applications: [item.identity.application],
      payload: () => ({
        kind: "domain",
        snapshot: {
          upstreamId: item.identity.guid,
          fingerprint: releaseFingerprint(item),
          detail: {
            kind: "release",
            target: request.target,
            search,
            media,
            title: item.release.title,
            protocol: item.release.protocol,
            indexerId: item.identity.indexerId,
            indexerName: item.release.indexer.name,
          } satisfies ReleaseSnapshotDetail,
        },
      }),
    });
    return publishRelease(item.release, entry.reference);
  });

  return {
    target: data.target,
    releases,
    completeness:
      data.completeness === undefined
        ? undefined
        : {
            complete: data.completeness.complete,
            queried: data.completeness.queried,
            succeeded: data.completeness.succeeded,
            indexers: data.completeness.indexers.map((outcome) => ({
              indexer: publishIndexer(outcome.indexer),
              state: outcome.state,
              releases: outcome.releases,
              reason: outcome.reason,
            })),
          },
  };
}

/**
 * Builds the adapter-facing search request from validated tool arguments.
 *
 * This is the only place a caller's opaque media reference becomes an upstream
 * identifier, and the switch is exhaustive over the published target union so a
 * new target cannot reach an adapter unmapped.
 */
function buildSearchRequest(
  invocation: OperationInvocation,
  input: ReleaseSearchInput,
): Resolved<ReleaseSearchRequest> {
  const base = { detail: input.detail, paging: { pageSize: input.pageSize, cursor: input.cursor } };

  switch (input.target) {
    case "sonarr_episode": {
      const episodeId = resolveUpstreamId(invocation, input.episode, "episode", "episode");
      return episodeId.ok
        ? { ok: true, value: { ...base, target: "sonarr_episode", episodeId: episodeId.value } }
        : episodeId;
    }
    case "sonarr_season": {
      const seriesId = resolveUpstreamId(invocation, input.series, "series", "series");
      return seriesId.ok
        ? {
            ok: true,
            value: {
              ...base,
              target: "sonarr_season",
              seriesId: seriesId.value,
              seasonNumber: input.seasonNumber,
            },
          }
        : seriesId;
    }
    case "radarr_movie": {
      const movieId = resolveUpstreamId(invocation, input.movie, "movie", "movie");
      return movieId.ok
        ? { ok: true, value: { ...base, target: "radarr_movie", movieId: movieId.value } }
        : movieId;
    }
    case "prowlarr_aggregate":
      return { ok: true, value: { ...base, target: "prowlarr_aggregate", term: input.term } };
  }
}

/**
 * Runs one bounded interactive release search for one application.
 *
 * The arguments are re-validated against the tool's own published schema rather
 * than cast, so the handler works on a value the contract vouches for whether
 * it arrived through the MCP transport or from an internal caller.
 */
export const releaseSearchHandler: OperationHandler = async (invocation) => {
  const parsed = releaseSearchInputSchema.safeParse(invocation.input);
  if (!parsed.success) {
    return {
      status: "error",
      error: invalid(invocation, "the arguments do not match the arr_release_search input schema"),
    };
  }

  const request = buildSearchRequest(invocation, parsed.data as ReleaseSearchInput);
  if (!request.ok) {
    return { status: "error", error: request.error };
  }

  const outcome = await runReleaseSearch(
    invocation.application,
    invocation.adapter.client,
    request.value,
    { clock: invocation.state.clock },
  );
  if (outcome.status === "error") {
    return { status: "error", error: outcome.error };
  }

  return {
    status: "ok",
    data: publishSearch(invocation, request.value, outcome.data),
    continuation: outcome.continuation,
    warnings: outcome.warnings,
  };
};

/**
 * One selected release, resolved back into everything the grab needs.
 *
 * The identity is rebuilt from the store rather than from anything the caller
 * sent, which is what makes "a grab can only target something this server
 * produced" a property of the code and not of the schema alone.
 */
interface SelectedRelease {
  readonly reference: string;
  readonly identity: ReleaseCacheIdentity;
  readonly detail: ReleaseSnapshotDetail;
  readonly fingerprint: string;
}

/**
 * Turns one release reference back into the upstream cache identity it stands
 * for.
 *
 * The shared dispatcher already rejected a forged, expired, previous-lifetime,
 * or wrong-kind reference before any instance was probed. What is left to check
 * here is what only this tool knows: that the entry really holds a release
 * snapshot, and that it belongs to the application this invocation targets.
 */
function resolveRelease(invocation: OperationInvocation, token: string): Resolved<SelectedRelease> {
  const resolution = invocation.state.references.resolve(token, "release");
  if (!resolution.ok) {
    return {
      ok: false,
      error: toolErrorForReferenceFailure(resolution.reason, "release", invocation.application),
    };
  }

  const entry = resolution.entry;
  if (!entry.applications.includes(invocation.application)) {
    return { ok: false, error: invalid(invocation, "a release names a different application") };
  }

  const detail = readReleaseDetail(entry);
  if (detail === undefined || entry.payload.kind !== "domain") {
    return { ok: false, error: invalid(invocation, "a release does not name a search result") };
  }

  return {
    ok: true,
    value: {
      reference: token,
      identity: {
        application: invocation.application,
        guid: entry.payload.snapshot.upstreamId,
        indexerId: detail.indexerId,
      },
      detail,
      fingerprint: entry.payload.snapshot.fingerprint,
    },
  };
}

function readGrabInput(invocation: OperationInvocation): Resolved<readonly SelectedRelease[]> {
  const parsed = releaseGrabInputSchema.safeParse(invocation.input);
  if (!parsed.success) {
    return {
      ok: false,
      error: invalid(invocation, "the arguments do not match the arr_release_grab input schema"),
    };
  }

  const input = parsed.data as ReleaseGrabInput;
  if (!("releases" in input)) {
    // The plan-apply form carries no intent of its own; the dispatcher replaces
    // it with the plan's recorded intent before a handler ever runs, so seeing
    // one here means the plan reference did not resolve to this tool's intent.
    return { ok: false, error: invalid(invocation, "no releases were named for this grab") };
  }

  const selected: SelectedRelease[] = [];
  const seen = new Set<string>();
  for (const token of input.releases) {
    if (seen.has(token)) {
      // Naming one release twice does not ask for two grabs, and sending the
      // same one again is exactly the duplicate the receipt exists to prevent.
      continue;
    }
    seen.add(token);
    const resolved = resolveRelease(invocation, token);
    if (!resolved.ok) {
      return resolved;
    }
    selected.push(resolved.value);
  }
  return { ok: true, value: selected };
}

/**
 * Everything one reference is bound to, as one comparable string.
 *
 * The search digest and the media context are in here rather than merely
 * recorded, which is what makes the binding load-bearing: a plan's read set is
 * a digest of these, so applying it re-checks that each reference still stands
 * for the same result of the same search in the same media context, not just
 * that a token of the right kind still resolves. Nothing here reaches a caller
 * in the clear — the published read set carries only the hash.
 */
function releaseBinding(release: SelectedRelease): string {
  const detail = release.detail;
  return [release.reference, release.fingerprint, detail.target, detail.search, detail.media].join(
    "|",
  );
}

/**
 * The read set a grab plan depends on: which releases were selected, and what
 * each reference was minted to stand for.
 *
 * Re-running it immediately before apply is what rechecks reference expiry at
 * the moment of the grab — an expired reference no longer resolves, so the read
 * is blocked with the same `stale_reference` a caller recovers from by
 * repeating the search. It is the first of two expiry checks, not the only one:
 * a bulk grab sends its requests in batches, so each request re-checks its own
 * reference again just before it goes out. The upstream cache itself is only
 * observable by trying the grab, which the adapter does next and reports as its
 * own typed failure.
 */
export const releaseGrabPreconditions: PreconditionReader = (invocation) => {
  const selected = readGrabInput(invocation);
  if (!selected.ok) {
    return Promise.resolve<PreconditionRead>({ status: "blocked", error: selected.error });
  }

  return Promise.resolve<PreconditionRead>({
    status: "ok",
    observations: [
      {
        key: "grab-releases",
        // Sorted so naming the same releases in another order is the same read
        // set, matching how the apply receipt already identifies a mutation.
        value: selected.value.map(releaseBinding).sort(),
      },
    ],
  });
};

function grabEffect(application: ApplicationId, release: SelectedRelease): Effect {
  return {
    application,
    severity: "consequential",
    summary: `send ${release.detail.title} to the download client`,
  };
}

function plannedRelease(application: ApplicationId, release: SelectedRelease) {
  return {
    reference: release.reference,
    application,
    title: release.detail.title,
    indexer: { id: release.detail.indexerId, name: release.detail.indexerName },
    protocol: release.detail.protocol,
  };
}

/**
 * Grabs releases a previous search returned.
 *
 * Nothing reaches an instance outside apply mode: plan discloses the effects and
 * returns, and a read-mode invocation — which the published schema cannot
 * produce, since a mode is required — is refused rather than quietly treated as
 * one of the two. Each selected release is then grabbed on its own and reports
 * its own outcome, so a mixed result stays mixed instead of collapsing into a
 * single success or a single failure.
 */
export const releaseGrabHandler: OperationHandler = async (invocation) => {
  const selected = readGrabInput(invocation);
  if (!selected.ok) {
    return { status: "error", error: selected.error };
  }
  const releases = selected.value;
  const application = invocation.application;

  if (invocation.mode === "plan") {
    const data: ReleaseGrabResultData = {
      stage: "planned",
      releases: releases.map((release) => plannedRelease(application, release)),
    };
    const effects = releases.map((release) => grabEffect(application, release));
    return {
      status: "ok",
      data,
      plan: {
        requestedEffects: effects,
        // Every selected release is still resolvable and still within its
        // lifetime, so each one is predicted; whether the instance's own cache
        // still holds it is only knowable by asking, which apply does.
        predictedEffects: effects,
        warnings: [
          "a release reference expires before the instance's own search cache does; apply this plan before it does or repeat the search",
        ],
      },
    };
  }

  if (invocation.mode !== "apply") {
    return {
      status: "error",
      error: invalid(invocation, "a grab runs only in plan or apply mode"),
    };
  }

  const requests: readonly ReleaseGrabRequest[] = releases.map((release) => ({
    reference: release.reference,
    identity: release.identity,
    // Checked again just before this release's own request goes out. The
    // batching below means a later request runs some time after the
    // preconditions were read, and a reference that ran out in between must be
    // refused rather than acted on.
    recheck: () => {
      const current = resolveRelease(invocation, release.reference);
      if (current.ok && releaseBinding(current.value) === releaseBinding(release)) {
        return undefined;
      }
      return current.ok
        ? invalid(invocation, "a release no longer stands for the result it was selected from")
        : current.error;
    },
  }));
  const result = await runReleaseGrab(application, invocation.adapter.client, requests);

  const byReference = new Map(result.outcomes.map((outcome) => [outcome.reference, outcome]));
  const items: ItemOutcome[] = releases.map((release) => {
    const outcome = byReference.get(release.reference);
    return {
      reference: release.reference,
      status: outcome?.state === "accepted" ? "ok" : "error",
      warnings: [],
      ...(outcome?.error === undefined ? {} : { error: outcome.error }),
    };
  });

  const data: ReleaseGrabResultData = {
    stage: "applied",
    requested: releases.length,
    accepted: result.accepted,
    releases: releases.map((release) => ({
      ...plannedRelease(application, release),
      outcome: byReference.get(release.reference)?.state ?? "failed",
    })),
  };

  // Nothing was accepted, so the call itself failed: reporting it as a
  // successful mutation would settle a receipt that then blocks the retry the
  // caller is entitled to. The per-release errors still travel with it, so no
  // failure is concealed by the collapse.
  if (result.accepted === 0 && releases.length > 0) {
    return {
      status: "error",
      error: grabFailure(application, items),
      items,
    };
  }

  return {
    status: "ok",
    data,
    items,
    effects: releases.map((release) => grabEffect(application, release)),
  };
};

/**
 * Names the failure of a grab in which no release was accepted.
 *
 * When every release failed the same way, that code and its remediation are the
 * answer and are kept. When they failed differently there is no single remedy,
 * so the shared partial-failure code points the caller at the per-release
 * outcomes, which carry each original code untouched.
 */
function grabFailure(application: ApplicationId, items: readonly ItemOutcome[]): ToolError {
  const codes = new Set(items.map((item) => item.error?.code));
  const first = items[0]?.error;
  if (codes.size === 1 && first !== undefined) {
    return first;
  }
  return createToolError({
    code: "partial_failure",
    message: `${application}: no release was accepted; each one reports its own outcome`,
    application,
  });
}
