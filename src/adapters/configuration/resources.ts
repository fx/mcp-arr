import type { ApplicationId } from "../../applications.js";
import type { ConfigurationDomain } from "./domains.js";

/**
 * The lossless internal representation of upstream configuration.
 *
 * The *arr applications update configuration by full resource: a PUT sends the
 * whole record back, and every field the sender omits is erased. A newer
 * instance — or a newer dynamic provider definition — can carry fields this
 * server has never heard of, so an update rebuilt from the allowlisted output
 * model would silently reset them. What is kept here is therefore the upstream
 * payload exactly as it arrived, byte-for-byte in structure: no normalization,
 * no dropped unknowns, no re-ordering.
 *
 * That makes this the one place in the configuration adapter that holds secret
 * values, so it is deliberately hard to leak or corrupt.
 *
 * Because a docstring that promises more than the code delivers is worse than
 * no docstring, every guarantee this module states is listed here with how it
 * is enforced. `readonly` is a compile-time claim only and stops nothing at
 * runtime, so each guarantee that matters is backed by a runtime mechanism and
 * pinned by a test.
 *
 * 1. **The stored payload is nobody else's to change.** It is deep-cloned on
 *    the way in and deep-frozen, so neither the HTTP boundary's handle nor the
 *    caller's own object can alter it afterwards. *Runtime: `structuredClone`
 *    plus a recursive `Object.freeze`.*
 * 2. **Reading it yields a mutable copy.** A full-resource write is a
 *    read-modify-write, so `payload()` clones again and one write's edits never
 *    become the next read's current state. *Runtime: `structuredClone`.*
 * 3. **A captured resource cannot be re-pointed.** Its `id` decides what
 *    {@link ConfigurationResourceSet.find} matches, and its `payload` decides
 *    what a write sends, so neither may be reassigned. *Runtime:
 *    `Object.freeze` on the wrapper, and again on every resource a set admits.*
 * 4. **A set holds only its own application and domain.** A mismatched entry is
 *    rejected at construction rather than filtered, because a census reporting
 *    one domain while `find` searches another is a programming error worth
 *    failing on. *Runtime: a constructor check that throws.*
 * 5. **A set cannot be reshaped after construction.** It copies and freezes the
 *    array it is handed and freezes itself, so neither the caller's retained
 *    reference nor a consumer of `list()` can reorder, extend, or shorten it,
 *    and its reported application and domain cannot be reassigned. *Runtime:
 *    `Object.freeze` on the copied array and on the instance.*
 * 6. **Serializing a set yields a census, never its contents.** `JSON.stringify`
 *    produces `{application, domain, size}`. Enumeration — spreading it, or
 *    `Object.entries` — reaches only those two labels, because the resources
 *    live in a private field with nothing to enumerate. Neither route reaches a
 *    payload. *Runtime: a private `#resources` field and an explicit
 *    {@link ConfigurationResourceSet.toJSON}.*
 *
 * Reaching a payload at all therefore takes a deliberate {@link
 * ConfigurationResourceSet.list} or {@link ConfigurationResourceSet.find} call,
 * which is the boundary a later write crosses on purpose and a result
 * serializer never does.
 */

/** Everything an upstream configuration payload can be. */
export type UpstreamValue =
  | string
  | number
  | boolean
  | null
  | readonly UpstreamValue[]
  | { readonly [key: string]: UpstreamValue };

export interface UpstreamResource {
  readonly application: ApplicationId;
  readonly domain: ConfigurationDomain;
  /** The upstream row identifier, absent for a payload that reported none. */
  readonly id: number | undefined;
  /**
   * A mutable copy of the untouched upstream payload.
   *
   * A copy, because a full-resource write is a read-modify-write: the caller
   * edits the fields it owns and sends the rest back unchanged. Handing out the
   * stored payload itself would let one write's edits become the next read's
   * "current" state.
   */
  payload(): UpstreamValue;
}

function deepFreeze(value: UpstreamValue): UpstreamValue {
  if (value === null || typeof value !== "object") {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child as UpstreamValue);
  }
  return Object.freeze(value);
}

function identifierOf(value: UpstreamValue): number | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const id = (value as { readonly id?: UpstreamValue }).id;
  return typeof id === "number" && Number.isSafeInteger(id) ? id : undefined;
}

/**
 * Captures one upstream payload without interpreting it.
 *
 * The payload is cloned on the way in as well as on the way out, so nothing the
 * HTTP boundary still holds a handle to can change what a later write will
 * send.
 *
 * The wrapper is frozen along with the payload it wraps. `readonly` is a
 * compile-time claim only, and this is the one type in the adapter whose whole
 * justification is that it cannot be corrupted: a stray assignment to `id`
 * would silently break {@link ConfigurationResourceSet.find}, and replacing
 * `payload` would substitute what a later full-resource write sends upstream.
 */
export function captureUpstreamResource(
  application: ApplicationId,
  domain: ConfigurationDomain,
  value: UpstreamValue,
): UpstreamResource {
  const stored = deepFreeze(structuredClone(value) as UpstreamValue);
  return Object.freeze({
    application,
    domain,
    id: identifierOf(stored),
    payload: () => structuredClone(stored) as UpstreamValue,
  });
}

/** What {@link ConfigurationResourceSet} serializes to, in place of its contents. */
export interface ResourceSetCensus {
  readonly application: ApplicationId;
  readonly domain: ConfigurationDomain;
  readonly size: number;
}

/**
 * The internal resources one observation captured.
 *
 * This class carries guarantees 3 through 6 of the module contract above; each
 * is enforced in the constructor or by the shape of the class, and each has a
 * test of its own. The resources live in a private field rather than a
 * property, which is what leaves nothing for enumeration to reach: spreading
 * the instance or calling `Object.entries` on it yields only the application
 * and domain labels, and `JSON.stringify` yields the census {@link toJSON}
 * defines. No route reaches a payload without asking for one.
 */
export class ConfigurationResourceSet {
  readonly #resources: readonly UpstreamResource[];
  readonly application: ApplicationId;
  readonly domain: ConfigurationDomain;

  constructor(
    application: ApplicationId,
    domain: ConfigurationDomain,
    resources: readonly UpstreamResource[],
  ) {
    this.application = application;
    this.domain = domain;
    this.#resources = Object.freeze(
      resources.map((resource) => {
        // Rejected rather than filtered. A set that quietly dropped a foreign
        // resource would report a size its caller did not expect; one that
        // quietly kept it would answer `find` from a different application's
        // rows while the census named this one. Both are programming errors,
        // and neither should be discovered later through a wrong answer.
        if (resource.application !== application || resource.domain !== domain) {
          throw new RangeError(
            `A ${application}/${domain} resource set cannot hold a ${resource.application}/${resource.domain} resource`,
          );
        }
        // Frozen on admission, not only when this module captured it: the
        // parameter is structural, so a caller can hand in a resource it built
        // itself, keep its own reference, and later swap the `id` that `find`
        // matches on or the `payload` a full-resource write would send.
        return Object.freeze(resource);
      }),
    );
    Object.freeze(this);
  }

  get size(): number {
    return this.#resources.length;
  }

  list(): readonly UpstreamResource[] {
    return this.#resources;
  }

  find(id: number): UpstreamResource | undefined {
    return this.#resources.find((resource) => resource.id === id);
  }

  toJSON(): ResourceSetCensus {
    return { application: this.application, domain: this.domain, size: this.size };
  }
}
