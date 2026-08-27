import {
  checkResuppliedSecrets,
  type SecretCheck,
  type SecretRequirement,
  type TransientSecret,
} from "../../state/plans.js";
import { secretPresenceFingerprint } from "../../state/tokens.js";

/**
 * The transient secret channel.
 *
 * This server has no secret store and no local database, yet an upstream
 * provider cannot be configured without credentials. The resolution recorded in
 * the change document is that a secret may travel in one tool input, be used to
 * build one upstream request, and then cease to exist here — so applying a
 * recorded plan requires the caller to resupply each named secret, because the
 * plan never had the value to begin with.
 *
 * That is a promise about data, so it is made structurally rather than by
 * discipline, in the same way {@link ../configuration/resources.js} makes its
 * own. Three properties hold, and each is enforced rather than described.
 *
 * 1. **Nothing that can hold a value is serializable.** The values live in a
 *    private field, so spreading the bundle, enumerating it, or handing it to
 *    `JSON.stringify` reaches only the census {@link TransientSecrets.toJSON}
 *    defines. There is no property to find and no getter to read.
 * 2. **A compiled patch carries names, never values.** The write pulls each
 *    value from the bundle at the moment it builds the payload, so the object a
 *    plan retains — the patch — has nowhere to put a credential even in
 *    principle. This is the half that makes rule 1 worth anything: a bundle
 *    that could not be serialized would still leak if the plan held a copy of
 *    what it contained.
 * 3. **The values are erased once the request is built.** {@link
 *    TransientSecrets.erase} clears the map, which is what the change document
 *    requires of process-local plan and receipt data. A bundle is therefore
 *    single-use: a second reconciliation must be given the credentials again,
 *    which is the same rule apply-by-plan imposes and not a special case of it.
 *
 * The instance is frozen, which stops a caller from replacing a method with one
 * that reports something friendlier. Freezing deliberately does not stop {@link
 * TransientSecrets.erase}: a private field is not a property, so it stays
 * writable, and erasure is the one state change this type has to keep.
 */

/** What a bundle serializes to, in place of anything it holds. */
export interface TransientSecretCensus {
  readonly count: number;
  readonly erased: boolean;
}

export class TransientSecrets {
  readonly #values: Map<string, string>;
  #erased = false;

  /**
   * A duplicate name is refused rather than collapsed. Two values for one field
   * is a request nobody can satisfy, and picking one of them would send a
   * credential the caller did not choose.
   */
  constructor(secrets: readonly TransientSecret[] = []) {
    this.#values = new Map();
    for (const secret of secrets) {
      if (this.#values.has(secret.name)) {
        throw new RangeError(`A transient secret bundle cannot hold two ${secret.name} values`);
      }
      this.#values.set(secret.name, secret.value);
    }
    Object.freeze(this);
  }

  get size(): number {
    return this.#values.size;
  }

  get erased(): boolean {
    return this.#erased;
  }

  /**
   * The names this bundle carries values for.
   *
   * A name is not a credential and is already published — a plan states which
   * secrets it needs, and an observation reports which are configured — so this
   * is the one thing about a bundle that may be read out of it.
   */
  names(): readonly string[] {
    return [...this.#values.keys()];
  }

  has(name: string): boolean {
    return this.#values.has(name);
  }

  /**
   * What a plan records: that a named secret is required, and a process-local,
   * non-reversible fingerprint of the value it was validated against.
   */
  requirements(): readonly SecretRequirement[] {
    return [...this.#values].map(([name, value]) => ({
      name,
      presence: secretPresenceFingerprint(name, value),
    }));
  }

  /**
   * Checks this bundle against what a plan says it needs.
   *
   * The comparison happens inside the bundle so the values never have to be
   * handed to the caller to perform it. A resupplied value that differs from
   * the planned one is not an error — the credential may legitimately have been
   * rotated — but the shared checker says so out loud.
   */
  check(required: readonly SecretRequirement[]): SecretCheck {
    return checkResuppliedSecrets(
      required,
      [...this.#values].map(([name, value]) => ({ name, value })),
    );
  }

  /**
   * The value for one field, for the request being built right now.
   *
   * The only route out. It answers `undefined` for a name the caller did not
   * supply and for every name once the bundle has been erased, which is what
   * makes a reused bundle fail loudly instead of quietly sending nothing.
   */
  take(name: string): string | undefined {
    return this.#values.get(name);
  }

  /** Erases every value. Called once the upstream request has been built. */
  erase(): void {
    this.#values.clear();
    this.#erased = true;
  }

  toJSON(): TransientSecretCensus {
    return { count: this.size, erased: this.#erased };
  }
}

export type TransientSecretCollection =
  | { readonly status: "ok"; readonly secrets: TransientSecrets }
  | { readonly status: "duplicate"; readonly name: string };

/**
 * Builds a bundle from caller-supplied input without throwing.
 *
 * The constructor refuses a duplicate name, which is right for a programming
 * error and wrong for an argument: a caller that named one field twice deserves
 * a refusal it can act on, so the boundary that accepts caller input builds its
 * bundle through this.
 */
export function collectTransientSecrets(
  secrets: readonly TransientSecret[],
): TransientSecretCollection {
  const seen = new Set<string>();
  for (const secret of secrets) {
    if (seen.has(secret.name)) {
      return { status: "duplicate", name: secret.name };
    }
    seen.add(secret.name);
  }
  return { status: "ok", secrets: new TransientSecrets(secrets) };
}

/** An empty bundle, for a reconciliation that names no credential. */
export function noTransientSecrets(): TransientSecrets {
  return new TransientSecrets();
}
