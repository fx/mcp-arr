import type { ConfigurationDomain, ProviderDomain } from "../adapters/configuration/domains.js";
import { isProviderDomain } from "../adapters/configuration/domains.js";
import type { ConfigurationRef } from "../adapters/configuration/model.js";
import { compileConfigurationPatch, type DesiredField } from "../adapters/configuration/patches.js";
import {
  type ConfigurationReconcileOutcome,
  runConfigurationReconciliation,
} from "../adapters/configuration/reconcile.js";
import {
  captureUpstreamResource,
  type UpstreamValue,
} from "../adapters/configuration/resources.js";
import {
  collectTransientSecrets,
  type TransientSecrets,
} from "../adapters/configuration/secrets.js";
import {
  readSyncLevel,
  runApplicationSync,
  type SyncItemOutcome,
  type SyncLevel,
} from "../adapters/configuration/sync.js";
import {
  describeExternalEffect,
  externalEffectOf,
  type ProviderTestResult,
  providerTestObservations,
  runProviderTest,
} from "../adapters/configuration/tests.js";
import {
  type ConfigurationDiff,
  writeConfigurationPatch,
} from "../adapters/configuration/write.js";
import type { UpstreamBody } from "../http/client.js";
import type { PreconditionRead, TransientSecret } from "../state/plans.js";
import { fingerprintReadSet } from "../state/plans.js";
import { referenceMinter } from "./configuration.js";
import { createToolError, type ToolError, toolErrorForReferenceFailure } from "./errors.js";
import type { OperationHandler, OperationInvocation, PreconditionReader } from "./operations.js";
import type { Effect, ItemOutcome } from "./results.js";
import { configReconcileInputSchema } from "./schemas/configuration.js";

/**
 * The `arr_config_reconcile` handlers.
 *
 * The division of labour is the one the library and activity mutations
 * established: everything that decides whether a mutation may run happens in
 * the precondition reader, and the handler is reached only once it has. Here
 * that means the reader runs the adapter's own plan-mode reconciliation — which
 * reads the record, compiles the desired state, validates every pointer it
 * names, and builds the resource a write would send without sending it — and
 * the handler either reports that plan or runs the same sequence in apply mode.
 *
 * Running it twice rather than carrying the built payload forward is
 * deliberate, and it is what keeps a credential out of the dispatcher. A
 * payload holds the values a caller supplied; handing one to the runtime as
 * "validated state" would park a credential in a field the plan store and the
 * receipt store both see. So each phase builds its own from a bundle of its
 * own, each bundle is erased when its call returns, and the apply is held to
 * the read set the reader just took — which is the same staleness rule a
 * recorded plan is held to, applied across the gap between the two phases.
 *
 * Six intents are registered. The three deletions and the create form of
 * `reconcile_provider` are declared upstream of here and deliberately not
 * implemented: deleting a referenced resource needs the dependent-migration
 * behaviour the spec describes and no task of this change built it, and
 * creating a provider needs a schema-driven template this change does not
 * assemble. Both answer `unsupported_capability`, which is what the capability
 * report already tells a caller.
 */

const contextKind = "config-reconcile";

function error(
  invocation: OperationInvocation,
  code: "invalid_input" | "unsupported_capability" | "conflict",
  message: string,
): ToolError {
  return createToolError({
    code,
    message: `${invocation.application}: ${message}`,
    application: invocation.application,
  });
}

type Resolved<TValue> =
  | { readonly ok: true; readonly value: TValue }
  | { readonly ok: false; readonly error: ToolError };

function blocked(reason: ToolError): PreconditionRead {
  return { status: "blocked", error: reason };
}

interface DirectIntent {
  readonly intent: string;
  readonly domain?: ConfigurationDomain;
  readonly target?: string;
  readonly fields?: readonly DesiredField[];
  readonly removeFields?: readonly string[];
  readonly secrets?: readonly TransientSecret[];
  readonly syncLevel?: string;
  readonly targets?: readonly string[];
  readonly startSync?: boolean;
}

function parseInput(invocation: OperationInvocation): Resolved<DirectIntent> {
  const parsed = configReconcileInputSchema.safeParse(invocation.input);
  if (!parsed.success || !("intent" in parsed.data)) {
    return {
      ok: false,
      error: error(
        invocation,
        "invalid_input",
        "the arguments do not match the arr_config_reconcile input schema",
      ),
    };
  }
  return { ok: true, value: parsed.data as DirectIntent };
}

