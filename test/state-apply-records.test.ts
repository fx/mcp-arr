import { describe, expect, it } from "vitest";
import {
  type ApplyRecordStore,
  applyIntentKey,
  createApplyRecordStore,
} from "../src/state/apply-records.js";
import { createManualClock, type ManualClock } from "../src/state/clock.js";
import { createReferenceStore } from "../src/state/references.js";
import { createToolError } from "../src/tools/errors.js";

const intent = {
  intent: "set_monitoring",
  mode: "apply",
  items: ["med_00000001"],
  monitored: true,
};

const begin = {
  tool: "arr_library_change",
  variant: "set_monitoring",
  application: "sonarr",
} as const;

const rejection = createToolError({
  code: "upstream_rejection",
  message: "sonarr: the application rejected the request",
  application: "sonarr",
});

const lostAnswer = createToolError({
  code: "timeout",
  message: "sonarr: the request timed out",
  application: "sonarr",
});

function store(now = 0): { applies: ApplyRecordStore; clock: ManualClock } {
  const clock = createManualClock(now);
  return { applies: createApplyRecordStore(createReferenceStore({ clock }), clock), clock };
}

describe("apply intent keys", () => {
  it("distinguishes tool, variant, application, and arguments", () => {
    const base = applyIntentKey({ ...begin, intent });

    expect(applyIntentKey({ ...begin, intent })).toBe(base);
    expect(applyIntentKey({ ...begin, application: "radarr", intent })).not.toBe(base);
    expect(applyIntentKey({ ...begin, variant: "delete_media", intent })).not.toBe(base);
    expect(applyIntentKey({ ...begin, intent: { ...intent, monitored: false } })).not.toBe(base);
  });

  it("ignores how the caller arrived at the apply", () => {
    // A planned apply replays the intent the plan recorded, whose own `mode`
    // still says `plan`. Both routes must resolve to the same receipt.
    expect(applyIntentKey({ ...begin, intent })).toBe(
      applyIntentKey({ ...begin, intent: { ...intent, mode: "plan" } }),
    );
  });

  it("ignores every ordering the caller chose", () => {
    const base = applyIntentKey({
      ...begin,
      intent: {
        ...intent,
        items: ["med_00000001", "med_00000002"],
        secrets: [
          { name: "apiKey", value: "a" },
          { name: "password", value: "b" },
        ],
      },
    });

    // The same mutation, named in the other order. Missing this receipt would
    // send a non-idempotent mutation upstream a second time.
    expect(
      applyIntentKey({
        ...begin,
        intent: {
          ...intent,
          items: ["med_00000002", "med_00000001"],
          secrets: [
            { name: "password", value: "b" },
            { name: "apiKey", value: "a" },
          ],
        },
      }),
    ).toBe(base);

    // Naming one item twice does not ask for two mutations.
    expect(
      applyIntentKey({
        ...begin,
        intent: {
          ...intent,
          items: ["med_00000002", "med_00000001", "med_00000002"],
          secrets: [
            { name: "apiKey", value: "a" },
            { name: "password", value: "b" },
          ],
        },
      }),
    ).toBe(base);
  });

  it("reorders nested collections too, not just the top-level ones", () => {
    const ordered = {
      intent: "edit_media",
      mode: "apply",
      items: ["med_00000001"],
      changes: { tags: { add: ["cfg_00000001", "cfg_00000002"] } },
    };
    const reordered = {
      ...ordered,
      changes: { tags: { add: ["cfg_00000002", "cfg_00000001"] } },
    };

    expect(applyIntentKey({ ...begin, intent: ordered })).toBe(
      applyIntentKey({ ...begin, intent: reordered }),
    );
  });

  it("still separates two genuinely different collections", () => {
    const one = applyIntentKey({ ...begin, intent: { ...intent, items: ["med_00000001"] } });
    const two = applyIntentKey({
      ...begin,
      intent: { ...intent, items: ["med_00000001", "med_00000002"] },
    });
    const other = applyIntentKey({ ...begin, intent: { ...intent, items: ["med_00000003"] } });

    expect(new Set([one, two, other]).size).toBe(3);
  });
});

