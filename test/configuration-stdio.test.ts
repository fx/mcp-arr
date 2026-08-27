import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import type { ApplicationId } from "../src/applications.js";
import {
  configObserveOutputSchema,
  configReconcileOutputSchema,
} from "../src/tools/schemas/configuration.js";
import {
  type FixtureInstance,
  instanceEnvironment,
  startFixtureInstance,
} from "./support/instance-server.js";
import {
  assertCleanProtocolStdout,
  type SpawnedStdioProcess,
  spawnBuiltServer,
} from "./support/spawned-stdio.js";

/**
 * The configuration tools over the protocol, against a running instance
 * double.
 *
 * These assert the things only the wire can show. That a caller receives an
 * opaque reference and never an upstream row number; that a desired-state write
 * is one `PUT` carrying the whole recorded resource; that a provider test is a
 * separate request that stores nothing and is disclosed before it is made; and
 * that a plan reference applied later reaches the same instance through the
 * same validation. The adapters' own tests cover what is sent — this covers
 * that the published contract, the references, and the receipts hold once the
 * server is the one making the calls.
 */

const started: FixtureInstance[] = [];

async function instance(
  application: ApplicationId,
  options: Parameters<typeof startFixtureInstance>[1] = {},
): Promise<FixtureInstance> {
  const running = await startFixtureInstance(application, options);
  started.push(running);
  return running;
}

afterEach(async () => {
  await Promise.all(started.splice(0).map((running) => running.close()));
});

interface CallResult {
  result?: {
    isError?: boolean;
    content?: Array<{ type: string; text?: string }>;
    structuredContent?: unknown;
  };
}

interface ObserveEnvelope {
  readonly status: string;
  readonly applications: readonly {
    readonly application: string;
    readonly status: string;
    readonly data?: {
      readonly family: string;
      readonly domain: string;
      readonly records: readonly {
        readonly reference: string;
        readonly name?: string;
        readonly secrets: readonly { readonly name: string; readonly state: string }[];
        readonly tags?: readonly string[];
      }[];
    };
    readonly error?: { readonly code: string };
  }[];
}

interface ReconcileEnvelope {
  readonly status: string;
  readonly mutation?: {
    readonly plan?: string;
    readonly requestedEffects?: readonly unknown[];
    readonly predictedEffects?: readonly unknown[];
    readonly receipt?: { readonly state: string };
  };
  readonly applications: readonly {
    readonly application: string;
    readonly status: string;
    readonly data?: unknown;
    readonly warnings?: readonly string[];
    readonly error?: { readonly code: string };
  }[];
}

async function observe(
  child: SpawnedStdioProcess,
  id: number,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; envelope: ObserveEnvelope; summary: string }> {
  const called = (await child.request(id, "tools/call", {
    name: "arr_config_observe",
    arguments: args,
  })) as CallResult;
  const structured = called.result?.structuredContent;
  expect(configObserveOutputSchema.safeParse(structured).success, String(args.domain)).toBe(true);
  expect(called.result?.content?.[0]?.type).toBe("text");
  return {
    isError: called.result?.isError === true,
    envelope: structured as ObserveEnvelope,
    summary: called.result?.content?.[0]?.text ?? "",
  };
}

async function reconcile(
  child: SpawnedStdioProcess,
  id: number,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; envelope: ReconcileEnvelope; summary: string }> {
  const called = (await child.request(id, "tools/call", {
    name: "arr_config_reconcile",
    arguments: args,
  })) as CallResult;
  const structured = called.result?.structuredContent;
  expect(configReconcileOutputSchema.safeParse(structured).success, String(args.intent)).toBe(true);
  expect(called.result?.content?.[0]?.type).toBe("text");
  return {
    isError: called.result?.isError === true,
    envelope: structured as ReconcileEnvelope,
    summary: called.result?.content?.[0]?.text ?? "",
  };
}

function onlyOutcome<TOutcome>(outcomes: readonly TOutcome[]): TOutcome {
  const first = outcomes[0];
  if (outcomes.length !== 1 || first === undefined) {
    throw new Error(`Expected exactly one application outcome, got ${outcomes.length}`);
  }
  return first;
}

