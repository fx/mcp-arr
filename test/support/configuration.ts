import type { ConfigurationDomain } from "../../src/adapters/configuration/domains.js";
import type {
  ConfigurationRecord,
  ProviderRecord,
} from "../../src/adapters/configuration/model.js";
import type {
  ConfigurationReconcileOutcome,
  ConfigurationReconcileRequest,
} from "../../src/adapters/configuration/reconcile.js";
import { runConfigurationReconciliation } from "../../src/adapters/configuration/reconcile.js";
import type { SerializationContext } from "../../src/adapters/configuration/serialize.js";
import type {
  ConfigurationObservationOutcome,
  ConfigurationObservationRequest,
} from "../../src/adapters/configuration/service.js";
import { runConfigurationObservation } from "../../src/adapters/configuration/service.js";
import type { ApplicationId } from "../../src/applications.js";
import { describeApplication } from "../../src/applications.js";
import { fixtureBody, jsonResponse, libraryHarness, type UpstreamCall } from "./library.js";

/**
 * Helpers for the configuration observation tests.
 *
 * The upstream harness is the library tests' own: it wires the real upstream
 * client to an injected fetch, so these tests exercise the same path joining,
 * header handling, and error normalization the server uses, with only the
 * network replaced.
 */

export function configurationHarness(
  application: ApplicationId,
  respond: (call: UpstreamCall) => Response | Promise<Response>,
) {
  return libraryHarness(application, respond);
}

export function observationRequest(
  domain: ConfigurationDomain,
  overrides: Partial<ConfigurationObservationRequest> = {},
): ConfigurationObservationRequest {
  return { domain, detail: "full", paging: { pageSize: 25 }, ...overrides };
}

/**
 * The context the recorded Sonarr indexer schema route is serialized under.
 *
 * A template is built only by the staleness check now, so every test that
 * examines one describes the same read: one provider domain's schema route, at
 * the detail a fingerprint is taken at.
 */
export const recordedSchemaContext: SerializationContext = {
  application: "sonarr",
  domain: "indexers",
  route: "indexer/schema",
  detail: "full",
};

export interface ObservationRun {
  readonly outcome: ConfigurationObservationOutcome;
  readonly calls: readonly UpstreamCall[];
}

export async function observe(
  application: ApplicationId,
  request: ConfigurationObservationRequest,
  respond: (call: UpstreamCall) => Response | Promise<Response>,
): Promise<ObservationRun> {
  const harness = configurationHarness(application, respond);
  const outcome = await runConfigurationObservation(application, harness.client, request);
  return { outcome, calls: harness.calls };
}

export function expectObserved(outcome: ConfigurationObservationOutcome) {
  if (outcome.status !== "ok") {
    throw new Error(`Expected an ok outcome, got ${outcome.error.code}: ${outcome.error.message}`);
  }
  return outcome;
}

export function expectObservationError(outcome: ConfigurationObservationOutcome) {
  if (outcome.status !== "error") {
    throw new Error("Expected an error outcome");
  }
  return outcome.error;
}

export function observedRecords(
  outcome: ConfigurationObservationOutcome,
): readonly ConfigurationRecord[] {
  return expectObserved(outcome).data.records;
}

/** Narrows an observation to the provider records it produced. */
export function providerRecords(
  outcome: ConfigurationObservationOutcome,
): readonly ProviderRecord[] {
  const view = expectObserved(outcome).data;
  if (view.family !== "provider") {
    throw new Error(`Expected a provider view, got ${view.family}`);
  }
  return view.records;
}

export function firstRecord<TRecord>(records: readonly TRecord[]): TRecord {
  const record = records[0];
  if (record === undefined) {
    throw new Error("Expected at least one observed record");
  }
  return record;
}

/**
 * The reconciliation harness.
 *
 * A reconciliation reads more than one route — the record, the lists it points
 * at, and the provider schema — so a test describes the instance as a small
 * routing table rather than as a single response, and every dispatched request
 * is recorded so a test can assert what was sent and, just as often, that
 * nothing was.
 */