/**
 * Turns one configuration reference back into the upstream row it names.
 *
 * The domain is checked here rather than at the schema, because every
 * configuration reference has the same published shape: an indexer reference
 * supplied where a quality profile belongs is a wrong-domain reference this
 * tool has to catch, and catching it costs no upstream request.
 */
function resolveTarget(
  invocation: OperationInvocation,
  token: string,
  domain: ConfigurationDomain,
): Resolved<number> {
  const resolution = invocation.state.references.resolve(token, "configuration");
  if (!resolution.ok) {
    return {
      ok: false,
      error: toolErrorForReferenceFailure(
        resolution.reason,
        "configuration",
        invocation.application,
      ),
    };
  }
  const entry = resolution.entry;
  if (!entry.applications.includes(invocation.application)) {
    return {
      ok: false,
      error: error(invocation, "invalid_input", "that reference names a different application"),
    };
  }
  if (entry.payload.kind !== "domain" || entry.payload.snapshot.detail?.domain !== domain) {
    return {
      ok: false,
      error: error(invocation, "invalid_input", `that reference does not name a ${domain} record`),
    };
  }
  const id = Number(entry.payload.snapshot.upstreamId);
  return Number.isSafeInteger(id) && id > 0
    ? { ok: true, value: id }
    : {
        ok: false,
        error: error(invocation, "invalid_input", "that reference names no single record"),
      };
}

/**
 * A bundle for this phase alone.
 *
 * Built from the validated input each time it is needed rather than carried
 * between the reader and the handler, because a bundle is single use: it is
 * erased when the call it was handed to returns, and a phase that inherited a
 * spent one would silently send no credential at all.
 */
function bundleFor(intent: DirectIntent): Resolved<TransientSecrets> {
  const collected = collectTransientSecrets(intent.secrets ?? []);
  return collected.status === "ok"
    ? { ok: true, value: collected.secrets }
    : {
        ok: false,
        error: createToolError({
          code: "invalid_input",
          message: `${collected.name} is supplied twice; a field takes one value`,
        }),
      };
}

interface ReconcileContext {
  readonly kind: typeof contextKind;
  readonly intent: string;
  readonly domain: ConfigurationDomain;
  readonly targetId: number;
  readonly changed: boolean;
  readonly warnings: readonly string[];
  readonly effects: readonly Effect[];
  readonly predicted: readonly Effect[];
  /** The plan's own read set, which the apply phase is held to. */
  readonly readSet: readonly { readonly key: string; readonly digest: string }[];
  readonly data: unknown;
  readonly items?: readonly ItemOutcome[] | undefined;
  readonly sync?:
    | {
        readonly targets: readonly number[];
        readonly level: SyncLevel;
        readonly startSync: boolean;
      }
    | undefined;
}

function isReconcileContext(value: unknown): value is ReconcileContext {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === contextKind
  );
}

function effect(
  invocation: OperationInvocation,
  severity: Effect["severity"],
  summary: string,
): Effect {
  return { application: invocation.application, severity, summary };
}

/**
 * The effects a desired-state write requests.
 *
 * A reconciliation that changes nothing still says so rather than claiming an
 * effect it will not have: the apply sends no request at all in that case, and
 * a plan that promised a change would describe a call that does not happen.
 */
function reconcileEffects(
  invocation: OperationInvocation,
  intent: DirectIntent,
  changed: boolean,
): readonly Effect[] {
  if (!changed) {
    return [
      effect(
        invocation,
        "informational",
        `this ${intent.domain} record already matches the desired state`,
      ),
    ];
  }
  return [
    effect(
      invocation,
      "consequential",
      `replaces this ${intent.domain} record with the desired state, preserving every field it does not name`,
    ),
  ];
}

/**
 * Publishes one diff, which means replacing every upstream identity in it with
 * a reference.
 *
 * The adapter's diff names the record it describes, and any record a pointer
 * now points at, by the identity it resolved. Neither may reach a result: the
 * token is what a caller holds. One minter serves the whole diff, so a record
 * and a pointer at that same record carry one token here — which is a claim
 * about this envelope and not about the next one; see the minter's own
 * contract.
 */
