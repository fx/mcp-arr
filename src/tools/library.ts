import type {
  CalendarEvent,
  ConfigurationPointer,
  LookupResult,
  MediaDetail,
  MediaFile,
  MediaItem,
  MediaKind,
  MediaRecordKind,
  MediaRecordRef,
  MediaRef,
  WantedItem,
  WantedReason,
} from "../adapters/library/model.js";
import { mediaRefKey } from "../adapters/library/model.js";
import { queryDigest } from "../adapters/library/paging.js";
import type { LibraryQueryRequest } from "../adapters/library/requests.js";
import { type LibraryViewData, runLibraryQuery } from "../adapters/library/service.js";
import type { ReferenceStore } from "../state/references.js";
import { createToolError, type ToolError, toolErrorForReferenceFailure } from "./errors.js";
import type { OperationHandler, OperationInvocation } from "./operations.js";
import { type LibraryQueryInput, libraryQueryInputSchema } from "./schemas/library.js";
import type {
  LibraryCalendarEvent,
  LibraryFileOfKind,
  LibraryLookupResult,
  LibraryMediaFile,
  LibraryMediaRecord,
  LibraryRecordOfKind,
  LibraryViewResult,
  LibraryWantedRecord,
} from "./schemas/library-results.js";

/**
 * The `arr_library_query` operation handler.
 *
 * It is the join between the published tool contract and the merged library
 * service: it re-narrows the caller's already-validated arguments, turns every
 * opaque media reference back into the upstream identifier it stands for, runs
 * the bounded query, and publishes the normalized result with fresh references
 * of its own. It builds no envelope and normalizes no error — the shared
 * dispatcher owns both.
 */

export type Resolved<TValue> =
  | { readonly ok: true; readonly value: TValue }
  | { readonly ok: false; readonly error: ToolError };

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
 * Which reference kind stands for one media identity.
 *
 * A file is its own kind on the published surface, because the file mutations
 * accept only file references; everything else is a media reference. Deriving
 * it from the identity rather than from the call site is what keeps a file from
 * ever being handed out as something a media mutation would accept.
 */
function referenceKindFor(kind: MediaKind): "media" | "media_file" {
  return kind === "episode_file" || kind === "movie_file" ? "media_file" : "media";
}

/**
 * Digests one record's identity and its mutable state.
 *
 * The parts are listed here in a fixed, code-authored order and deliberately
 * exclude anything the caller's detail level changes, so the same record
 * fingerprints alike whether it was read at `summary` or at `full`.
 */
function mediaFingerprint(item: MediaItem): string {
  return queryDigest([
    mediaRefKey(item.ref),
    item.title,
    item.year,
    item.monitoring.monitored,
    item.monitoring.monitoredChildren,
    item.monitoring.totalChildren,
    item.status,
    item.statistics?.fileCount,
    item.statistics?.sizeOnDiskBytes,
    item.qualityProfile?.id,
  ]);
}

function mediaFileFingerprint(file: MediaFile): string {
  return queryDigest([
    mediaRefKey(file.ref),
    mediaRefKey(file.parent),
    file.relativePath,
    file.sizeBytes,
    file.dateAdded,
    file.quality,
    file.releaseGroup,
  ]);
}

/**
 * An identity this query mentioned but did not read.
 *
 * A file's parent series and the library record a lookup result matches are
 * named, not returned, so the only thing there is to fingerprint is the
 * identity itself. Inventing state for them would be a false snapshot.
 */
function identityFingerprint(ref: MediaRef): string {
  return queryDigest([mediaRefKey(ref)]);
}

interface ReferenceMinter {
  /** The opaque reference for one identity, minted once per query. */
  token(ref: MediaRef, fingerprint: string): string;
  /**
   * An identity this query named without reading it. Only a record can be
   * named that way — a file's parent, a lookup match — so a file identity
   * cannot be published here.
   */
  identity(ref: MediaRecordRef): {
    reference: string;
    application: MediaRef["application"];
    kind: MediaRecordKind;
    id: string;
  };
  /**
   * A configuration object a record points at. It is minted as its own
   * reference kind, so the profile a series uses can be supplied to an edit
   * intent while remaining impossible to pass where a media reference belongs.
   */
  pointer(pointer: ConfigurationPointer): {
    reference: string;
    application: ConfigurationPointer["application"];
    kind: ConfigurationPointer["kind"];
    id: string;
  };
}

