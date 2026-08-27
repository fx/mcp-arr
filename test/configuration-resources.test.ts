import { describe, expect, it } from "vitest";
import {
  ConfigurationResourceSet,
  captureUpstreamResource,
  type UpstreamResource,
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
  it("guarantee 1: stores the payload losslessly, unknown fields included", () => {
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
  it("guarantee 1: round-trips a recorded upstream payload unchanged", async () => {
    const body = await fixtureBody<readonly UpstreamValue[]>("prowlarr", "indexer");
    const captured = body.map((record) =>
      captureUpstreamResource("prowlarr", "indexers", record).payload(),
    );

    expect(captured).toEqual(body);
    expect(body.length).toBeGreaterThan(1);
  });

  it("guarantee 2: hands out a copy, so one write's edits are not the next read's state", () => {
    const resource = captureUpstreamResource("sonarr", "indexers", upstreamRecord);
    const first = resource.payload() as Record<string, unknown>;
    first.name = "edited";
    (first.fields as Record<string, unknown>[])[0] = { name: "apiKey", value: "replaced" };

    expect(resource.payload()).toEqual(upstreamRecord);
  });

  it("guarantee 1: stores a frozen copy the source object can no longer change", () => {
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

  /**
   * The model-facing side refuses each of these outright, in
   * `configuration-observe.test.ts`; both halves ask the same predicate, so
   * neither can start recognizing an identifier the other does not.
   */
  it("reports no identifier for a payload that carries none this adapter can use", () => {
    expect(captureUpstreamResource("sonarr", "tags", { label: "example" }).id).toBeUndefined();
    expect(captureUpstreamResource("sonarr", "tags", { id: "1" }).id).toBeUndefined();
    expect(captureUpstreamResource("sonarr", "tags", { id: 1.5 }).id).toBeUndefined();
    expect(captureUpstreamResource("sonarr", "tags", { id: Number.NaN }).id).toBeUndefined();
    expect(
      captureUpstreamResource("sonarr", "tags", { id: Number.MAX_SAFE_INTEGER + 2 }).id,
    ).toBeUndefined();
    expect(captureUpstreamResource("sonarr", "tags", ["not-a-record"]).id).toBeUndefined();
  });
});

describe("the internal resource set", () => {
  const set = new ConfigurationResourceSet("prowlarr", "indexers", [
    captureUpstreamResource("prowlarr", "indexers", upstreamRecord),
  ]);

  it("guarantee 6: serializes to a census, and enumeration reaches no payload", () => {
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

  /**
   * `readonly` is a compile-time claim, and this container's whole purpose is
   * that it cannot be corrupted. These pin the runtime half: an identifier a
   * stray assignment could change would silently break `find`, and a `payload`
   * that could be replaced would substitute what a later write sends upstream.
   */
  it("guarantee 3: refuses to let a captured resource be re-pointed", () => {
    const resource = captureUpstreamResource("prowlarr", "indexers", upstreamRecord);
    const mutable = resource as unknown as Record<string, unknown>;

    expect(Object.isFrozen(resource)).toBe(true);
    expect(() => {
      mutable.id = 99;
    }).toThrow(TypeError);
    expect(() => {
      mutable.payload = () => ({ substituted: true });
    }).toThrow(TypeError);
    expect(() => {
      mutable.application = "sonarr";
    }).toThrow(TypeError);

    expect(resource.id).toBe(7);
    expect(resource.payload()).toEqual(upstreamRecord);
  });

  it("guarantee 5: cannot be reshaped, and find() still resolves afterwards", () => {
    const mutableSet = set as unknown as Record<string, unknown>;

    expect(Object.isFrozen(set)).toBe(true);
    expect(() => {
      mutableSet.application = "sonarr";
    }).toThrow(TypeError);
    // The array it hands out is frozen too, so no consumer can reorder or
    // shorten the set behind a later reconciliation's back.
    expect(Object.isFrozen(set.list())).toBe(true);
    expect(() => {
      (set.list() as UpstreamResource[]).push(
        captureUpstreamResource("prowlarr", "indexers", { id: 8 }),
      );
    }).toThrow(TypeError);

    expect(set.application).toBe("prowlarr");
    expect(set.size).toBe(1);
    expect(set.find(7)?.payload()).toEqual(upstreamRecord);
    expect(set.find(8)).toBeUndefined();
  });

  it("guarantee 3: freezes a resource it was handed, not only ones it captured", () => {
    // The constructor parameter is structural, so a caller can build its own
    // resource rather than using captureUpstreamResource, keep the reference,
    // and try to swap what find() matches on afterwards.
    const forged = {
      application: "prowlarr",
      domain: "indexers",
      id: 7,
      payload: () => ({ id: 7 }),
    } as unknown as UpstreamResource;
    const held = new ConfigurationResourceSet("prowlarr", "indexers", [forged]);
    const mutableForged = forged as unknown as Record<string, unknown>;

    expect(Object.isFrozen(forged)).toBe(true);
    expect(() => {
      mutableForged.id = 99;
    }).toThrow(TypeError);
    expect(() => {
      mutableForged.payload = () => ({ substituted: true });
    }).toThrow(TypeError);

    expect(held.find(7)?.payload()).toEqual({ id: 7 });
    expect(held.find(99)).toBeUndefined();
  });

  it("guarantee 4: rejects a resource belonging to another application or domain", () => {
    const foreignApplication = captureUpstreamResource("sonarr", "indexers", { id: 1 });
    const foreignDomain = captureUpstreamResource("prowlarr", "tags", { id: 1 });

    expect(
      () => new ConfigurationResourceSet("prowlarr", "indexers", [foreignApplication]),
    ).toThrow(RangeError);
    expect(() => new ConfigurationResourceSet("prowlarr", "indexers", [foreignDomain])).toThrow(
      /prowlarr\/indexers resource set cannot hold a prowlarr\/tags resource/u,
    );
    // Rejected outright rather than filtered: a set that silently dropped it
    // would report a size nobody asked for, and one that silently kept it would
    // answer find() from rows the census does not describe.
    expect(
      () =>
        new ConfigurationResourceSet("prowlarr", "indexers", [
          captureUpstreamResource("prowlarr", "indexers", { id: 1 }),
          foreignDomain,
        ]),
    ).toThrow(RangeError);
  });

  it("guarantee 5: copies the array, so the caller's own handle cannot change it", () => {
    const resources = [captureUpstreamResource("prowlarr", "indexers", upstreamRecord)];
    const copied = new ConfigurationResourceSet("prowlarr", "indexers", resources);
    resources.push(captureUpstreamResource("prowlarr", "indexers", { id: 8 }));

    expect(copied.size).toBe(1);
    expect(copied.find(8)).toBeUndefined();
  });
});