function publishDiff(invocation: OperationInvocation, diff: ConfigurationDiff): unknown {
  const mint = referenceMinter(invocation.state.references);
  return {
    reference: mint(diff.ref),
    changes: diff.changes.map((change) => {
      const { reference, ...rest } = change;
      return reference === undefined ? rest : { ...rest, reference: mint(reference) };
    }),
    secrets: diff.secrets,
    preserved: diff.preserved,
  };
}

/**
 * The per-item outcomes of one synchronization, named by the same minter its
 * payload used.
 *
 * An item outcome sits beside the payload, so it is a second place an identity
 * could escape through — and a second minter would be a subtler version of the
 * same defect: the mapping would carry one token in the payload and another in
 * its own settlement, and a caller could not tell that the two are one row.
 */
function syncItems(
  items: readonly SyncItemOutcome[],
  mint: (ref: ConfigurationRef) => string,
): readonly ItemOutcome[] {
  return items.map((item) => ({
    reference: mint(item.ref),
    status: item.error === undefined ? "ok" : "error",
    warnings: [...item.warnings],
    ...(item.error === undefined ? {} : { error: item.error }),
  }));
}

/** Publishes each synchronized mapping, references and all. */
function publishSync(
  items: readonly SyncItemOutcome[],
  mint: (ref: ConfigurationRef) => string,
): unknown {
  return {
    mappings: items.map((item) => ({
      reference: mint(item.ref),
      name: item.name,
      selection: item.selection,
      ...(item.currentLevel === undefined ? {} : { currentLevel: item.currentLevel }),
      desiredLevel: item.desiredLevel,
      effects: item.effects.map((entry) => ({
        indexer: mint(entry.indexer),
        name: entry.name,
        effect: entry.effect,
        reason: entry.reason,
      })),
      changed: item.changed,
      attempted: item.attempted,
      ...(item.verified === undefined ? {} : { verified: item.verified }),
    })),
  };
}

/**
 * Publishes a provider test.
 *
 * The instance's own objection text is dropped: a rejection body is upstream
 * text this server does not quote back, and the field it named is what a caller
 * can act on.
 */
function publishTest(result: ProviderTestResult): unknown {
  return {
    outcome: result.outcome,
    findings: result.findings.map((finding) => ({
      ...(finding.field === undefined ? {} : { field: finding.field }),
      warning: finding.severity === "warning",
    })),
    unreadable: result.unreadable,
  };
}

interface ResolvedTarget {
  readonly domain: ConfigurationDomain;
  readonly id: number;
}

/**
 * The record an intent names, refused where it names none.
 *
 * A create form — a reconciliation with no target — is refused here rather than
 * further in, because the refusal is about what this server implements and not
 * about anything the instance would say.
 */
function targetOf(invocation: OperationInvocation, intent: DirectIntent): Resolved<ResolvedTarget> {
  const domain = intent.domain;
  if (domain === undefined) {
    return { ok: false, error: error(invocation, "invalid_input", "this intent names no domain") };
  }
  if (intent.target === undefined) {
    return {
      ok: false,
      error: error(
        invocation,
        "unsupported_capability",
        "creating a configuration record is not implemented; name an existing record to reconcile",
      ),
    };
  }
  const resolved = resolveTarget(invocation, intent.target, domain);
  return resolved.ok ? { ok: true, value: { domain, id: resolved.value } } : resolved;
}

async function reconcileDirect(
  invocation: OperationInvocation,
  intent: DirectIntent,
  target: ResolvedTarget,
  mode: "plan" | "apply",
  planned?: readonly { readonly key: string; readonly digest: string }[],
  bypass = false,
): Promise<Resolved<ConfigurationReconcileOutcome>> {
  const bundle = bundleFor(intent);
  if (!bundle.ok) {
    return { ok: false, error: bundle.error };
  }

  return {
    ok: true,
    value: await runConfigurationReconciliation(invocation.application, invocation.adapter.client, {
      domain: target.domain,
      targetId: target.id,
      fields: intent.fields ?? [],
      removeFields: intent.removeFields,
      mode,
      secrets: bundle.value,
      ...(bypass ? { bypassValidationWarnings: true } : {}),
      ...(planned === undefined ? {} : { planned: { readSet: planned } }),
    }),
  };
}

