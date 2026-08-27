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
  // Anything still carrying a path separator of either kind. This is the rule
  // that makes the four above sufficient rather than merely usual: each of them
  // stops at the first space, so a real path — `C:\\Example Folder\\file.mkv`,
  // `/media/Example Series/file.mkv` — leaves a readable tail behind, and this
  // takes it. It runs last, after the URL rule has consumed the one other thing
  // that contains separators. Over-redaction is the deliberate trade: a token
  // such as `and/or` becomes a marker, and a path fragment never survives.
  [/[^\s"']*[\\/][^\s"']+|[^\s"']+[\\/][^\s"']*/gu, "[redacted path]"],
];

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
export function safeText(
  value: string | null | undefined,
  maxLength = maxMessageLength,
): string | undefined {
  const raw = text(value);
  if (raw === undefined) {
    return undefined;
  }
  let cleaned = normalizeHidden(raw);
  for (const [pattern, marker] of redactions) {
    cleaned = cleaned.replaceAll(pattern, marker);
  }
  cleaned = cleaned.replaceAll(/\s+/gu, " ").trim();
  if (cleaned === "") {
    return undefined;
  }
  return cleaned.length <= maxLength ? cleaned : `${cleaned.slice(0, maxLength).trimEnd()}…`;
}

/** A short sanitized label: an indexer name, a download client, a quality. */
export const maxLabelLength = 120;

/** The ceiling on a release title, which is upstream text this server sanitizes. */
export const maxTitleLength = 200;

export function safeLabel(value: string | null | undefined): string | undefined {
  return safeText(value, maxLabelLength);
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
