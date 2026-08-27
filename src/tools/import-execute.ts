import type { CandidateOrigin, UpstreamMappingPatch } from "../adapters/import/candidates.js";
import { readMediaFolder } from "../adapters/import/candidates.js";
import {
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

function itemsFor(files: readonly ValidatedFile[]): readonly ItemOutcome[] {
  return files.map((file) => ({ reference: file.reference, status: "ok", warnings: [] }));
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
  for (const token of input.candidates) {
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
      items: itemsFor(context.files),
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
    return {
      status: "error",
      error: submission.error,
      items: itemsFor(context.files),
    };
  }

  const record = invocation.state.jobs.project({
    application: context.application,
    command: { name: submission.command.name, upstreamId: submission.command.upstreamId },
    observation: {
      ...submission.command.observation,
      // One item per file the command carries, so a caller can see which files
      // this job is about. They carry no per-file verdict, and that is a fact
      // about the applications rather than a gap here: a `ManualImport`
      // reports one state for the whole command, so a terminal failure says
      // that the import failed and never which file did.
      items: itemsFor(context.files),
    },
    // This server has no way to ask an application to stop a running import.
    cancellation: { supported: false },
  });

  return {
    status: "ok",
    data: { job: projectJob(record), files: context.files.length, importMode: context.importMode },
    items: itemsFor(context.files),
    effects,
    job: record.reference,
    warnings: [
      ...context.warnings,
      ...record.warnings,
      "this application reports one outcome for the whole import rather than one per file",
    ],
  };
};
