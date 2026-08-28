import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { ApplicationId } from "../../applications.js";
import { UpstreamError } from "../../http/errors.js";
import { text } from "../library/parse.js";

/**
 * Sanitizing and narrowing for the activity adapters.
 *
 * The generic upstream-payload helpers this module needs — `text`, `count`,
 * `present`, and the nullish field schemas — already exist in the library
 * adapter's parser and are imported rather than copied; only the parts that are
 * specific to activity payloads are defined here. Those parts are the ones the
 * library never needed: activity is where upstream hands this server free text
 * it did not author, so this module owns the sanitizer, the closed-set
 * narrowing, and the download-identity digest.
 */

/**
 * The upstream words this server understands, narrowed to a closed set.
 *
 * The *arr APIs report these as camel case — `importBlocked`,
 * `downloadClientUnavailable` — and every enumerated value in the activity
 * model is snake case, so the conversion is mechanical. What is not mechanical
 * is the membership test: a word this server does not know becomes the caller's
 * fallback rather than widening the set, because a state machine downstream
 * branches on these and must never be handed a value it has no case for.
 */
export function closedWord<TWord extends string>(
  value: string | null | undefined,
  allowed: readonly TWord[],
  fallback: TWord,
): TWord {
  const normalized = text(value)
    ?.replaceAll(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .toLowerCase();
  if (normalized === undefined) {
    return fallback;
  }
  return (allowed as readonly string[]).includes(normalized) ? (normalized as TWord) : fallback;
}

/**
 * The same narrowing, but reporting that upstream said nothing at all.
 *
 * A tracked download status the instance omitted and one it reported as a word
 * this server does not know are different facts, and the model keeps them
 * apart: the first is absent, the second is `unknown`.
 */
export function optionalClosedWord<TWord extends string>(
  value: string | null | undefined,
  allowed: readonly TWord[],
  fallback: TWord,
): TWord | undefined {
  return text(value) === undefined ? undefined : closedWord(value, allowed, fallback);
}

/**
 * The character classes upstream text is normalized against.
 *
 * They are named by Unicode general category rather than by a table of ranges,
 * because a hand-written table is wrong the moment it is written: an earlier
 * version of this listed the bidirectional overrides it could think of and
 * still let U+061C ARABIC LETTER MARK through. `Cf` is every format character —
 * the zero-width and word-joining characters, the bidirectional controls,
 * U+061C, and the byte order mark. `Cc` is every C0 and C1 control, which
 * covers NUL and the ANSI escape introducer.
 *
 * The whitespace test is deliberately applied to controls only, and never used
 * to exempt a format character. JavaScript counts U+FEFF as whitespace, so a
 * `\s` guard over both classes would have exempted the byte order mark — the
 * one format character an attacker is most likely to reach for.
 */
const formatPattern = /\p{Cf}/u;
const controlPattern = /\p{Cc}/u;
const whitespacePattern = /\s/u;

/**
 * Removes what can hide inside a token, and spaces what genuinely separates.
 *
 * A format character and a non-whitespace control are **deleted**, not turned
 * into a space, because turning one into a space is itself an attack: a
 * zero-width space or a NUL wedged into the middle of a URL would split it into
 * two tokens, and the redaction rules below would then take only the first,
 * leaving the tail readable. Deleting them puts the token back together before
 * anything tries to match it.
 *
 * A tab or a line break is real layout, so it becomes a space. What survives
 * such a break is a bare word rather than a path fragment — a path fragment is
 * recognizable by the separator it carries, and the residual-separator rule
 * takes anything that carries one.
 */
function normalizeHidden(value: string): string {
  let normalized = "";
  for (const character of value) {
    if (formatPattern.test(character)) {
      continue;
    }
    if (controlPattern.test(character)) {
      normalized += whitespacePattern.test(character) ? " " : "";
      continue;
    }
    normalized += character;
  }
  return normalized;
}

/**
 * Substrings that must never survive into a mapped message.
 *
 * Each pattern replaces with a fixed marker rather than deleting, so a reader
 * can see that something was removed and what kind of thing it was. The path
 * patterns use a lookbehind for the character before the path, which keeps the
 * surrounding sentence intact instead of eating the space in front of it.
 */
const redactions: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b[a-z][a-z0-9+.-]*:\/\/\S+/giu, "[redacted url]"],
  [/\\\\[^\s"']+/gu, "[redacted path]"],
  [/\b[a-z]:[\\/][^\s"']*/giu, "[redacted path]"],
  [/(?<=^|[\s"'([])~?\/[^\s"')\]]+/gu, "[redacted path]"],
  // A long unbroken run of identifier characters is a torrent hash, a GUID, or
  // a key — never a word. Twenty is below the shortest of those and above the
  // longest plausible word, so ordinary prose is untouched.
  [/\b[0-9a-f]{20,}\b/giu, "[redacted id]"],
  [/\b[A-Za-z0-9_-]{32,}\b/gu, "[redacted id]"],
];

/**
 * Anything still carrying a path separator of either kind.
 *
 * This is the rule that makes the ones above sufficient rather than merely
 * usual: each of them stops at the first space, so a real path —
 * `C:\\Example Folder\\file.mkv`, `/media/Example Series/file.mkv` — leaves a
 * readable tail behind, and this takes it. It runs last, after the URL rule has
 * consumed the one other thing that contains separators.
 *
 * What it does with a token it matched is the caller's decision, and for all but
 * two fields the answer is the same: redact it. Over-redaction is the deliberate
 * trade — a token such as `and/or` becomes a marker, and a path fragment never
 * survives. {@link safeTaxonomyLabel} is the single exception, and it is asked
 * for by name by the two fields whose values carry a separator by construction.
 * See {@link namesTaxonomy}.
 */
const residualSeparator = /[^\s"']*[\\/][^\s"']+|[^\s"']+[\\/][^\s"']*/gu;

/**
 * What a matched token becomes.
 *
 * The subject is the whole value the token was found in, after the redactions
 * above ran and before whitespace was collapsed. Only the taxonomy rule reads
 * it, and it reads it to insist that the token is the entire value rather than
 * the surviving tail of something larger.
 */
type ResidualRule = (token: string, subject: string) => string;

/** What every residual separator becomes outside a taxonomy field: redacted. */
function redactResidual(): string {
  return "[redacted path]";
}

/** The ceiling on one sanitized message. Long enough for a real diagnostic. */
export const maxMessageLength = 500;

/**
 * Sanitizes one piece of upstream free text.
 *
 * The order is deliberate. Hidden characters go first, so a redaction cannot be
 * evaded by wedging a zero-width space into the middle of a URL or a path — the
 * token is whole again before any pattern runs. Redaction comes next.
 * Whitespace is collapsed after that, so a message cannot lay itself out as a
 * fake structure. The length bound is applied last, to the result: a caller
 * cannot push content past the cap by padding what precedes it, because the
 * padding is gone by then.
 */
function sanitize(
  value: string | null | undefined,
  maxLength: number,
  residual: ResidualRule,
): string | undefined {
  const raw = text(value);
  if (raw === undefined) {
    return undefined;
  }
  let cleaned = normalizeHidden(raw);
  for (const [pattern, marker] of redactions) {
    cleaned = cleaned.replaceAll(pattern, marker);
  }
  const subject = cleaned;
  cleaned = cleaned.replaceAll(residualSeparator, (token) => residual(token, subject));
  cleaned = cleaned.replaceAll(/\s+/gu, " ").trim();
  if (cleaned === "") {
    return undefined;
  }
  return cleaned.length <= maxLength ? cleaned : `${cleaned.slice(0, maxLength).trimEnd()}…`;
}

export function safeText(
  value: string | null | undefined,
  maxLength = maxMessageLength,
): string | undefined {
  return sanitize(value, maxLength, redactResidual);
}

/** A short sanitized label: an indexer name, a download client, a quality. */
export const maxLabelLength = 120;

/** The ceiling on a release title, which is upstream text this server sanitizes. */
export const maxTitleLength = 200;

/**
 * Sanitizes one short upstream label.
 *
 * It is {@link safeText} under a label's length bound and nothing else. Every
 * rule the prose sanitizer applies, this applies — the residual-separator rule
 * included — so a token carrying a separator of either kind never survives a
 * label either. A field whose published values are slash-delimited by
 * construction asks for {@link safeTaxonomyLabel} by name instead; nothing gets
 * that tolerance by default.
 */
export function safeLabel(value: string | null | undefined): string | undefined {
  return safeText(value, maxLabelLength);
}

/**
 * The longest a segment may be and still read as a name rather than a folder.
 *
 * The taxonomies {@link safeTaxonomyLabel} spares are terse by construction —
 * `HD`, `Foreign`, `Lossless`, `Proper` — so the bound is generous for a name
 * and short for the directory names a media root is actually built from.
 *
 * It is a defence in its own right rather than a restatement of the
 * opaque-identifier rule, which shares the number but not the reach. That rule
 * matches `[A-Za-z0-9_-]{32,}` between word boundaries, so it sees neither a
 * segment written in a non-ASCII script nor one an `&` has broken into runs
 * shorter than its threshold. A long opaque segment of either kind reaches this
 * bound un-redacted, and this bound is what takes it.
 */
const maxTaxonomySegmentLength = 32;

/**
 * One segment of a taxonomy label, as a name rather than a path component.
 *
 * It opens with a letter or a digit and continues with letters, digits, and the
 * few joiners a chosen name uses. A dot is excluded deliberately and is the
 * single most load-bearing exclusion here: a dot inside a segment is what a file
 * name, a host name, and a version string all have and what a category or a
 * format name never needs, so excluding it rejects `file.mkv`,
 * `tracker.example.invalid/x`, and `10.0.0.1/24` without having to guess at a
 * list of extensions. A colon is excluded for the same reason — it is a drive
 * letter or a scheme.
 *
 * A plus is excluded too, and for a reason the other exclusions do not share: no
 * *arr taxonomy value observed on a live instance uses one, while `+` and `/`
 * together are exactly the alphabet of unpadded base64, so admitting it would
 * have let a token shaped like a credential through a rule meant for `TV/HD`.
 */
const taxonomySegmentPattern = /^[\p{L}\p{N}][\p{L}\p{N}_&-]*$/u;

/**
 * Whether a separator joins two words of a name rather than two parts of a path.
 *
 * The values the two taxonomy fields publish are slash-delimited on purpose:
 * Prowlarr's category taxonomy is `TV/HD` and `Movies/UHD`, and the custom
 * format TRaSH Guides ships for a repacked release is literally named
 * `Repack/Proper`. Redacting those destroys the whole of what the field was for,
 * so those two fields need a test for what distinguishes a name from a path.
 *
 * Four properties do it, and a value must have all of them:
 *
 * 1. **The separator is a forward slash.** Every *arr taxonomy writes itself
 *    with one; a backslash appears in none of them and is the Windows path
 *    separator, so it is simply not a taxonomy separator here. Splitting on `/`
 *    alone is what refuses `server\share` and `C\Media` — a UNC share or a drive
 *    path whose prefix a rule above already ate — because each of those is then
 *    one segment carrying a character no segment may contain.
 * 2. **Exactly two segments, both non-empty.** A leading separator, a trailing
 *    separator, a UNC prefix, and a drive prefix all produce an empty segment or
 *    a third one. Real taxonomies are two-level — a category, then its
 *    subcategory — while a path worth hiding is a root plus what is under it,
 *    which is three parts or more by the time it names anything.
 * 3. **Neither segment carries a dot or a colon**, so nothing shaped like a file
 *    name, a host, or a drive survives.
 * 4. **Neither segment is longer than {@link maxTaxonomySegmentLength}.**
 *
 * This is a test of *shape*, and shape alone cannot tell `TV/HD` from
 * `etc/passwd`. A two-segment pair of short dotless words joined by a forward
 * slash that really is a path fragment — `etc/passwd`, `home/someone`,
 * `Users/someone`, `admin/hunter2` — passes it, and no refinement of the shape
 * can refuse those without refusing `Movies/UHD` too. That is not a defect in
 * the test; it is the reason its one caller is named after the two fields it
 * serves rather than being the default for every label.
 */
function namesTaxonomy(token: string): boolean {
  const segments = token.split("/");
  return (
    segments.length === 2 &&
    segments.every(
      (segment) =>
        segment.length <= maxTaxonomySegmentLength && taxonomySegmentPattern.test(segment),
    )
  );
}

/**
 * Sanitizes one label whose documented values carry a path separator.
 *
 * This is {@link safeLabel} with one deliberate hole in it, and the hole is why
 * it has a name of its own: a residual-separator token is published as it stands
 * when {@link namesTaxonomy} accepts its shape **and** the token is the entire
 * value. Use it only for a field whose taxonomy is slash-delimited by
 * construction — a Prowlarr category, a custom format — and never for a field
 * that merely might contain a separator one day.
 *
 * The whole-value condition is what keeps the hole from widening. Every path
 * rule above is `[^\s"']`-bounded and so stops at the first space, which leaves
 * the tail of a space-bearing path behind as a token of its own:
 * `\\\\server\\share$\\Private Stash\\Home Movies` reaches this rule as
 * `[redacted path] Stash\\Home Movies`. Shape alone would spare `Stash\\Home`
 * and disclose two directory names; requiring the token to be the whole value
 * refuses it, because a value that has already lost a head to a redaction marker
 * is not a category name. What a taxonomy field publishes is one bare value, and
 * that is all this admits.
 *
 * It remains weaker than {@link safeLabel}, by exactly the residue
 * {@link namesTaxonomy} describes: a bare `root/child` pair of short dotless
 * words is published. The three fields that call it — Prowlarr's categories and
 * the custom formats on both the acquisition and the import surface — are the
 * whole of that exposure, and none of them reads an upstream `data` bag.
 */
export function safeTaxonomyLabel(value: string | null | undefined): string | undefined {
  return sanitize(value, maxLabelLength, (token, subject) =>
    token === subject.trim() && namesTaxonomy(token) ? token : redactResidual(),
  );
}

/**
 * Salts the download-identity digest for this process only.
 *
 * A download-client identifier is short and low entropy — an info hash is drawn
 * from a space a determined holder of the digest could search. Salting with a
 * value that exists only in this process's memory makes the digest meaningless
 * outside it, while leaving it perfectly stable within one, which is all
 * correlation between a queue row and a history record needs.
 */
const identitySalt = randomBytes(32);

/**
 * How many hexadecimal characters of the digest are kept.
 *
 * Exported because the published schema bounds the field to exactly this shape,
 * and a contract that stated a length of its own could drift from the one this
 * function actually mints.
 */
export const downloadIdentityLength = 16;

/**
 * A non-reversible stand-in for the download-client identifier.
 *
 * The identifier itself never leaves the adapter. What the model carries is
 * this digest, so a caller can tell that two rows describe the same download
 * without ever being told which download that is.
 */
export function downloadIdentity(value: string | null | undefined): string | undefined {
  const raw = text(value);
  if (raw === undefined) {
    return undefined;
  }
  return createHash("sha256")
    .update(identitySalt)
    .update(raw)
    .digest("hex")
    .slice(0, downloadIdentityLength);
}

/**
 * Parses one upstream body, turning a shape this server cannot map into the
 * same redacted {@link UpstreamError} every other upstream failure produces.
 *
 * It is the library parser's `parseUpstream` widened to every application:
 * Prowlarr has no media library, so the library's version narrows its parameter
 * to the two applications that do, and history, health, and command payloads
 * come from all three.
 */
export function parseActivity<TSchema extends z.ZodType>(
  schema: TSchema,
  body: unknown,
  application: ApplicationId,
  operation: string,
): z.infer<TSchema> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new UpstreamError("unexpected-response", { application, operation });
  }
  return parsed.data;
}

/** The upstream quality wrapper, reduced to the one name worth reporting. */
export const qualitySchema = z
  .object({ quality: z.object({ name: z.string().nullish() }).nullish() })
  .nullish();

export function qualityName(value: z.infer<typeof qualitySchema>): string | undefined {
  return safeLabel(value?.quality?.name);
}
