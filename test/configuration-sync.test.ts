import { beforeAll, describe, expect, it } from "vitest";
import {
  type ApplicationSyncOutcome,
  type ApplicationSyncRequest,
  describeSelection,
  planSyncEffects,
  readSyncLevel,
  readSyncObservation,
  runApplicationSync,
  type SyncEffectKind,
  selects,
  syncCapabilities,
  syncCommandName,
  syncLevels,
  upstreamSyncLevel,
} from "../src/adapters/configuration/sync.js";
import { fixtureBody, jsonResponse, libraryHarness, type UpstreamCall } from "./support/library.js";

/**
 * Prowlarr application synchronization, against the recorded fixtures.
 *
 * The recorded instance carries one mapping at each level — a full-sync mapping
 * with no tags, an add-only mapping tagged for movies, and a disabled one — and
 * four indexers, one of them tagged and one of them disabled. That is enough for
 * every selection rule and every level transition to be exercised against real
 * recorded payloads rather than against records invented per test.
 */

const fixtures: Record<string, unknown> = {};

beforeAll(async () => {
  for (const route of ["applications", "indexer", "tag"]) {
    fixtures[route] = await fixtureBody("prowlarr", route);
  }
});

function body(route: string): unknown {
  const value = fixtures[route];
  if (value === undefined) {
    throw new Error(`Missing loaded fixture for prowlarr ${route}`);
  }
  return value;
}

function records(route: string): Record<string, unknown>[] {
  return structuredClone(body(route)) as Record<string, unknown>[];
}

interface InstanceOptions {
  /** Replaces one recorded collection, for a test that needs different state. */
  readonly collections?: Readonly<Record<string, unknown>> | undefined;
  /** Routes that answer with a status instead of their body. */
  readonly failing?: Readonly<Record<string, number>> | undefined;
  /** Drops the connection on writes, as an instance whose answer was lost does. */
  readonly loseWriteAnswers?: boolean | undefined;
  /**
   * Accepts a write and then keeps answering reads with the stored record, as
   * an instance that took the request and did not store it does.
   */
  readonly ignoreWrites?: boolean | undefined;
}

interface Instance {
  readonly calls: UpstreamCall[];
  readonly writes: { route: string; body: Record<string, unknown> }[];
  run(request: ApplicationSyncRequest): Promise<ApplicationSyncOutcome>;
}

/**
 * A Prowlarr answering the three routes a sync decision reads, and keeping the
 * writes it accepted so a test can assert what was actually sent.
 */
function instance(options: InstanceOptions = {}): Instance {
  const collections: Record<string, unknown> = {
    applications: records("applications"),
    indexer: records("indexer"),
    tag: records("tag"),
    ...(options.collections ?? {}),
  };
  const writes: { route: string; body: Record<string, unknown> }[] = [];

  const harness = libraryHarness("prowlarr", async (call) => {
    const route = call.url.pathname.replace("/api/v1/", "");
    const failing = options.failing?.[route];
    if (failing !== undefined) {
      return jsonResponse({ message: "instance error" }, failing);
    }

    const method = call.init.method ?? "GET";
    if (method !== "GET") {
      const raw = typeof call.init.body === "string" ? call.init.body : "{}";
      writes.push({ route, body: JSON.parse(raw) as Record<string, unknown> });
      if (options.loseWriteAnswers === true) {
        throw new Error("connection reset");
      }
      return jsonResponse({ ok: true });
    }

    const single = /^applications\/(\d+)$/u.exec(route);
    if (single !== null) {
      const id = Number(single[1]);
      const written =
        options.ignoreWrites === true
          ? undefined
          : [...writes].reverse().find((write) => write.route === route)?.body;
      const stored = (collections.applications as Record<string, unknown>[]).find(
        (record) => record.id === id,
      );
      const answer = written ?? stored;
      return answer === undefined
        ? jsonResponse({ message: "not found" }, 404)
        : jsonResponse(answer);
    }

    const stored = collections[route];
    return stored === undefined
      ? jsonResponse({ message: "not found" }, 404)
      : jsonResponse(stored);
  });

  return {
    calls: harness.calls,
    writes,
    run: (request) => runApplicationSync("prowlarr", harness.client, request),
  };
}