/**
 * Mints the references one query's results carry.
 *
 * Identities are deduplicated by the model's own key, which is built in a fixed
 * order from the identity's own parts, so a page of episode files that all
 * belong to one series mints exactly one reference for it and nothing a caller
 * supplied can influence what two identities collapse to.
 *
 * Within one query an identity is either read as a record or merely named — a
 * file's parent, a lookup match — and never both, so keeping the first token
 * minted for a key cannot replace a record's fingerprint with an identity-only
 * one.
 */
function createReferenceMinter(references: ReferenceStore): ReferenceMinter {
  const minted = new Map<string, string>();

  const token = (ref: MediaRef, fingerprint: string): string => {
    const key = mediaRefKey(ref);
    const existing = minted.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const entry = references.mint({
      kind: referenceKindFor(ref.kind),
      applications: [ref.application],
      payload: () => ({
        kind: "domain",
        snapshot: { upstreamId: ref.id, fingerprint, detail: { kind: ref.kind } },
      }),
    });
    minted.set(key, entry.reference);
    return entry.reference;
  };

  const pointerToken = (pointer: ConfigurationPointer): string => {
    // Prefixed so a configuration key can never collide with a media key, even
    // if the two vocabularies ever name a kind alike.
    const key = `configuration:${pointer.application}:${pointer.kind}:${pointer.id}`;
    const existing = minted.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const entry = references.mint({
      kind: "configuration",
      applications: [pointer.application],
      payload: () => ({
        kind: "domain",
        snapshot: {
          upstreamId: pointer.id,
          // A pointer is named, not read, so the only thing there is to
          // fingerprint is the identity itself.
          fingerprint: queryDigest([pointer.application, pointer.kind, pointer.id]),
          detail: { kind: pointer.kind },
        },
      }),
    });
    minted.set(key, entry.reference);
    return entry.reference;
  };

  return {
    token,
    identity: (ref) => ({
      reference: token(ref, identityFingerprint(ref)),
      application: ref.application,
      kind: ref.kind,
      id: ref.id,
    }),
    pointer: (pointer) => ({
      reference: pointerToken(pointer),
      application: pointer.application,
      kind: pointer.kind,
      id: pointer.id,
    }),
  };
}

function publishDetail(detail: MediaDetail | undefined) {
  return detail === undefined
    ? undefined
    : {
        overview: detail.overview,
        genres: list(detail.genres),
        runtimeMinutes: detail.runtimeMinutes,
        certification: detail.certification,
        path: detail.path,
        alternateTitles: list(detail.alternateTitles),
      };
}

function publishRecordBase(item: MediaItem, mint: ReferenceMinter) {
  return {
    reference: mint.token(item.ref, mediaFingerprint(item)),
    id: item.ref.id,
    title: item.title,
    sortTitle: item.sortTitle,
    year: item.year,
    monitoring: item.monitoring,
    status: item.status,
    added: item.added,
    statistics: item.statistics,
    qualityProfile:
      item.qualityProfile === undefined ? undefined : mint.pointer(item.qualityProfile),
    rootFolder: item.rootFolder === undefined ? undefined : mint.pointer(item.rootFolder),
    tags: item.tags?.map((tag) => mint.pointer(tag)),
    detail: publishDetail(item.detail),
  };
}

/**
 * Publishes one library record.
 *
 * The published record is discriminated by `kind` alone, so the namespaced
 * extension carries only the fields that application actually adds and no
 * discriminant is repeated inside it.
 */
