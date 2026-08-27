import { describe, expect, it } from "vitest";
import type { ConfigurationReconcileRequest } from "../src/adapters/configuration/reconcile.js";
import {
  collectTransientSecrets,
  TransientSecrets,
} from "../src/adapters/configuration/secrets.js";
import { createApplyRecordStore } from "../src/state/apply-records.js";
import { createManualClock } from "../src/state/clock.js";
import { createPlanStore, fingerprintReadSet } from "../src/state/plans.js";
import { createReferenceStore } from "../src/state/references.js";
import {
  expectApplied,
  expectPlanned,
  expectRefused,
  first,
  type Instance,
  onlyWrite,
  planning,
  reconcile,
  type UpstreamRecord,
  writes,
} from "./support/configuration.js";
import { fixtureBody, jsonResponse } from "./support/library.js";

/**
 * What a plan may carry, and what makes it still valid at apply time.
 *
 * These are one subject seen twice. A plan that retained a credential would be
 * a secret store this server is not allowed to have, so it retains a name and a
 * presence fingerprint and the apply insists on being given the value again;
 * and a plan whose validity rested only on the record would miss the schema
 * moving underneath it, because a provider's field list lives in a document the
 * record does not contain.
 */

const supplied = "CANARY-SUPPLIED-APIKEY-0001";

function secrets(...entries: readonly (readonly [string, string])[]): TransientSecrets {
  const collected = collectTransientSecrets(entries.map(([name, value]) => ({ name, value })));
  if (collected.status !== "ok") {
    throw new Error(`Expected a bundle, got a duplicate ${collected.name}`);
  }
  return collected.secrets;
}

/** The Sonarr indexer and the schema its Newznab implementation comes from. */
async function newznab(): Promise<Instance> {
  return {
    routes: {
      "indexer/1": await first("sonarr", "indexer"),
      "indexer/schema": await fixtureBody("sonarr", "indexer/schema"),
    },
  };
}

function fieldValue(record: unknown, name: string): unknown {
  const fields = (record as UpstreamRecord).fields;
  return Array.isArray(fields)
    ? (fields as readonly UpstreamRecord[]).find((field) => field.name === name)?.value
    : undefined;
}

/** A reconciliation that changes one credential and nothing else. */
function changingApiKey(
  overrides: Partial<ConfigurationReconcileRequest> = {},
): ConfigurationReconcileRequest {
  return planning("indexers", 1, { secrets: secrets(["apiKey", supplied]), ...overrides });
}

describe("a bundle of transient secrets", () => {
  it("serializes to a census rather than to anything it holds", () => {
    const bundle = secrets(["apiKey", supplied]);

    expect(JSON.stringify(bundle)).toBe('{"count":1,"erased":false}');
    expect(JSON.stringify({ held: bundle })).not.toContain(supplied);
    // Enumeration reaches nothing either: the values are in a private field, so
    // there is no property for a spread or an Object.entries to find.
    expect(Object.entries({ ...bundle })).toEqual([]);
    expect(JSON.stringify(bundle.requirements())).not.toContain(supplied);
    expect(bundle.names()).toEqual(["apiKey"]);
  });

  it("erases every value once, and answers nothing afterwards", () => {
    const bundle = secrets(["apiKey", supplied]);
    expect(bundle.take("apiKey")).toBe(supplied);

    bundle.erase();

    expect(bundle.take("apiKey")).toBeUndefined();
    expect(bundle.size).toBe(0);
    expect(bundle.erased).toBe(true);
    expect(JSON.stringify(bundle)).toBe('{"count":0,"erased":true}');
  });

  it("refuses two values for one field rather than choosing one", () => {
    expect(collectTransientSecrets([{ name: "apiKey", value: "a" }])).toMatchObject({
      status: "ok",
    });
    expect(
      collectTransientSecrets([
        { name: "apiKey", value: "a" },
        { name: "apiKey", value: "b" },
      ]),
    ).toEqual({ status: "duplicate", name: "apiKey" });
    expect(
      () =>
        new TransientSecrets([
          { name: "apiKey", value: "a" },
          { name: "apiKey", value: "b" },
        ]),
    ).toThrow("cannot hold two apiKey values");
  });
});