function request(overrides: Partial<ApplicationSyncRequest> = {}): ApplicationSyncRequest {
  return { targets: [1], syncLevel: "full_sync", startSync: false, mode: "plan", ...overrides };
}

function effectsOf(outcome: ApplicationSyncOutcome, kind: SyncEffectKind): readonly string[] {
  if (outcome.status === "error") {
    throw new Error(`Expected a planned or applied outcome, got ${outcome.error.code}`);
  }
  return outcome.items.flatMap((item) =>
    item.effects.filter((effect) => effect.effect === kind).map((effect) => effect.name),
  );
}

function planned(outcome: ApplicationSyncOutcome) {
  if (outcome.status !== "planned") {
    throw new Error(`Expected a planned outcome, got ${outcome.status}`);
  }
  return outcome;
}

function applied(outcome: ApplicationSyncOutcome) {
  if (outcome.status !== "applied") {
    throw new Error(`Expected an applied outcome, got ${outcome.status}`);
  }
  return outcome;
}

function failed(outcome: ApplicationSyncOutcome) {
  if (outcome.status !== "error") {
    throw new Error(`Expected an error outcome, got ${outcome.status}`);
  }
  return outcome;
}

describe("sync levels", () => {
  it("names each level in both vocabularies without guessing at a third", () => {
    expect(syncLevels).toEqual(["disabled", "add_only", "full_sync"]);
    expect(syncLevels.map(upstreamSyncLevel)).toEqual(["disabled", "addOnly", "fullSync"]);
    expect(readSyncLevel("fullSync")).toBe("full_sync");
    expect(readSyncLevel("FULLSYNC")).toBe("full_sync");
    expect(readSyncLevel("full_sync")).toBe("full_sync");
    // A level this server does not model is not resolved to the nearest one:
    // every effect it reports is a claim about what a level does.
    expect(readSyncLevel("partialSync")).toBeUndefined();
    expect(readSyncLevel(null)).toBeUndefined();
  });

  it("states once what each level may do", () => {
    expect(syncCapabilities.disabled).toEqual({ adds: false, updates: false, removes: false });
    expect(syncCapabilities.add_only).toEqual({ adds: true, updates: false, removes: false });
    expect(syncCapabilities.full_sync).toEqual({ adds: true, updates: true, removes: true });
  });
});

describe("tag selection", () => {
  it("carries every enabled indexer for an untagged mapping and only the tagged ones otherwise", async () => {
    const harness = libraryHarness("prowlarr", (call) =>
      jsonResponse(body(call.url.pathname.replace("/api/v1/", ""))),
    );
    const observation = await readSyncObservation("prowlarr", harness.client);

    const untagged = observation.mappings.find((mapping) => mapping.id === 1);
    const tagged = observation.mappings.find((mapping) => mapping.id === 2);
    if (untagged === undefined || tagged === undefined) {
      throw new Error("The recorded applications fixture lost a mapping");
    }

    const carried = (mapping: typeof untagged) =>
      observation.indexers.filter((indexer) => selects(mapping, indexer)).map((one) => one.name);

    // The disabled indexer is carried by neither, which is decided once rather
    // than by each caller.
    expect(carried(untagged)).toEqual([
      "Example Indexer A",
      "Example Indexer B",
      "Example Indexer C",
    ]);
    expect(carried(tagged)).toEqual(["Example Indexer B"]);
    expect(describeSelection(untagged, observation.tagLabels)).toBe("every enabled indexer");
    expect(describeSelection(tagged, observation.tagLabels)).toBe(
      "enabled indexers tagged example-movies",
    );
  });

  it("names a tag the instance no longer labels by its identifier", async () => {
    const harness = libraryHarness("prowlarr", (call) =>
      call.url.pathname.endsWith("/tag")
        ? jsonResponse([])
        : jsonResponse(body(call.url.pathname.replace("/api/v1/", ""))),
    );
    const observation = await readSyncObservation("prowlarr", harness.client);
    const tagged = observation.mappings.find((mapping) => mapping.id === 2);
    if (tagged === undefined) {
      throw new Error("The recorded applications fixture lost a mapping");
    }

    expect(describeSelection(tagged, observation.tagLabels)).toBe("enabled indexers tagged tag 1");
  });

  it("treats an indexer with no reported enable flag as enabled", async () => {
    const indexers = records("indexer").map((record) => {
      const { enable: _dropped, ...rest } = record;
      return rest;
    });
    const harness = libraryHarness("prowlarr", (call) =>
      call.url.pathname.endsWith("/indexer")
        ? jsonResponse(indexers)
        : jsonResponse(body(call.url.pathname.replace("/api/v1/", ""))),
    );
    const observation = await readSyncObservation("prowlarr", harness.client);

    // Prowlarr omits the flag on an indexer it has never disabled, so reading
    // the omission as "disabled" would exclude every such indexer everywhere.
    expect(observation.indexers.every((indexer) => indexer.enabled)).toBe(true);
  });
});

