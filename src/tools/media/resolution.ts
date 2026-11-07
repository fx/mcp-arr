import type { QualityProfileRecord } from "../../adapters/library/changes.js";

/**
 * Turning a requested resolution into a quality profile.
 *
 * Everything here is a pure function over values already read, so every rule
 * of the choice — and every tie-break — is decided without a network and
 * tested as such.
 */

/** The accepted resolutions, lowest first. Their order is the ladder below. */
export const resolutions = ["480p", "576p", "720p", "1080p", "2160p"] as const;

export type Resolution = (typeof resolutions)[number];

/**
 * The vertical pixel count each resolution names. A quality reporting any
 * other count has no known resolution: guessing which step it is closest to
 * would choose a profile on a rule nobody wrote.
 */
const resolutionPixels: Readonly<Record<Resolution, number>> = {
  "480p": 480,
  "576p": 576,
  "720p": 720,
  "1080p": 1080,
  "2160p": 2160,
};

export function resolutionOf(pixels: number | undefined): Resolution | undefined {
  return resolutions.find((resolution) => resolutionPixels[resolution] === pixels);
}

/**
 * A profile's resolution: that of its cutoff quality, or the highest known one
 * in its cutoff group.
 *
 * The cutoff is looked up among the profile's own entries, as a single quality
 * or as a group by the group's own identifier. A cutoff that matches nothing,
 * or matches both a quality and a group, gives the profile no resolution
 * rather than a guess, and so does a cutoff whose qualities report none this
 * server knows.
 */
export function profileResolution(profile: QualityProfileRecord): Resolution | undefined {
  const cutoff = profile.cutoff;
  if (cutoff === undefined) {
    return undefined;
  }
  const matches = profile.items.filter((item) =>
    item.groupId === undefined ? item.qualities[0]?.id === cutoff : item.groupId === cutoff,
  );
  const [match] = matches;
  if (match === undefined || matches.length > 1) {
    return undefined;
  }

  let highest: Resolution | undefined;
  for (const quality of match.qualities) {
    const resolution = resolutionOf(quality.resolution);
    if (resolution !== undefined && (highest === undefined || rank(resolution) > rank(highest))) {
      highest = resolution;
    }
  }
  return highest;
}

/** How many qualities a profile allows, counting each quality a group holds. */
export function allowedQualityCount(profile: QualityProfileRecord): number {
  return profile.items
    .filter((item) => item.allowed)
    .reduce((total, item) => total + item.qualities.length, 0);
}

function rank(resolution: Resolution): number {
  return resolutions.indexOf(resolution);
}

/** A profile beside what the choice reads of it. */
export interface RatedProfile {
  readonly profile: QualityProfileRecord;
  readonly resolution: Resolution | undefined;
  readonly allowed: number;
}

export function rateProfile(profile: QualityProfileRecord): RatedProfile {
  return {
    profile,
    resolution: profileResolution(profile),
    allowed: allowedQualityCount(profile),
  };
}

/**
 * Orders two names by UTF-16 code unit, which is what "sorts first" means
 * here: a locale-aware collation would let the server's own locale decide
 * which profile a title is added with. A profile with no name sorts last.
 */
function compareNames(left: string | undefined, right: string | undefined): number {
  if (left === right) {
    return 0;
  }
  if (left === undefined) {
    return 1;
  }
  if (right === undefined) {
    return -1;
  }
  return left < right ? -1 : 1;
}

/**
 * Chooses the profile a requested resolution is added with.
 *
 * The candidates are the profiles whose resolution equals the request, or,
 * where none does, those nearest to it on the five-step ladder, the lower of
 * two equally near steps winning. Among candidates the configured default wins
 * when it is one of them, then the profile allowing the fewest qualities, then
 * the name that sorts first, and last the lowest identifier, so the answer is
 * the same whatever order the instance listed its profiles in.
 *
 * A profile with no resolution is never a candidate, and `undefined` means no
 * profile has one, which only the operator can change.
 */
export function chooseProfile(
  profiles: readonly RatedProfile[],
  requested: Resolution,
  defaultName: string | undefined,
): RatedProfile | undefined {
  const target = rank(requested);
  let best: { readonly distance: number; readonly rank: number } | undefined;
  for (const rated of profiles) {
    if (rated.resolution === undefined) {
      continue;
    }
    const step = rank(rated.resolution);
    const distance = Math.abs(step - target);
    if (
      best === undefined ||
      distance < best.distance ||
      (distance === best.distance && step < best.rank)
    ) {
      best = { distance, rank: step };
    }
  }
  if (best === undefined) {
    return undefined;
  }

  const chosenRank = best.rank;
  const candidates = profiles.filter(
    (rated) => rated.resolution !== undefined && rank(rated.resolution) === chosenRank,
  );
  const configured =
    defaultName === undefined
      ? undefined
      : candidates.find((rated) => rated.profile.name === defaultName);
  if (configured !== undefined) {
    return configured;
  }
  return [...candidates].sort(
    (left, right) =>
      left.allowed - right.allowed ||
      compareNames(left.profile.name, right.profile.name) ||
      left.profile.id - right.profile.id,
  )[0];
}