function publishMediaRecord(item: MediaItem, mint: ReferenceMinter): LibraryMediaRecord {
  const base = publishRecordBase(item, mint);

  if (item.application === "sonarr") {
    const fields = item.sonarr;
    switch (fields.kind) {
      case "series":
        return {
          ...base,
          kind: "series",
          application: "sonarr",
          sonarr: {
            seriesType: fields.seriesType,
            network: fields.network,
            tvdbId: fields.tvdbId,
            ended: fields.ended,
            seasonCount: fields.seasonCount,
          },
        };
      case "season":
        return {
          ...base,
          kind: "season",
          application: "sonarr",
          sonarr: {
            seriesId: fields.seriesId,
            seasonNumber: fields.seasonNumber,
            episodeCount: fields.episodeCount,
            episodeFileCount: fields.episodeFileCount,
          },
        };
      case "episode":
        return {
          ...base,
          kind: "episode",
          application: "sonarr",
          sonarr: {
            seriesId: fields.seriesId,
            seriesTitle: fields.seriesTitle,
            seasonNumber: fields.seasonNumber,
            episodeNumber: fields.episodeNumber,
            absoluteEpisodeNumber: fields.absoluteEpisodeNumber,
            airDate: fields.airDate,
            airDateUtc: fields.airDateUtc,
            hasFile: fields.hasFile,
            finaleType: fields.finaleType,
          },
        };
    }
  }

  const fields = item.radarr;
  if (fields.kind === "movie") {
    return {
      ...base,
      kind: "movie",
      application: "radarr",
      radarr: {
        tmdbId: fields.tmdbId,
        imdbId: fields.imdbId,
        minimumAvailability: fields.minimumAvailability,
        hasFile: fields.hasFile,
        studio: fields.studio,
        collection: fields.collection,
        releaseDates: fields.releaseDates,
      },
    };
  }
  return {
    ...base,
    kind: "collection",
    application: "radarr",
    radarr: {
      tmdbId: fields.tmdbId,
      movieCount: fields.movieCount,
      searchOnAdd: fields.searchOnAdd,
    },
  };
}

/**
 * Narrows a published record to the variants one view can contain.
 *
 * Which kind each view maps is a fact about the adapters that neither the
 * normalized model nor the service carries in its types, and the published
 * schema now states it per view. So it is checked here rather than asserted: a
 * mismap fails at the site that produced it, naming the view and the kind,
 * instead of surfacing one layer later as a result that merely did not conform.
 */
function recordOfKind<TKind extends LibraryMediaRecord["kind"]>(
  item: MediaItem,
  mint: ReferenceMinter,
  kinds: readonly TKind[],
): LibraryRecordOfKind<TKind> {
  const record = publishMediaRecord(item, mint);
  if (!kinds.some((kind) => kind === record.kind)) {
    throw new Error(`a library view produced a ${record.kind} record where it cannot appear`);
  }
  // Sound because the check above compared the same discriminant the published
  // union is keyed on; TypeScript cannot narrow a union by a generic literal.
  return record as LibraryRecordOfKind<TKind>;
}

function fileOfKind<TKind extends LibraryMediaFile["kind"]>(
  file: MediaFile,
  mint: ReferenceMinter,
  kind: TKind,
): LibraryFileOfKind<TKind> {
  const published = publishMediaFile(file, mint);
  if (published.kind !== kind) {
    throw new Error(`a library view produced a ${published.kind} where it cannot appear`);
  }
  return published as LibraryFileOfKind<TKind>;
}

function publishMediaFile(file: MediaFile, mint: ReferenceMinter): LibraryMediaFile {
  const base = {
    reference: mint.token(file.ref, mediaFileFingerprint(file)),
    id: file.ref.id,
    parent: mint.identity(file.parent),
    relativePath: file.relativePath,
    sizeBytes: file.sizeBytes,
    dateAdded: file.dateAdded,
    quality: file.quality,
    languages: list(file.languages),
    releaseGroup: file.releaseGroup,
    detail:
      file.detail === undefined
        ? undefined
        : {
            path: file.detail.path,
            customFormats: list(file.detail.customFormats),
            customFormatScore: file.detail.customFormatScore,
            mediaInfo: file.detail.mediaInfo,
          },
  };

  return file.application === "sonarr"
    ? {
        ...base,
        kind: "episode_file",
        application: "sonarr",
        sonarr: {
          seriesId: file.sonarr.seriesId,
          seasonNumber: file.sonarr.seasonNumber,
          episodeIds: [...file.sonarr.episodeIds],
        },
      }
    : {
        ...base,
        kind: "movie_file",
        application: "radarr",
        radarr: { movieId: file.radarr.movieId, edition: file.radarr.edition },
      };
}