describe("planning a credential change", () => {
  it("records the requirement by name and keeps no value in the plan or its receipt", async () => {
    const bundle = secrets(["apiKey", supplied]);
    const { outcome } = await reconcile(
      "sonarr",
      await newznab(),
      changingApiKey({ secrets: bundle }),
    );
    const planned = expectPlanned(outcome);

    expect(planned.requiredSecrets).toEqual([
      { name: "apiKey", presence: expect.stringMatching(/^[0-9a-f]{16}$/u) },
    ]);
    expect(JSON.stringify(planned)).not.toContain(supplied);
    // The bundle was erased as soon as the request had been built, which is the
    // whole of what this server ever does with a credential.
    expect(bundle.erased).toBe(true);
    expect(bundle.take("apiKey")).toBeUndefined();

    // The same claim through the machinery that actually retains a plan and a
    // receipt: both are built from an intent that carried the value.
    const clock = createManualClock(0);
    const references = createReferenceStore({ clock });
    const intent = {
      intent: "reconcile_provider",
      mode: "plan",
      application: "sonarr",
      domain: "indexers",
      target: "cfg_1",
      fields: [],
      secrets: [{ name: "apiKey", value: supplied }],
    };
    const record = createPlanStore(references, clock).record({
      tool: "arr_config_reconcile",
      variant: "reconcile_provider",
      applications: ["sonarr"],
      intent,
      requestedEffects: [],
      predictedEffects: [],
      warnings: [],
      observations: planned.observations,
    });
    const receipt = createApplyRecordStore(references, clock).begin({
      tool: "arr_config_reconcile",
      variant: "reconcile_provider",
      application: "sonarr",
      intent,
    });

    expect(JSON.stringify(record)).not.toContain(supplied);
    expect(record.requiredSecrets.map((secret) => secret.name)).toEqual(["apiKey"]);
    expect(JSON.stringify(receipt.record)).not.toContain(supplied);
  });

  it("describes the credential by disposition, never by value", async () => {
    const { outcome } = await reconcile("sonarr", await newznab(), changingApiKey());
    const planned = expectPlanned(outcome);

    expect(planned.diff.changes).toEqual([
      { path: "fields.apiKey", action: "set", redacted: true },
    ]);
    // Configured before, so this replaces one rather than supplying a first.
    expect(planned.diff.secrets).toEqual([{ name: "apiKey", disposition: "changed" }]);
  });

  it("says a first credential was set rather than changed", async () => {
    const record = await first("sonarr", "indexer");
    const unconfigured = {
      ...record,
      fields: (record.fields as readonly UpstreamRecord[]).map((field) =>
        field.name === "apiKey" ? { ...field, value: "" } : field,
      ),
    };
    const { outcome } = await reconcile(
      "sonarr",
      {
        routes: {
          "indexer/1": unconfigured,
          "indexer/schema": await fixtureBody("sonarr", "indexer/schema"),
        },
      },
      changingApiKey(),
    );

    expect(expectPlanned(outcome).diff.secrets).toEqual([{ name: "apiKey", disposition: "set" }]);
  });
});

