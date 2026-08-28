import { z } from "zod";
import type { ApplicationId } from "../../applications.js";
import { safeLabel } from "../activity/parse.js";
import {
  count,
  customFormatList,
  flag,
  indexerFlagStrings,
  indexerFlagValue,
  languageList,
  optionalUpstreamId,
  present,
  text,
  upstreamFlag,
  upstreamNumber,
  upstreamText,
} from "../library/parse.js";
import type {
  ReleaseCacheIdentity,
  ReleaseCandidateBase,
  ReleaseDecision,
  ReleaseDetail,
  ReleaseProtocol,
  ReleaseQuality,
  ReleaseRejection,
  ReleaseRejectionType,
} from "./model.js";
import type { ReleaseDetailLevel } from "./requests.js";

/**
 * Upstream release-payload parsing, shared by all three search adapters.
 *
 * All three applications answer a search with the same `ReleaseResource` shape,
 * so the schema and the mapping of its shared half live here once and each
 * adapter extends them with only the fields its own application adds.
 *
 * The schema is also the redaction boundary. `downloadUrl`, `magnetUrl`,
 * `infoUrl`, and every other protected link an instance returns are simply not
 * declared, and zod drops what it was not asked for — so those values never
 * reach a mapped object, and no later layer has to remember to strip them.
 */

const revisionSchema = z
  .object({ version: upstreamNumber, real: upstreamNumber, isRepack: upstreamFlag })
  .nullish();

const releaseQualitySchema = z
  .object({
    quality: z
      .object({ name: upstreamText, source: upstreamText, resolution: upstreamNumber })
      .nullish(),
    revision: revisionSchema,
  })
  .nullish();

/**
 * One rejection as an instance reports it.
 *
 * Sonarr and Radarr have shipped both forms — a bare reason string, and an
 * object that also says whether the rejection is permanent — so both are
 * accepted rather than pinning the adapters to one release's serialization.
 */
const rejectionSchema = z.union([
  z.string(),
  z.object({ reason: upstreamText, type: upstreamText }),
]);

/** The half of `ReleaseResource` every application returns. */
export const releaseSchema = z.object({
  guid: z.string().min(1),
  title: z.string().min(1),
  indexer: upstreamText,
  indexerId: optionalUpstreamId,
  protocol: upstreamText,
  size: upstreamNumber,
  age: upstreamNumber,
  ageHours: upstreamNumber,
  ageMinutes: upstreamNumber,
  publishDate: upstreamText,
  seeders: upstreamNumber,
  leechers: upstreamNumber,
  releaseGroup: upstreamText,
  approved: upstreamFlag,
  rejected: upstreamFlag,
  temporarilyRejected: upstreamFlag,
  rejections: z.array(rejectionSchema).nullish(),
  quality: releaseQualitySchema,
  languages: languageList,
  customFormats: customFormatList,
  customFormatScore: upstreamNumber,
  indexerFlags: indexerFlagValue,
});

export type UpstreamRelease = z.infer<typeof releaseSchema>;

/**
 * What a free-form upstream sentence may not carry out.
 *
 * A rejection reason is the one caller-visible field whose text an application
 * composes itself, so it is the one place the values the spec keeps off the
 * model-facing contract — a tracker URL, a magnet link, a canonical server
 * path, a credential, the upstream cache identity — can still appear even
 * though no property holding one is parsed. Each is replaced in place rather
 * than the whole reason dropped: the sentence around it is what tells a caller
 * what to do about it.
 *
 * The three patterns cover the *shapes* those values have, and
 * {@link safeReason} takes the *values* this server already holds — a release's
 * own GUID — as literals to remove, which is what closes the case a shape
 * cannot: an opaque identifier that looks like an ordinary word. Beyond those
 * two, the reason is prose composed by an instance the operator configured and
 * is passed through; a denylist over arbitrary prose has no terminating form,
 * so the boundary is drawn here deliberately rather than extended one phrase at
 * a time.
 *
 * A path run begins where a word does not, so a path an application wrapped in
 * quotes or brackets is redacted like any other, while ordinary prose such as
 * `1080p`, `24/7`, and `Series/Season` is left alone because each of those
 * follows a word character. It ends at {@link pathBoundary} — whitespace, or a
 * delimiter a sentence wraps a path in — and every segment ends there, the last
 * one included, so `("C:\\Media\\file.mkv")` gives up the path and keeps its
 * quote and parenthesis. The one relaxation is that an inner segment may
 * contain spaces, because a server path routinely does; it still stops at a
 * boundary character, so a run cannot leap across prose to a later separator
 * and take the sentence with it.
 *
 * The link and credential patterns deliberately do not share that boundary:
 * both run to whitespace, because a URL query and a cookie value legitimately
 * contain commas and brackets, and stopping early there would leave the tail of
 * a credential in the sentence. So they over-consume a closing bracket rather
 * than under-consume a secret — the safe direction for those two, and the
 * reason a rejection wrapping a link in parentheses keeps only its opening one.
 *
 * The credential pattern goes one step further and follows a `;`-separated run
 * of further `key=value` pairs, because a cookie or authorization header is
 * written that way and its value ends at the space *inside* it; without that a
 * `cookie=a=b; c=secret` reason would publish everything after the first space.
 * The continuation has to look like a pair, so ordinary prose after a semicolon
 * is left alone.
 */

