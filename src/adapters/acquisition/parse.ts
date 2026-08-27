import { z } from "zod";
import type { ApplicationId } from "../../applications.js";
import {
  count,
  customFormatList,
  flag,
  languageList,
  languageNames,
  optionalUpstreamId,
  present,
  text,
  textList,
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

/**
 * Indexer flags, which have been a string list and a numeric bitmask across
 * releases. Neither is worth refusing a whole search over, so the element type
 * is left open and {@link flagNames} keeps only what it can name.
 */
const indexerFlagList = z.array(z.unknown()).nullish();

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
  indexerFlags: indexerFlagList,
});

export type UpstreamRelease = z.infer<typeof releaseSchema>;

function flagNames(values: readonly unknown[] | null | undefined): readonly string[] | undefined {
  return textList((values ?? []).filter((value): value is string => typeof value === "string"));
}

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
 * The path pattern requires a separator that starts a run and a real first
 * segment after it, so it takes `/mnt/media/example.mkv` and
 * `C:\\Media\\Example Series\\file.mkv` out of a sentence — an inner segment may
 * contain spaces, because a server path routinely does, but never the quotes,
 * brackets, or sentence punctuation that end one, so a run cannot leap across
 * prose to a later separator and redact the sentence with it. A run may begin
 * anywhere a word does not, rather than after a listed set of delimiters, so a
 * path an application wrapped in brackets or quotes is redacted like any other;
 * that is also what leaves ordinary prose such as `1080p`, `24/7`, and
 * `Series/Season` untouched, since each of those follows a word character.
 * Only the final segment stops at whitespace, which is what keeps a redaction
 * from swallowing the rest of the sentence.
 */
const protectedPatterns: readonly RegExp[] = [
  /(?:\b[a-z][a-z0-9+.-]*:\/\/|\bmagnet:\?)\S+/giu,
  /(?<![\w-])(?:api[\s_-]?key|rss[\s_-]?key|passkey|auth(?:orization)?|token|secret|password|passwd|session|cookie)\s*[=:]\s*\S+/giu,
  /(?<!\w)(?:~|[a-z]:)?[\\/]{1,2}[^\s\\/]+(?:[\\/][^\s\\/"'()[\],;][^\\/"'()[\],;]*?(?=[\\/]))*(?:[\\/][^\s\\/]*)?/giu,
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

function releaseQuality(quality: UpstreamRelease["quality"]): ReleaseQuality | undefined {
  if (quality === null || quality === undefined) {
    return undefined;
  }
  const version = count(quality.revision?.version);
  return present({
    name: text(quality.quality?.name),
    source: text(quality.quality?.source),
    resolution: count(quality.quality?.resolution),
    proper: version === undefined ? undefined : version > 1,
    repack: flag(quality.revision?.isRepack),
  });
}

function releaseDetail(
  record: UpstreamRelease,
  detail: ReleaseDetailLevel,
  categories: readonly string[] | undefined,
): ReleaseDetail | undefined {
  if (detail !== "full") {
    return undefined;
  }
  return present({
    customFormats: textList((record.customFormats ?? []).map((format) => format.name)),
    customFormatScore: count(record.customFormatScore),
    indexerFlags: flagNames(record.indexerFlags),
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

/** Maps the half of a release every application describes the same way. */
export function mapReleaseBase(
  record: UpstreamRelease,
  options: ReleaseBaseOptions,
): ReleaseCandidateBase {
  return {
    title: record.title,
    indexer: { id: count(record.indexerId), name: text(record.indexer) },
    protocol: releaseProtocol(record.protocol),
    quality: releaseQuality(record.quality),
    languages: languageNames(record.languages),
    sizeBytes: count(record.size),
    publishedAt: text(record.publishDate),
    ageMinutes: releaseAgeMinutes(record),
    seeders: count(record.seeders),
    leechers: count(record.leechers),
    releaseGroup: text(record.releaseGroup),
    decision: options.decided ? releaseDecision(record) : undefined,
    detail: releaseDetail(record, options.detail, options.categories),
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