describe("applying a credential change", () => {
  it("sends the supplied value upstream and echoes it nowhere", async () => {
    const { outcome, dispatched } = await reconcile(
      "sonarr",
      await newznab(),
      changingApiKey({ mode: "apply" }),
    );
    const applied = expectApplied(outcome);

    expect(fieldValue(onlyWrite(dispatched).body, "apiKey")).toBe(supplied);
    expect(JSON.stringify(applied)).not.toContain(supplied);
    expect(applied.verification).toEqual({ status: "succeeded" });
  });

  it("refuses a planned apply that did not resupply the credential", async () => {
    const { outcome } = await reconcile("sonarr", await newznab(), changingApiKey());
    const planned = expectPlanned(outcome);

    const { outcome: applied, dispatched } = await reconcile("sonarr", await newznab(), {
      ...changingApiKey({ mode: "apply" }),
      secrets: undefined,
      planned: {
        readSet: fingerprintReadSet(planned.observations),
        requiredSecrets: planned.requiredSecrets,
      },
    });

    // Not a stale plan: the record did not move, the caller simply did not
    // bring the credential the plan never held.
    expect(expectRefused(applied).error).toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("apiKey"),
    });
    expect(dispatched).toEqual([]);
  });

  it("refuses a credential the plan being applied never disclosed", async () => {
    const { outcome } = await reconcile(
      "sonarr",
      await newznab(),
      planning("indexers", 1, { fields: [{ name: "priority", value: 30 }] }),
    );
    const planned = expectPlanned(outcome);

    const { outcome: applied, dispatched } = await reconcile("sonarr", await newznab(), {
      ...changingApiKey({ mode: "apply", fields: [{ name: "priority", value: 30 }] }),
      planned: { readSet: fingerprintReadSet(planned.observations) },
    });

    // An apply does what its plan disclosed. Smuggling a credential change into
    // one that never mentioned it is the case a plan is read to rule out.
    expect(expectRefused(applied).error).toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("this plan does not change apiKey"),
    });
    expect(dispatched).toEqual([]);
  });

  it("erases the bundle even when the reconciliation refuses", async () => {
    const bundle = secrets(["apiKey", supplied]);
    const { outcome } = await reconcile(
      "sonarr",
      { routes: {} },
      planning("indexers", 9, { mode: "apply", secrets: bundle }),
    );

    // The record was never found, so nothing was ever built from the value —
    // and it is gone all the same, because a bundle does not outlive the call
    // it was handed to.
    expect(expectRefused(outcome).error.code).toBe("stale_reference");
    expect(bundle.erased).toBe(true);
    expect(bundle.take("apiKey")).toBeUndefined();
  });

  it("applies a resupplied credential and says so when the value differs", async () => {
    const { outcome } = await reconcile("sonarr", await newznab(), changingApiKey());
    const planned = expectPlanned(outcome);

    const rotated = "CANARY-ROTATED-APIKEY-0002";
    const { outcome: applied, dispatched } = await reconcile("sonarr", await newznab(), {
      ...changingApiKey({ mode: "apply" }),
      secrets: secrets(["apiKey", rotated]),
      planned: {
        readSet: fingerprintReadSet(planned.observations),
        requiredSecrets: planned.requiredSecrets,
      },
    });
    const settled = expectApplied(applied);

    expect(fieldValue(onlyWrite(dispatched).body, "apiKey")).toBe(rotated);
    expect(settled.warnings).toContain(
      "the resupplied apiKey differs from the value the plan validated",
    );
    expect(JSON.stringify(settled)).not.toContain(rotated);
  });

  it("refuses a supplied value for a field nothing calls a credential", async () => {
    const { outcome, dispatched } = await reconcile(
      "sonarr",
      await newznab(),
      planning("indexers", 1, {
        mode: "apply",
        secrets: secrets(["baseUrl", "https://indexer.example.invalid"]),
      }),
    );

    expect(expectRefused(outcome).error).toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("baseUrl is not a credential on this record"),
    });
    expect(writes(dispatched)).toEqual([]);
  });

  it("refuses a supplied value for a switch that merely reads like a credential", async () => {
    // The observation classifier calls a boolean under a credential-shaped name
    // a switch rather than a credential and withholds it. The write side has to
    // agree, or this channel becomes a way to overwrite an ordinary switch with
    // a supplied string.
    const record = await first("radarr", "downloadclient");
    const switched = {
      ...record,
      fields: [{ order: 0, name: "useAuthentication", value: false }],
    };
    const instance = {
      routes: { "downloadclient/1": switched, "downloadclient/schema": [] },
    };

    const { outcome, dispatched } = await reconcile(
      "radarr",
      instance,
      planning("download_clients", 1, {
        mode: "apply",
        secrets: secrets(["useAuthentication", supplied]),
      }),
    );
    expect(expectRefused(outcome).error).toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("useAuthentication is not a credential on this record"),
    });
    expect(writes(dispatched)).toEqual([]);

    // And it is not clearable either: this server cannot describe it, so it
    // will not blank it.
    const cleared = await reconcile(
      "radarr",
      instance,
      planning("download_clients", 1, {
        mode: "apply",
        removeFields: ["useAuthentication"],
      }),
    );
    expect(expectRefused(cleared.outcome).error).toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("is a switch on this record"),
    });
  });

  it("accepts a supplied value for a field the instance marks as one", async () => {
    // The mirror of the desired-field rule: upstream privacy escalates a field
    // to a credential, so a field this server would not have guessed at may be
    // supplied through the channel that never retains a value.
    const record = await first("radarr", "downloadclient");
    const marked = {
      ...record,
      fields: [{ order: 0, name: "movieCategory", value: "radarr", privacy: "password" }],
    };
    const { outcome, dispatched } = await reconcile(
      "radarr",
      { routes: { "downloadclient/1": marked, "downloadclient/schema": [] } },
      planning("download_clients", 1, {
        mode: "apply",
        secrets: secrets(["movieCategory", supplied]),
      }),
    );
    const applied = expectApplied(outcome);

    expect(fieldValue(onlyWrite(dispatched).body, "movieCategory")).toBe(supplied);
    expect(applied.diff.secrets).toEqual([{ name: "movieCategory", disposition: "changed" }]);
  });
});