/**
 * Publishes one wanted record for the view that asked for it.
 *
 * Both the media kind and the reason are fixed by the view — the Sonarr wanted
 * endpoints report episodes and the Radarr ones movies, and each endpoint
 * answers one reason — so both are checked against what the adapter produced
 * rather than copied through.
 */
function publishWanted<TKind extends LibraryMediaRecord["kind"], TReason extends WantedReason>(
  item: WantedItem,
  mint: ReferenceMinter,
  kind: TKind,
  reason: TReason,
): LibraryWantedRecord<LibraryRecordOfKind<TKind>, TReason> {
  if (item.wanted.reason !== reason) {
    throw new Error(`a wanted view produced a ${item.wanted.reason} record where it cannot appear`);
  }
  return {
    media: recordOfKind(item.media, mint, [kind]),
    wanted: { reason, expectedAt: item.wanted.expectedAt },
  };
}

function publishCalendarEvent(event: CalendarEvent, mint: ReferenceMinter): LibraryCalendarEvent {
  return {
    // Sonarr dates episodes and Radarr dates movies; nothing else is dated.
    media: recordOfKind(event.media, mint, ["episode", "movie"]),
    start: event.start,
    end: event.end,
    hasFile: event.hasFile,
    radarr: event.radarr,
  };
}

function publishLookupResult(result: LookupResult, mint: ReferenceMinter): LibraryLookupResult {
  const base = {
    // A candidate is named, not read: its metadata identity is the whole of
    // what this reference stands for, and an add intent re-reads the candidate
    // from the application before it sends anything.
    reference:
      result.ref === undefined
        ? undefined
        : mint.token(result.ref, identityFingerprint(result.ref)),
    title: result.title,
    sortTitle: result.sortTitle,
    year: result.year,
    status: result.status,
    existing: result.existing === undefined ? undefined : mint.identity(result.existing),
    detail: publishDetail(result.detail),
  };

  return result.application === "sonarr"
    ? {
        ...base,
        application: "sonarr",
        sonarr: {
          tvdbId: result.sonarr.tvdbId,
          seriesType: result.sonarr.seriesType,
          network: result.sonarr.network,
        },
      }
    : {
        ...base,
        application: "radarr",
        radarr: {
          tmdbId: result.radarr.tmdbId,
          imdbId: result.radarr.imdbId,
          studio: result.radarr.studio,
        },
      };
}

/**
 * Publishes one view's payload.
 *
 * The switch is exhaustive over the service's closed view union, so a view
 * added there without a published shape fails to compile rather than reaching a
 * caller as a payload the declared output schema would reject.
 */
function publishViewData(data: LibraryViewData, mint: ReferenceMinter): LibraryViewResult {
  const media = <TKind extends LibraryMediaRecord["kind"]>(
    items: readonly MediaItem[],
    kind: TKind,
  ) => items.map((item) => recordOfKind(item, mint, [kind]));
  const files = <TKind extends LibraryMediaFile["kind"]>(
    items: readonly MediaFile[],
    kind: TKind,
  ) => items.map((file) => fileOfKind(file, mint, kind));
  const wanted = <TKind extends LibraryMediaRecord["kind"], TReason extends WantedReason>(
    items: readonly WantedItem[],
    kind: TKind,
    reason: TReason,
  ) => items.map((item) => publishWanted(item, mint, kind, reason));

  switch (data.view) {
    case "series":
      return { view: "series", items: media(data.items, "series") };
    case "seasons":
      return { view: "seasons", items: media(data.items, "season") };
    case "episodes":
      return { view: "episodes", items: media(data.items, "episode") };
    case "movies":
      return { view: "movies", items: media(data.items, "movie") };
    case "collections":
      return { view: "collections", items: media(data.items, "collection") };
    case "episode_files":
      return { view: "episode_files", items: files(data.items, "episode_file") };
    case "movie_files":
      return { view: "movie_files", items: files(data.items, "movie_file") };
    case "missing_episodes":
      return {
        view: "missing_episodes",
        items: wanted(data.items, "episode", "missing"),
      };
    case "cutoff_unmet_episodes":
      return {
        view: "cutoff_unmet_episodes",
        items: wanted(data.items, "episode", "cutoff_unmet"),
      };
    case "missing_movies":
      return { view: "missing_movies", items: wanted(data.items, "movie", "missing") };
    case "cutoff_unmet_movies":
      return {
        view: "cutoff_unmet_movies",
        items: wanted(data.items, "movie", "cutoff_unmet"),
      };
    case "calendar":
      return {
        view: "calendar",
        items: data.items.map((event) => publishCalendarEvent(event, mint)),
      };
    case "lookup":
      return {
        view: "lookup",
        items: data.items.map((result) => publishLookupResult(result, mint)),
      };
  }
}

