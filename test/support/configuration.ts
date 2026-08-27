import type { ConfigurationDomain } from "../../src/adapters/configuration/domains.js";
import type {
  ConfigurationRecord,
  ProviderRecord,
} from "../../src/adapters/configuration/model.js";
import type {
  ConfigurationObservationOutcome,
  ConfigurationObservationRequest,
} from "../../src/adapters/configuration/service.js";
import { runConfigurationObservation } from "../../src/adapters/configuration/service.js";
import type { ApplicationId } from "../../src/applications.js";
import { libraryHarness, type UpstreamCall } from "./library.js";

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
