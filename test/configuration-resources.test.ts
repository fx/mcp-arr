import { describe, expect, it } from "vitest";
import {
  ConfigurationResourceSet,
  captureUpstreamResource,
  type UpstreamValue,
} from "../src/adapters/configuration/resources.js";
import { fixtureBody } from "./support/library.js";

/**
 * The internal representation is what a later full-resource write sends back,
 * so these tests are about one property: nothing is lost, and nothing that is
 * kept can escape by accident.
 */

const upstreamRecord: UpstreamValue = {
  id: 7,
  name: "Example Private Tracker",
  // A field no version of this server knows about, of the kind a newer provider
  // definition adds. A full-resource update rebuilt without it would erase it.
  unknownFutureSetting: { nested: [1, "two", false, null] },
  fields: [
    { name: "apiKey", value: "CANARY-ROUNDTRIP-0101" },
    { name: "minimumSeeders", value: 2 },
  ],
};

describe("lossless upstream capture", () => {
  it("round-trips a payload including the fields nothing here understands", () => {
    const resource = captureUpstreamResource("prowlarr", "indexers", upstreamRecord);

    expect(resource.payload()).toEqual(upstreamRecord);
    expect(resource.id).toBe(7);
    expect(resource.application).toBe("prowlarr");
    expect(resource.domain).toBe("indexers");
  });

  /**
   * One recorded payload is enough here, because losslessness is a property of
   * the capture rather than of any particular body. That every *other* recorded
   * provider payload also survives internally is asserted where it matters — in
   * the leakage suite, which checks each planted marker reaches the internal
   * side and none reaches the model-facing one.
   */
  it("round-trips a recorded upstream payload unchanged", async () => {
    const body = await fixtureBody<readonly UpstreamValue[]>("prowlarr", "indexer");
    const captured = body.map((record) =>
      captureUpstreamResource("prowlarr", "indexers", record).payload(),
    );

    expect(captured).toEqual(body);
    expect(body.length).toBeGreaterThan(1);
  });

  it("hands out a copy, so one write's edits never become the next read's state", () => {
    const resource = captureUpstreamResource("sonarr", "indexers", upstreamRecord);
    const first = resource.payload() as Record<string, unknown>;
    first.name = "edited";
    (first.fields as Record<string, unknown>[])[0] = { name: "apiKey", value: "replaced" };

    expect(resource.payload()).toEqual(upstreamRecord);
  });

  it("stores a frozen copy, so the payload it holds is nobody else's to change", () => {
    const source: Record<string, unknown> = {
      id: 7,
      fields: [{ name: "apiKey", value: "CANARY-ROUNDTRIP-0101" }],
    };
    const resource = captureUpstreamResource("sonarr", "indexers", source as UpstreamValue);
    source.name = "added after capture";
    (source.fields as Record<string, unknown>[])[0] = { name: "apiKey", value: "changed" };

    expect(resource.payload()).toEqual({
      id: 7,
      fields: [{ name: "apiKey", value: "CANARY-ROUNDTRIP-0101" }],
    });
    // The copy handed out is the caller's to edit; the stored one never is.
    expect(Object.isFrozen(resource.payload())).toBe(false);
  });

  it("reports no identifier for a payload that carries none", () => {
    expect(captureUpstreamResource("sonarr", "tags", { label: "example" }).id).toBeUndefined();
    expect(captureUpstreamResource("sonarr", "tags", { id: "1" }).id).toBeUndefined();
    expect(captureUpstreamResource("sonarr", "tags", { id: 1.5 }).id).toBeUndefined();
    expect(captureUpstreamResource("sonarr", "tags", ["not-a-record"]).id).toBeUndefined();
  });
});

describe("the internal resource set", () => {
  const set = new ConfigurationResourceSet("prowlarr", "indexers", [
    captureUpstreamResource("prowlarr", "indexers", upstreamRecord),
  ]);

  it("serializes to a census rather than to the payloads it holds", () => {
    const serialized = JSON.stringify(set);

    expect(serialized).not.toContain("CANARY-ROUNDTRIP-0101");
    expect(JSON.parse(serialized)).toEqual({
      application: "prowlarr",
      domain: "indexers",
      size: 1,
    });
    // Enumerating it — spreading it into a result envelope is the realistic
    // accident — reaches no payload either.
    expect(Object.keys({ ...set })).toEqual(["application", "domain"]);
  });

  it("reaches a payload only through a deliberate call", () => {
    expect(set.size).toBe(1);
    expect(set.list()).toHaveLength(1);
    expect(set.find(7)?.payload()).toEqual(upstreamRecord);
    expect(set.find(8)).toBeUndefined();
  });
});
