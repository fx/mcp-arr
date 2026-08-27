import type { CandidateOrigin, UpstreamMappingPatch } from "../adapters/import/candidates.js";
import { readMediaFolder } from "../adapters/import/candidates.js";
import {
  checkFreeSpace,
  compileCorrections,
  type ImportRefusal,
  validateForImport,
} from "../adapters/import/corrections.js";
import {
  type ImportFileRequest,
  type ImportMode,
  submitManualImport,
} from "../adapters/import/execute.js";
import type { ImportCandidate } from "../adapters/import/model.js";
import type { MediaApplication } from "../adapters/library/model.js";
import { isMediaApplication } from "../adapters/library/model.js";
import type { PreconditionRead, ReadSetObservation } from "../state/plans.js";
import { createToolError, type ToolError } from "./errors.js";
import { resolveCandidateReference } from "./import-references.js";
import { projectJob } from "./jobs.js";
import type { OperationHandler, OperationInvocation, PreconditionReader } from "./operations.js";
import type { Effect, ItemOutcome } from "./results.js";
import { importExecuteInputSchema } from "./schemas/acquisition.js";

/**
 * The `arr_import_execute` handler.
 *
 * An import moves files on the operator's disk, so everything that decides
 * whether one may run happens before the handler is reached — and the handler
 * receives what that decision was made against rather than re-reading it. The
 * reader resolves every candidate reference, rebuilds the exact mapping the
 * reference stands for, re-runs the application's own decision engine with it,
 * and refuses on anything the specification says must stop an import: a file
 * that has gone, a file the library already holds, a fingerprint that moved, a
 * blocking rejection, or a destination without room.
 *
 * What the handler then submits is one allowlisted `ManualImport` command,
 * assembled field by field from what that validation approved. It is reported
 * as a job, because an import is a command the application runs in its own
 * time, and the job's identity carries this project's own command name rather
 * than the instance's echo of it.
 */

const contextKind = "import-execute";

interface ValidatedFile {
  readonly reference: string;
  readonly identity: string;
  /** Where this file would land, for the aggregate room check below. */
  readonly destination: string;
  readonly sizeBytes?: number | undefined;
  readonly origin: CandidateOrigin;
  readonly patch: UpstreamMappingPatch;
  /** The candidate as the instance decided it just now, not as it was inspected. */
  readonly candidate: ImportCandidate;
  readonly tracked: boolean;
}

interface ExecuteContext {
  readonly kind: typeof contextKind;
  readonly application: MediaApplication;
  readonly importMode: ImportMode;
  readonly files: readonly ValidatedFile[];
  readonly warnings: readonly string[];
}

function isExecuteContext(value: unknown): value is ExecuteContext {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === contextKind
  );
}

function fail(
  invocation: OperationInvocation,
  code: "invalid_input" | "conflict" | "stale_reference" | "upstream_rejection",
  message: string,
): ToolError {
  return createToolError({
    code,
    message: `${invocation.application}: ${message}`,
    application: invocation.application,
  });
}

function blocked(error: ToolError): PreconditionRead {
  return { status: "blocked", error };
}

interface DirectInput {
  readonly candidates: readonly string[];
  readonly importMode: ImportMode;
}

function parseInput(invocation: OperationInvocation): DirectInput | undefined {
  const parsed = importExecuteInputSchema.safeParse(invocation.input);
  if (!parsed.success || !("candidates" in parsed.data)) {
    return undefined;
  }
  return parsed.data as DirectInput;
}

/**
 * Turns one refusal into the answer the rest of this surface would give.
 *
 * Each kind has its own remedy and its own code, because collapsing them would
 * tell a caller to do the wrong thing: a file that has gone is re-read, a file
 * the library already holds goes to the library-file workflow, a moved
 * fingerprint is re-inspected, a rejection is fixed upstream, and a full disk
 * is not any of those.
 */
function refusalError(invocation: OperationInvocation, refusal: ImportRefusal): ToolError {
  switch (refusal.kind) {
    case "absent":
    case "unmapped":
      return refusal.error;
    case "existing_file":
      return fail(
        invocation,
        "invalid_input",
        "that candidate is a file the library already holds; change it through the library-file workflow rather than importing it again",
      );
    case "rejected": {
      const reasons = refusal.rejections.map((rejection) => rejection.reason).join("; ");
      return fail(
        invocation,
        "upstream_rejection",
        reasons === ""
          ? "this application will not import that candidate as mapped"
          : `this application will not import that candidate as mapped: ${reasons}`,
      );
    }
    case "stale":
      return fail(
        invocation,
        "stale_reference",
        `that candidate changed since it was inspected (${refusal.moved.join(", ")}); inspect it again`,
      );
    case "no_space":
      return fail(
        invocation,
        "conflict",
        "the destination does not have room for that file; free space and try again",
      );
    case "unverified_space":
      return fail(
        invocation,
        "conflict",
        "this application did not report free space for the destination, so there is no evidence the file fits",
      );
  }
}

