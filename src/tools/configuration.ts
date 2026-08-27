import type {
  ConfigurationDomain,
  ConfigurationFamily,
} from "../adapters/configuration/domains.js";
import type {
  ConfigurationRecord,
  ConfigurationRef,
  ConfigurationView,
  ProviderSchema,
} from "../adapters/configuration/model.js";
import { runConfigurationObservation } from "../adapters/configuration/service.js";
import { queryDigest } from "../adapters/library/paging.js";
import type { ReferenceStore } from "../state/references.js";
import { createToolError, type ToolError } from "./errors.js";
import type { OperationHandler, OperationInvocation } from "./operations.js";
import { configObserveInputSchema } from "./schemas/configuration.js";

/**
 * The `arr_config_observe` handler.
 *
 * Everything that decides what may leave has already been decided by the time
 * this runs: the adapter builds its model-facing view by explicit allowlist and
 * keeps the untouched upstream payloads in a separate object this never
 * touches. What is left here is the tool layer's own job, which is the one
 * thing the adapter deliberately cannot do — turning the upstream identity the
 * adapter resolved into an opaque reference a caller may name later.
 *
 * That translation is the reason this file exists at all. A configuration
 * record's upstream identifier never reaches a result: the caller receives a
 * `cfg_` token, the store holds the identity behind it, and a later
 * reconciliation resolves the token rather than accepting an upstream row
 * number from whoever happened to send one.
 */

function invalid(invocation: OperationInvocation, message: string): ToolError {
  return createToolError({
    code: "invalid_input",
    message: `${invocation.application}: ${message}`,
    application: invocation.application,
  });
}

/**
 * One configuration record as a caller reads it.
 *
 * It is the adapter's record with its `ref` replaced by a token. Nothing else
 * is rewritten, because everything else already went through the allowlist that
 * built it — and a second mapping here would be a second place for the two to
 * disagree about what may be published.
 */
type PublishedRecord = Omit<ConfigurationRecord, "ref" | "tags"> & {
  readonly reference: string;
  readonly tags?: readonly string[] | undefined;
};

export interface PublishedView {
  readonly family: ConfigurationFamily;
  readonly domain: ConfigurationDomain;
  readonly records: readonly PublishedRecord[];
  readonly schema?: ProviderSchema | undefined;
}

/**
 * Mints one reference per configuration record, reusing the token within a
 * call.
 *
 * A record and the tags it points at are minted the same way, so a tag a
 * provider carries and the same tag read from the tags domain resolve to one
 * reference rather than two names for one row.
 *
 * The detail carries both vocabularies on purpose. `arr_library_change`
 * resolves a configuration reference by the pointer kind a library record uses
 * — `tag`, `root_folder`, `quality_profile` — while reconciliation resolves it
 * by the configuration domain it was observed in. Recording both is what lets
 * one tag reference be used by either tool instead of each minting a token the
 * other refuses.
 */
export function referenceMinter(references: ReferenceStore): (ref: ConfigurationRef) => string {
  const minted = new Map<string, string>();
  return (ref) => {
    const key = `${ref.application}:${ref.domain}:${ref.id}`;
    const existing = minted.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const entry = references.mint({
      kind: "configuration",
      applications: [ref.application],
      payload: () => ({
        kind: "domain",
        snapshot: {
          upstreamId: ref.id,
          // A configuration record is named by this reference, not read through
          // it, so the identity is the whole of what there is to fingerprint.
          // Whether the record itself moved is a question reconciliation asks
          // of the instance, not of a token minted before it.
          fingerprint: queryDigest([ref.application, ref.domain, ref.id]),
          detail: {
            domain: ref.domain,
            ...(pointerKinds[ref.domain] === undefined ? {} : { kind: pointerKinds[ref.domain] }),
          },
        },
      }),
    });
    minted.set(key, entry.reference);
    return entry.reference;
  };
}

/**
 * The three configuration domains a library record can also point at, in the
 * vocabulary that surface already publishes. Every other domain has no pointer
 * kind, and its reference carries only the domain it came from.
 */
const pointerKinds: Readonly<Partial<Record<ConfigurationDomain, string>>> = {
  tags: "tag",
  root_folders: "root_folder",
  quality_profiles: "quality_profile",
};

function publishRecord(
  record: ConfigurationRecord,
  mint: (ref: ConfigurationRef) => string,
): PublishedRecord {
  const { ref, ...rest } = record;
  const tags = "tags" in record ? record.tags : undefined;
  return {
    ...rest,
    reference: mint(ref),
    ...(tags === undefined ? {} : { tags: tags.map((tag) => mint(tag)) }),
  } as PublishedRecord;
}

function publishView(
  view: ConfigurationView,
  mint: (ref: ConfigurationRef) => string,
): PublishedView {
  return {
    family: view.family,
    domain: view.domain,
    records: view.records.map((record) => publishRecord(record, mint)),
    ...(view.family === "provider" && view.schema !== undefined ? { schema: view.schema } : {}),
  };
}

export const configObserveHandler: OperationHandler = async (invocation) => {
  const parsed = configObserveInputSchema.safeParse(invocation.input);
  if (!parsed.success) {
    return {
      status: "error",
      error: invalid(invocation, "the arguments do not match the arr_config_observe input schema"),
    };
  }
  const input = parsed.data as {
    readonly domain: ConfigurationDomain;
    readonly detail: "summary" | "full";
    readonly pageSize: number;
    readonly cursor?: string | undefined;
  };

  const outcome = await runConfigurationObservation(
    invocation.application,
    invocation.adapter.client,
    {
      domain: input.domain,
      detail: input.detail,
      paging: { pageSize: input.pageSize, cursor: input.cursor },
      // The instance's own provider templates are read only at full detail: they
      // cost a second request, and a summary is asking what is configured rather
      // than what could be.
      includeSchema: input.detail === "full",
    },
  );
  if (outcome.status === "error") {
    return { status: "error", error: outcome.error };
  }

  return {
    status: "ok",
    data: publishView(outcome.data, referenceMinter(invocation.state.references)),
    continuation: outcome.continuation,
    warnings: outcome.warnings,
  };
};