describe("planned effects", () => {
  it("adds what a disabled mapping does not synchronize at all", async () => {
    const outcome = planned(await instance().run(request({ targets: [3] })));

    expect(effectsOf(outcome, "add")).toEqual([
      "Example Indexer A",
      "Example Indexer B",
      "Example Indexer C",
    ]);
    expect(effectsOf(outcome, "update")).toEqual([]);
    // The disabled indexer is excluded, and full sync deletes an excluded one.
    expect(effectsOf(outcome, "remove")).toEqual(["Example Indexer D"]);
  });

  it("lists the proposed removals a full-sync level would perform", async () => {
    const outcome = planned(await instance().run(request({ targets: [2] })));

    // The add-only mapping is tagged for movies, so everything outside that
    // selection is excluded — and full sync deletes an excluded indexer from
    // the application the mapping points at.
    expect(effectsOf(outcome, "remove")).toEqual([
      "Example Indexer A",
      "Example Indexer C",
      "Example Indexer D",
    ]);
    expect(effectsOf(outcome, "update")).toEqual(["Example Indexer B"]);
    expect(outcome.warnings).toEqual([
      expect.stringContaining("deletes 3 indexer(s)"),
      expect.stringContaining("no synchronization is started"),
    ]);
  });

  it("reports what a level cannot carry out as stale rather than omitting it", async () => {
    const outcome = planned(await instance().run(request({ targets: [1], syncLevel: "add_only" })));

    // Moving off full sync stops both the refreshes and the deletions. Neither
    // simply disappears: the remote keeps what it has, and a caller reading a
    // shorter list would conclude the opposite.
    expect(effectsOf(outcome, "update")).toEqual([]);
    expect(effectsOf(outcome, "remove")).toEqual([]);
    expect(effectsOf(outcome, "stale")).toEqual([
      "Example Indexer A",
      "Example Indexer B",
      "Example Indexer C",
      "Example Indexer D",
    ]);
    const first = outcome.items[0]?.effects[0];
    expect(first?.reason).toContain("never re-sends it");
  });

  it("reports an excluded indexer a level cannot delete rather than omitting it", async () => {
    // The add-only mapping stays add-only: nothing changes, and the point is
    // what the remote may already be holding that Prowlarr no longer maintains.
    const outcome = planned(await instance().run(request({ targets: [2], syncLevel: "add_only" })));

    expect(effectsOf(outcome, "remove")).toEqual([]);
    expect(effectsOf(outcome, "stale")).toEqual([
      "Example Indexer A",
      "Example Indexer B",
      "Example Indexer C",
      "Example Indexer D",
    ]);
    const excluded = outcome.items[0]?.effects.find(
      (effect) => effect.name === "Example Indexer A",
    );
    expect(excluded?.reason).toContain("outside the mapping's tag selection");
    expect(excluded?.reason).toContain("deletes nothing");
  });

  it("says a disabled level abandons everything rather than deleting it", async () => {
    const outcome = planned(await instance().run(request({ targets: [1], syncLevel: "disabled" })));

    expect(effectsOf(outcome, "remove")).toEqual([]);
    expect(effectsOf(outcome, "stale")).toHaveLength(4);
    expect(outcome.items[0]?.effects[0]?.reason).toContain("synchronizes nothing");
  });

  it("answers each named mapping on its own", async () => {
    const outcome = planned(await instance().run(request({ targets: [1, 2, 3] })));

    expect(outcome.items.map((item) => [item.name, item.currentLevel, item.changed])).toEqual([
      ["Example Series Application", "full_sync", false],
      ["Example Movie Application", "add_only", true],
      ["Example Paused Application", "disabled", true],
    ]);
    expect(outcome.items[0]?.warnings).toEqual([
      expect.stringContaining("already at the requested synchronization level"),
    ]);
  });

  it("computes an effect from the capability table rather than from the level's name", () => {
    const mapping = {
      ref: { application: "prowlarr" as const, domain: "applications" as const, id: "9" },
      id: 9,
      name: "Example",
      level: "add_only" as const,
      tagIds: [] as readonly number[],
      resource: { application: "prowlarr", domain: "applications", id: 9, payload: () => ({}) },
    };
    const indexers = [
      {
        ref: { application: "prowlarr" as const, domain: "indexers" as const, id: "1" },
        id: 1,
        name: "Example",
        enabled: true,
        tagIds: [] as readonly number[],
      },
    ];

    expect(
      planSyncEffects(mapping as never, indexers, "full_sync").map((effect) => effect.effect),
    ).toEqual(["update"]);
    expect(
      planSyncEffects(mapping as never, indexers, "add_only").map((one) => one.effect),
    ).toEqual(["stale"]);
  });
});