/**
 * What one file's import depends on.
 *
 * The identity of the file, the decision the instance just made about it, and
 * the mapping it would be imported under — and nothing else. Free space is
 * deliberately absent: it is checked at apply, and observing it would expire a
 * valid plan every time an unrelated download landed on the same disk.
 */
function observationsFor(files: readonly ValidatedFile[]): readonly ReadSetObservation[] {
  return files.map((file) => ({
    key: `candidate:${file.identity}`,
    value: {
      importable: file.candidate.decision.importable,
      media: file.candidate.media?.id,
      season: file.candidate.seasonNumber,
      episodes: (file.candidate.episodes ?? []).map((episode) => episode.id),
      quality: file.candidate.quality?.name,
      languages: [...(file.candidate.languages ?? [])].sort(),
      releaseGroup: file.candidate.releaseGroup,
    },
  }));
}

/**
 * What an import does, disclosed before it is asked for.
 *
 * A tracked download is presented as potentially source-consuming unless the
 * mode proves otherwise: `copy` leaves the source where it is, and every other
 * mode may not. That is the specification's rule, and it is decided from the
 * mode and the candidate's own source kind rather than from anything a caller
 * asserted.
 */
function effectsFor(
  invocation: OperationInvocation,
  files: readonly ValidatedFile[],
  importMode: ImportMode,
): readonly Effect[] {
  const consuming = importMode !== "copy" && files.some((file) => file.tracked);
  return [
    {
      application: invocation.application,
      severity: "destructive",
      summary: `imports ${String(files.length)} file(s) into the library, which moves or copies them on the application's filesystem`,
    },
    ...(consuming
      ? [
          {
            application: invocation.application,
            severity: "destructive" as const,
            summary:
              "at least one of these files came from a tracked download, and this import mode may consume the source rather than leave it in place",
          },
        ]
      : []),
  ];
}

/**
 * The per-item outcomes of a *plan*, where `ok` means what it says: this file
 * passed every precondition an import has. An apply publishes no item statuses
 * at all — see the handler — because these applications report one outcome for
 * the whole command and a status here would invent a verdict for each file.
 */
function validatedItems(files: readonly ValidatedFile[]): readonly ItemOutcome[] {
  return files.map((file) => ({ reference: file.reference, status: "ok", warnings: [] }));
}

/** Which files an import is about, named without claiming anything about them. */
function membership(files: readonly ValidatedFile[]): readonly { readonly reference: string }[] {
  return files.map((file) => ({ reference: file.reference }));
}

