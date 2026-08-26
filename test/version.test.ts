import { describe, expect, it } from "vitest";
import {
  compareVersionSegments,
  meetsMinimumVersion,
  parseVersionSegments,
} from "../src/adapters/version.js";
import { applicationDescriptors } from "../src/applications.js";

describe("parseVersionSegments", () => {
  it("reads dotted numeric segments and stops at non-numeric suffixes", () => {
    expect(parseVersionSegments("4.0.19.2979")).toEqual([4, 0, 19, 2979]);
    expect(parseVersionSegments("  v6.3.0.10514 ")).toEqual([6, 3, 0, 10514]);
    expect(parseVersionSegments("6.3.0.10514-develop")).toEqual([6, 3, 0, 10514]);
    expect(parseVersionSegments("2.5.2.5491.nightly.7")).toEqual([2, 5, 2, 5491]);
    expect(parseVersionSegments("4")).toEqual([4]);
  });

  it("returns undefined when no numeric segment is present", () => {
    expect(parseVersionSegments("nightly")).toBeUndefined();
    expect(parseVersionSegments("")).toBeUndefined();
    expect(parseVersionSegments("   ")).toBeUndefined();
    expect(parseVersionSegments("v")).toBeUndefined();
  });
});

describe("compareVersionSegments", () => {
  it("orders numerically rather than lexically", () => {
    expect(compareVersionSegments([4, 0, 19, 2979], [4, 0, 9, 9999])).toBe(1);
    expect(compareVersionSegments([4, 0, 9, 9999], [4, 0, 19, 2979])).toBe(-1);
    expect(compareVersionSegments([4, 0, 19, 10000], [4, 0, 19, 2979])).toBe(1);
  });

  it("treats missing trailing segments as zero", () => {
    expect(compareVersionSegments([4, 0], [4, 0, 0, 0])).toBe(0);
    expect(compareVersionSegments([4, 0], [4, 0, 19, 2979])).toBe(-1);
    expect(compareVersionSegments([4, 0, 19, 2979], [4, 0])).toBe(1);
    expect(compareVersionSegments([], [])).toBe(0);
  });
});

describe("meetsMinimumVersion", () => {
  it("accepts the recorded minimum and anything newer", () => {
    for (const descriptor of applicationDescriptors) {
      expect(meetsMinimumVersion(descriptor.minimumVersion, descriptor.minimumVersion)).toBe(true);
    }

    expect(meetsMinimumVersion("4.0.19.2980", "4.0.19.2979")).toBe(true);
    expect(meetsMinimumVersion("4.0.20.1", "4.0.19.2979")).toBe(true);
    expect(meetsMinimumVersion("5.0.0.1", "4.0.19.2979")).toBe(true);
    expect(meetsMinimumVersion("4.0.19.2979.1", "4.0.19.2979")).toBe(true);
    expect(meetsMinimumVersion("6.3.0.10514-develop", "6.3.0.10514")).toBe(true);
  });

  it("rejects releases older than the recorded minimum", () => {
    expect(meetsMinimumVersion("4.0.9.9999", "4.0.19.2979")).toBe(false);
    expect(meetsMinimumVersion("4.0.19.2978", "4.0.19.2979")).toBe(false);
    expect(meetsMinimumVersion("3.0.10.1567", "4.0.19.2979")).toBe(false);
    expect(meetsMinimumVersion("4.0", "4.0.19.2979")).toBe(false);
  });

  it("does not reject a version merely because it is unrecognized", () => {
    expect(meetsMinimumVersion("nightly", "4.0.19.2979")).toBe(true);
    expect(meetsMinimumVersion("main", "4.0.19.2979")).toBe(true);
    expect(meetsMinimumVersion("4.0.19.2979", "unversioned")).toBe(true);
  });
});
