import { describe, expect, it } from "vitest";
import type { QueueItem } from "../src/adapters/activity/model.js";
import { runActivityQuery } from "../src/adapters/activity/service.js";
import {
  compileQueueTransition,
  compileQueueTransitions,
  describeVersionRefusal,
  flagMinimumVersions,
  type ObservedQueueItem,
  pendingQueueIntents,
  type QueueResolveIntent,
  type QueueTransition,
  type QueueTransitionCompilation,
  queueIntentItemKind,
  queueResolveIntents,
  type ReplacementSearch,
  trackedQueueIntents,
} from "../src/adapters/activity/transitions.js";
import type { MediaApplication } from "../src/adapters/library/model.js";
import { compareToMinimumVersion, parseVersionSegments } from "../src/adapters/version.js";
import { type ApplicationId, describeApplication } from "../src/applications.js";
import { createManualClock } from "../src/state/clock.js";
import { createReferenceStore } from "../src/state/references.js";
import {
  mintQueueReference,
  type QueueReferenceContext,
  resolveQueueReference,
} from "../src/tools/activity-references.js";
import { activityFixture, expectOk, paging, queueItems } from "./support/activity.js";
import { jsonResponse, libraryHarness, type UpstreamCall } from "./support/library.js";

/**
 * The queue transition compiler.
 *
 * Every assertion here runs with no instance in the loop, which is the point:
 * compilation is pure, so the exact request each intent would send can be held
 * to a literal shape rather than inferred from what a fake instance was asked.
 * The one test that does reach a fake instance is the canary, because what it
 * proves — that nothing upstream-authored survives the trip from a queue row to
 * a compiled transition — needs a real upstream payload to start from.
 */

const versions: Readonly<Record<MediaApplication, string>> = {
  sonarr: describeApplication("sonarr").minimumVersion,
  radarr: describeApplication("radarr").minimumVersion,
};

function tracked(
  application: MediaApplication,
  overrides: Partial<ObservedQueueItem> = {},
): ObservedQueueItem {
  return {
    application,
    queueItemId: application === "sonarr" ? 502 : 602,
    itemKind: "tracked_download",
    status: "completed",
    trackedState: "import_blocked",
    mediaId: application === "sonarr" ? 12 : 9,
    ...overrides,
  };
}

function pending(
  application: MediaApplication,
  overrides: Partial<ObservedQueueItem> = {},
): ObservedQueueItem {
  return {
    application,
    queueItemId: application === "sonarr" ? 503 : 603,
    itemKind: "pending_release",
    status: application === "sonarr" ? "delay" : "fallback",
    mediaId: application === "sonarr" ? 13 : 10,
    ...overrides,
  };
}

/** The row an intent is valid for, so a shape test is never blocked on kind. */
function observedFor(application: MediaApplication, intent: QueueResolveIntent): ObservedQueueItem {
  return queueIntentItemKind(intent) === "tracked_download"
    ? tracked(application)
    : pending(application);
}

function compile(
  application: ApplicationId,
  intent: QueueResolveIntent,
  observed: ObservedQueueItem,
  options: { replacementSearch?: ReplacementSearch; version?: string } = {},
): QueueTransitionCompilation {
  return compileQueueTransition({
    application,
    version: options.version ?? versions[observed.application],
    intent,
    observed,
    ...(options.replacementSearch === undefined
      ? {}
      : { replacementSearch: options.replacementSearch }),
  });
}

function expectCompiled(compilation: QueueTransitionCompilation): QueueTransition {
  if (compilation.status !== "compiled") {
    throw new Error(
      `Expected a compiled transition, got ${compilation.error.code}: ${compilation.error.message}`,
    );
  }
  return compilation.transition;
}

function expectRejected(compilation: QueueTransitionCompilation) {
  if (compilation.status !== "rejected") {
    throw new Error("Expected the intent to be rejected");
  }
  return compilation.error;
}

