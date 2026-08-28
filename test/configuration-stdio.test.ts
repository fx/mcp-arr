import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import type { ApplicationId } from "../src/applications.js";
import { configObserveOutputSchema } from "../src/tools/schemas/configuration.js";
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
 * The configuration tool over the protocol, against a running instance double.
 *
 * These assert the things only the wire can show: that a caller receives an
 * opaque reference and never an upstream row number, and that a credential the
 * instance holds is acknowledged without being carried. The adapter's own tests
 * cover what is read — this covers that the published contract and the
 * references hold once the server is the one making the calls.
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
      // A tag a provider carries is a reference too, minted the same way.
      expect(indexer?.tags?.every((tag) => tag.startsWith("cfg_"))).toBe(true);
      expect(resource.data?.records.every((record) => record.reference.startsWith("cfg_"))).toBe(
        true,
      );

      // Across calls a token is not an identity: reading the same domain again
      // mints again, so two answers name one row with two tokens. A caller
      // comparing tokens between results would conclude these are different
      // rows, which is why nothing here invites it to.
      const again = onlyOutcome(
        (await observe(child, 5, { domain: "tags", applications: ["sonarr"] })).envelope
          .applications,
      );
      const first = resource.data?.records.map((record) => record.reference) ?? [];
      const second = again.data?.records.map((record) => record.reference) ?? [];
      expect(second).toHaveLength(first.length);
      expect(second.some((reference) => first.includes(reference))).toBe(false);

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