describe("schema and resource fingerprints", () => {
  it("makes a plan stale when the schema moved and the record did not", async () => {
    const instance = await newznab();
    const { outcome } = await reconcile(
      "sonarr",
      instance,
      planning("indexers", 1, { fields: [{ name: "priority", value: 30 }] }),
    );
    const planned = expectPlanned(outcome);

    // The same record, byte for byte. Only the definition of its provider moved:
    // a field that was an ordinary setting is now a credential.
    const schema = (await fixtureBody<readonly UpstreamRecord[]>("sonarr", "indexer/schema")).map(
      (template) =>
        template.implementation === "Newznab"
          ? {
              ...template,
              fields: (template.fields as readonly UpstreamRecord[]).map((field) =>
                field.name === "apiPath" ? { ...field, privacy: "password" } : field,
              ),
            }
          : template,
    );
    const { outcome: stale, dispatched } = await reconcile(
      "sonarr",
      { routes: { ...instance.routes, "indexer/schema": schema } },
      {
        ...planning("indexers", 1, {
          mode: "apply",
          fields: [{ name: "priority", value: 30 }],
        }),
        planned: { readSet: fingerprintReadSet(planned.observations) },
      },
    );

    expect(expectRefused(stale).error).toMatchObject({
      code: "stale_plan",
      message: expect.stringContaining("provider-schema"),
    });
    expect(writes(dispatched)).toEqual([]);
  });

  it("does not expire a plan when a different implementation's template moves", async () => {
    const instance = await newznab();
    const request = planning("indexers", 1, { fields: [{ name: "priority", value: 30 }] });
    const { outcome } = await reconcile("sonarr", instance, request);
    const planned = expectPlanned(outcome);

    const schema = (await fixtureBody<readonly UpstreamRecord[]>("sonarr", "indexer/schema")).map(
      (template) =>
        template.implementation === "Torznab" ? { ...template, fields: [] } : template,
    );
    const { outcome: applied } = await reconcile(
      "sonarr",
      { routes: { ...instance.routes, "indexer/schema": schema } },
      { ...request, mode: "apply", planned: { readSet: fingerprintReadSet(planned.observations) } },
    );

    expect(expectApplied(applied).attempted).toBe(true);
  });

  it("does not expire a plan for a label the schema renders and nothing reads", async () => {
    const instance = await newznab();
    const request = planning("indexers", 1, { fields: [{ name: "priority", value: 30 }] });
    const { outcome } = await reconcile("sonarr", instance, request);
    const planned = expectPlanned(outcome);

    // Same fields, same types, same classifications, different display text, a
    // different order, and the instance re-casing its own implementation on
    // both sides. Nothing a write depends on has moved.
    const schema = (await fixtureBody<readonly UpstreamRecord[]>("sonarr", "indexer/schema")).map(
      (template) => ({
        ...template,
        // Re-cased, not renamed: the same template is selected and the same
        // write is produced, so a digest that moved for it would expire every
        // plan over a spelling.
        implementation: String(template.implementation).toLowerCase(),
        implementationName: "Newznab (renamed)",
        fields: [...(template.fields as readonly UpstreamRecord[])]
          .reverse()
          .map((field) => ({ ...field, label: `${String(field.label)} (renamed)` })),
      }),
    );
    const record = await first("sonarr", "indexer");
    const { outcome: applied } = await reconcile(
      "sonarr",
      {
        routes: {
          ...instance.routes,
          "indexer/1": { ...record, implementation: "newznab" },
          "indexer/schema": schema,
        },
      },
      { ...request, mode: "apply", planned: { readSet: fingerprintReadSet(planned.observations) } },
    );

    expect(expectApplied(applied).attempted).toBe(true);
  });

  it("observes a switch the writer cannot move as unwritable rather than by value", async () => {
    const instance = await newznab();
    const record = await first("sonarr", "indexer");
    const legacy = { ...record, enable: "yes" };
    const request = planning("indexers", 1, { fields: [{ name: "enabled", value: true }] });
    const { outcome } = await reconcile(
      "sonarr",
      { routes: { ...instance.routes, "indexer/1": legacy } },
      request,
    );
    const planned = expectPlanned(outcome);
    const quoting = { readSet: fingerprintReadSet(planned.observations) };

    // The legacy property moves to another value the writer still cannot use.
    // Nothing this write does has changed, so the plan is still good.
    const { outcome: applied } = await reconcile(
      "sonarr",
      { routes: { ...instance.routes, "indexer/1": { ...legacy, enable: "no" } } },
      { ...request, mode: "apply", planned: quoting },
    );
    expect(expectApplied(applied).attempted).toBe(true);

    // It becomes a real switch, which the writer would now move: that is a
    // different write, so the plan is stale.
    const { outcome: stale } = await reconcile(
      "sonarr",
      { routes: { ...instance.routes, "indexer/1": { ...legacy, enable: false } } },
      { ...request, mode: "apply", planned: quoting },
    );
    expect(expectRefused(stale).error).toMatchObject({ code: "stale_plan" });
  });

  it("makes a plan stale when a field entry has appeared on the record", async () => {
    const instance = await newznab();
    const request = planning("indexers", 1, { fields: [{ name: "priority", value: 30 }] });
    const { outcome } = await reconcile("sonarr", instance, request);
    const planned = expectPlanned(outcome);

    const record = await first("sonarr", "indexer");
    const quoting = { readSet: fingerprintReadSet(planned.observations) };
    const reshaped = {
      ...record,
      fields: [...(record.fields as readonly UpstreamRecord[]), { order: 9, name: "seedRatio" }],
    };
    const { outcome: stale } = await reconcile(
      "sonarr",
      { routes: { ...instance.routes, "indexer/1": reshaped } },
      { ...request, mode: "apply", planned: quoting },
    );

    expect(expectRefused(stale).error).toMatchObject({
      code: "stale_plan",
      message: expect.stringContaining("resource-shape"),
    });

    // A second entry under a name that already exists is the same kind of
    // change, and it must expire the plan rather than reach the writer, which
    // would refuse it as an unreadable response and blame the instance.
    const duplicated = {
      ...record,
      fields: [
        ...(record.fields as readonly UpstreamRecord[]),
        { order: 9, name: "apiKey", value: "CANARY-SECOND-ENTRY-0003" },
      ],
    };
    const { outcome: ambiguous } = await reconcile(
      "sonarr",
      { routes: { ...instance.routes, "indexer/1": duplicated } },
      { ...request, mode: "apply", planned: quoting },
    );
    expect(expectRefused(ambiguous).error.code).toBe("stale_plan");
  });

  it("says so when the instance offers no template for this record's implementation", async () => {
    const record = { ...(await first("sonarr", "indexer")), implementation: "Cardigann" };
    const { outcome } = await reconcile(
      "sonarr",
      {
        routes: {
          "indexer/1": record,
          "indexer/schema": await fixtureBody("sonarr", "indexer/schema"),
        },
      },
      planning("indexers", 1, { fields: [{ name: "priority", value: 30 }] }),
    );
    const planned = expectPlanned(outcome);

    expect(planned.warnings).toContain(
      "this instance offers no provider template for this record's implementation",
    );
    // Still fingerprinted: a template that appears later is a change too.
    expect(planned.observations.map((entry) => entry.key)).toContain("provider-schema");
  });

  it("says so when the instance offers the same implementation twice", async () => {
    const templates = await fixtureBody<readonly UpstreamRecord[]>("sonarr", "indexer/schema");
    const { outcome } = await reconcile(
      "sonarr",
      {
        routes: {
          "indexer/1": await first("sonarr", "indexer"),
          // Two templates claiming the same implementation: the instance has
          // not said which definition a write would be against.
          "indexer/schema": [...templates, ...templates],
        },
      },
      planning("indexers", 1, { fields: [{ name: "priority", value: 30 }] }),
    );
    const planned = expectPlanned(outcome);

    expect(planned.warnings).toContain(
      "this instance offers more than one provider template for this record's implementation, so which definition a write is against cannot be established",
    );
    expect(planned.observations.map((entry) => entry.key)).toContain("provider-schema");
  });

  it("discloses an instance whose schema it could not read instead of refusing", async () => {
    const { outcome } = await reconcile(
      "sonarr",
      { routes: { "indexer/1": await first("sonarr", "indexer") } },
      planning("indexers", 1, { fields: [{ name: "priority", value: 30 }] }),
    );
    const planned = expectPlanned(outcome);

    expect(planned.warnings).toContain(
      "this instance did not answer with a readable provider schema, so a schema change cannot make this plan stale",
    );
    // Still comparable: a schema that becomes readable is itself a change.
    expect(planned.observations.map((entry) => entry.key)).toContain("provider-schema");
  });
});

