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
 * The third answer is the point of having three. A version neither side can
 * parse is not a version that is new enough and not one that is too old — it is
 * one this server could not read, and which of those two it actually is remains
 * unknown. Callers that must not act on a guess branch on `unreadable`
 * explicitly rather than receiving whichever boolean happened to be safer for
 * somebody else's question.
 */
export const versionComparisons = ["meets", "below", "unreadable"] as const;

export type VersionComparison = (typeof versionComparisons)[number];

/**
 * Compares a reported version to a recorded minimum without deciding what an
 * unreadable one means.
 *
 * Either side being unparsable answers `unreadable`, including the minimum:
 * that one is authored in this repository, so a minimum this function cannot
 * read is a defect here rather than a fact about the instance, and answering
 * `meets` for it would hide the defect behind a pass.
 */
export function compareToMinimumVersion(reported: string, minimum: string): VersionComparison {
  const reportedSegments = parseVersionSegments(reported);
  const minimumSegments = parseVersionSegments(minimum);
  if (reportedSegments === undefined || minimumSegments === undefined) {
    return "unreadable";
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