describe("the synchronization a level change starts", () => {
  it("discloses every mapping the started synchronization runs, not only the named one", async () => {
    const running = instance();
    const quiet = planned(await running.run(request({ targets: [2], startSync: false })));
    const loud = planned(await running.run(request({ targets: [2], startSync: true })));

    // Prowlarr's command is not addressed to a mapping: it runs all of them. A
    // plan that started one and disclosed only the named mapping would carry out
    // the deletions the untouched full-sync mapping implies, unannounced.
    expect(quiet.items.map((item) => item.name)).toEqual(["Example Movie Application"]);
    expect(loud.items.map((item) => item.name)).toEqual([
      "Example Movie Application",
      "Example Series Application",
      "Example Paused Application",
    ]);
    expect(loud.items[1]).toMatchObject({
      changed: false,
      currentLevel: "full_sync",
      desiredLevel: "full_sync",
      warnings: [expect.stringContaining("runs this mapping too")],
    });
    // And what it discloses for that mapping is what a run does to it as it
    // stands: the full-sync mapping still deletes the indexer it excludes.
    expect(loud.items[1]?.effects.filter((effect) => effect.effect === "remove")).toEqual([
      expect.objectContaining({ name: "Example Indexer D" }),
    ]);
    expect(loud.warnings[0]).toContain("deletes 4 indexer(s)");
  });

  it("refuses to start one while a mapping it would run reports an unmodelled level", async () => {
    const running = instance({
      collections: {
        applications: records("applications").map((record) =>
          record.id === 1 ? { ...record, syncLevel: "partialSync" } : record,
        ),
      },
    });

    // Mapping 1 is not named, but the command runs it, and there is no honest
    // claim to make about what an unrecognized level will do to a remote.
    expect(failed(await running.run(request({ targets: [2], startSync: true }))).error.code).toBe(
      "unsupported_capability",
    );
    // Without the command, that mapping is nobody's business.
    expect(
      planned(await running.run(request({ targets: [2], startSync: false }))).items,
    ).toHaveLength(1);
  });

  it("writes only the mappings the call named, however many it disclosed", async () => {
    const running = instance();
    const outcome = applied(
      await running.run(request({ targets: [2], mode: "apply", startSync: true })),
    );

    expect(outcome.items).toHaveLength(3);
    // Two upstream writes: the level, and the global command. Both are counted,
    // because the command is a consequential mutation of its own.
    expect(outcome.dispatched).toBe(2);
    expect(running.writes.map((write) => write.route)).toEqual(["applications/2", "command"]);
    expect(outcome.items.filter((item) => item.attempted).map((item) => item.name)).toEqual([
      "Example Movie Application",
    ]);
  });
});