/** One upstream configuration record, as a fixture or an instance reports it. */
export type UpstreamRecord = Record<string, unknown>;

export interface Instance {
  /** Upstream route, without the versioned API prefix, to its response body. */
  readonly routes: Readonly<Record<string, unknown>>;
  /**
   * How the instance answers a write. The default echoes what it was sent,
   * which is what these applications do; a test that is about verification
   * overrides it to answer with something else, with nothing, or with a
   * failure.
   */
  readonly answerWrite?: ((sent: unknown) => Response) | undefined;
}

export interface Dispatched {
  readonly method: string;
  readonly route: string;
  readonly body?: unknown;
}

export interface ReconcileRun {
  readonly outcome: ConfigurationReconcileOutcome;
  readonly dispatched: readonly Dispatched[];
}

/**
 * Runs one reconciliation against a small routing table.
 *
 * A route the table does not carry answers 404, like an instance that does not
 * have that record; a PUT echoes what it was sent, like an instance that
 * accepted it.
 */
export async function reconcile(
  application: ApplicationId,
  instance: Instance,
  request: ConfigurationReconcileRequest,
): Promise<ReconcileRun> {
  const prefix = `${describeApplication(application).apiBasePath}/`;
  const dispatched: Dispatched[] = [];
  const harness = configurationHarness(application, (call) => {
    const route = call.url.pathname.startsWith(prefix)
      ? call.url.pathname.slice(prefix.length)
      : call.url.pathname;
    const method = call.init.method ?? "GET";
    const sent = typeof call.init.body === "string" ? JSON.parse(call.init.body) : undefined;
    dispatched.push({ method, route, ...(sent === undefined ? {} : { body: sent }) });
    if (method !== "GET") {
      return instance.answerWrite === undefined ? jsonResponse(sent) : instance.answerWrite(sent);
    }
    const body = instance.routes[route];
    return body === undefined
      ? jsonResponse({ message: "NotFound" }, 404)
      : jsonResponse(structuredClone(body));
  });

  const outcome = await runConfigurationReconciliation(application, harness.client, request);
  return { outcome, dispatched };
}

export function planning(
  domain: ConfigurationDomain,
  targetId: number,
  overrides: Partial<ConfigurationReconcileRequest> = {},
): ConfigurationReconcileRequest {
  return { domain, targetId, fields: [], mode: "plan", ...overrides };
}

export function expectPlanned(outcome: ConfigurationReconcileOutcome) {
  if (outcome.status !== "planned") {
    throw new Error(
      `Expected a plan, got ${outcome.status === "error" ? outcome.error.message : outcome.status}`,
    );
  }
  return outcome;
}

export function expectApplied(outcome: ConfigurationReconcileOutcome) {
  if (outcome.status !== "applied") {
    throw new Error(
      `Expected an apply, got ${outcome.status === "error" ? outcome.error.message : outcome.status}`,
    );
  }
  return outcome;
}

export function expectRefused(outcome: ConfigurationReconcileOutcome) {
  if (outcome.status !== "error") {
    throw new Error(`Expected a refusal, got ${outcome.status}`);
  }
  return outcome;
}

export function writes(dispatched: readonly Dispatched[]): readonly Dispatched[] {
  return dispatched.filter((call) => call.method !== "GET");
}

export function onlyWrite(dispatched: readonly Dispatched[]): Dispatched {
  const [write, ...rest] = writes(dispatched);
  if (write === undefined || rest.length > 0) {
    throw new Error(`Expected exactly one upstream write, saw ${writes(dispatched).length}`);
  }
  return write;
}

export async function first(application: ApplicationId, route: string): Promise<UpstreamRecord> {
  const body = await fixtureBody<readonly UpstreamRecord[]>(application, route);
  const record = body[0];
  if (record === undefined) {
    throw new Error(`The recorded ${route} response is empty`);
  }
  return record;
}
