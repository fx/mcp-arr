import { describe, expect, it } from "vitest";
import { createManualClock } from "../src/state/clock.js";
import {
  checkResuppliedSecrets,
  compareReadSet,
  createPlanStore,
  fingerprintReadSet,
  readTransientSecrets,
  stripTransientSecrets,
} from "../src/state/plans.js";
import { createReferenceStore, referenceLifetimes } from "../src/state/references.js";
import { canonicalJson } from "../src/state/tokens.js";

const password = "correct-horse-battery-staple";

function planStore(now = 0) {
  const clock = createManualClock(now);
  const references = createReferenceStore({ clock });
  return { plans: createPlanStore(references, clock), references, clock };
}

const reconcileIntent = {
  intent: "reconcile_provider",
  mode: "apply",
  application: "sonarr",
  domain: "indexers",
  fields: [{ name: "baseUrl", value: "https://indexer.example.invalid" }],
  secrets: [{ name: "apiKey", value: password }],
};

describe("read-set fingerprints", () => {
  it("ignores property and key ordering so an identical read looks identical", () => {
    const left = fingerprintReadSet([
      { key: "queue-item", value: { status: "downloading", id: 7 } },
      { key: "series", value: { monitored: true } },
    ]);
    const right = fingerprintReadSet([
      { key: "series", value: { monitored: true } },
      { key: "queue-item", value: { id: 7, status: "downloading" } },
    ]);

    expect(left).toEqual(right);
    expect(compareReadSet(left, right)).toEqual({ status: "unchanged" });
  });

  it("retains no readable copy of what it fingerprinted", () => {
    const [entry] = fingerprintReadSet([{ key: "provider", value: { token: password } }]);

    expect(entry?.digest).toBeTruthy();
    expect(entry?.digest).not.toContain(password);
    expect(canonicalJson({ token: password })).toContain(password);
  });

  it("reports a changed value and a value that vanished", () => {
    const planned = fingerprintReadSet([
      { key: "status", value: "queued" },
      { key: "monitored", value: true },
    ]);

    expect(
      compareReadSet(
        planned,
        fingerprintReadSet([
          { key: "status", value: "downloading" },
          { key: "monitored", value: true },
        ]),
      ),
    ).toEqual({ status: "changed", changed: ["status"], missing: [] });

    expect(
      compareReadSet(planned, fingerprintReadSet([{ key: "status", value: "queued" }])),
    ).toEqual({ status: "changed", changed: [], missing: ["monitored"] });
  });

  it("does not treat a newly observed key as staleness", () => {
    const planned = fingerprintReadSet([{ key: "status", value: "queued" }]);
    const observed = fingerprintReadSet([
      { key: "status", value: "queued" },
      { key: "cancellable", value: true },
    ]);

    expect(compareReadSet(planned, observed)).toEqual({ status: "unchanged" });
  });
});

describe("transient secrets", () => {
  it("reads only the well-formed secrets a validated intent carried", () => {
    expect(readTransientSecrets(reconcileIntent)).toEqual([{ name: "apiKey", value: password }]);
    expect(readTransientSecrets({ secrets: "not-an-array" })).toEqual([]);
    expect(readTransientSecrets(undefined)).toEqual([]);
  });

  it("strips every secret value while retaining its name and presence", () => {
    const stripped = stripTransientSecrets(reconcileIntent);

    expect(stripped.requiredSecrets.map((secret) => secret.name)).toEqual(["apiKey"]);
    expect(stripped.requiredSecrets[0]?.presence).not.toContain(password);
    expect(JSON.stringify(stripped)).not.toContain(password);
    expect(stripped.intent).toEqual({
      intent: "reconcile_provider",
      mode: "apply",
      application: "sonarr",
      domain: "indexers",
      fields: [{ name: "baseUrl", value: "https://indexer.example.invalid" }],
    });
  });

  it("requires each named secret to be resupplied", () => {
    const { requiredSecrets } = stripTransientSecrets(reconcileIntent);

    expect(checkResuppliedSecrets(requiredSecrets, [])).toEqual({
      status: "missing",
      names: ["apiKey"],
    });
    expect(checkResuppliedSecrets(requiredSecrets, [{ name: "apiKey", value: password }])).toEqual({
      status: "satisfied",
      warnings: [],
    });
  });

  it("says so when the resupplied value is not the one the plan validated", () => {
    const { requiredSecrets } = stripTransientSecrets(reconcileIntent);
    const check = checkResuppliedSecrets(requiredSecrets, [{ name: "apiKey", value: "rotated" }]);

    expect(check.status).toBe("satisfied");
    expect(check.status === "satisfied" && check.warnings).toEqual([
      "the resupplied apiKey differs from the value the plan validated",
    ]);
  });
});

describe("plan store", () => {
  it("records the intent, effects, and read set behind an opaque reference", () => {
    const { plans } = planStore(5_000);
    const record = plans.record({
      tool: "arr_config_reconcile",
      variant: "reconcile_provider",
      applications: ["sonarr"],
      intent: reconcileIntent,
      requestedEffects: [
        { application: "sonarr", severity: "consequential", summary: "update the indexer" },
      ],
      predictedEffects: [],
      warnings: ["the indexer will be re-tested"],
      observations: [{ key: "provider", value: { id: 3, name: "Example" } }],
    });

    expect(record.reference.startsWith("pln_")).toBe(true);
    expect(record.createdAt).toBe(5_000);
    expect(record.expiresAt).toBe(5_000 + referenceLifetimes.plan);
    expect(record.readSet).toHaveLength(1);
    expect(record.requiredSecrets.map((secret) => secret.name)).toEqual(["apiKey"]);

    const resolved = plans.resolve(record.reference);
    expect(resolved).toEqual({ ok: true, record });
  });

  it("never retains a secret value in the record or in any serialization of it", () => {
    const { plans, references } = planStore();
    const record = plans.record({
      tool: "arr_config_reconcile",
      variant: "reconcile_provider",
      applications: ["sonarr"],
      intent: reconcileIntent,
      requestedEffects: [],
      predictedEffects: [],
      warnings: [],
      observations: [],
    });

    expect(JSON.stringify(record)).not.toContain(password);
    const resolved = references.resolve(record.reference, "plan");
    expect(JSON.stringify(resolved)).not.toContain(password);
    expect(canonicalJson(record)).not.toContain(password);
  });

  it("expires and rejects a reference of another kind", () => {
    const { plans, references, clock } = planStore(0);
    const record = plans.record({
      tool: "arr_job_cancel",
      variant: undefined,
      applications: ["sonarr"],
      intent: { mode: "apply" },
      requestedEffects: [],
      predictedEffects: [],
      warnings: [],
      observations: [],
    });
    const job = references.mint({
      kind: "job",
      applications: ["sonarr"],
      payload: () => ({ kind: "domain", snapshot: { upstreamId: "1", fingerprint: "x" } }),
    });

    expect(plans.resolve(job.reference)).toEqual({ ok: false, reason: "wrong_kind" });

    clock.advance(referenceLifetimes.plan);
    expect(plans.resolve(record.reference)).toEqual({ ok: false, reason: "expired" });
  });
});