function summaries(transition: QueueTransition): string {
  return transition.effects.map((effect) => effect.summary).join(" | ");
}

/**
 * The reviewed request shape for every intent.
 *
 * Sonarr and Radarr compile identically at the versions this project supports —
 * the same route, the same method, and the same four flags — so the table is
 * written once and asserted against both. It is a literal rather than a
 * derivation on purpose: a change to the mapping has to be made here as well,
 * where it is read as a request rather than as a branch.
 */
const reviewedShapes: readonly {
  readonly intent: QueueResolveIntent;
  readonly replacementSearch?: ReplacementSearch;
  readonly action: Record<string, unknown>;
}[] = [
  {
    intent: "ignore_tracking",
    action: {
      kind: "upstream",
      method: "DELETE",
      path: "queue/{id}",
      query: {
        removeFromClient: false,
        blocklist: false,
        skipRedownload: true,
        changeCategory: false,
      },
    },
  },
  {
    intent: "remove_from_client_and_delete_data",
    action: {
      kind: "upstream",
      method: "DELETE",
      path: "queue/{id}",
      query: {
        removeFromClient: true,
        blocklist: false,
        skipRedownload: true,
        changeCategory: false,
      },
    },
  },
  {
    intent: "blocklist_and_remove",
    replacementSearch: "allow",
    action: {
      kind: "upstream",
      method: "DELETE",
      path: "queue/{id}",
      query: {
        removeFromClient: true,
        blocklist: true,
        skipRedownload: false,
        changeCategory: false,
      },
    },
  },
  {
    intent: "blocklist_and_remove",
    replacementSearch: "suppress",
    action: {
      kind: "upstream",
      method: "DELETE",
      path: "queue/{id}",
      query: {
        removeFromClient: true,
        blocklist: true,
        skipRedownload: true,
        changeCategory: false,
      },
    },
  },
  {
    intent: "change_category_mark_imported",
    action: {
      kind: "upstream",
      method: "DELETE",
      path: "queue/{id}",
      query: {
        removeFromClient: false,
        blocklist: false,
        skipRedownload: true,
        changeCategory: true,
      },
    },
  },
  {
    intent: "force_pending_grab",
    action: { kind: "upstream", method: "POST", path: "queue/grab/{id}", query: {} },
  },
  {
    intent: "remove_pending",
    action: {
      kind: "upstream",
      method: "DELETE",
      path: "queue/{id}",
      query: {
        removeFromClient: false,
        blocklist: false,
        skipRedownload: true,
        changeCategory: false,
      },
    },
  },
  {
    intent: "blocklist_pending",
    action: {
      kind: "upstream",
      method: "DELETE",
      path: "queue/{id}",
      query: {
        removeFromClient: false,
        blocklist: true,
        skipRedownload: true,
        changeCategory: false,
      },
    },
  },
];