/** Reads the resource a provider test is run against, without building one. */
async function readProviderPayload(
  invocation: OperationInvocation,
  domain: ProviderDomain,
  targetId: number,
): Promise<Resolved<UpstreamBody>> {
  const route = `${providerRouteFor(domain)}/${String(targetId)}`;
  const body = await invocation.adapter.client.get(route);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return {
      ok: false,
      error: error(invocation, "conflict", "this application no longer reports that provider"),
    };
  }
  return { ok: true, value: body as UpstreamBody };
}

/**
 * The collection route a provider domain lives at.
 *
 * The registry has already refused any application that does not model the
 * domain, so what is left here is the spelling each one uses.
 */
function providerRouteFor(domain: ProviderDomain): string {
  return providerRoutes[domain] ?? domain;
}

const providerRoutes: Readonly<Partial<Record<ProviderDomain, string>>> = {
  indexers: "indexer",
  download_clients: "downloadclient",
  applications: "applications",
  notifications: "notification",
  import_lists: "importlist",
  metadata: "metadata",
  proxies: "indexerproxy",
};

/**
 * What a provider test reaches, disclosed before it is run.
 *
 * A notification test delivers a real message to whoever the provider is
 * configured to notify, so it is `consequential` rather than informational even
 * though it changes no configuration: the effect lands on a person.
 */
function testEffects(invocation: OperationInvocation, domain: ProviderDomain): readonly Effect[] {
  const external = externalEffectOf(domain);
  return [
    effect(
      invocation,
      external === "delivers_message" ? "consequential" : "informational",
      describeExternalEffect(domain, invocation.application),
    ),
  ];
}

function testItem(result: ProviderTestResult): ItemOutcome {
  return {
    reference: "provider-test",
    status: result.outcome === "failed" ? "error" : "ok",
    warnings: [],
    ...(result.outcome === "failed"
      ? {
          error: createToolError({
            code: "upstream_rejection",
            message: `this provider failed validation on ${String(result.findings.length)} field(s)`,
          }),
        }
      : {}),
  };
}

export const configReconcilePreconditions: PreconditionReader = async (invocation) => {
  const parsed = parseInput(invocation);
  if (!parsed.ok) {
    return blocked(parsed.error);
  }
  const intent = parsed.value;

  if (intent.intent === "reconcile_application_sync") {
    return readSyncPreconditions(invocation, intent);
  }
  if (intent.intent === "test_provider") {
    return readTestPreconditions(invocation, intent);
  }
  if (
    intent.intent === "reconcile_provider" ||
    intent.intent === "force_provider_save" ||
    intent.intent === "reconcile_profile" ||
    intent.intent === "reconcile_resource"
  ) {
    return readReconcilePreconditions(invocation, intent);
  }
  return blocked(
    error(
      invocation,
      "unsupported_capability",
      `${intent.intent} is declared but not implemented yet`,
    ),
  );
};

async function readReconcilePreconditions(
  invocation: OperationInvocation,
  intent: DirectIntent,
): Promise<PreconditionRead> {
  const target = targetOf(invocation, intent);
  if (!target.ok) {
    return blocked(target.error);
  }
  const run = await reconcileDirect(invocation, intent, target.value, "plan");
  if (!run.ok) {
    return blocked(run.error);
  }
  const outcome = run.value;
  if (outcome.status === "error") {
    return blocked(outcome.error);
  }
  if (outcome.status !== "planned") {
    return blocked(error(invocation, "conflict", "the plan phase reported an apply"));
  }

  const bypass = intent.intent === "force_provider_save";
  const context: ReconcileContext = {
    kind: contextKind,
    intent: intent.intent,
    domain: target.value.domain,
    targetId: target.value.id,
    changed: outcome.changed,
    warnings: outcome.warnings,
    effects: [
      ...reconcileEffects(invocation, intent, outcome.changed),
      // Requested rather than predicted, for the bypass: the test is not a
      // consequence of some condition holding, it is what this intent does
      // every time it is applied. A caller reading only the effects has to see
      // that applying this contacts something outside the instance.
      ...(bypass
        ? [
            effect(
              invocation,
              "consequential",
              `tests this provider before saving, which ${describeExternalEffect(
                target.value.domain as ProviderDomain,
                invocation.application,
              )}`,
            ),
          ]
        : []),
    ],
    predicted: bypass
      ? [
          effect(
            invocation,
            "consequential",
            "saves over validation warnings only where the instance raises warnings; a provider it fails outright is refused",
          ),
        ]
      : [],
    readSet: [...fingerprintReadSet(outcome.observations)],
    data: publishDiff(invocation, outcome.diff),
  };

  return {
    status: "ok",
    observations: outcome.observations,
    warnings: outcome.warnings,
    validated: context,
  };
}

