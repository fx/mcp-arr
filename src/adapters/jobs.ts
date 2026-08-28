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
 * Two things come back without an exception: an observation the job store can
 * fold in, or a redacted failure that learned nothing about the command. That
 * is what makes it usable from a read that must keep answering with the
 * instance switched off — the caller decides what an unreachable instance means
 * for the projection it already holds, rather than having the read fail
 * underneath it.
 *
 * The exception is reserved for the failures a caller must act on rather than
 * wait out: a rejected API key, a request the instance called invalid, and a
 * defect in this process. Swallowing one of those into a warning beside a
 * projection that can never advance is how an operator who rotated a key would
 * poll a job forever without ever being told why it stopped moving.
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
      // Not an instance this server could not reach. Every failure the upstream
      // boundary and the shared parser can produce is an `UpstreamError`, so
      // anything else is a defect in this process, and dressing one up as an
      // outage would freeze the job at its last state and say nothing.
      throw error;
    }
    switch (error.kind) {
      // Every one of the three applications answers an unknown or aged-out
      // command identifier with 404, which is the command record expiring
      // rather than anything going wrong.
      case "not-found":
        return { status: "observed", observation: { warnings: [commandGoneWarning] } };

      // Nothing was learned about the command, and nothing about the failure is
      // the caller's to fix: the instance was down, slow, throttling, or said
      // something this server could not read. A job read is answerable with the
      // instance switched off, so these leave the held projection alone.
      case "unavailable":
      case "timeout":
      case "rate-limit":
      case "unexpected-response":
        return { status: "unreachable", failure: { kind: error.kind, message: error.message } };

      // A rejected API key, a request the instance called invalid, and a
      // request this server could not even compose are all failures a caller
      // has to be told about, and none of them get better by being read again.
      // Degrading them would leave a poller reading `ok` beside a projection
      // that can never advance, never learning that its credentials are being
      // refused. Every other read in this project surfaces them as errors, and
      // so does this one.
      case "authentication":
      case "validation":
      case "invalid-request":
        throw error;
    }
  }
}
