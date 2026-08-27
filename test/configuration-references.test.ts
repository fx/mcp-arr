import { describe, expect, it } from "vitest";
import { configurationRef } from "../src/adapters/configuration/model.js";
import { createManualClock } from "../src/state/clock.js";
import { createReferenceStore } from "../src/state/references.js";
import { referenceMinter } from "../src/tools/configuration.js";

/**
 * What a configuration reference promises, in both directions.
 *
 * The two halves are asserted here rather than described in prose beside the
 * minter, because they are the difference between a caller comparing tokens
 * inside one result — which is sound — and keying a cache on one across calls,
 * which is not. A guarantee that only holds in one of the two is worth pinning
 * in the one place a reader checks when they doubt it.
 */

function minter() {
  const clock = createManualClock(0);
  const references = createReferenceStore({ clock });
  return { references, mint: referenceMinter(references) };
}

const tag = configurationRef("sonarr", "tags", 3);

describe("a configuration reference within one envelope", () => {
  it("names one row with one token, however often it appears", () => {
    const { mint } = minter();

    // The case this exists for: a tag two providers both carry, and the same
    // tag read from the tags domain in the same answer.
    expect(mint(tag)).toBe(mint(tag));
    expect(mint(configurationRef("sonarr", "tags", 3))).toBe(mint(tag));
  });

  it("keeps rows apart by application, domain, and identifier", () => {
    const { mint } = minter();
    const tokens = [
      mint(tag),
      mint(configurationRef("sonarr", "tags", 4)),
      mint(configurationRef("radarr", "tags", 3)),
      mint(configurationRef("sonarr", "indexers", 3)),
    ];

    // One identifier under another application or another domain is another
    // row, so collapsing any pair of these would name the wrong record.
    expect(new Set(tokens).size).toBe(tokens.length);
  });
});

describe("a configuration reference across envelopes", () => {
  it("mints again rather than returning the token an earlier call issued", () => {
    const { references } = minter();
    const first = referenceMinter(references)(tag);
    const second = referenceMinter(references)(tag);

    expect(first).not.toBe(second);
  });

  it("resolves both tokens to the same row, so neither invalidates the other", () => {
    const { references } = minter();
    const first = referenceMinter(references)(tag);
    const second = referenceMinter(references)(tag);

    for (const token of [first, second]) {
      const resolution = references.resolve(token, "configuration");
      expect(resolution.ok).toBe(true);
      if (!resolution.ok || resolution.entry.payload.kind !== "domain") {
        throw new Error("Expected a resolvable domain reference");
      }
      expect(resolution.entry.payload.snapshot.upstreamId).toBe("3");
      expect(resolution.entry.payload.snapshot.detail?.domain).toBe("tags");
      expect(resolution.entry.applications).toEqual(["sonarr"]);
    }
  });

  it("records the pointer vocabulary a library record uses, where there is one", () => {
    const { mint, references } = minter();
    const resolved = (token: string) => {
      const resolution = references.resolve(token, "configuration");
      if (!resolution.ok || resolution.entry.payload.kind !== "domain") {
        throw new Error("Expected a resolvable domain reference");
      }
      return resolution.entry.payload.snapshot.detail;
    };

    // A tag observed here is usable by `arr_library_change`, which resolves a
    // configuration reference by the pointer kind rather than by the domain.
    expect(resolved(mint(tag))).toMatchObject({ domain: "tags", kind: "tag" });
    expect(resolved(mint(configurationRef("sonarr", "root_folders", 1)))).toMatchObject({
      domain: "root_folders",
      kind: "root_folder",
    });
    // A domain no library record points at carries the domain alone.
    expect(resolved(mint(configurationRef("sonarr", "indexers", 1)))).toEqual({
      domain: "indexers",
    });
  });
});
