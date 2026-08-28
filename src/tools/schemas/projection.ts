import { z } from "zod";

/**
 * The projection argument every bounded collection query accepts, and the two
 * bounds that keep it from being the one unbounded array on the input surface.
 *
 * Both bounds are floors read off the payload path inventory `publish-results.ts`
 * generates, not numbers anybody preferred. A projection can only ever shrink a
 * result — the work it causes is already bounded by the page size — so an
 * over-long one protects against nothing; what a bound must never do is refuse a
 * projection naming exactly the paths the tool advertises. That fixes the floor
 * at the widest and deepest payload published, and `tool-projection.test.ts`
 * asserts both against the generated inventory, so a payload that later grows a
 * wider or deeper shape fails there rather than silently making a published path
 * unselectable.
 *
 * The bounds cannot be computed here. The inventory is generated from the tool
 * output schemas, which are built from the payload schemas, which import this
 * module's neighbours — so reading it at module load would close a cycle through
 * the very shapes it measures. The constants are therefore stated and the test
 * ties them to the inventory.
 */

/**
 * The most paths one projection may name.
 *
 * The widest payload the server publishes is `arr_library_query`'s calendar, at
 * 56 leaf paths; this is above it with room for a payload to grow.
 */
export const maxProjectionPaths = 64;

/**
 * The longest a single path may be, in characters.
 *
 * The deepest path the server publishes is
 * `items.media.radarr.releaseDates.physicalRelease`, at 47 characters; this is
 * above it with room for a payload to grow.
 */
export const maxProjectionPathLength = 64;

/**
 * A projection names fields; it never filters, sorts, renames, or computes.
 *
 * Nothing here refuses a path that names no field. A projection is written by a
 * caller working from a list, and a first attempt that misses would cost a whole
 * round trip if it were rejected — so an unmatched path is reported as a warning
 * naming what was available instead, and the call still returns its matched
 * selection.
 */
export const projectionSchema = z
  .array(z.string().min(1).max(maxProjectionPathLength))
  .min(1)
  .max(maxProjectionPaths)
  .describe(
    "Fields of applications[].data to return, as dot-paths; the paths each payload publishes " +
      "are listed in this tool's output schema. An array contributes no path segment. An " +
      "unmatched path warns rather than fails.",
  );