async function readTestPreconditions(
  invocation: OperationInvocation,
  intent: DirectIntent,
): Promise<PreconditionRead> {
  const domain = intent.domain;
  if (domain === undefined || !isProviderDomain(domain)) {
    return blocked(error(invocation, "invalid_input", "a provider test names a provider domain"));
  }
  if (intent.target === undefined) {
    return blocked(
      error(
        invocation,
        "unsupported_capability",
        "testing an unsaved provider is not implemented; name an existing provider",
      ),
    );
  }
  const target = resolveTarget(invocation, intent.target, domain);
  if (!target.ok) {
    return blocked(target.error);
  }

  const context: ReconcileContext = {
    kind: contextKind,
    intent: intent.intent,
    domain,
    targetId: target.value,
    changed: false,
    warnings: [],
    effects: testEffects(invocation, domain),
    predicted: [],
    readSet: [],
    data: undefined,
  };

  // Built here exactly as the apply builds it, credential and all, and then
  // discarded. A plan is worth reading only if it validated the request it
  // would send: a name that is not a credential on this record, or one the
  // record does not carry, is refused now rather than after an apply has been
  // authorized and before any test could be sent.
  const payload = await buildTestPayload(invocation, context, intent, domain);
  if (!payload.ok) {
    return blocked(payload.error);
  }

  return {
    status: "ok",
    // A test sends the provider as the instance holds it, so the plan depends
    // on the whole resource rather than on its identity: a URL or an account
    // that moved between the plan and its apply would have the apply contact
    // something the plan never disclosed. Credentials are folded to their
    // configured state inside the digest, so a rotation expires nothing.
    observations: providerTestObservations(payload.value),
    warnings: [],
    validated: context,
  };
}

async function readSyncPreconditions(
  invocation: OperationInvocation,
  intent: DirectIntent,
): Promise<PreconditionRead> {
  const level = readSyncLevel(intent.syncLevel);
  if (level === undefined) {
    return blocked(error(invocation, "invalid_input", "that is not a synchronization level"));
  }
  const targets: number[] = [];
  for (const token of intent.targets ??
    [intent.target].filter((value): value is string => value !== undefined)) {
    const resolved = resolveTarget(invocation, token, "applications");
    if (!resolved.ok) {
      return blocked(resolved.error);
    }
    targets.push(resolved.value);
  }

  const outcome = await runApplicationSync(invocation.application, invocation.adapter.client, {
    targets,
    syncLevel: level,
    startSync: intent.startSync === true,
    mode: "plan",
  });
  if (outcome.status === "error") {
    return blocked(outcome.error);
  }
  if (outcome.status !== "planned") {
    return blocked(error(invocation, "conflict", "the plan phase reported an apply"));
  }

  // One minter for this envelope; see syncItems.
  const mint = referenceMinter(invocation.state.references);
  const removes = outcome.items.some((item) =>
    item.effects.some((entry) => entry.effect === "remove"),
  );
  const context: ReconcileContext = {
    kind: contextKind,
    intent: intent.intent,
    domain: "applications",
    targetId: 0,
    changed: outcome.items.some((item) => item.changed),
    warnings: outcome.warnings,
    effects: [
      effect(
        invocation,
        removes ? "destructive" : "consequential",
        removes
          ? "sets the synchronization level and, where a level removes, deletes indexers on the remote application"
          : "sets the synchronization level of each named application mapping",
      ),
    ],
    predicted: [],
    readSet: [...fingerprintReadSet(outcome.observations)],
    data: publishSync(outcome.items, mint),
    items: syncItems(outcome.items, mint),
    sync: { targets, level, startSync: intent.startSync === true },
  };

  return {
    status: "ok",
    observations: outcome.observations,
    warnings: outcome.warnings,
    validated: context,
  };
}

