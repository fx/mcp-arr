import { maxTitleLength, safeText } from "../../adapters/activity/parse.js";
import type { MediaContext } from "./context.js";

/**
 * Upstream text, as a `media` result may carry it, or `undefined` where
 * nothing publishable is left.
 *
 * Two rules apply and neither is enough alone. The shared upstream-text
 * sanitizer takes out what looks like a credential, a URL, or a path; the
 * registry takes out the API keys actually configured, whatever they look
 * like, and withholds the text outright when one is too short to mark. The
 * exact rule runs on both sides of the sanitizer: before it, so its length
 * bound cannot cut a key in half and leave a readable prefix, and after it, so
 * a key split by a hidden character the sanitizer deletes is caught once it is
 * whole again.
 */
export function publishedText(context: MediaContext, value: string): string | undefined {
  const withheld = context.registry.withholdSecrets(value);
  if (withheld === undefined) {
    return undefined;
  }
  const sanitized = safeText(withheld, maxTitleLength);
  return sanitized === undefined ? undefined : context.registry.withholdSecrets(sanitized);
}