describe("arr_config_observe over stdio", () => {
  it("answers each family with references rather than upstream identifiers", async () => {
    const sonarr = await instance("sonarr");
    const child = spawnBuiltServer(instanceEnvironment([sonarr]), 10_000);

    try {
      await child.initializeSession(1, LATEST_PROTOCOL_VERSION);

      // One domain per family, which is what the three reconciliation rules are
      // divided by: a provider with dynamic fields, an ordered profile, and a
      // flat resource.
      const provider = onlyOutcome(
        (await observe(child, 2, { domain: "indexers", applications: ["sonarr"] })).envelope
          .applications,
      );
      const profile = onlyOutcome(
        (await observe(child, 3, { domain: "quality_profiles", applications: ["sonarr"] })).envelope
          .applications,
      );
      const resource = onlyOutcome(
        (await observe(child, 4, { domain: "tags", applications: ["sonarr"] })).envelope
          .applications,
      );

      expect([provider.status, profile.status, resource.status]).toEqual(["ok", "ok", "ok"]);
      expect(provider.data?.family).toBe("provider");
      expect(profile.data?.family).toBe("profile");
      expect(resource.data?.family).toBe("resource");

      const indexer = provider.data?.records[0];
      expect(indexer?.reference).toMatch(/^cfg_/u);
      // The credential the recorded indexer holds is acknowledged and never
      // carried: this is the same claim the adapter makes, made again where the
      // answer has crossed a transport.
      expect(indexer?.secrets.map((secret) => secret.name)).toContain("apiKey");
      expect(JSON.stringify(provider.data)).not.toContain("CANARY");
      // A tag a provider carries is a reference too, and it is the same one the
      // tags domain answers with.
      // A tag a provider carries is a reference too. It is a token of the same
      // kind rather than the same token: references are minted per call, so two
      // calls name one row twice without either naming the row itself.
      expect(indexer?.tags?.every((tag) => tag.startsWith("cfg_"))).toBe(true);
      expect(resource.data?.records.every((record) => record.reference.startsWith("cfg_"))).toBe(
        true,
      );

      await child.terminateGracefully();
      assertCleanProtocolStdout(child.stdout);
      expect(child.stderr).toBe("");
      expect(child.stdout).not.toContain(sonarr.apiKey);
    } finally {
      await child.forceCleanup().catch(() => undefined);
    }
  });

  it("carries no upstream identifier across the transport", async () => {
    const sonarr = await instance("sonarr");
    const child = spawnBuiltServer(instanceEnvironment([sonarr]), 10_000);

    try {
      await child.initializeSession(1, LATEST_PROTOCOL_VERSION);
      const observed = await observe(child, 2, {
        domain: "indexers",
        detail: "full",
        applications: ["sonarr"],
      });
      const outcome = onlyOutcome(observed.envelope.applications);

      // The recorded indexer is row 1 upstream. The published record names it
      // only by token, so the serialized answer carries no `"id"` at all.
      expect(JSON.stringify(outcome.data)).not.toContain('"id"');
      expect(outcome.data?.records.every((record) => record.reference.startsWith("cfg_"))).toBe(
        true,
      );

      await child.terminateGracefully();
      assertCleanProtocolStdout(child.stdout);
    } finally {
      await child.forceCleanup().catch(() => undefined);
    }
  });
});