describe("queue transition compilation", () => {
  it.each(["sonarr", "radarr"] as const)(
    "compiles each intent to its one reviewed request shape on %s",
    (application) => {
      for (const shape of reviewedShapes) {
        const observed = observedFor(application, shape.intent);
        const transition = expectCompiled(
          compile(application, shape.intent, observed, {
            ...(shape.replacementSearch === undefined
              ? {}
              : { replacementSearch: shape.replacementSearch }),
          }),
        );

        expect(transition.application).toBe(application);
        expect(transition.itemKind).toBe(queueIntentItemKind(shape.intent));
        expect(transition.action).toEqual({
          ...shape.action,
          path: String(shape.action.path).replace("{id}", String(observed.queueItemId)),
        });
      }
    },
  );

  it("routes a manual import to inspection instead of sending anything upstream", () => {
    const transition = expectCompiled(
      compile("sonarr", "route_to_manual_import", tracked("sonarr")),
    );

    expect(transition.action).toEqual({
      kind: "inspect",
      tool: "arr_import_inspect",
      variant: "queue_item",
      queueItemId: 502,
      mediaId: 12,
    });
    expect(transition.effects.every((effect) => effect.severity === "informational")).toBe(true);
    expect(transition.warnings.join(" ")).toContain("sends nothing upstream");
  });

  it("reaches no flag combination other than the reviewed ones", () => {
    const compiled = new Set<string>();
    const choices: readonly (ReplacementSearch | undefined)[] = [undefined, "allow", "suppress"];

    for (const application of ["sonarr", "radarr"] as const) {
      for (const intent of queueResolveIntents) {
        for (const replacementSearch of choices) {
          const compilation = compile(application, intent, observedFor(application, intent), {
            ...(replacementSearch === undefined ? {} : { replacementSearch }),
          });
          if (compilation.status !== "compiled") {
            continue;
          }
          const action = compilation.transition.action;
          if (action.kind === "upstream" && action.method === "DELETE") {
            compiled.add(JSON.stringify(action.query));
          }
        }
      }
    }

    // Every one of the sixteen combinations the endpoint accepts is enumerated,
    // and the ones this project has not reviewed have to be unreachable rather
    // than merely unused: an intent that could compile to one would show up
    // here as a combination outside the reviewed set.
    const reachable = new Set(
      reviewedShapes
        .map((shape) => shape.action.query as Record<string, boolean>)
        .filter((query) => Object.keys(query).length > 0)
        .map((query) => JSON.stringify(query)),
    );
    expect([...compiled].sort()).toEqual([...reachable].sort());

    const every: string[] = [];
    for (const removeFromClient of [false, true]) {
      for (const blocklist of [false, true]) {
        for (const skipRedownload of [false, true]) {
          for (const changeCategory of [false, true]) {
            every.push(
              JSON.stringify({ removeFromClient, blocklist, skipRedownload, changeCategory }),
            );
          }
        }
      }
    }
    expect(every.filter((combination) => compiled.has(combination))).toHaveLength(compiled.size);
    expect(compiled.size).toBeLessThan(every.length);
  });
});

describe("queue item kind validation", () => {
  it("rejects a pending intent on a tracked download before any upstream action", () => {
    for (const intent of pendingQueueIntents) {
      const error = expectRejected(compile("sonarr", intent, tracked("sonarr")));
      expect(error.code).toBe("invalid_input");
      expect(error.message).toContain("pending release");
      expect(error.message).toContain("tracked download");
    }
  });

  it("rejects a tracked intent on a pending release", () => {
    for (const intent of trackedQueueIntents) {
      const error = expectRejected(compile("radarr", intent, pending("radarr")));
      expect(error.code).toBe("invalid_input");
      expect(error.message).toContain("pending release");
    }
  });

  it("refuses an observed row whose kind and status disagree", () => {
    // The kind is a function of the status everywhere this project derives one,
    // so a pair that disagrees is a defect rather than a caller error — and it
    // is exactly the pair that would smuggle a pending-only intent onto a
    // tracked download.
    const error = expectRejected(
      compile("sonarr", "force_pending_grab", {
        ...tracked("sonarr"),
        itemKind: "pending_release",
      }),
    );
    expect(error.code).toBe("invalid_input");
    expect(error.message).toContain("kind its status does not support");
  });

  it("refuses a row that names another application or no single record", () => {
    expect(
      expectRejected(
        compileQueueTransition({
          application: "radarr",
          version: versions.radarr,
          intent: "ignore_tracking",
          observed: tracked("sonarr"),
        }),
      ).message,
    ).toContain("different application");

    expect(
      expectRejected(compile("sonarr", "ignore_tracking", tracked("sonarr", { queueItemId: 0 })))
        .code,
    ).toBe("invalid_input");
  });
});

