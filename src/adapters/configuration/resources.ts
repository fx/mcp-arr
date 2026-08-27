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
 * values, so it is deliberately hard to leak. The payload is frozen, it is
 * reachable only through a method call, and the set that holds it serializes to
 * a census rather than to its contents — an internal record that ever reached
 * `JSON.stringify` on the way to a caller produces a count, not a password.
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
 * The records are held in a private field rather than a property, so the class
 * has nothing to enumerate: spreading it, `Object.entries`, and a plain
 * `JSON.stringify` all yield the census that {@link toJSON} defines instead of
 * the payloads. Reaching a payload takes a deliberate {@link list} or
 * {@link find} call, which is exactly the boundary a later write crosses on
 * purpose and a result serializer never does.
 *
 * Integrity is enforced at runtime rather than claimed in the type. The set
 * copies and freezes the array it is given, so a caller that keeps its own
 * handle and mutates it afterwards cannot change what this set holds, and
 * {@link list} therefore hands out something no consumer can reorder or
 * shorten. The instance itself is frozen too, so neither the application nor
 * the domain it reports can be reassigned after construction.
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
    // Each element is frozen too, not just the array. The constructor's
    // parameter is structural, so a caller can hand in a resource it built
    // itself rather than one `captureUpstreamResource` returned, keep its own
    // reference, and later swap the `id` that `find` matches on or the
    // `payload` a full-resource write would send.
    this.#resources = Object.freeze(resources.map((resource) => Object.freeze(resource)));
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
