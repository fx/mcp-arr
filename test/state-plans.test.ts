import { describe, expect, it } from "vitest";
import { createManualClock } from "../src/state/clock.js";
import { compareReadSet, createPlanStore, fingerprintReadSet } from "../src/state/plans.js";
import { createReferenceStore, referenceLifetimes } from "../src/state/references.js";
import { canonicalJson } from "../src/state/tokens.js";

const password = "correct-horse-battery-staple";

function planStore(now = 0) {
  const clock = createManualClock(now);
  const references = createReferenceStore({ clock });
  return { plans: createPlanStore(references, clock), references, clock };
}

const monitoringIntent = {
  intent: "set_monitoring",
  mode: "apply",
  items: ["med_00000001"],
  monitored: true,
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

describe("plan store", () => {
  it("records the intent, effects, and read set behind an opaque reference", () => {
    const { plans } = planStore(5_000);
    const record = plans.record({
      tool: "arr_library_change",
      variant: "set_monitoring",
      applications: ["sonarr"],
      intent: monitoringIntent,
      requestedEffects: [
        { application: "sonarr", severity: "consequential", summary: "monitor the series" },
      ],
      predictedEffects: [],
      warnings: ["the series will be searched"],
      observations: [{ key: "provider", value: { id: 3, name: "Example" } }],
    });

    expect(record.reference.startsWith("pln_")).toBe(true);
    expect(record.createdAt).toBe(5_000);
    expect(record.expiresAt).toBe(5_000 + referenceLifetimes.plan);
    expect(record.readSet).toHaveLength(1);
    expect(record.intent).toEqual(monitoringIntent);

    const resolved = plans.resolve(record.reference);
    expect(resolved).toEqual({ ok: true, record });
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