describe("values that crossed an untyped boundary", () => {
  /**
   * The compiler is exported, so its arguments can arrive from somewhere the
   * published schema never validated. Each case below is a word outside the
   * closed set it belongs to, cast in because that is exactly the situation the
   * guard exists for: the type system is what is missing in the case under
   * test.
   */
  const canary = "SUPPLIED-VALUE-a1b2c3";

  function compileWith(overrides: Record<string, unknown>): QueueTransitionCompilation {
    return compileQueueTransition({
      application: "sonarr",
      version: versions.sonarr,
      intent: "ignore_tracking",
      observed: tracked("sonarr"),
      ...overrides,
    } as Parameters<typeof compileQueueTransition>[0]);
  }

  it.each([
    ["application", { application: canary }],
    ["observed application", { observed: { ...tracked("sonarr"), application: canary } }],
    ["intent", { intent: canary }],
    ["item kind", { observed: { ...tracked("sonarr"), itemKind: canary } }],
    ["status", { observed: { ...tracked("sonarr"), status: canary } }],
    ["tracked state", { observed: { ...tracked("sonarr"), trackedState: canary } }],
    ["replacement-search choice", { intent: "blocklist_and_remove", replacementSearch: canary }],
  ])("refuses an unrecognized %s without repeating what it was given", (_name, overrides) => {
    const error = expectRejected(compileWith(overrides));

    expect(error.code).toBe("invalid_input");
    // Neither half of the error may carry the value back: a word nothing
    // validated could be anything at all, including a credential.
    expect(JSON.stringify(error)).not.toContain(canary);
    expect(error.application).toBeUndefined();
  });

  it("never compiles an unrecognized replacement-search choice as an allowed search", () => {
    // The failure this guards is silent and one-directional: a value that is
    // neither word would otherwise compile as `allow` and start the very search
    // a caller supplying it may have been trying to suppress.
    const compilation = compileWith({
      intent: "blocklist_and_remove",
      replacementSearch: "definitely-not-a-choice",
    });

    expect(compilation.status).toBe("rejected");
  });

  it("does not name an unrecognized application even when the selection is empty", () => {
    const batch = compileQueueTransitions({
      application: canary,
      version: versions.sonarr,
      intent: "ignore_tracking",
      items: [],
    } as unknown as Parameters<typeof compileQueueTransitions>[0]);

    if (batch.status !== "rejected") {
      throw new Error("Expected the empty selection to be refused");
    }
    expect(JSON.stringify(batch.error)).not.toContain(canary);
    expect(batch.error.message).toContain("at least one queue item");
  });
});