describe("applying a level change", () => {
  it("writes the level over the untouched mapping and verifies what landed", async () => {
    const running = instance();
    const outcome = applied(
      await running.run(request({ targets: [2], mode: "apply", startSync: true })),
    );

    expect(outcome.dispatched).toBe(2);
    expect(outcome.items[0]).toMatchObject({ attempted: true, verified: true, changed: true });
    expect(running.writes[0]?.route).toBe("applications/2");
    // Prowlarr's own spelling of the level, written over the whole resource, so
    // the mapping's credential and its category selection survive untouched.
    expect(running.writes[0]?.body).toMatchObject({
      id: 2,
      syncLevel: "fullSync",
      configContract: "RadarrSettings",
      tags: [1],
    });
    expect(running.writes[0]?.body.fields).toEqual(
      (records("applications").find((record) => record.id === 2) as Record<string, unknown>).fields,
    );
    // The synchronization is a separate, explicitly requested push.
    expect(running.writes[1]).toMatchObject({ route: "command", body: { name: syncCommandName } });
  });

  it("starts no synchronization unless the caller asked for one", async () => {
    const running = instance();
    await running.run(request({ targets: [2], mode: "apply", startSync: false }));

    expect(running.writes.map((write) => write.route)).toEqual(["applications/2"]);
  });

  it("writes no level for a mapping already at the requested one", async () => {
    const running = instance();
    const outcome = applied(
      await running.run(request({ targets: [1], mode: "apply", startSync: false })),
    );

    expect(outcome.dispatched).toBe(0);
    expect(outcome.items[0]).toMatchObject({ attempted: false, changed: false });
    expect(running.writes).toEqual([]);
  });

  it("still starts a synchronization the caller asked for when no level moved", async () => {
    const running = instance();
    const outcome = applied(
      await running.run(request({ targets: [1], mode: "apply", startSync: true })),
    );

    // The levels were already right, so nothing was written — but the caller
    // asked for a synchronization and every effect it will carry out was
    // disclosed, so declining to start one would answer a different request.
    expect(running.writes.map((write) => write.route)).toEqual(["command"]);
    expect(outcome.dispatched).toBe(1);
    expect(outcome.items[0]).toMatchObject({ attempted: false, changed: false });
    expect(outcome.warnings.at(-1)).toContain("a synchronization was started");
  });

  it("holds the synchronization back when a level it would run is unconfirmed", async () => {
    const running = instance({ failing: { "applications/3": 500 } });
    const outcome = applied(
      await running.run(request({ targets: [2, 3], mode: "apply", startSync: true })),
    );

    // The command runs every mapping at whatever level it is actually on, so
    // starting it after a failed write would carry out one set of effects while
    // this result described another.
    expect(running.writes.map((write) => write.route)).toEqual(["applications/2"]);
    expect(outcome.dispatched).toBe(2);
    expect(outcome.warnings.at(-1)).toContain("no synchronization was started");
    expect(outcome.warnings.at(-1)).toContain("not confirmed at the requested level");
    expect(outcome.unresolved).toBeUndefined();
  });

  it("holds it back for a level that was written but did not land either", async () => {
    const stubborn = instance({ ignoreWrites: true });
    const outcome = applied(
      await stubborn.run(request({ targets: [2], mode: "apply", startSync: true })),
    );

    expect(outcome.items[0]).toMatchObject({ attempted: true, verified: false });
    expect(stubborn.writes.map((write) => write.route)).toEqual(["applications/2"]);
    expect(outcome.warnings.at(-1)).toContain("no synchronization was started");
  });

  it("says a synchronization was not started rather than that it was", async () => {
    const running = instance();
    const planning = planned(await running.run(request({ targets: [2], startSync: true })));
    const applying = applied(
      await running.run(request({ targets: [2], mode: "apply", startSync: false })),
    );

    // A plan predicts and an apply reports, and those are different sentences.
    expect(planning.warnings.at(-1)).toContain("a synchronization is started");
    expect(applying.warnings.at(-1)).toContain("no synchronization was started");
  });

  it("reports each mapping's own outcome and claims nothing about the others", async () => {
    const running = instance({ failing: { "applications/3": 500 } });
    const outcome = applied(
      await running.run(request({ targets: [2, 3], mode: "apply", startSync: false })),
    );

    // Prowlarr synchronizes each mapping separately, so a partial result is the
    // normal case: the one that worked is not withdrawn and the one that failed
    // is not hidden behind it.
    expect(outcome.dispatched).toBe(2);
    expect(outcome.items.map((item) => [item.name, item.attempted, item.error?.code])).toEqual([
      ["Example Movie Application", true, undefined],
      ["Example Paused Application", true, "unexpected_response"],
    ]);
    // The refused write is absent from what the instance accepted while the item
    // still reports it as attempted, and that difference is the point: one says
    // what was stored, the other says what was sent and may have been.
    expect(running.writes.map((write) => write.route)).toEqual(["applications/2"]);
  });

  it("reports a write whose answer was lost as attempted rather than as untried", async () => {
    const running = instance({ loseWriteAnswers: true });
    const outcome = applied(
      await running.run(request({ targets: [2], mode: "apply", startSync: false })),
    );

    // The request was sent and may well have been stored. `dispatched` counts
    // what went out rather than inferring it from the items having failed, so a
    // caller settling a receipt can tell this from a mutation that never ran.
    expect(running.writes).toHaveLength(1);
    expect(outcome.dispatched).toBe(1);
    expect(outcome.items[0]).toMatchObject({ attempted: true });
    expect(outcome.items[0]?.error?.code).toBe("unavailable_application");
  });

  it("reports a level that was written but did not land as unverified", async () => {
    // The instance accepts the write and then keeps answering with the level it
    // already had, which is what one that silently refused the change looks
    // like — and the difference is only visible by reading it back.
    const stubborn = instance({ ignoreWrites: true });
    const outcome = applied(await stubborn.run(request({ targets: [2], mode: "apply" })));

    expect(stubborn.writes).toHaveLength(1);
    // Sent and unconfirmed, rather than a success nothing observed. The write
    // is not reported as a failure either: it was accepted.
    expect(outcome.items[0]).toMatchObject({ attempted: true, verified: false });
    expect(outcome.items[0]?.error).toBeUndefined();
  });

  it("keeps a started synchronization's failure separate from the level writes", async () => {
    const running = instance({ failing: { command: 500 } });
    const outcome = applied(
      await running.run(request({ targets: [2], mode: "apply", startSync: true })),
    );

    // The levels landed; only the push this server asked for did not, and the
    // items must not be recast as failures because of it.
    expect(outcome.items[0]).toMatchObject({ attempted: true, verified: true });
    expect(outcome.items[0]?.error).toBeUndefined();
    expect(outcome.unresolved?.code).toBe("unexpected_response");
  });
});

