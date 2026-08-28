import { z } from "zod";
import type { ApplicationId } from "../../applications.js";
import { UpstreamError } from "../../http/errors.js";

/**
 * Upstream payload parsing for the configuration readers.
 *
 * The schemas here validate only what a reader has to be able to find. Every
 * other property is left alone: it is preserved verbatim by the lossless
 * capture in {@link ./resources.js} and dropped from the model-facing output by
 * the allowlists in {@link ./fields.js}, so there is nothing for a schema to say
 * about it. Requiring more would refuse instances that work.
 */

/**
 * Whether an upstream `id` is one both halves of this adapter can use.
 *
 * The model-facing output mints a reference from it and the lossless capture in
 * {@link ./resources.js} matches on it, so a value only one of them accepted
 * would leave a record a caller can name and the internal side cannot find.
 * That is the divergence the two-representation design exists to prevent, so
 * both halves — and the schemas below — decide it here and nowhere else.
 *
 * Safe integers only: a fraction is not a row identifier, and a magnitude past
 * the safe range no longer denotes the row upstream meant.
 */
export function isUpstreamId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

const upstreamId = z.custom<number>(isUpstreamId);

const optionalUpstreamId = upstreamId.nullish();

const upstreamText = z.string().nullish();

const upstreamFlag = z.boolean().nullish();

const upstreamNumber = z.number().nullish();

/**
 * One dynamic provider field as a configured resource reports it.
 *
 * `value` is `unknown` by design. A definition file decides what it holds, and
 * the point of the classifier is that nothing gets to assume a shape before the
 * field has been classified; typing it here would be that assumption.
 *
 * It is also optional, because an unset field arrives with the key absent rather
 * than with a null — an `authPassword` nobody filled in is simply not there. In
 * zod 4 a bare `z.unknown()` is a required key, where zod 3 made it optional, so
 * leaving it bare would refuse that ordinary shape and turn every provider
 * record carrying one unconfigured field into an unexpected-response refusal.
 * Optional changes only whether the key must be present; the value still reaches
 * the classifier unexamined.
 */
export const providerFieldSchema = z.object({
  name: z.string().min(1),
  value: z.unknown().optional(),
  privacy: upstreamText,
});

export const providerResourceSchema = z.object({
  id: optionalUpstreamId,
  name: upstreamText,
  implementation: upstreamText,
  implementationName: upstreamText,
  configContract: upstreamText,
  protocol: upstreamText,
  priority: upstreamNumber,
  enable: upstreamFlag,
  enableRss: upstreamFlag,
  enableAutomaticSearch: upstreamFlag,
  enableInteractiveSearch: upstreamFlag,
  syncLevel: upstreamText,
  tags: z.array(upstreamId).nullish(),
  fields: z.array(providerFieldSchema).nullish(),
});

export type UpstreamProviderResource = z.infer<typeof providerResourceSchema>;

/**
 * A quality-profile entry, which nests: a group carries its own name and the
 * qualities under it, while a leaf carries one quality. Both are reported by
 * name in the order the instance sent them, because that order is the profile's
 * preference and a later full-resource write has to send it back unchanged.
 */
const qualityProfileItemSchema = z.object({
  name: upstreamText,
  allowed: upstreamFlag,
  quality: z.object({ id: optionalUpstreamId, name: upstreamText }).nullish(),
});

export const qualityProfileSchema = z.object({
  id: optionalUpstreamId,
  name: upstreamText,
  items: z.array(qualityProfileItemSchema).nullish(),
  formatItems: z.array(z.object({ name: upstreamText, score: upstreamNumber })).nullish(),
});

export const customFormatSchema = z.object({
  id: optionalUpstreamId,
  name: upstreamText,
  specifications: z.array(z.object({ name: upstreamText })).nullish(),
});

/** Everything else in the profile and resource families is a flat record. */
export const flatRecordSchema = z.object({
  id: optionalUpstreamId,
  name: upstreamText,
  label: upstreamText,
});

export function isUpstreamRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parses one upstream body, turning a shape this server cannot read into the
 * same redacted {@link UpstreamError} every other upstream failure produces.
 *
 * The error names the route and nothing else. A payload this server did not
 * expect is precisely the payload it must not quote back: an instance that
 * answers a configuration route with an error document, a login page, or a
 * proxy's response would otherwise have that body echoed into a tool result.
 */
export function parseConfiguration<TSchema extends z.ZodType>(
  schema: TSchema,
  body: unknown,
  application: ApplicationId,
  route: string,
): z.infer<TSchema> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new UpstreamError("unexpected-response", { application, operation: route });
  }
  return parsed.data;
}

/**
 * Requires a collection body.
 *
 * Every configuration route this server reads answers with an array. An
 * instance that answers with an object is reporting something else — an error
 * document is the usual case — and is refused without being read.
 */
export function parseCollection(
  body: unknown,
  application: ApplicationId,
  route: string,
): readonly unknown[] {
  if (!Array.isArray(body)) {
    throw new UpstreamError("unexpected-response", { application, operation: route });
  }
  return body;
}