describe("impossible intent combinations", () => {
  it("requires an explicit replacement-search choice to blocklist and remove", () => {
    const error = expectRejected(compile("sonarr", "blocklist_and_remove", tracked("sonarr")));

    expect(error.code).toBe("invalid_input");
    expect(error.message).toContain("allow or suppress");
  });

  it("refuses a replacement-search choice on an intent that requests no search", () => {
    for (const intent of queueResolveIntents) {
      if (intent === "blocklist_and_remove") {
        continue;
      }
      const error = expectRejected(
        compile("sonarr", intent, observedFor("sonarr", intent), { replacementSearch: "suppress" }),
      );
      expect(error.code).toBe("invalid_input");
      expect(error.message).toContain("no replacement-search choice");
    }
  });

  it("refuses to import or re-categorize a download that has not finished", () => {
    for (const status of ["queued", "downloading", "paused"] as const) {
      const observed = tracked("sonarr", { status, trackedState: "downloading" });
      for (const intent of ["route_to_manual_import", "change_category_mark_imported"] as const) {
        expect(expectRejected(compile("sonarr", intent, observed)).code).toBe("conflict");
      }
      // The intents that do not depend on a finished payload stay available.
      expect(expectCompiled(compile("sonarr", "ignore_tracking", observed)).intent).toBe(
        "ignore_tracking",
      );
    }
  });

  it("refuses to import or re-categorize a download whose status could not be read", () => {
    // `unknown` is what an upstream status word this server does not recognize
    // maps onto. It is not evidence the download finished, and treating it as
    // such is how an unfinished download would be marked imported.
    const observed = tracked("sonarr", { status: "unknown", trackedState: "unknown" });

    for (const intent of ["route_to_manual_import", "change_category_mark_imported"] as const) {
      const error = expectRejected(compile("sonarr", intent, observed));
      expect(error.code).toBe("conflict");
      expect(error.message).toContain("could not be established");
    }
    expect(expectCompiled(compile("sonarr", "ignore_tracking", observed)).intent).toBe(
      "ignore_tracking",
    );
  });

  it("refuses a manual import while the download client is unreachable", () => {
    const error = expectRejected(
      compile(
        "radarr",
        "route_to_manual_import",
        tracked("radarr", { status: "download_client_unavailable", trackedState: "unknown" }),
      ),
    );

    expect(error.code).toBe("conflict");
    expect(error.message).toContain("download client is unreachable");
  });

  it("refuses an application with no managed-download queue", () => {
    const error = expectRejected(
      compileQueueTransition({
        application: "prowlarr",
        version: describeApplication("prowlarr").minimumVersion,
        intent: "ignore_tracking",
        observed: tracked("sonarr"),
      }),
    );

    expect(error.code).toBe("unsupported_capability");
    expect(error.message).toContain("no managed-download queue");
  });

  it("passes a flag only on an instance at or above the release it was reviewed against", () => {
    for (const version of ["4.0.0", "4.0.19.2979", "5.1.0.1", "6.0.0-develop"]) {
      expect(
        expectCompiled(
          compile("sonarr", "change_category_mark_imported", tracked("sonarr"), { version }),
        ).intent,
      ).toBe("change_category_mark_imported");
    }
  });

  it("refuses a flag on an instance older than the release it was reviewed against", () => {
    // `4.0` is deliberately absent: a missing trailing segment counts as zero,
    // so it meets a 4.0.0 minimum rather than falling below it.
    for (const version of ["3.0.10.1567", "3.9.9.9999", "1.0.0.1"]) {
      const error = expectRejected(
        compile("sonarr", "change_category_mark_imported", tracked("sonarr"), { version }),
      );
      expect(error.code).toBe("unsupported_capability");
      expect(error.message).toContain("sonarr 4.0.0 or newer");
      expect(error.message).not.toContain("could not be read");
    }

    // The two intents that carry no delete flag are unaffected by the table.
    expect(
      expectCompiled(
        compile("sonarr", "route_to_manual_import", tracked("sonarr"), { version: "3.0.10.1567" }),
      ).intent,
    ).toBe("route_to_manual_import");
    expect(
      expectCompiled(
        compile("sonarr", "force_pending_grab", pending("sonarr"), { version: "3.0.10.1567" }),
      ).intent,
    ).toBe("force_pending_grab");
  });

  it("refuses a flag on an instance whose reported version cannot be read", () => {
    // The gate fails closed. An unreadable version establishes nothing: the
    // instance may support the flag and may not, and sending it anyway would be
    // acting on a version nobody could parse. Every flag-bearing intent is
    // checked, because the gate is per flag rather than per intent.
    for (const version of ["nightly", "", "   ", "v", "unversioned"]) {
      for (const intent of [
        "ignore_tracking",
        "remove_from_client_and_delete_data",
        "change_category_mark_imported",
        "remove_pending",
        "blocklist_pending",
      ] as const) {
        const error = expectRejected(
          compile("sonarr", intent, observedFor("sonarr", intent), { version }),
        );
        expect(error.code).toBe("unsupported_capability");
        expect(error.message).toContain("could not be read");
      }

      expect(
        expectRejected(
          compile("radarr", "blocklist_and_remove", tracked("radarr"), {
            version,
            replacementSearch: "allow",
          }),
        ).message,
      ).toContain("radarr 5.0.0 or newer");
    }
  });

  it("blames this repository, not the instance, for a minimum it cannot read", () => {
    // The one branch the table cannot reach, and the reason the refusal is a
    // function rather than one string with a clause appended. A minimum is
    // authored in this repository, so a minimum that will not parse is our
    // defect — and an operator sent to inspect a healthy instance for it would
    // be looking at the wrong system entirely.
    const refusal = describeVersionRefusal("sonarr", "unreadable_minimum", "not-a-version");

    expect(refusal).toContain("defect in this server");
    expect(refusal).not.toContain("this instance reported");
    expect(refusal).not.toContain("or newer");
    // The unreadable minimum is repository-authored, but there is no reason to
    // echo it either: the message says where to look without it.
    expect(refusal).not.toContain("not-a-version");
  });

  it("blames the instance only for a version the instance reported", () => {
    const reported = describeVersionRefusal("sonarr", "unreadable_reported", "4.0.0");
    const below = describeVersionRefusal("radarr", "below", "5.0.0");

    expect(reported).toContain("this instance reported a version that could not be read");
    expect(reported).toContain("sonarr 4.0.0 or newer");
    expect(below).toBe("this intent needs radarr 5.0.0 or newer");
    expect(below).not.toContain("could not be read");
    expect(describeVersionRefusal("sonarr", "meets", "4.0.0")).toBeUndefined();
  });

  it("keeps every recorded flag minimum readable, so the defect branch stays unreachable", () => {
    // The companion to the test above: it proves the message is right if the
    // table ever went wrong, and this proves the table has not.
    for (const support of flagMinimumVersions) {
      for (const [application, minimum] of Object.entries(support.minimums)) {
        expect(parseVersionSegments(minimum)).toBeDefined();
        expect(compareToMinimumVersion(minimum, minimum)).toBe("meets");
        expect(application).toMatch(/^(sonarr|radarr)$/u);
      }
    }
  });

  it("does not quote an unreadable version back in the refusal", () => {
    // The instance's own version string is upstream text this server did not
    // author, and a capability message is not a place to repeat one. The value
    // is distinctive rather than a short word, so the assertion cannot pass on
    // a substring that any English sentence would contain.
    const error = expectRejected(
      compile("sonarr", "ignore_tracking", tracked("sonarr"), {
        version: "build-CANARY-4f21-from-the-instance",
      }),
    );

    expect(error.code).toBe("unsupported_capability");
    expect(JSON.stringify(error)).not.toContain("CANARY");
  });

  it("still compiles the two flagless intents when the version cannot be read", () => {
    // They send no delete flag, so there is nothing the table vouches for and
    // nothing to fail closed on. Refusing them would be the mirror error:
    // failing closed on a question that was never asked.
    expect(
      expectCompiled(
        compile("sonarr", "route_to_manual_import", tracked("sonarr"), { version: "nightly" }),
      ).intent,
    ).toBe("route_to_manual_import");
    expect(
      expectCompiled(
        compile("sonarr", "force_pending_grab", pending("sonarr"), { version: "nightly" }),
      ).intent,
    ).toBe("force_pending_grab");
  });
});

