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
 * the job's state is no longer knowable from it. The two failures learned
 * nothing about the command, and are kept apart from it — and from each other —
 * so a job read can still answer from what it already holds while saying which
 * of the two happened.
 *
 * `unreachable` is an outage: down, slow, throttling, or answering something
 * this server cannot read. Waiting is the remedy, and the next poll may well
 * succeed. `refused` is not an outage. The instance rejected the credential or
 * the request, or this server could not compose the request at all, and no
 * amount of polling changes that — somebody has to fix something. Collapsing
 * the two is how an operator who rotated an API key mid-job would poll forever
 * behind a warning that reads like a transient blip.
 */
export type CommandRefresh =
  | { readonly status: "observed"; readonly observation: UpstreamCommandObservation }
  | { readonly status: "unreachable"; readonly failure: UpstreamFailure }
  | { readonly status: "refused"; readonly failure: UpstreamFailure };

/**
 * The half of a command reading a refresh keeps: what the command is doing.
 *
 * Written as an omission rather than as a copy of the fields it keeps, so a
 * value added to the observation later travels without this module having to be
 * remembered, and the single field a refresh drops stays named in one place.
 */
function withoutCommandMessage(
  observation: UpstreamCommandObservation,
): UpstreamCommandObservation {
  const { warnings: _message, ...state } = observation;
  return state;
}

/**
 * Reads the current state of one upstream command.
 *
 * Nothing an instance can do to this read is an exception: what comes back is
 * an observation the job store can fold in, or a redacted failure that names
 * which kind of failure it was. That is what makes it usable from a read that
 * must keep answering with the instance switched off — the caller decides what
 * a failed refresh means for the projection it already holds, rather than
 * having the read fail underneath it and take the locally held state with it.
 */
export async function readCommandRecord(
  client: UpstreamClient,
  application: ApplicationId,
  upstreamId: string,
): Promise<CommandRefresh> {
  const route = commandRecordRoute(upstreamId);
  try {
    const accepted = readAcceptedCommand(await client.get(route), application, route);
    // The command's own message is deliberately left behind. It is the sentence
    // an instance writes about its progress — "Processing file 1 of 1" — and a
    // job is refreshed on every read, so carrying it would file one line of
    // prose per poll under a channel that means "something needs attention",
    // walk the projection's warning cap, and evict the warnings that do. The
    // start path carries one message because it reads the command once; that is
    // not licence for a path that reads it repeatedly.
    return { status: "observed", observation: withoutCommandMessage(accepted.observation) };
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

      // The instance was down, slow, throttling, or said something this server
      // could not read. Nothing was learned about the command and nothing here
      // is anybody's to fix, so the next poll is a reasonable thing to do.
      case "unavailable":
      case "timeout":
      case "rate-limit":
      case "unexpected-response":
        return { status: "unreachable", failure: { kind: error.kind, message: error.message } };

      // A refused API key, a request the instance called invalid, and a request
      // this server could not compose at all. The read learned nothing either,
      // so the held projection is still the answer — but polling will not
      // improve it, and the caller has to be told that rather than being left
      // to read the same stale state indefinitely.
      case "authentication":
      case "validation":
      case "invalid-request":
        return { status: "refused", failure: { kind: error.kind, message: error.message } };
    }
  }
}