export const importExecutePreconditions: PreconditionReader = async (invocation) => {
  const application = invocation.application;
  if (!isMediaApplication(application)) {
    return blocked(
      fail(invocation, "invalid_input", "manual import is a Sonarr and Radarr workflow"),
    );
  }
  const input = parseInput(invocation);
  if (input === undefined) {
    return blocked(
      fail(invocation, "invalid_input", "the arguments do not match the arr_import_execute schema"),
    );
  }

  const files: ValidatedFile[] = [];
  const warnings: string[] = [];
  // One token names one file, so naming it twice does not ask for two imports.
  // Left un-normalized it would validate the file twice, count its size twice
  // against the destination, and send the instance two entries for one path —
  // a bulk grab collapses repeats for the same reason.
  const selected = [...new Set(input.candidates)];
  if (selected.length !== input.candidates.length) {
    warnings.push("a candidate was named more than once and is imported once");
  }
  for (const token of selected) {
    const resolved = resolveCandidateReference(invocation.state.references, token, application);
    if (!resolved.ok) {
      return blocked(resolved.error);
    }
    const retained = resolved.value;

    // The mapping the reference stands for, resolved the same way a correction
    // resolves one. Rebuilding it here rather than trusting the retained text
    // is what makes the import send the mapping the reference was fingerprinted
    // from: a reference that says which mapping it stands for while the import
    // sends another is half a guarantee.
    const compiled = await compileCorrections(invocation.adapter.client, application, {
      mediaId: retained.mediaId,
      episodeIds: retained.episodeIds,
      quality: retained.selected?.quality,
      languages: retained.selected?.languages,
      releaseGroup: retained.selected?.releaseGroup,
    });
    if (compiled.status !== "ok") {
      return blocked(fail(invocation, "invalid_input", compiled.reason));
    }

    const destinationId = retained.mediaId ?? retained.scanMediaId;
    const destination =
      destinationId === undefined
        ? undefined
        : await readMediaFolder(invocation.adapter.client, application, destinationId);
    if (destination === undefined) {
      return blocked(
        fail(
          invocation,
          "conflict",
          "this application reports no folder for that candidate's media, so there is no destination to check",
        ),
      );
    }

    const origin: CandidateOrigin = {
      sourceKind: retained.sourceKind,
      queueItemId: retained.queueItemId,
      scanMediaId: retained.scanMediaId,
      seasonNumber: retained.seasonNumber,
      mediaId: retained.queueMediaId,
    };
    const validated = await validateForImport(invocation.adapter.client, application, {
      retained,
      patch: compiled.compiled.patch,
      destination,
    });
    if (validated.status !== "ok") {
      return blocked(refusalError(invocation, validated.refusal));
    }

    files.push({
      reference: token,
      identity: retained.fileIdentity,
      destination,
      sizeBytes: validated.validation.candidate.sizeBytes,
      origin,
      patch: compiled.compiled.patch,
      candidate: validated.validation.candidate,
      tracked: retained.sourceKind === "tracked_download",
    });
    if (validated.validation.space.status === "sufficient") {
      continue;
    }
    warnings.push("the destination's free space could not be compared for every file");
  }

  if (files.length === 0) {
    return blocked(fail(invocation, "invalid_input", "name at least one candidate to import"));
  }

  // Each file was checked against the room its own size needs, which is not the
  // question a batch asks: two files that each fit can still not fit together,
  // and this import sends them as one command. So the sizes are summed per
  // destination and the check is repeated for the total.
  const totals = new Map<string, number>();
  for (const file of files) {
    if (file.sizeBytes === undefined) {
      // A file whose size this instance did not report cannot be added to a
      // total, and treating it as zero would let it through by contributing
      // nothing — the same shape as substituting an identifier nobody gave.
      // An unestablished precondition is not a met one.
      return blocked(
        fail(
          invocation,
          "conflict",
          "this application reports no size for one of these files, so there is no evidence they fit together",
        ),
      );
    }
    totals.set(file.destination, (totals.get(file.destination) ?? 0) + file.sizeBytes);
  }
  for (const [destination, bytes] of totals) {
    const room = await checkFreeSpace(invocation.adapter.client, application, destination, bytes);
    if (room.status === "insufficient") {
      return blocked(
        fail(
          invocation,
          "conflict",
          "the destination does not have room for these files together; import fewer of them or free space",
        ),
      );
    }
    if (room.status === "unknown") {
      return blocked(
        fail(
          invocation,
          "conflict",
          "this application did not report free space for the destination, so there is no evidence these files fit",
        ),
      );
    }
  }

  const context: ExecuteContext = {
    kind: contextKind,
    application,
    importMode: input.importMode,
    files,
    warnings,
  };
  return { status: "ok", observations: observationsFor(files), warnings, validated: context };
};

export const importExecuteHandler: OperationHandler = async (invocation) => {
  const context = invocation.validated;
  if (!isExecuteContext(context)) {
    return {
      status: "error",
      error: fail(invocation, "conflict", "the current state of this import was not validated"),
    };
  }

  const effects = effectsFor(invocation, context.files, context.importMode);
  if (invocation.mode === "plan") {
    return {
      status: "ok",
      plan: { requestedEffects: effects, predictedEffects: [], warnings: context.warnings },
      items: validatedItems(context.files),
    };
  }

  const requests: readonly ImportFileRequest[] = context.files.map((file) => ({
    origin: file.origin,
    identity: file.identity,
    patch: file.patch,
  }));
  const submission = await submitManualImport(
    invocation.adapter.client,
    context.application,
    requests,
    context.importMode,
  );
  if (submission.status !== "ok") {
    // Nothing was sent: the recovery that failed happens before the command is
    // built, so this is a refusal rather than an outcome nobody can settle.
    return { status: "error", error: submission.error };
  }

  const record = invocation.state.jobs.project({
    application: context.application,
    command: { name: submission.command.name, upstreamId: submission.command.upstreamId },
    // No per-item outcomes: a `ManualImport` reports one state for the whole
    // command and never one per file, so an item list here would carry a
    // verdict nobody gave — and a terminal snapshot would then preserve it.
    // Which files the job is about is published beside it instead.
    observation: submission.command.observation,
    // This server has no way to ask an application to stop a running import.
    cancellation: { supported: false },
  });

  return {
    status: "ok",
    data: {
      job: projectJob(record),
      files: membership(context.files),
      importMode: context.importMode,
    },
    effects,
    job: record.reference,
    warnings: [
      ...context.warnings,
      ...record.warnings,
      "this application reports one outcome for the whole import rather than one per file, so the job's result covers every file together",
    ],
  };
};
