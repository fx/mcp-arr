import type { ApplicationId } from "../applications.js";
import type { UpstreamClient } from "../http/client.js";
import { isUpstreamError } from "../http/errors.js";
import type { UpstreamCommandObservation } from "../state/jobs.js";
import { readAcceptedCommand, searchCommandRoutes } from "./acquisition/commands.js";
import type { UpstreamFailure } from "./registry.js";

/**
 * Reading back the one upstream command a job stands for.
 *
 * All three applications answer a single command on the same relative route —
 * `command/{id}` under whichever API version the adapter's client is already
 * bound to, which is `v3` on Sonarr and Radarr and `v1` on Prowlarr — so this
 * module needs no per-application table. What comes back is read by the same
 * {@link readAcceptedCommand} that reads a command this server just started, so
 * a job observed at its start and a job observed on a later read are normalized
 * by one piece of code rather than two that could disagree.
 */

/**
 * The route one command record is read back on.
 *
 * The identifier is encoded even though every id these applications mint is an
 * integer: the job store keeps it as a string so a GUID would fit, and the
 * shared upstream boundary refuses a path that escapes its prefix, so neither
 * layer is relying on the other to have checked.
 */
export function commandRecordRoute(upstreamId: string): string {
  return `${searchCommandRoutes.command}/${encodeURIComponent(upstreamId)}`;
}

/**
 * Said in place of the command record when the application no longer has one.
 *
 * It travels as a warning rather than as an error because the job still
 * resolves: an aged-out command is the ordinary end of a command record's life,
 * and the observation it produces carries no state, which the job store
 * normalizes to `unknown`.
 */
export const commandGoneWarning = "the application no longer holds this command record";

/**
 * What one refresh learned.
 *
 * A command that is gone is an observation rather than a failure, because the
 * projection genuinely learned something: the command record has expired and
 * the job's state is no longer knowable from it. A failure to reach the
 * instance at all learned nothing, and is kept apart so a job read can still
 * answer from what it already holds.
 */
export type CommandRefresh =
  | { readonly status: "observed"; readonly observation: UpstreamCommandObservation }
  | { readonly status: "unreachable"; readonly failure: UpstreamFailure };

/**
 * Reads the current state of one upstream command.
 *
 * Only two things ever come out of it, and neither is an exception: an
 * observation the job store can fold in, or a redacted failure. That is what
 * makes it usable from a read that must keep answering with the instance
 * switched off — the caller decides what an unreachable instance means for the
 * projection it already holds, rather than having the read fail underneath it.
 */
export async function readCommandRecord(
  client: UpstreamClient,
  application: ApplicationId,
  upstreamId: string,
): Promise<CommandRefresh> {
  const route = commandRecordRoute(upstreamId);
  try {
    const accepted = readAcceptedCommand(await client.get(route), application, route);
    return { status: "observed", observation: accepted.observation };
  } catch (error) {
    if (!isUpstreamError(error)) {
      return {
        status: "unreachable",
        failure: {
          kind: "unexpected-response",
          message: `${application}: reading the command behind this job failed unexpectedly`,
        },
      };
    }
    // Every one of the three applications answers an unknown or aged-out
    // command identifier with 404, which is the command record expiring rather
    // than anything going wrong.
    return error.kind === "not-found"
      ? { status: "observed", observation: { warnings: [commandGoneWarning] } }
      : { status: "unreachable", failure: { kind: error.kind, message: error.message } };
  }
}