export const configReconcileHandler: OperationHandler = async (invocation) => {
  const context = invocation.validated;
  if (!isReconcileContext(context)) {
    return {
      status: "error",
      error: error(invocation, "conflict", "the current state of this mutation was not validated"),
    };
  }

  if (invocation.mode === "plan") {
    return {
      status: "ok",
      data: context.data,
      plan: {
        requestedEffects: context.effects,
        predictedEffects: context.predicted,
        warnings: context.warnings,
      },
      ...(context.items === undefined ? {} : { items: context.items }),
    };
  }

  const parsed = parseInput(invocation);
  if (!parsed.ok) {
    return { status: "error", error: parsed.error };
  }
  const intent = parsed.value;

  if (context.sync !== undefined) {
    return applySync(invocation, context, context.sync);
  }
  if (context.intent === "test_provider") {
    return applyTest(invocation, context, intent);
  }
  if (context.intent === "force_provider_save") {
    return applyBypass(invocation, context, intent);
  }
  return applyReconcile(invocation, context, intent);
};

async function applyReconcile(
  invocation: OperationInvocation,
  context: ReconcileContext,
  intent: DirectIntent,
): Promise<Awaited<ReturnType<OperationHandler>>> {
  const run = await reconcileDirect(
    invocation,
    intent,
    { domain: context.domain, id: context.targetId },
    "apply",
    context.readSet,
  );
  if (!run.ok) {
    return { status: "error", error: run.error };
  }
  const outcome = run.value;
  if (outcome.status === "error") {
    return outcome.attempted
      ? { status: "ok", outcomeUnknown: outcome.error, effects: context.effects }
      : { status: "error", error: outcome.error };
  }
  if (outcome.status !== "applied") {
    return {
      status: "error",
      error: error(invocation, "conflict", "the apply phase reported a plan"),
    };
  }

  return {
    status: "ok",
    data: publishDiff(invocation, outcome.diff),
    effects: context.effects,
    warnings: outcome.warnings,
    ...(outcome.attempted
      ? {}
      : {
          unattempted: createToolError({
            code: "invalid_input",
            message: `${invocation.application}: this record already matched the desired state, so nothing was sent`,
            application: invocation.application,
          }),
        }),
    ...(outcome.verification?.status === "indeterminate" && outcome.attempted
      ? {
          outcomeUnknown: createToolError({
            code: "unexpected_response",
            message: `${invocation.application}: the write was sent and this application could not be read back to confirm it`,
            application: invocation.application,
          }),
        }
      : {}),
  };
}

async function applyTest(
  invocation: OperationInvocation,
  context: ReconcileContext,
  intent: DirectIntent,
): Promise<Awaited<ReturnType<OperationHandler>>> {
  const domain = context.domain;
  if (!isProviderDomain(domain)) {
    return {
      status: "error",
      error: error(invocation, "invalid_input", "a provider test names a provider domain"),
    };
  }
  const payload = await buildTestPayload(invocation, context, intent, domain);
  if (!payload.ok) {
    return { status: "error", error: payload.error };
  }

  const result = await runProviderTest(invocation.application, invocation.adapter.client, {
    domain,
    payload: payload.value,
  });
  if (result.status === "error") {
    // A test whose answer was lost may already have delivered its message, so
    // the effect travels with the failure and the receipt stays reconcilable.
    return result.attempted
      ? { status: "ok", outcomeUnknown: result.error, effects: context.effects }
      : { status: "error", error: result.error };
  }

  return {
    status: "ok",
    data: publishTest(result),
    effects: context.effects,
    items: [testItem(result)],
    warnings: [describeExternalEffect(domain, invocation.application)],
  };
}

/**
 * The explicit bypass.
 *
 * It is the ordinary apply with one flag set, deliberately: the adapter tests
 * the resource it is about to send and decides the parameter, the refusal, and
 * the disclosure together, so a save cannot claim to have skipped checks while
 * sending no parameter or send one while reporting that nothing was overridden.
 * Splitting that across two calls here would have this layer build a second
 * payload, and a second payload is a second chance to send something the test
 * never saw.
 */