describe("arr_config_reconcile over stdio", () => {
  async function indexerReference(child: SpawnedStdioProcess, id: number): Promise<string> {
    const observed = await observe(child, id, { domain: "indexers", applications: ["sonarr"] });
    const reference = onlyOutcome(observed.envelope.applications).data?.records[0]?.reference;
    if (reference === undefined) {
      throw new Error("Expected the recorded indexer to be observed");
    }
    return reference;
  }

  it("plans a desired state, applies the plan, and sends one whole resource", async () => {
    const sonarr = await instance("sonarr");
    const child = spawnBuiltServer(instanceEnvironment([sonarr]), 10_000);

    try {
      await child.initializeSession(1, LATEST_PROTOCOL_VERSION);
      const target = await indexerReference(child, 2);

      const planned = await reconcile(child, 3, {
        intent: "reconcile_provider",
        mode: "plan",
        application: "sonarr",
        domain: "indexers",
        target,
        fields: [{ name: "priority", value: 30 }],
      });
      expect(planned.isError).toBe(false);
      const plan = planned.envelope.mutation?.plan;
      expect(plan).toMatch(/^pln_/u);
      expect(planned.envelope.mutation?.requestedEffects?.length).toBeGreaterThan(0);
      // Planning sends nothing: the instance has been read and not written.
      expect(sonarr.requests.filter((route) => route === "indexer/1")).toHaveLength(1);

      const applied = await reconcile(child, 4, { mode: "apply", plan });
      expect(applied.isError).toBe(false);
      expect(applied.envelope.mutation?.receipt?.state).toBe("succeeded");

      const written = sonarr.writes.filter((write) => write.method === "PUT");
      expect(written).toHaveLength(1);
      const body = written[0]?.body as { priority?: number; fields?: readonly unknown[] };
      expect(body.priority).toBe(30);
      // The whole recorded resource went back, credential and unknown fields
      // included, which is what a full-resource update has to send.
      expect(body.fields).toHaveLength(5);
      expect(JSON.stringify(body)).toContain("CANARY-SONARR-INDEXER-APIKEY-0001");

      await child.terminateGracefully();
      assertCleanProtocolStdout(child.stdout);
      expect(child.stdout).not.toContain(sonarr.apiKey);
    } finally {
      await child.forceCleanup().catch(() => undefined);
    }
  });

  it("discloses what a provider test reaches before it runs it", async () => {
    const sonarr = await instance("sonarr");
    const child = spawnBuiltServer(instanceEnvironment([sonarr]), 10_000);

    try {
      await child.initializeSession(1, LATEST_PROTOCOL_VERSION);
      const target = await indexerReference(child, 2);

      const planned = await reconcile(child, 3, {
        intent: "test_provider",
        mode: "plan",
        application: "sonarr",
        domain: "indexers",
        target,
      });
      expect(planned.isError).toBe(false);
      const effects = planned.envelope.mutation?.requestedEffects ?? [];
      expect(JSON.stringify(effects)).toContain("contact");
      // Planning a test does not run it.
      expect(sonarr.providerTests).toHaveLength(0);

      const applied = await reconcile(child, 4, {
        intent: "test_provider",
        mode: "apply",
        application: "sonarr",
        domain: "indexers",
        target,
      });
      expect(applied.isError).toBe(false);
      expect(sonarr.providerTests).toHaveLength(1);
      // A test stores nothing: the only write this instance saw is the test.
      expect(sonarr.writes.filter((write) => write.method === "PUT")).toEqual([]);

      await child.terminateGracefully();
      assertCleanProtocolStdout(child.stdout);
    } finally {
      await child.forceCleanup().catch(() => undefined);
    }
  });

  it("saves over warnings with the parameter that skips them", async () => {
    // The instance raises a warning rather than a failure, which is the one
    // case a bypass exists for. The save then carries the parameter, and the
    // result says plainly which checks were skipped.
    const sonarr = await instance("sonarr", {
      providerTestObjections: [
        { isWarning: true, propertyName: "apiPath", errorMessage: "unusual path" },
      ],
    });
    const child = spawnBuiltServer(instanceEnvironment([sonarr]), 10_000);

    try {
      await child.initializeSession(1, LATEST_PROTOCOL_VERSION);
      const target = await indexerReference(child, 2);

      const applied = await reconcile(child, 3, {
        intent: "force_provider_save",
        mode: "apply",
        application: "sonarr",
        domain: "indexers",
        target,
        fields: [{ name: "priority", value: 30 }],
        acceptValidationWarnings: true,
      });

      expect(applied.isError).toBe(false);
      // The provider was tested with the resource the save would send, not the
      // one the instance already had: the test body carries the new priority.
      expect(sonarr.providerTests).toHaveLength(1);
      expect((sonarr.providerTests[0]?.body as { priority?: number }).priority).toBe(30);
      const write = sonarr.writes.filter((entry) => entry.method === "PUT")[0];
      expect(write).toBeDefined();
      // Read from what the instance actually received: the parameter is on the
      // save's own request, and only there.
      const saved = sonarr.searches.filter((entry) => entry.route === "indexer/1");
      expect(saved.some((entry) => entry.query.get("forceSave") === "true")).toBe(true);
      expect(JSON.stringify(applied.envelope.applications[0]?.warnings)).toContain("skipped");

      await child.terminateGracefully();
      assertCleanProtocolStdout(child.stdout);
    } finally {
      await child.forceCleanup().catch(() => undefined);
    }
  });

  it("refuses a bypass the instance's objections do not justify", async () => {
    // The instance answers the test with a failure rather than a warning. A
    // bypass overrides warnings and only warnings, so this is refused however
    // explicitly it was asked for.
    const sonarr = await instance("sonarr", {
      providerTestObjections: [
        { isWarning: false, propertyName: "apiKey", errorMessage: "rejected" },
      ],
    });
    const child = spawnBuiltServer(instanceEnvironment([sonarr]), 10_000);

    try {
      await child.initializeSession(1, LATEST_PROTOCOL_VERSION);
      const target = await indexerReference(child, 2);

      const applied = await reconcile(child, 3, {
        intent: "force_provider_save",
        mode: "apply",
        application: "sonarr",
        domain: "indexers",
        target,
        fields: [{ name: "priority", value: 30 }],
        acceptValidationWarnings: true,
      });

      expect(applied.isError).toBe(true);
      expect(onlyOutcome(applied.envelope.applications).error?.code).toBe("upstream_rejection");
      expect(sonarr.writes.filter((write) => write.method === "PUT")).toEqual([]);

      await child.terminateGracefully();
      assertCleanProtocolStdout(child.stdout);
    } finally {
      await child.forceCleanup().catch(() => undefined);
    }
  });

  it("reports an intent it has not implemented rather than pretending", async () => {
    const sonarr = await instance("sonarr");
    const child = spawnBuiltServer(instanceEnvironment([sonarr]), 10_000);

    try {
      await child.initializeSession(1, LATEST_PROTOCOL_VERSION);
      const target = await indexerReference(child, 2);

      const deleted = await reconcile(child, 3, {
        intent: "delete_provider",
        mode: "apply",
        application: "sonarr",
        domain: "indexers",
        target,
      });

      expect(deleted.isError).toBe(true);
      expect(onlyOutcome(deleted.envelope.applications).error?.code).toBe("unsupported_capability");
      expect(sonarr.writes).toEqual([]);

      await child.terminateGracefully();
      assertCleanProtocolStdout(child.stdout);
    } finally {
      await child.forceCleanup().catch(() => undefined);
    }
  });
});
