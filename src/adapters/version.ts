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
 * Reports whether a version is at least the recorded minimum. Anything newer
 * passes, including unseen patch or build segments, and a version that cannot
 * be parsed at all is accepted rather than rejected for being unrecognized.
 */
export function meetsMinimumVersion(reported: string, minimum: string): boolean {
  const reportedSegments = parseVersionSegments(reported);
  const minimumSegments = parseVersionSegments(minimum);
  if (reportedSegments === undefined || minimumSegments === undefined) {
    return true;
  }
  return compareVersionSegments(reportedSegments, minimumSegments) >= 0;
}