async function applyBypass(
  invocation: OperationInvocation,
  context: ReconcileContext,
  intent: DirectIntent,
): Promise<Awaited<ReturnType<OperationHandler>>> {
  const run = await reconcileDirect(
    invocation,
    intent,
    { domain: context.domain, id: context.targetId },
    "apply",
    context.readSet,
    true,
  );
  if (!run.ok) {
    return { status: "error", error: run.error };
  }
  const outcome = run.value;
  if (outcome.status === "error") {
    return outcome.attempted
      ? { status: "ok", outcomeUnknown: outcome.error, effects: context.effects }
      : { status: "error", error: outcome.error };
  }
  if (outcome.status !== "applied") {
    return {
      status: "error",
      error: error(invocation, "conflict", "the apply phase reported a plan"),
    };
  }

  return {
    status: "ok",
    data: publishDiff(invocation, outcome.diff),
    effects: context.effects,
    warnings: outcome.warnings,
  };
}

/**
 * The resource a test is run against.
 *
 * Read fresh and rebuilt here rather than carried from the reader, because a
 * caller may have supplied a credential for the test to use and a payload
 * holding one must not sit in validated state.
 */
async function buildTestPayload(
  invocation: OperationInvocation,
  context: ReconcileContext,
  intent: DirectIntent,
  domain: ProviderDomain,
): Promise<Resolved<UpstreamBody>> {
  const stored = await readProviderPayload(invocation, domain, context.targetId);
  if (!stored.ok || (intent.secrets ?? []).length === 0) {
    return stored;
  }

  // A supplied credential is written into the payload through the same writer a
  // save uses, which is the point of the channel: testing a credential before
  // committing it is what a caller supplies one for, and testing the stored one
  // instead would answer a question nobody asked. The bundle is erased when the
  // writer returns, exactly as it is for a save.
  const bundle = bundleFor(intent);
  if (!bundle.ok) {
    return bundle;
  }
  const compilation = compileConfigurationPatch(invocation.application, domain, {
    fields: [],
    secretNames: bundle.value.names(),
  });
  if (compilation.status === "error") {
    return { ok: false, error: compilation.error };
  }
  try {
    const written = writeConfigurationPatch({
      application: invocation.application,
      resource: captureUpstreamResource(
        invocation.application,
        domain,
        stored.value as UpstreamValue,
      ),
      patch: compilation.patch,
      catalog: new Map(),
      id: context.targetId,
      secrets: bundle.value,
    });
    return written.status === "ok"
      ? { ok: true, value: written.write.payload }
      : { ok: false, error: written.error };
  } finally {
    bundle.value.erase();
  }
}

async function applySync(
  invocation: OperationInvocation,
  context: ReconcileContext,
  sync: NonNullable<ReconcileContext["sync"]>,
): Promise<Awaited<ReturnType<OperationHandler>>> {
  const outcome = await runApplicationSync(invocation.application, invocation.adapter.client, {
    targets: sync.targets,
    syncLevel: sync.level,
    startSync: sync.startSync,
    mode: "apply",
    planned: context.readSet,
  });
  if (outcome.status === "error") {
    return outcome.dispatched > 0
      ? { status: "ok", outcomeUnknown: outcome.error, effects: context.effects }
      : { status: "error", error: outcome.error };
  }
  if (outcome.status !== "applied") {
    return {
      status: "error",
      error: error(invocation, "conflict", "the apply phase reported a plan"),
    };
  }

  // One minter for this envelope, so the mapping a payload names and the
  // mapping its own settlement names are the same token. Across envelopes they
  // would differ, which is why it has to be one minter here rather than two
  // that happen to read the same store.
  const mint = referenceMinter(invocation.state.references);

  return {
    status: "ok",
    data: publishSync(outcome.items, mint),
    items: syncItems(outcome.items, mint),
    effects: context.effects,
    warnings: outcome.warnings,
    // Counted, never inferred: one mapping whose write timed out produces the
    // same "every item errored" an unsent call does.
    ...(outcome.dispatched === 0
      ? {
          unattempted: createToolError({
            code: "invalid_input",
            message: `${invocation.application}: no synchronization level needed changing, so nothing was sent`,
            application: invocation.application,
          }),
        }
      : {}),
    ...(outcome.unresolved === undefined ? {} : { outcomeUnknown: outcome.unresolved }),
  };
}