describe("disclosed effects", () => {
  it("discloses client data deletion for every intent that removes from the client", () => {
    for (const compilation of [
      compile("sonarr", "remove_from_client_and_delete_data", tracked("sonarr")),
      compile("sonarr", "blocklist_and_remove", tracked("sonarr"), {
        replacementSearch: "suppress",
      }),
    ]) {
      const transition = expectCompiled(compilation);
      expect(summaries(transition)).toContain("delete the data it downloaded");
      expect(transition.effects.some((effect) => effect.severity === "destructive")).toBe(true);
    }
  });

  it("states whether a blocklisting will be followed by a replacement search", () => {
    expect(
      summaries(
        expectCompiled(
          compile("radarr", "blocklist_and_remove", tracked("radarr"), {
            replacementSearch: "allow",
          }),
        ),
      ),
    ).toContain("search for a replacement");

    expect(
      summaries(
        expectCompiled(
          compile("radarr", "blocklist_and_remove", tracked("radarr"), {
            replacementSearch: "suppress",
          }),
        ),
      ),
    ).toContain("no replacement search is requested");
  });

  it("never claims a pending release removes anything from a download client", () => {
    for (const intent of pendingQueueIntents) {
      const transition = expectCompiled(compile("sonarr", intent, pending("sonarr")));
      expect(summaries(transition)).not.toContain("download client");
      if (intent !== "force_pending_grab") {
        expect(transition.warnings.join(" ")).toContain("no download-client item");
      }
    }
  });

  it("says that ignoring and re-categorizing leave the payload where it is", () => {
    for (const intent of ["ignore_tracking", "change_category_mark_imported"] as const) {
      const transition = expectCompiled(compile("sonarr", intent, tracked("sonarr")));
      expect(summaries(transition)).not.toContain("delete");
      expect(transition.warnings.join(" ")).toContain("download client");
    }
  });

  it("names an effect for every application it was compiled against", () => {
    for (const application of ["sonarr", "radarr"] as const) {
      for (const intent of queueResolveIntents) {
        const compilation = compile(application, intent, observedFor(application, intent), {
          ...(intent === "blocklist_and_remove" ? { replacementSearch: "suppress" as const } : {}),
        });
        const transition = expectCompiled(compilation);
        expect(transition.effects.length).toBeGreaterThan(0);
        expect(transition.effects.every((effect) => effect.application === application)).toBe(true);
        expect(transition.effects.every((effect) => effect.summary.length > 0)).toBe(true);
      }
    }
  });
});