describe("refusals and staleness", () => {
  it("refuses an application that synchronizes nothing into others", async () => {
    const harness = libraryHarness("sonarr", () => jsonResponse([]));
    const outcome = await runApplicationSync("sonarr", harness.client, request());

    expect(failed(outcome).error.code).toBe("unsupported_capability");
    expect(harness.calls).toEqual([]);
  });

  it("refuses a mapping the instance no longer reports", async () => {
    const outcome = await instance().run(request({ targets: [1, 99] }));

    expect(failed(outcome).error.code).toBe("stale_reference");
    expect(failed(outcome).dispatched).toBe(0);
  });

  it("refuses a mapping whose level this server does not model", async () => {
    const running = instance({
      collections: {
        applications: records("applications").map((record) =>
          record.id === 1 ? { ...record, syncLevel: "partialSync" } : record,
        ),
      },
    });
    const outcome = await running.run(request({ targets: [1] }));

    // There is no honest claim to make about what an unrecognized level does,
    // so the call is refused rather than described against a guess.
    expect(failed(outcome).error.code).toBe("unsupported_capability");
    expect(running.writes).toEqual([]);
  });

  it("refuses a call that names no mapping without reading anything", async () => {
    const running = instance();
    const outcome = await running.run(request({ targets: [] }));

    expect(failed(outcome).error.code).toBe("invalid_input");
    expect(running.calls).toEqual([]);
  });

  it("refuses a plan whose selection changed underneath it", async () => {
    const first = instance();
    const plan = planned(await first.run(request({ targets: [2] })));

    // An indexer is disabled after the plan proposed to keep synchronizing it,
    // which changes what the level would do to the remote.
    const second = instance({
      collections: {
        indexer: records("indexer").map((record) =>
          record.id === 2 ? { ...record, enable: false } : record,
        ),
      },
    });
    const outcome = await second.run(
      request({
        targets: [2],
        mode: "apply",
        planned: plan.observations.map((observation) => ({
          key: observation.key,
          digest: "",
        })),
      }),
    );

    expect(failed(outcome).error.code).toBe("stale_plan");
    expect(second.writes).toEqual([]);
  });

  it("refuses a plan whose disclosed names have changed", async () => {
    const first = instance();
    const plan = planned(await first.run(request({ targets: [2] })));
    const { fingerprintReadSet } = await import("../src/state/plans.js");

    // The mapping was renamed. Nothing upstream depends on its name and the
    // write would still land — but the plan named it, and applying against a
    // mapping that now describes something else is not what was approved.
    const renamed = instance({
      collections: {
        applications: records("applications").map((record) =>
          record.id === 2 ? { ...record, name: "Example Other Application" } : record,
        ),
      },
    });
    const outcome = await renamed.run(
      request({ targets: [2], mode: "apply", planned: fingerprintReadSet(plan.observations) }),
    );

    expect(failed(outcome).error.code).toBe("stale_plan");
    expect(renamed.writes).toEqual([]);

    // The same holds for an indexer this plan listed an effect for by name.
    const relabelled = instance({
      collections: {
        indexer: records("indexer").map((record) =>
          record.id === 1 ? { ...record, name: "Example Renamed Indexer" } : record,
        ),
      },
    });
    expect(
      failed(
        await relabelled.run(
          request({ targets: [2], mode: "apply", planned: fingerprintReadSet(plan.observations) }),
        ),
      ).error.code,
    ).toBe("stale_plan");
  });

  it("applies a plan whose state has not moved", async () => {
    const running = instance();
    const plan = planned(await running.run(request({ targets: [2] })));
    const { fingerprintReadSet } = await import("../src/state/plans.js");

    const outcome = applied(
      await running.run(
        request({
          targets: [2],
          mode: "apply",
          planned: fingerprintReadSet(plan.observations),
        }),
      ),
    );

    expect(outcome.items[0]).toMatchObject({ attempted: true, verified: true });
  });
});

