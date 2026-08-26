/**
 * The only source of time the ephemeral state stores read.
 *
 * Expiration is a contract this project has to prove, and proving it by
 * sleeping makes a test suite slow and flaky. Every store therefore takes a
 * clock, so a test advances time by assignment instead of by waiting.
 */
export interface Clock {
  /** Milliseconds since the Unix epoch, as {@link Date.now} reports them. */
  now(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};

/**
 * A clock a test drives by hand. It is exported from the runtime rather than
 * from a test helper because the stores document their expiration behavior in
 * terms of it, and a consumer of this package that wants deterministic state
 * needs the same construction.
 */
export interface ManualClock extends Clock {
  advance(milliseconds: number): void;
  set(milliseconds: number): void;
}

export function createManualClock(start = 0): ManualClock {
  let current = start;
  return {
    now: () => current,
    advance(milliseconds: number): void {
      current += milliseconds;
    },
    set(milliseconds: number): void {
      current = milliseconds;
    },
  };
}