/**
 * Where a path run ends, besides whitespace and a separator.
 *
 * Shared by all three segment rules so the first, inner, and final segments
 * cannot drift apart — the asymmetry that let a final segment swallow the
 * punctuation closing the sentence around it.
 *
 * A path segment that itself contains one of these is redacted only up to it,
 * so a bracketed library tag such as `/media/Show [2020]/file.mkv` leaves
 * `[2020]` behind between two redactions. That is the accepted cost of keeping
 * prose balanced: the root and the file name, which are what the spec keeps off
 * the contract, are both removed.
 */
const pathBoundary = `"'()\\[\\],;`;

const protectedPathPattern = new RegExp(
  `(?<!\\w)(?:~|[a-z]:)?[\\\\/]{1,2}` +
    `[^\\s\\\\/${pathBoundary}]+` +
    `(?:[\\\\/][^\\s\\\\/${pathBoundary}][^\\\\/${pathBoundary}]*?(?=[\\\\/]))*` +
    `(?:[\\\\/][^\\s\\\\/${pathBoundary}]*)?`,
  "giu",
);

const protectedPatterns: readonly RegExp[] = [
  /(?:\b[a-z][a-z0-9+.-]*:\/\/|\bmagnet:\?)\S+/giu,
  /(?<![\w-])(?:api[\s_-]?key|rss[\s_-]?key|passkey|auth(?:orization)?|token|secret|password|passwd|session|cookie)\s*[=:]\s*[^\s;]+(?:\s*;\s*[^\s;=]+\s*=\s*[^\s;]+)*/giu,
  protectedPathPattern,
];

const maxRejectionReasonLength = 300;

/**
 * The shortest literal worth removing from a sentence.
 *
 * A very short identifier is indistinguishable from an ordinary word, and
 * removing every occurrence of one would mangle the sentence it was meant to
 * keep readable.
 */
const minimumRedactableSecretLength = 8;

export function safeReason(
  value: string | null | undefined,
  secrets: readonly string[] = [],
): string | undefined {
  const trimmed = text(value);
  if (trimmed === undefined) {
    return undefined;
  }
  const patterned = protectedPatterns.reduce(
    (reason, pattern) => reason.replaceAll(pattern, "[redacted]"),
    trimmed,
  );
  // Literal replacement, so nothing a caller or an instance supplied is ever
  // compiled as a pattern.
  const scrubbed = text(
    secrets.reduce(
      (reason, secret) =>
        secret.length < minimumRedactableSecretLength
          ? reason
          : reason.replaceAll(secret, "[redacted]"),
      patterned,
    ),
  );
  if (scrubbed === undefined) {
    return undefined;
  }
  // The ellipsis replaces a character rather than being appended, so the bound
  // holds for what the caller actually receives.
  return scrubbed.length > maxRejectionReasonLength
    ? `${scrubbed.slice(0, maxRejectionReasonLength - 1)}…`
    : scrubbed;
}

/**
 * One upstream label, with the caller's own literals removed before the rest.
 *
 * Defined here, beside {@link safeReason}, because it is that sanitizer plus a
 * label's length bound, and because both the acquisition and the import adapter
 * need it: each of them publishes lists of names an operator or an indexer
 * chose, and the two must not disagree about whether such a name is scrubbed.
 */
export function scrubLabel(
  value: string | null | undefined,
  known: readonly string[],
): string | undefined {
  return safeLabel(safeReason(value, known));
}