describe("disclosure", () => {
  it("keeps the mapping's credentials out of every planned and applied field", async () => {
    const canary = "CANARY-PROWLARR-APPLICATION-APIKEY-0008";
    const running = instance();

    const plan = planned(await running.run(request({ targets: [1, 2, 3] })));
    const outcome = applied(
      await running.run(request({ targets: [2], mode: "apply", startSync: true })),
    );

    // The recorded fixture's first mapping carries its API key in the clear,
    // which is exactly what a read-modify-write has to carry back upstream and
    // exactly what nothing here may publish.
    const published = [JSON.stringify(plan), JSON.stringify(outcome)].join("\n");
    expect(published).not.toContain(canary);
    expect(published).not.toContain("example-movie-application");
    expect(published).not.toContain("apiKey");
    // It does still reach the instance, because the whole resource goes back.
    expect(JSON.stringify(running.writes)).toContain("apiKey");
  });

  it("names the effects it plans without naming an upstream identifier", async () => {
    const outcome = planned(await instance().run(request({ targets: [2] })));
    const item = outcome.items[0];

    // The references are the tool layer's to turn into opaque tokens; what the
    // adapter reports is identity and reason, not a row a caller could name.
    expect(item?.effects[0]).toMatchObject({
      indexer: { application: "prowlarr", domain: "indexers" },
      effect: "remove",
    });
    expect(item?.selection).toBe("enabled indexers tagged example-movies");
  });
});