/**
 * Turns one media reference back into the upstream identifier it stands for.
 *
 * The shared dispatcher already rejected a forged, expired, previous-lifetime,
 * or wrong-kind reference before any instance was probed. What is left to check
 * here is what only this tool knows: that the reference names the kind of
 * record the filter it was supplied for actually queries, so an episode
 * reference can never be sent as a series identifier.
 *
 * It is exported because `arr_release_search` accepts the very same media
 * references this tool mints, and a second implementation of the kind and
 * application checks is a second place for them to drift.
 */
export function resolveUpstreamId(
  invocation: OperationInvocation,
  token: string,
  expected: MediaKind,
  property: string,
): Resolved<number> {
  const kind = referenceKindFor(expected);
  const resolution = invocation.state.references.resolve(token, kind);
  if (!resolution.ok) {
    return {
      ok: false,
      error: toolErrorForReferenceFailure(resolution.reason, kind, invocation.application),
    };
  }

  const entry = resolution.entry;
  if (!entry.applications.includes(invocation.application)) {
    return { ok: false, error: invalid(invocation, `${property} names a different application`) };
  }
  if (entry.payload.kind !== "domain" || entry.payload.snapshot.detail?.kind !== expected) {
    return { ok: false, error: invalid(invocation, `${property} must name a ${expected} record`) };
  }

  // Matched before it is converted, because `Number` answers several strings
  // that are not a plain identifier by quietly changing them — `""` becomes 0,
  // `" 12 "` becomes 12, `"0x0c"` becomes 12. A composite identity such as a
  // season's `12/3` has no single upstream id and is refused here rather than
  // narrowed to one of its halves.
  const upstreamId = entry.payload.snapshot.upstreamId;
  const id = /^\d+$/u.test(upstreamId) ? Number(upstreamId) : Number.NaN;
  if (!Number.isSafeInteger(id)) {
    return { ok: false, error: invalid(invocation, `${property} does not name a single record`) };
  }
  return { ok: true, value: id };
}

function resolveUpstreamIds(
  invocation: OperationInvocation,
  tokens: readonly string[] | undefined,
  expected: MediaKind,
  property: string,
): Resolved<readonly number[] | undefined> {
  if (tokens === undefined) {
    return { ok: true, value: undefined };
  }
  const ids: number[] = [];
  for (const token of tokens) {
    const resolved = resolveUpstreamId(invocation, token, expected, property);
    if (!resolved.ok) {
      return resolved;
    }
    ids.push(resolved.value);
  }
  return { ok: true, value: ids };
}

/**
 * Builds the adapter-facing request from validated tool arguments.
 *
 * The published input and the adapter request are deliberately different
 * shapes: this is the only place a caller's opaque reference becomes an
 * upstream identifier, and the switch is exhaustive over the published view
 * union so a new view cannot reach an adapter unmapped.
 */