/**
 * Every marker either sanitizer can leave behind.
 *
 * {@link safeReason} writes a bare `[redacted]`, and `safeLabel` writes kinded
 * ones — `[redacted url]`, `[redacted path]`, `[redacted id]` — so the shape has
 * to be matched rather than a single literal.
 */
const redactionMarker = /\[redacted[^\]]*\]/gu;

/** Whether a scrubbed label has nothing left but the markers of what it lost. */
function namesNothing(label: string): boolean {
  return label.replaceAll(redactionMarker, "").trim() === "";
}

/**
 * A list of upstream labels, each sanitized rather than merely trimmed.
 *
 * `textList` normalizes; it does not scrub. Every member of these lists is a
 * name an operator or an indexer chose — a custom format, a language, an
 * indexer flag, an indexer category — so any of them can carry a path, a URL,
 * or an identifier, and on these surfaces that is the one thing that must not
 * travel.
 *
 * A member that is *entirely* redacted is dropped rather than returned as a
 * marker, because a label that says only "[redacted]" names nothing a caller
 * can use. A member that is only partly redacted is kept: {@link scrubLabel}
 * has already replaced the protected run, so the words around it disclose
 * nothing and are the half that told the caller something. Where the sensitive
 * substring happened to sit inside the name is not a reason to publish
 * "Freeleech, see [redacted]" and discard "[redacted] Freeleech" — they carry
 * the same information and now meet the same fate.
 */
export function safeLabelList(
  values: readonly (string | null | undefined)[] | null | undefined,
  known: readonly string[],
): readonly string[] | undefined {
  if (!Array.isArray(values)) {
    return undefined;
  }
  const cleaned = values
    .map((value) => scrubLabel(value, known))
    .filter((value): value is string => value !== undefined && !namesNothing(value));
  return cleaned.length === 0 ? undefined : cleaned;
}

function rejectionType(value: string | null | undefined): ReleaseRejectionType {
  const name = text(value)?.toLowerCase();
  return name === "permanent" || name === "temporary" ? name : "unknown";
}

/**
 * Maps one release's rejections, keeping its own cache identity out of its own
 * reasons — an application that names the release it refused would otherwise
 * publish the GUID this server deliberately holds beside the candidate.
 */
function releaseRejections(record: UpstreamRelease): readonly ReleaseRejection[] {
  return (record.rejections ?? []).flatMap((rejection): ReleaseRejection[] => {
    const raw = typeof rejection === "string" ? rejection : rejection.reason;
    const reason = safeReason(raw, [record.guid]);
    if (reason === undefined) {
      return [];
    }
    return [
      { reason, type: typeof rejection === "string" ? "unknown" : rejectionType(rejection.type) },
    ];
  });
}

/**
 * Whether the application would accept this release as it stands.
 *
 * The instance's own answer wins whenever it states one, so a release an
 * application approved despite reporting an advisory rejection is not silently
 * re-judged here. Only when it states none is the answer derived, and then both
 * rejection flags are consulted before the list is: an instance that reports a
 * release as temporarily rejected without listing a reason has still refused
 * it, and reading an empty list as approval would offer the caller a release
 * the application will not take.
 */
function releaseApproved(
  record: UpstreamRelease,
  rejections: readonly ReleaseRejection[],
): boolean {
  const approved = flag(record.approved);
  if (approved !== undefined) {
    return approved;
  }
  const rejected = flag(record.rejected);
  if (rejected === true || flag(record.temporarilyRejected) === true) {
    return false;
  }
  return rejected === false || rejections.length === 0;
}

export function releaseDecision(record: UpstreamRelease): ReleaseDecision {
  const rejections = releaseRejections(record);
  return { approved: releaseApproved(record, rejections), rejections };
}

function releaseProtocol(value: string | null | undefined): ReleaseProtocol {
  const name = text(value)?.toLowerCase();
  return name === "torrent" || name === "usenet" ? name : "unknown";
}

/**
 * How old a release is, in minutes.
 *
 * The applications report age in three units and populate whichever ones they
 * please, so the most precise present one wins. Zero is a real answer — a
 * release published moments ago — which is why each unit is tested for absence
 * rather than for falsiness.
 */
function releaseAgeMinutes(record: UpstreamRelease): number | undefined {
  const minutes = count(record.ageMinutes);
  if (minutes !== undefined) {
    return Math.round(minutes);
  }
  const hours = count(record.ageHours);
  if (hours !== undefined) {
    return Math.round(hours * 60);
  }
  const days = count(record.age);
  return days === undefined ? undefined : Math.round(days * 1440);
}