describe("bulk compilation", () => {
  it("compiles each selected row independently and reports each outcome", () => {
    const batch = compileQueueTransitions({
      application: "sonarr",
      version: versions.sonarr,
      intent: "ignore_tracking",
      items: [
        { reference: "que_first", observed: tracked("sonarr") },
        // A pending release under a tracked intent: refused on its own without
        // deciding anything about the rows beside it.
        { reference: "que_second", observed: pending("sonarr") },
        { reference: "que_third", observed: tracked("sonarr", { queueItemId: 504 }) },
      ],
    });

    if (batch.status !== "compiled") {
      throw new Error("Expected the selection to compile");
    }
    expect(batch.items.map((item) => [item.reference, item.compilation.status])).toEqual([
      ["que_first", "compiled"],
      ["que_second", "rejected"],
      ["que_third", "compiled"],
    ]);

    const third = expectCompiled(batch.items[2]?.compilation as QueueTransitionCompilation);
    expect(third.action).toMatchObject({ path: "queue/504" });
  });

  it("reports a per-row reason even when every row is refused", () => {
    const batch = compileQueueTransitions({
      application: "radarr",
      version: versions.radarr,
      intent: "force_pending_grab",
      items: [
        { reference: "que_a", observed: tracked("radarr") },
        { reference: "que_b", observed: tracked("radarr", { queueItemId: 0 }) },
      ],
    });

    if (batch.status !== "compiled") {
      throw new Error("Expected the selection to compile");
    }
    const messages = batch.items.map((item) => expectRejected(item.compilation).message);
    expect(messages[0]).toContain("pending release");
    expect(messages[1]).toContain("no single queue record");
    expect(messages[0]).not.toBe(messages[1]);
  });

  it("refuses an empty selection as the one whole-call failure", () => {
    const batch = compileQueueTransitions({
      application: "sonarr",
      version: versions.sonarr,
      intent: "ignore_tracking",
      items: [],
    });

    if (batch.status !== "rejected") {
      throw new Error("Expected the empty selection to be refused");
    }
    expect(batch.error.code).toBe("invalid_input");
    expect(batch.error.message).toContain("at least one queue item");
  });
});