function buildRequest(
  invocation: OperationInvocation,
  input: LibraryQueryInput,
): Resolved<LibraryQueryRequest> {
  const base = { detail: input.detail, paging: { pageSize: input.pageSize, cursor: input.cursor } };

  switch (input.view) {
    case "series": {
      const ids = resolveUpstreamIds(invocation, input.media, "series", "media");
      return ids.ok
        ? {
            ok: true,
            value: { ...base, view: "series", monitored: input.monitored, ids: ids.value },
          }
        : ids;
    }
    case "seasons": {
      const seriesId = resolveUpstreamId(invocation, input.series, "series", "series");
      return seriesId.ok
        ? {
            ok: true,
            value: {
              ...base,
              view: "seasons",
              seriesId: seriesId.value,
              monitored: input.monitored,
            },
          }
        : seriesId;
    }
    case "episodes": {
      const seriesId = resolveUpstreamId(invocation, input.series, "series", "series");
      return seriesId.ok
        ? {
            ok: true,
            value: {
              ...base,
              view: "episodes",
              seriesId: seriesId.value,
              seasonNumber: input.seasonNumber,
              monitored: input.monitored,
            },
          }
        : seriesId;
    }
    case "episode_files": {
      const seriesId = resolveUpstreamId(invocation, input.series, "series", "series");
      return seriesId.ok
        ? {
            ok: true,
            value: {
              ...base,
              view: "episode_files",
              seriesId: seriesId.value,
              seasonNumber: input.seasonNumber,
            },
          }
        : seriesId;
    }
    case "missing_episodes":
      return {
        ok: true,
        value: { ...base, view: "missing_episodes", monitored: input.monitored },
      };
    case "cutoff_unmet_episodes":
      return {
        ok: true,
        value: { ...base, view: "cutoff_unmet_episodes", monitored: input.monitored },
      };
    case "movies": {
      const ids = resolveUpstreamIds(invocation, input.media, "movie", "media");
      return ids.ok
        ? {
            ok: true,
            value: { ...base, view: "movies", monitored: input.monitored, ids: ids.value },
          }
        : ids;
    }
    case "collections":
      return { ok: true, value: { ...base, view: "collections", monitored: input.monitored } };
    case "movie_files": {
      const movieId = resolveUpstreamId(invocation, input.movie, "movie", "movie");
      return movieId.ok
        ? { ok: true, value: { ...base, view: "movie_files", movieId: movieId.value } }
        : movieId;
    }
    case "missing_movies":
      return { ok: true, value: { ...base, view: "missing_movies", monitored: input.monitored } };
    case "cutoff_unmet_movies":
      return {
        ok: true,
        value: { ...base, view: "cutoff_unmet_movies", monitored: input.monitored },
      };
    case "calendar":
      return {
        ok: true,
        value: {
          ...base,
          view: "calendar",
          start: input.start,
          end: input.end,
          monitored: input.monitored,
        },
      };
    case "lookup":
      return { ok: true, value: { ...base, view: "lookup", term: input.term } };
  }
}

/**
 * Answers one bounded library query for one application.
 *
 * The arguments are re-validated against the tool's own published schema rather
 * than cast, so the handler works on a value the contract vouches for whether
 * it arrived through the MCP transport or from an internal caller. One
 * application's failure never leaves this handler as anything but that
 * application's error; the dispatcher decides what the envelope says about it.
 */
export const libraryQueryHandler: OperationHandler = async (invocation) => {
  const parsed = libraryQueryInputSchema.safeParse(invocation.input);
  if (!parsed.success) {
    return {
      status: "error",
      error: invalid(invocation, "the arguments do not match the arr_library_query input schema"),
    };
  }

  const request = buildRequest(invocation, parsed.data as LibraryQueryInput);
  if (!request.ok) {
    return { status: "error", error: request.error };
  }

  const outcome = await runLibraryQuery(
    invocation.application,
    invocation.adapter.client,
    request.value,
  );
  if (outcome.status === "error") {
    return { status: "error", error: outcome.error };
  }

  return {
    status: "ok",
    data: publishViewData(outcome.data, createReferenceMinter(invocation.state.references)),
    continuation: outcome.continuation,
    warnings: outcome.warnings,
  };
};