describe("verifying what the instance stored", () => {
  const priority = planning("indexers", 1, {
    mode: "apply",
    fields: [{ name: "priority", value: 30 }],
  });

  it("confirms an apply from the record the write answered with", async () => {
    const { outcome, dispatched } = await reconcile("sonarr", await newznab(), priority);

    expect(expectApplied(outcome).verification).toEqual({ status: "succeeded" });
    // Confirmed from the write's own answer, so nothing was re-read.
    expect(
      dispatched.filter((call) => call.route === "indexer/1" && call.method === "GET"),
    ).toHaveLength(1);
  });

  it("judges only the switches the writer moved", async () => {
    const record = await first("sonarr", "indexer");
    // A legacy switch the writer leaves alone because it is not a boolean. An
    // instance moving it says nothing about the apply that never wrote it.
    const legacy = { ...record, enable: "yes" };
    const { outcome } = await reconcile(
      "sonarr",
      {
        routes: { ...(await newznab()).routes, "indexer/1": legacy },
        answerWrite: (sent) => jsonResponse({ ...(sent as UpstreamRecord), enable: "no" }),
      },
      planning("indexers", 1, { mode: "apply", fields: [{ name: "enabled", value: true }] }),
    );

    expect(expectApplied(outcome).verification).toEqual({ status: "succeeded" });
  });

  it("reports a conflict when the instance stored something else", async () => {
    const instance = await newznab();
    const { outcome } = await reconcile(
      "sonarr",
      {
        ...instance,
        answerWrite: (sent) => jsonResponse({ ...(sent as UpstreamRecord), priority: 50 }),
      },
      priority,
    );
    const applied = expectApplied(outcome);

    expect(applied.attempted).toBe(true);
    expect(applied.verification).toMatchObject({
      status: "failed",
      error: { code: "conflict", message: expect.stringContaining("priority") },
    });
  });

  it("reads the record back when the write answered with nothing", async () => {
    const instance = await newznab();
    const record = await first("sonarr", "indexer");
    let reads = 0;
    const { outcome, dispatched } = await reconcile(
      "sonarr",
      {
        routes: {
          ...instance.routes,
          // The record as it was, and then as the instance stored it: the
          // second read is the verification's own, which is the point.
          get "indexer/1"() {
            reads += 1;
            return reads === 1 ? record : { ...record, priority: 30 };
          },
        },
        answerWrite: () => new Response(null, { status: 204 }),
      },
      priority,
    );

    expect(expectApplied(outcome).verification).toEqual({ status: "succeeded" });
    expect(
      dispatched.filter((call) => call.route === "indexer/1" && call.method === "GET"),
    ).toHaveLength(2);
  });

  it("leaves the outcome unknown when the instance cannot be read back", async () => {
    let reads = 0;
    const record = await first("sonarr", "indexer");
    const { outcome } = await reconcile(
      "sonarr",
      {
        routes: {
          // The record answers the first read and is gone by the second, which
          // is the shape of an instance that went away mid-apply.
          get "indexer/1"() {
            reads += 1;
            return reads === 1 ? record : undefined;
          },
          "indexer/schema": await fixtureBody("sonarr", "indexer/schema"),
        },
        answerWrite: () => new Response(null, { status: 204 }),
      },
      priority,
    );
    const applied = expectApplied(outcome);

    expect(applied.attempted).toBe(true);
    // Never guessed into a verdict: the write may well have been stored.
    expect(applied.verification).toEqual({ status: "indeterminate" });
  });

  it("verifies a credential by presence, which is all a credential can be verified by", async () => {
    const instance = await newznab();
    const { outcome } = await reconcile(
      "sonarr",
      {
        ...instance,
        // The instance answers with the mask it substitutes for a stored
        // credential, which says that one is configured and nothing more.
        answerWrite: (sent) => {
          const record = sent as UpstreamRecord;
          return jsonResponse({
            ...record,
            fields: (record.fields as readonly UpstreamRecord[]).map((field) =>
              field.name === "apiKey" ? { ...field, value: "********" } : field,
            ),
          });
        },
      },
      changingApiKey({ mode: "apply" }),
    );

    expect(expectApplied(outcome).verification).toEqual({ status: "succeeded" });
  });

  it("holds an ordinary clear to the value it sent rather than to mere absence", async () => {
    const record = await first("radarr", "downloadclient");
    const clearing = planning("download_clients", 1, {
      mode: "apply",
      removeFields: ["movieCategory"],
    });

    const stored = await reconcile(
      "radarr",
      {
        routes: { "downloadclient/1": record, "downloadclient/schema": [] },
        // The instance answers with the value it already had, so the clear did
        // not happen — a presence check would have called this a success.
        answerWrite: () => jsonResponse(record),
      },
      clearing,
    );
    expect(expectApplied(stored.outcome).verification).toMatchObject({
      status: "failed",
      error: { code: "conflict", message: expect.stringContaining("fields.movieCategory") },
    });

    const cleared = await reconcile(
      "radarr",
      { routes: { "downloadclient/1": record, "downloadclient/schema": [] } },
      clearing,
    );
    expect(expectApplied(cleared.outcome).verification).toEqual({ status: "succeeded" });
  });

  it("settles as unknown when the record repeats a field this apply wrote", async () => {
    const instance = await newznab();
    const { outcome } = await reconcile(
      "sonarr",
      {
        ...instance,
        // The same name twice, with different values. The record does not say
        // what that field holds, so the write's effect cannot be established
        // from it either way.
        answerWrite: (sent) => {
          const record = sent as UpstreamRecord;
          return jsonResponse({
            ...record,
            fields: [
              ...(record.fields as readonly UpstreamRecord[]),
              { order: 9, name: "categories", value: [1010] },
            ],
          });
        },
      },
      planning("indexers", 1, { mode: "apply", fields: [{ name: "categories", value: [5030] }] }),
    );
    const applied = expectApplied(outcome);

    expect(applied.attempted).toBe(true);
    expect(applied.verification).toEqual({ status: "indeterminate" });
  });

  it("settles as unknown when a credential this apply set reads back twice", async () => {
    const instance = await newznab();
    const { outcome } = await reconcile(
      "sonarr",
      {
        ...instance,
        answerWrite: (sent) => {
          const record = sent as UpstreamRecord;
          return jsonResponse({
            ...record,
            fields: [
              ...(record.fields as readonly UpstreamRecord[]),
              { order: 9, name: "apiKey", value: "", privacy: "apiKey" },
            ],
          });
        },
      },
      changingApiKey({ mode: "apply" }),
    );

    expect(expectApplied(outcome).verification).toEqual({ status: "indeterminate" });
  });

  it("settles as unknown when a credential reads back as a switch", async () => {
    const instance = await newznab();
    const { outcome } = await reconcile(
      "sonarr",
      {
        ...instance,
        // A boolean where a credential was written is not a credential at all,
        // so nothing about the write has been established either way.
        answerWrite: (sent) => {
          const record = sent as UpstreamRecord;
          return jsonResponse({
            ...record,
            fields: (record.fields as readonly UpstreamRecord[]).map((field) =>
              field.name === "apiKey" ? { ...field, value: true } : field,
            ),
          });
        },
      },
      changingApiKey({ mode: "apply" }),
    );

    expect(expectApplied(outcome).verification).toEqual({ status: "indeterminate" });
  });

  it("confirms a clear however the instance spells an empty credential", async () => {
    const instance = await newznab();
    const clearing = planning("indexers", 1, { mode: "apply", removeFields: ["apiKey"] });

    // Null, blank, and no `value` property at all: three spellings of the same
    // statement, and the entry is still the field the apply wrote.
    for (const spelling of [{ value: null }, { value: "" }, {}] as const) {
      const { outcome } = await reconcile(
        "sonarr",
        {
          ...instance,
          answerWrite: (sent) => {
            const record = sent as UpstreamRecord;
            return jsonResponse({
              ...record,
              fields: (record.fields as readonly UpstreamRecord[]).map((field) =>
                field.name === "apiKey"
                  ? { order: field.order, name: "apiKey", privacy: "apiKey", ...spelling }
                  : field,
              ),
            });
          },
        },
        clearing,
      );

      expect(expectApplied(outcome).verification).toEqual({ status: "succeeded" });
    }
  });

  it("settles as unknown when the cleared credential is no longer a field at all", async () => {
    const instance = await newznab();
    const { outcome } = await reconcile(
      "sonarr",
      {
        ...instance,
        // The entry is gone from the record, which is not the same statement as
        // an entry holding nothing: the field this apply wrote is not there to
        // be read, and a record that dropped it says nothing about the clear.
        answerWrite: (sent) => {
          const record = sent as UpstreamRecord;
          return jsonResponse({
            ...record,
            fields: (record.fields as readonly UpstreamRecord[]).filter(
              (field) => field.name !== "apiKey",
            ),
          });
        },
      },
      planning("indexers", 1, { mode: "apply", removeFields: ["apiKey"] }),
    );

    expect(expectApplied(outcome).verification).toEqual({ status: "indeterminate" });
  });

  it("reports a cleared credential the instance still holds as a conflict", async () => {
    const instance = await newznab();
    const { outcome } = await reconcile(
      "sonarr",
      {
        ...instance,
        answerWrite: () => jsonResponse(instance.routes["indexer/1"]),
      },
      planning("indexers", 1, { mode: "apply", removeFields: ["apiKey"] }),
    );

    expect(expectApplied(outcome).verification).toMatchObject({
      status: "failed",
      error: { code: "conflict" },
    });
  });
});
