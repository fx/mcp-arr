import { createHash, randomBytes } from "node:crypto";

/**
 * The random half of a reference token, in base64url characters. Sixteen bytes
 * of randomness is far more than a process-local namespace needs, and it is
 * what makes a token unguessable: nothing about the object it stands for is
 * derivable from it, so a caller can neither decode nor forge one.
 */
const tokenRandomBytes = 16;

/** Six bytes encode to exactly eight base64url characters with no padding. */
const lifetimeRandomBytes = 6;

const lifetimeLength = 8;

function base64url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

/**
 * Identifies one process lifetime.
 *
 * Every token carries this prefix, so a reference minted before a restart is
 * recognized as belonging to a previous lifetime and rejected with a message
 * that says so, rather than being reported as merely unknown. It is random
 * rather than a timestamp or a process id: neither of those is a fact a caller
 * needs, and both leak something about the host.
 */
export function createLifetimeId(): string {
  return base64url(randomBytes(lifetimeRandomBytes));
}

export function mintToken(prefix: string, lifetimeId: string): string {
  return `${prefix}_${lifetimeId}${base64url(randomBytes(tokenRandomBytes))}`;
}

/**
 * Reads the lifetime segment of a token, or `undefined` when the token is not
 * shaped like one this server minted. It deliberately extracts nothing else:
 * the remainder is random and stands for nothing on its own.
 */
export function lifetimeOfToken(token: string, prefix: string): string | undefined {
  const head = `${prefix}_`;
  if (!token.startsWith(head)) {
    return undefined;
  }
  const body = token.slice(head.length);
  return body.length > lifetimeLength ? body.slice(0, lifetimeLength) : undefined;
}

function canonicalize(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
      return Number.isFinite(value) ? String(value) : "null";
    case "boolean":
      return value ? "true" : "false";
    case "bigint":
      return `"${value.toString()}"`;
    case "object": {
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
      return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`).join(",")}}`;
    }
    default:
      // Functions, symbols, and `undefined` are not upstream data. Encoding the
      // type keeps this total, because a fingerprint is computed in the middle
      // of an apply and must never be the thing that throws.
      return `"<${typeof value}>"`;
  }
}

/**
 * A stable serialization of a value, independent of property insertion order.
 * Two upstream reads that describe the same state must fingerprint identically,
 * or every planned apply would look stale.
 */
export function canonicalJson(value: unknown): string {
  return canonicalize(value);
}

const digestLength = 32;

/**
 * A non-reversible fingerprint of a value. Truncated because it is compared for
 * equality, never inverted, and a plan record that carries dozens of them stays
 * small enough to keep in memory for the process lifetime.
 */
export function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex").slice(0, digestLength);
}

const presenceLength = 16;

/**
 * Salts every secret presence fingerprint for this process only.
 *
 * A plan retains the fact that a secret was supplied, never the secret. Salting
 * with a value that exists only in this process's memory means the retained
 * fingerprint is not a dictionary-attackable hash of the secret and is
 * meaningless outside the process that produced it.
 */
const presenceSalt = randomBytes(32);

/**
 * A presence fingerprint for one named transient secret.
 *
 * The result records that a value was present and lets a later apply notice
 * that the resupplied value differs from the planned one. It is not a
 * credential, cannot be inverted, and is never compared across processes.
 */
export function secretPresenceFingerprint(name: string, value: string): string {
  // The name is length-prefixed so no pair of (name, value) inputs can be
  // concatenated into the same string and fingerprint identically.
  return createHash("sha256")
    .update(presenceSalt)
    .update(`${name.length}:${name}:${value}`)
    .digest("hex")
    .slice(0, presenceLength);
}
