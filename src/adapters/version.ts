/**
 * Splits a dotted version into its leading numeric segments, stopping at the
 * first segment that does not start with a digit so build or pre-release
 * suffixes never break the comparison. Returns `undefined` when the version
 * carries no numeric segment at all.
 */
export function parseVersionSegments(version: string): readonly number[] | undefined {
  const normalized = version.trim().replace(/^v/iu, "");
  const segments: number[] = [];

  for (const part of normalized.split(".")) {
    const digits = /^\d+/u.exec(part)?.[0];
    if (digits === undefined) {
      break;
    }
    segments.push(Number.parseInt(digits, 10));
  }

  return segments.length === 0 ? undefined : segments;
}

/**
 * Compares numeric version segments positionally, treating a missing trailing
 * segment as zero. Returns a negative number when `left` is older.
 */
export function compareVersionSegments(left: readonly number[], right: readonly number[]): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return difference < 0 ? -1 : 1;
    }
  }
  return 0;
}

/**
 * How a reported version stands against a recorded minimum.
 *
 * The answers beyond `meets` and `below` are the point of having four. A version
 * that will not parse is not one that is new enough and not one that is too old
 * — it is one this server could not read, and which of those two it actually is
 * remains unknown. Callers that must not act on a guess branch on that
 * explicitly rather than receiving whichever boolean happened to be safer for
 * somebody else's question.
 *
 * The two unreadable answers are kept apart because they are faults in
 * different systems. `unreadable_reported` is a fact about the instance, which
 * an operator can go and look at. `unreadable_minimum` is a fact about this
 * repository — the minimums are authored here — so an error derived from it
 * must not send anybody to inspect a perfectly healthy instance. Collapsing the
 * two would produce exactly that confidently wrong direction.
 */
export const versionComparisons = [
  "meets",
  "below",
  "unreadable_reported",
  "unreadable_minimum",
] as const;

export type VersionComparison = (typeof versionComparisons)[number];

/**
 * Compares a reported version to a recorded minimum without deciding what an
 * unreadable one means.
 *
 * The minimum is checked first, and that order is deliberate: when neither side
 * parses, a defect in this repository's own table is the more useful thing to
 * report, because it is the one that is certainly wrong and the one whose fix is
 * ours. Reporting the instance in that case would be true and useless.
 */
export function compareToMinimumVersion(reported: string, minimum: string): VersionComparison {
  const minimumSegments = parseVersionSegments(minimum);
  if (minimumSegments === undefined) {
    return "unreadable_minimum";
  }
  const reportedSegments = parseVersionSegments(reported);
  if (reportedSegments === undefined) {
    return "unreadable_reported";
  }
  return compareVersionSegments(reportedSegments, minimumSegments) >= 0 ? "meets" : "below";
}

/**
 * Reports whether a version is at least the recorded minimum. Anything newer
 * passes, including unseen patch or build segments, and a version that cannot
 * be parsed at all is accepted rather than rejected for being unrecognized.
 *
 * That last part is a deliberate choice for the question this function is asked
 * — whether to *report* an instance as supported — where refusing an instance
 * because its version string is unusual would be worse than trusting it. It is
 * the wrong choice for a gate that decides whether to *send* something, because
 * there the same permissiveness means acting on a version nobody could read.
 * Such a gate uses {@link compareToMinimumVersion} and refuses `unreadable`.
 */
export function meetsMinimumVersion(reported: string, minimum: string): boolean {
  return compareToMinimumVersion(reported, minimum) !== "below";
}