/**
 * The value that must never survive the trip from a queue row to a compiled
 * transition. It is planted in every upstream field that carries a path, a
 * download-client identifier, or free text, so a compiler that started
 * interpolating any of them would be caught here rather than assumed safe.
 */
const canary = "CANARY-QUEUE-SECRET-91";

async function observedFromInstance(): Promise<{
  item: QueueItem;
  context: QueueReferenceContext;
}> {
  const body = await activityFixture<{ records: Record<string, unknown>[] }>("sonarr", "queue");
  const records = body.records.map((record) => ({
    ...record,
    title: `${String(record.title)} ${canary}`,
    downloadId: canary,
    outputPath: `/downloads/${canary}/payload`,
    errorMessage: `failed at /downloads/${canary}`,
    statusMessages: [{ title: canary, messages: [`could not import /downloads/${canary}`] }],
  }));

  const harness = libraryHarness("sonarr", (call: UpstreamCall) =>
    jsonResponse({
      page: Number(call.url.searchParams.get("page") ?? "1"),
      pageSize: records.length,
      totalRecords: records.length,
      records,
    }),
  );
  const outcome = await runActivityQuery("sonarr", harness.client, {
    view: "queue",
    detail: "full",
    paging: paging(),
  });
  // The blocked import rather than the first tracked row: it is the state every
  // tracked intent is valid in, so one row exercises all five.
  const item = queueItems(expectOk(outcome).data).find(
    (candidate) => candidate.evidence.trackedState === "import_blocked",
  );
  if (item === undefined) {
    throw new Error("The queue fixture holds no blocked tracked download");
  }

  const store = createReferenceStore({ clock: createManualClock(1_000) });
  const resolved = resolveQueueReference(store, mintQueueReference(store, item), "sonarr");
  if (!resolved.ok) {
    throw new Error(`Expected the minted reference to resolve: ${resolved.error.message}`);
  }
  return { item, context: resolved.value };
}

describe("compilation from an observed instance", () => {
  it("compiles from a resolved queue reference and leaks nothing it was read from", async () => {
    const { item, context } = await observedFromInstance();

    // The resolved reference is the observed row, without restatement: this
    // assignment is the check that the two shapes cannot drift apart.
    const observed: ObservedQueueItem = context;
    expect(observed.queueItemId).toBe(item.context.queueItemId);
    expect(observed.itemKind).toBe(item.kind);

    for (const intent of trackedQueueIntents) {
      const compilation = compile("sonarr", intent, observed, {
        ...(intent === "blocklist_and_remove" ? { replacementSearch: "allow" as const } : {}),
      });
      const serialized = JSON.stringify(expectCompiled(compilation));

      expect(serialized).not.toContain(canary);
      expect(serialized).not.toContain("/downloads");
      expect(serialized).not.toContain(item.title);
    }
  });

  it("compiles a pending release read from the same instance", async () => {
    const body = await activityFixture<{ records: Record<string, unknown>[] }>("sonarr", "queue");
    const harness = libraryHarness("sonarr", () =>
      jsonResponse({ page: 1, pageSize: 10, totalRecords: body.records.length, ...body }),
    );
    const outcome = await runActivityQuery("sonarr", harness.client, {
      view: "queue",
      detail: "summary",
      paging: paging(),
    });
    const item = queueItems(expectOk(outcome).data).find(
      (candidate) => candidate.kind === "pending_release",
    );
    if (item === undefined) {
      throw new Error("The queue fixture holds no pending release");
    }

    const transition = expectCompiled(
      compile("sonarr", "force_pending_grab", {
        application: "sonarr",
        queueItemId: item.context.queueItemId,
        itemKind: item.kind,
        status: item.evidence.status,
        mediaId: item.context.mediaId,
      }),
    );
    expect(transition.action).toEqual({
      kind: "upstream",
      method: "POST",
      path: `queue/grab/${String(item.context.queueItemId)}`,
      query: {},
    });
  });
});
