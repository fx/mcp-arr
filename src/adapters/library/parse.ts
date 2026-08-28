import { z } from "zod";
import type { ApplicationId } from "../../applications.js";
import { UpstreamError } from "../../http/errors.js";

/**
 * Shared upstream-payload parsing for the library adapters.
 *
 * Two rules keep these schemas usable against releases nobody has recorded a
 * fixture for. Only the fields an adapter genuinely cannot map without are
 * required, and everything else is nullish, because the *arr APIs return `null`
 * for an absent value as readily as they omit the property. Unknown properties
 * are dropped rather than rejected, so a newer instance that adds a field is
 * never refused for being unfamiliar.
 */

/** An identifier as upstream reports it. */
export const upstreamId = z.number().int();

/**
 * An identifier or ordinal upstream may omit, null, or report as zero.
 *
 * It stays integral: a whole number is the only thing these fields ever are,
 * and a fractional value that parsed cleanly here could reach a media
 * reference, which is the identity every later change keys media on. Absence is
 * a real answer; `1.5` is a payload this server does not understand.
 */
export const optionalUpstreamId = z.number().int().nullish();

/** A string field that may be absent, null, or empty upstream. */
export const upstreamText = z.string().nullish();

export const upstreamNumber = z.number().nullish();

export const upstreamFlag = z.boolean().nullish();

/** Normalizes an upstream string, treating blank and whitespace-only as absent. */
export function text(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** Normalizes an upstream number, treating null and non-finite values as absent. */
export function count(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function flag(value: boolean | null | undefined): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/**
 * Keeps a nested record only when it has something to say.
 *
 * Every member of these records is optional, so one whose members are all
 * absent carries no information — and returning it anyway would say the
 * instance reported an empty thing rather than reporting nothing at all. The
 * normalized model makes each such record optional precisely so "unknown" and
 * "empty" stay distinguishable; this is what keeps them so.
 */
export function present<TRecord extends object>(record: TRecord): TRecord | undefined {
  return Object.values(record).some((value) => value !== undefined) ? record : undefined;
}

/** Normalizes a list, dropping blank entries and an absent list alike. */
export function textList(values: readonly (string | null | undefined)[] | null | undefined) {
  if (!Array.isArray(values)) {
    return undefined;
  }
  const cleaned = values.map(text).filter((value): value is string => value !== undefined);
  return cleaned.length === 0 ? undefined : cleaned;
}

/**
 * The paged envelope every `wanted/*` endpoint returns. `records` is the only
 * required member: an instance that stops reporting a total still produces a
 * usable page, and {@link upstreamPage} already has an answer for that case.
 */
export function pagedEnvelope<TRecord extends z.ZodType>(record: TRecord) {
  return z.object({
    page: optionalUpstreamId,
    pageSize: optionalUpstreamId,
    totalRecords: optionalUpstreamId,
    records: z.array(record),
  });
}

/**
 * Parses one upstream body, turning a shape this server cannot map into the
 * same redacted {@link UpstreamError} every other upstream failure produces.
 *
 * The error names only the route, never the body: a payload this server did not
 * expect is exactly the payload it must not quote back.
 */
export function parseUpstream<TSchema extends z.ZodType>(
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

/** The upstream quality wrapper both applications nest inside file records. */
export const qualityWrapper = z.object({
  quality: z.object({ name: upstreamText, resolution: upstreamNumber }).nullish(),
});

export const languageList = z.array(z.object({ name: upstreamText })).nullish();

export function languageNames(
  languages: ReadonlyArray<{ name?: string | null | undefined }> | null | undefined,
): readonly string[] | undefined {
  return Array.isArray(languages)
    ? textList(languages.map((language) => language.name))
    : undefined;
}

export const mediaInfoSchema = z
  .object({
    videoCodec: upstreamText,
    audioCodec: upstreamText,
    audioChannels: upstreamNumber,
    resolution: upstreamText,
    runTime: upstreamText,
  })
  .nullish();

export function mediaInfo(value: z.infer<typeof mediaInfoSchema>) {
  if (value === null || value === undefined) {
    return undefined;
  }
  return present({
    videoCodec: text(value.videoCodec),
    audioCodec: text(value.audioCodec),
    audioChannels: count(value.audioChannels),
    resolution: text(value.resolution),
    runTime: text(value.runTime),
  });
}

export const customFormatList = z.array(z.object({ name: upstreamText })).nullish();

/**
 * Indexer flags exactly as an instance sends them, whatever that turns out to
 * be.
 *
 * The field has shipped as a string list and as a numeric bitmask, and the two
 * forms are live at once: Sonarr's release route answers with a bitmask where
 * Radarr's answers with a list, and both manual-import routes answer with a
 * bitmask. Nothing this server returns depends on the value — every reader
 * keeps only the entries it can name and reports the rest as no flags — so
 * constraining the shape could only refuse a whole result over an advisory
 * field, and enumerating today's two forms would just defer that to the next
 * one.
 *
 * It is declared once, here, so the acquisition and import adapters cannot
 * disagree about one upstream concept.
 */
export const indexerFlagValue = z.unknown().nullish();

/**
 * The flag names an {@link indexerFlagValue} carried, if it carried any.
 *
 * A bitmask names nothing and yields no names: the bit-to-name mapping is an
 * application's internal enum rather than a documented contract, so decoding
 * one would publish a claim this project cannot keep true across versions.
 * Reporting no flags is honest; reporting guessed flags is not.
 *
 * A shape that names nothing is answered with an empty list rather than a
 * distinct absent value, because every caller passes the result through a list
 * normalizer that already reports an empty list as absent.
 */
export function indexerFlagStrings(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((flagName): flagName is string => typeof flagName === "string")
    : [];
}

/**
 * Adds a runtime to a start instant, which is how both calendars derive an end.
 * An unparsable instant or a non-positive runtime yields no end rather than an
 * invented one.
 */
export function endOf(start: string | undefined, runtimeMinutes: number | undefined) {
  if (start === undefined || runtimeMinutes === undefined || runtimeMinutes <= 0) {
    return undefined;
  }
  const parsed = Date.parse(start);
  if (Number.isNaN(parsed)) {
    return undefined;
  }
  return new Date(parsed + runtimeMinutes * 60_000).toISOString();
}