describe("apply record store", () => {
  it("creates the record before the mutation is sent", () => {
    const { applies } = store(1_000);
    const attempt = applies.begin({ ...begin, intent });

    expect(attempt.status).toBe("proceed");
    expect(attempt.record.state).toBe("applying");
    expect(attempt.record.attempts).toBe(1);
    expect(attempt.record.startedAt).toBe(1_000);
    expect(attempt.record.reference.startsWith("apl_")).toBe(true);
    expect(applies.resolve(attempt.record.reference)).toEqual({ ok: true, record: attempt.record });
  });

  it("replays the existing record rather than authorizing a second mutation", () => {
    const { applies } = store();
    const first = applies.begin({ ...begin, intent });
    applies.settle(first.record.reference, { status: "succeeded", job: "job_00000001" });

    const second = applies.begin({ ...begin, intent });

    expect(second.status).toBe("replayed");
    expect(second.record.reference).toBe(first.record.reference);
    expect(second.record.state).toBe("succeeded");
    expect(second.record.attempts).toBe(1);
  });

  it("replays a record whose outcome is unknown instead of resending blindly", () => {
    const { applies } = store();
    const first = applies.begin({ ...begin, intent });
    applies.settle(first.record.reference, { status: "outcome_unknown", error: lostAnswer });

    const second = applies.begin({ ...begin, intent });

    expect(second.status).toBe("replayed");
    expect(second.record.state).toBe("outcome_unknown");
    expect(second.record.error?.code).toBe("timeout");
  });

  it("allows a fresh attempt only after upstream demonstrably refused", () => {
    const { applies, clock } = store(0);
    const first = applies.begin({ ...begin, intent });
    applies.settle(first.record.reference, { status: "failed", error: rejection });

    clock.advance(500);
    const second = applies.begin({ ...begin, intent });

    expect(second.status).toBe("proceed");
    expect(second.record.reference).toBe(first.record.reference);
    expect(second.record.state).toBe("applying");
    expect(second.record.attempts).toBe(2);
    expect(second.record.startedAt).toBe(500);
    expect(second.record.error).toBeUndefined();
  });

  it("settles into exactly one of the four states", () => {
    const { applies, clock } = store(0);
    const outcomes = [
      { settlement: { status: "succeeded" } as const, expected: "succeeded" },
      { settlement: { status: "failed", error: rejection } as const, expected: "failed" },
      {
        settlement: { status: "outcome_unknown", error: lostAnswer } as const,
        expected: "outcome_unknown",
      },
    ];

    for (const [index, outcome] of outcomes.entries()) {
      const attempt = applies.begin({ ...begin, intent: { ...intent, monitored: index } });
      clock.advance(10);
      const settled = applies.settle(attempt.record.reference, outcome.settlement);

      expect(settled?.state).toBe(outcome.expected);
      expect(settled?.settledAt).toBe(clock.now());
    }
  });

  it("reconciles an unknown outcome against authoritative upstream state", async () => {
    const { applies } = store();
    const attempt = applies.begin({ ...begin, intent });
    applies.settle(attempt.record.reference, { status: "outcome_unknown", error: lostAnswer });

    const reconciled = await applies.reconcile(attempt.record.reference, async () => ({
      status: "succeeded",
      job: "job_00000002",
    }));

    expect(reconciled.status).toBe("reconciled");
    expect(reconciled.status === "reconciled" && reconciled.record.state).toBe("succeeded");
    expect(reconciled.status === "reconciled" && reconciled.record.job).toBe("job_00000002");
    expect(reconciled.status === "reconciled" && reconciled.record.error).toBeUndefined();
  });

  it("leaves the record unknown when upstream cannot answer either", async () => {
    const { applies } = store();
    const attempt = applies.begin({ ...begin, intent });
    applies.settle(attempt.record.reference, { status: "outcome_unknown", error: lostAnswer });

    const reconciled = await applies.reconcile(attempt.record.reference, async () => ({
      status: "indeterminate",
    }));

    expect(reconciled.status).toBe("indeterminate");
    expect(applies.resolve(attempt.record.reference)).toMatchObject({
      ok: true,
      record: { state: "outcome_unknown" },
    });
  });

  it("never re-opens a record that already has a settled outcome", async () => {
    const { applies } = store();
    let readerCalls = 0;
    const reader = async () => {
      readerCalls += 1;
      return { status: "failed", error: rejection } as const;
    };

    const applying = applies.begin({ ...begin, intent });
    expect((await applies.reconcile(applying.record.reference, reader)).status).toBe(
      "not_applicable",
    );

    applies.settle(applying.record.reference, { status: "succeeded" });
    expect((await applies.reconcile(applying.record.reference, reader)).status).toBe(
      "not_applicable",
    );
    expect(readerCalls).toBe(0);
  });

  it("keeps every receipt a repeat still has to be answered from", () => {
    const clock = createManualClock(0);
    const references = createReferenceStore({ clock, maxDurableEntries: 1 });
    const applies = createApplyRecordStore(references, clock);
    const unsettled = ["applying", "succeeded", "outcome_unknown"] as const;

    const kept = unsettled.map((state, index) => {
      const attempt = applies.begin({ ...begin, intent: { ...intent, monitored: index } });
      if (state !== "applying") {
        applies.settle(
          attempt.record.reference,
          state === "succeeded"
            ? { status: "succeeded" }
            : { status: "outcome_unknown", error: lostAnswer },
        );
      }
      return attempt.record.reference;
    });

    // The ceiling is one, and three receipts are held anyway: evicting any of
    // them would let its identical apply send the mutation a second time.
    for (const [index, reference] of kept.entries()) {
      const resolved = applies.resolve(reference);
      expect(resolved.ok, unsettled[index]).toBe(true);
      expect(applies.begin({ ...begin, intent: { ...intent, monitored: index } }).status).toBe(
        "replayed",
      );
    }
  });

  it("drops a refused receipt, which a repeat is allowed to re-send anyway", () => {
    const clock = createManualClock(0);
    const references = createReferenceStore({ clock, maxDurableEntries: 1 });
    const applies = createApplyRecordStore(references, clock);

    const refused = applies.begin({ ...begin, intent });
    applies.settle(refused.record.reference, { status: "failed", error: rejection });
    applies.begin({ ...begin, intent: { ...intent, monitored: false } });

    const again = applies.begin({ ...begin, intent });
    expect(applies.resolve(refused.record.reference).ok).toBe(false);
    expect(again.status).toBe("proceed");
    expect(again.record.reference).not.toBe(refused.record.reference);
  });

  it("keeps a concurrent settlement from being overwritten by reconciliation", async () => {
    const { applies } = store();
    const attempt = applies.begin({ ...begin, intent });
    applies.settle(attempt.record.reference, { status: "outcome_unknown", error: lostAnswer });

    const reconciled = await applies.reconcile(attempt.record.reference, async () => {
      // Something else observed the mutation itself while the reader was
      // observing only its aftermath.
      applies.settle(attempt.record.reference, { status: "failed", error: rejection });
      return { status: "succeeded" };
    });

    expect(reconciled.status).toBe("not_applicable");
    expect(applies.resolve(attempt.record.reference)).toMatchObject({
      ok: true,
      record: { state: "failed" },
    });
  });

  it("reports a reference it never issued rather than inventing a record", async () => {
    const { applies } = store();

    expect(applies.resolve("apl_neverissuedneverissued")).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(
      await applies.reconcile("job_00000001", async () => ({ status: "indeterminate" })),
    ).toEqual({ status: "unresolved", reason: "wrong_kind" });
  });
});