function releaseQuality(
  quality: UpstreamRelease["quality"],
  known: readonly string[],
): ReleaseQuality | undefined {
  if (quality === null || quality === undefined) {
    return undefined;
  }
  const version = count(quality.revision?.version);
  return present({
    name: scrubLabel(quality.quality?.name, known),
    source: scrubLabel(quality.quality?.source, known),
    resolution: count(quality.quality?.resolution),
    proper: version === undefined ? undefined : version > 1,
    repack: flag(quality.revision?.isRepack),
  });
}

/**
 * The advisory half of a release, which only a full-detail search asks for.
 *
 * Every name here is one an operator or an indexer chose — a custom format an
 * operator wrote, a flag an indexer declares, a category an indexer publishes —
 * so any of them can carry a tracker URL, a credential, or a server path
 * exactly as a rejection reason can, and all of them are scrubbed on the way
 * out against the same literals, the release's own cache identity included.
 * That is also what the import adapter does with the same fields, so one
 * concept cannot be scrubbed on one surface and published verbatim on the
 * other. The categories arrive already scrubbed because only Prowlarr reports
 * them, and it is the adapter that declares them.
 */
function releaseDetail(
  record: UpstreamRelease,
  detail: ReleaseDetailLevel,
  categories: readonly string[] | undefined,
  known: readonly string[],
): ReleaseDetail | undefined {
  if (detail !== "full") {
    return undefined;
  }
  return present({
    customFormats: safeLabelList(
      (record.customFormats ?? []).map((format) => format.name),
      known,
    ),
    customFormatScore: count(record.customFormatScore),
    indexerFlags: safeLabelList(indexerFlagStrings(record.indexerFlags), known),
    categories,
  });
}

export interface ReleaseBaseOptions {
  readonly detail: ReleaseDetailLevel;
  /**
   * Whether this application judges a release. Passed rather than inferred so
   * that an application which reports no decision publishes none, instead of an
   * empty rejection list that would read as an approval.
   */
  readonly decided: boolean;
  readonly categories?: readonly string[] | undefined;
}

/**
 * Maps the half of a release every application describes the same way.
 *
 * Every label on the result is scrubbed, and against the same literals the
 * rejection reasons are — the release's own cache identity included. The
 * indexer's name is the operator's own wording, the quality and the language
 * are names an application publishes and an operator may rename, and the
 * release group is a fragment the application parsed out of the indexer's
 * title: none of them is prose this server composed, so each can carry a link,
 * a credential, or a canonical path, and each is held to the same rule as the
 * indexer flags and the custom formats. The activity and import adapters
 * already scrub their counterparts of these fields; publishing one of them
 * verbatim here is the divergence, not the scrubbing.
 *
 * The title is deliberately not among them. It is the release's identity — the
 * one field a caller reads to choose between two offers, and the one this
 * schema requires — and every other adapter in this project passes an
 * application's own title through as it stands.
 */
export function mapReleaseBase(
  record: UpstreamRelease,
  options: ReleaseBaseOptions,
): ReleaseCandidateBase {
  const known = [record.guid];
  return {
    title: record.title,
    indexer: { id: count(record.indexerId), name: scrubLabel(record.indexer, known) },
    protocol: releaseProtocol(record.protocol),
    quality: releaseQuality(record.quality, known),
    languages: safeLabelList(
      (record.languages ?? []).map((language) => language.name),
      known,
    ),
    sizeBytes: count(record.size),
    publishedAt: text(record.publishDate),
    ageMinutes: releaseAgeMinutes(record),
    seeders: count(record.seeders),
    leechers: count(record.leechers),
    releaseGroup: scrubLabel(record.releaseGroup, known),
    decision: options.decided ? releaseDecision(record) : undefined,
    detail: releaseDetail(record, options.detail, options.categories, known),
  };
}

/**
 * The upstream cache identity for one release.
 *
 * It is built here, next to the schema that decided which fields exist at all,
 * so the two facts stay together: the identity carries the GUID and indexer the
 * application files its own cache under, and the protected link the same
 * payload contained was never parsed in the first place.
 */
export function cacheIdentity(
  application: ApplicationId,
  record: UpstreamRelease,
): ReleaseCacheIdentity {
  return { application, guid: record.guid, indexerId: count(record.indexerId) };
}
