import { randomBytes } from "node:crypto";
import { maxTitleLength, safeText } from "../../adapters/activity/parse.js";
import { redactedSecretMarker } from "../../adapters/registry.js";
import type { MediaContext } from "./context.js";

/**
 * What a configured key becomes while the text is still being sanitized.
 *
 * The visible marker cannot stand in during that pass: it carries a space, and
 * the sanitizer reads whitespace as the end of a token, so a key replaced
 * inside a URL would split it and leave the rest — a password, a host — to be
 * read as ordinary words. This stands in instead. It is letters and digits
 * only, so it stays part of whatever token surrounds it and is redacted with
 * that token: a URL carrying it is still taken whole, and a long run it is
 * glued into is still taken as an identifier. It is short enough to match no
 * identifier rule on its own, and drawn at random once per process, so text an
 * upstream source wrote cannot spell it; and were one ever to, it would only
 * be shown as a redaction.
 */
const keySentinel = `Zq${randomBytes(6).toString("hex")}qZ`;

/**
 * Upstream text, as a `media` result may carry it, or `undefined` where
 * nothing publishable is left.
 *
 * Two rules apply and neither is enough alone. The shared upstream-text
 * sanitizer takes out what looks like a credential, a URL, or a path; the
 * registry takes out the API keys actually configured, whatever they look
 * like, and withholds the text outright when one is too short to mark.
 *
 * The exact rule runs on both sides of the sanitizer. Before it, with the
 * sentinel above, so the sanitizer's length bound cannot cut a key in half and
 * leave a readable prefix, and so the token a key sat in is redacted exactly
 * as it would have been with the key in place. After it, every sentinel that
 * survived becomes the visible marker — one the length bound cut short shows
 * only random characters — and the exact rule runs again, so a key split by a
 * hidden character the sanitizer deletes is caught once it is whole again.
 */
export function publishedText(context: MediaContext, value: string): string | undefined {
  const withheld = context.registry.withholdSecrets(value, keySentinel);
  if (withheld === undefined) {
    return undefined;
  }
  const sanitized = safeText(withheld, maxTitleLength);
  return sanitized === undefined
    ? undefined
    : context.registry.withholdSecrets(sanitized.replaceAll(keySentinel, redactedSecretMarker));
}
