import {
  classifyValue,
  coversValue,
  createIdentifyingNeutralizer,
  factOf,
  identifyingFieldOf,
} from "./fixture-contract.mjs";

/**
 * Replaces what the fixture screens refuse, keeping the shape intact.
 *
 * The screens decide; this only supplies the replacement, and it takes the
 * decision from the refusal they raise rather than from a second copy of their
 * rules. A key the screens name as secret-bearing or identifying is dropped
 * outright: a credential's field name is what makes it findable, and no fixture
 * needs it. Anything else refused — a value, or a key whose own text is a path
 * or a URL — becomes a neutral stand-in, distinct per original text so that two
 * fields which carried the same text still carry the same text afterwards. What
 * a fixture owes is its field shapes, not its text.
 *
 * A field that identifies the library or the services behind it — a title, an
 * overview, artwork, a metadata id, an indexer's or a client's name, a
 * download's id — is replaced by the stand-in the fixture contract defines
 * for it, whatever it holds, rather than only when a screen refuses its text:
 * the contract refuses any other value there, and it is the one definition of
 * which fields those are. Every date the body holds is moved by the one
 * offset that capture chose, whatever field it is in.
 *
 * It is a module of its own so the contract test can run the capture's own
 * replacement over every rule and field the contract defines, without an
 * instance; `fail` is how the caller stops on a body it cannot write.
 */
export function createSanitizer(screen, fail) {
  const replacements = new Map();
  const identifying = createIdentifyingNeutralizer();

  /** `keep`, `drop` — the name itself is the disclosure — or `rename`. */
  const keyDisposition = (key) => {
    try {
      // Probed with no value, so only the name is judged: an identifying
      // field holding nothing is neutral, and its name is not a disclosure.
      screen({ [key]: null }, "value");
      return "keep";
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      return /^(?:Secret-bearing|Identifying) key/u.test(message) ? "drop" : "rename";
    }
  };

  // Only the screens that refuse a credential, a host, a path, or an address
  // decide this; which text identifies a library is decided by its field.
  const refusesValue = (value) => {
    try {
      screen(value, "value", undefined, { classified: true });
      return false;
    } catch {
      return true;
    }
  };

  const replace = (value) => {
    const existing = replacements.get(value);
    if (existing !== undefined) {
      return existing;
    }
    const ordinal = replacements.size + 1;
    // A value that reads as an absolute path stays one, so a path field keeps
    // describing a path. `/media/example` is the one prefix the screens allow.
    const isPath =
      value.startsWith("/") || /^[a-z]:[\\/]/iu.test(value) || value.startsWith("\\\\");
    const fresh = isPath ? `/media/example/example-${ordinal}` : `example-value-${ordinal}`;
    replacements.set(value, fresh);
    return fresh;
  };

  /**
   * The two texts a provider field's value carries as meaning, not as content.
   *
   * A blank value is how these applications say a credential is unset, and a
   * run of asterisks is what they substitute for one that is set — the
   * configuration adapter reads both as state rather than as text. Replacing
   * either would make a recaptured fixture claim the opposite of what the
   * instance said, which is the class of defect this whole change exists to
   * end. Neither can carry a credential: one is empty and the other is the
   * applications' own stand-in for the secret they are not disclosing.
   */
  const statesRatherThanCarries = (value) => value.trim() === "" || /^\*+$/u.test(value.trim());

  /** Replaces every string inside a value, however it is nested. */
  const redact = (value) => {
    if (Array.isArray(value)) {
      return value.map(redact);
    }
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redact(child)]));
    }
    if (typeof value !== "string" || statesRatherThanCarries(value)) {
      return value;
    }
    return replace(value);
  };

  /**
   * Whether this object is a dynamically described provider field.
   *
   * These applications describe a provider's settings as a list of
   * `{ name, value }` pairs, so a credential arrives under the property name
   * `value` with its real name as a sibling. Screening the property name alone
   * sees `value`, finds nothing to object to, and writes the credential — the
   * one shape where what a field holds is stated beside it rather than by the
   * key it is under.
   *
   * Every such value is replaced, not only those whose sibling name the secret
   * list happens to spell. That list cannot be the test here: a private tracker
   * calls its credential `passkey`, `authkey`, `rssKey` or `torrent_pass`, a
   * Cardigann definition may call it anything at all, and adding `key` or
   * `pass` to the list instead would refuse `sortKey` in every paged fixture.
   * A provider field's value is instance configuration that no fixture's shape
   * depends on — the shape is the field's presence, its name and its type, and
   * all three survive — so the safe rule is the one that does not need to
   * recognize the credential to protect it.
   */
  const isProviderField = (value) =>
    typeof value.name === "string" && Object.hasOwn(value, "value");

  /**
   * `context` is where a value sits: the key it is under, the object that key
   * is in, and the key that object sits under, which decide what some fields
   * name. A list's items, however deeply lists nest, sit where the list does.
   */
  const sanitize = (value, context = {}) => {
    if (Array.isArray(value)) {
      // Only a list's direct items are covered by the field that named it.
      return value.map((item) =>
        sanitize(item, Array.isArray(item) ? { ...context, classified: false } : context),
      );
    }
    if (typeof value === "object" && value !== null) {
      const redactSiblingValue = isProviderField(value);
      const entries = [];
      for (const [key, child] of Object.entries(value)) {
        const disposition = keyDisposition(key);
        if (disposition === "drop") {
          continue;
        }
        // A key is text the instance chose too. Where a payload is a dictionary
        // its keys carry paths and URLs, and one held only to the name lists
        // would be written verbatim — so such a key is replaced exactly as a
        // value is rather than dropped, which would take its value with it and
        // lose a field the shape has.
        const sanitizedKey = disposition === "rename" ? replace(key) : key;
        const field =
          disposition === "keep" && context.fact === undefined
            ? identifyingFieldOf(key, value, context.key)
            : undefined;
        // A fact's context passes to every descendant, whatever its key.
        const fact = context.fact ?? factOf(field);
        const at = { key, parent: value, container: context.key };
        entries.push([
          sanitizedKey,
          fact !== undefined
            ? sanitize(child, { ...at, fact })
            : field !== undefined
              ? // Screened as well, for what a stand-in leaves in place, such as
                // the text beside a rating's numbers or a rejection's own fields;
                // a value the field does not cover as it is is judged leaf by leaf.
                sanitize(identifying.neutralize(field, child), {
                  ...at,
                  classified: coversValue(field, child),
                })
              : redactSiblingValue && key === "value"
                ? redact(child)
                : sanitize(child, at),
        ]);
      }
      // A replaced key could land on one the object already has, and building
      // the object would then drop a field rather than record it. This tool
      // refuses rather than writing something the instance did not answer.
      const keys = entries.map(([key]) => key);
      if (new Set(keys).size !== keys.length) {
        fail("A sanitized key collided with another. Nothing was written.");
      }
      // Built as entries rather than assigned: `result.__proto__ = …` invokes
      // the prototype setter, so an upstream key of that name would silently
      // take its whole subtree out of the fixture.
      return Object.fromEntries(entries);
    }
    if (context.fact !== undefined && typeof value !== "object") {
      return identifying.neutralizeFactLeaf(context.fact, context.key, value);
    }
    if (typeof value === "number" && context.classified !== true) {
      // A number is structural unless a named field holds it, however deeply.
      const field = identifyingFieldOf(context.key, context.parent ?? {}, context.container);
      return field === undefined ? value : identifying.neutralize(field, value);
    }
    if (typeof value === "string" && context.classified !== true) {
      // Every string is identifying unless a rule recognizes it as
      // structure, wherever it sits; a named field's was replaced with it.
      const field = classifyValue(context.key, context.parent ?? {}, context.container, value);
      if (field !== undefined) {
        return identifying.neutralize(field, value);
      }
    }
    const shifted = identifying.shiftDate(value);
    if (shifted !== undefined) {
      return shifted;
    }
    if (typeof value === "string" && refusesValue(value)) {
      return replace(value);
    }
    return value;
  };

  return { sanitize, replacements };
}
