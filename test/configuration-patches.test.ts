import { describe, expect, it } from "vitest";
import type { ConfigurationDomain } from "../src/adapters/configuration/domains.js";
import {
  type CompiledPatch,
  compileConfigurationPatch,
  type DesiredField,
} from "../src/adapters/configuration/patches.js";
import type { ApplicationId } from "../src/applications.js";

/**
 * Desired-state compilation, which is where a patch stops being a caller's
 * arbitrary name/value list and becomes something typed.
 *
 * Every test here is about a refusal or about the exact shape a name compiles
 * to. Nothing reaches an instance: compilation deliberately knows nothing about
 * the current resource, so that a planning call and the apply that follows it
 * validate the desired state identically.
 */

function compile(
  domain: ConfigurationDomain,
  fields: readonly DesiredField[],
  removeFields: readonly string[] = [],
  application: ApplicationId = "sonarr",
  secretNames: readonly string[] = [],
) {
  return compileConfigurationPatch(application, domain, { fields, removeFields, secretNames });
}

function expectCompiled(
  domain: ConfigurationDomain,
  fields: readonly DesiredField[],
  removeFields: readonly string[] = [],
  application: ApplicationId = "sonarr",
  secretNames: readonly string[] = [],
): CompiledPatch {
  const compilation = compile(domain, fields, removeFields, application, secretNames);
  if (compilation.status !== "ok") {
    throw new Error(`Expected a compiled patch, got ${compilation.error.message}`);
  }
  return compilation.patch;
}

function expectRefused(
  domain: ConfigurationDomain,
  fields: readonly DesiredField[],
  removeFields: readonly string[] = [],
  application: ApplicationId = "sonarr",
  secretNames: readonly string[] = [],
) {
  const compilation = compile(domain, fields, removeFields, application, secretNames);
  if (compilation.status !== "error") {
    throw new Error("Expected the desired state to be refused");
  }
  return compilation.error;
}

describe("compiling a typed desired state", () => {
  it("resolves every managed provider name to a location, a kind, and its dependencies", () => {
    const patch = expectCompiled("indexers", [
      { name: "priority", value: 30 },
      { name: "name", value: "  Renamed Indexer  " },
      { name: "categories", value: [5030, 5040] },
      { name: "tags", value: [3, 4] },
      { name: "enabled", value: false },
    ]);

    expect(patch.family).toBe("provider");
    // Sorted by name, so one desired state always produces one diff regardless
    // of the order the caller happened to list its fields in.
    expect(patch.assignments).toEqual([
      { target: "field", name: "categories", value: [5030, 5040] },
      { target: "enabled", name: "enabled", value: false },
      { target: "property", name: "name", property: "name", value: "Renamed Indexer" },
      { target: "property", name: "priority", property: "priority", value: 30 },
      { target: "tags", name: "tags", ids: [3, 4] },
    ]);
    expect(patch.dependencies).toEqual([{ kind: "tags", ids: [3, 4] }]);
  });

  it("points a list at a profile by identifier and a root folder by identifier", () => {
    const patch = expectCompiled("import_lists", [
      { name: "qualityProfileId", value: 2 },
      { name: "rootFolderId", value: 5 },
    ]);

    expect(patch.assignments).toEqual([
      {
        target: "reference",
        name: "qualityProfileId",
        property: "qualityProfileId",
        dependency: "quality_profiles",
        id: 2,
      },
      // The caller names a root folder, never a path: the writer substitutes
      // the path the instance itself reported for that identifier.
      {
        target: "reference",
        name: "rootFolderId",
        property: "rootFolderPath",
        dependency: "root_folders",
        id: 5,
      },
    ]);
    expect(patch.dependencies).toEqual([
      { kind: "quality_profiles", ids: [2] },
      { kind: "root_folders", ids: [5] },
    ]);
  });

  it("refuses a list pointer on a provider domain that has no such property", () => {
    expect(expectRefused("indexers", [{ name: "qualityProfileId", value: 2 }])).toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("not a field of the indexers domain"),
    });
  });

  it("refuses a field this server does not manage rather than forwarding it", () => {
    for (const name of ["baseUrl", "additionalParameters", "definitionFile"]) {
      expect(expectRefused("indexers", [{ name, value: "anything" }])).toMatchObject({
        code: "invalid_input",
        message: expect.stringContaining("is not a field this server manages"),
      });
    }
  });

  it("refuses a credential as a desired field and names the removal channel", () => {
    for (const name of ["apiKey", "password", "passKey"]) {
      expect(expectRefused("indexers", [{ name, value: "supplied-here" }])).toMatchObject({
        code: "invalid_input",
        message: expect.stringContaining("holds a credential"),
      });
    }
  });

  it("holds an allowlisted name to the kind of value that name carries", () => {
    // The name was chosen by a definition file, so it vouches for nothing: a
    // string in a numeric setting is refused rather than written through.
    expect(expectRefused("indexers", [{ name: "minimumSeeders", value: "many" }])).toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("must be a number"),
    });
    expect(
      expectRefused("download_clients", [
        { name: "movieCategory", value: "a/category?with=query" },
      ]),
    ).toMatchObject({ code: "invalid_input" });
    expect(expectRefused("indexers", [{ name: "priority", value: 1.5 }])).toMatchObject({
      code: "invalid_input",
    });
    expect(expectRefused("indexers", [{ name: "enabled", value: "yes" }])).toMatchObject({
      code: "invalid_input",
    });
    expect(expectRefused("indexers", [{ name: "tags", value: [3, 3] }])).toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("distinct tag identifiers"),
    });
  });

  it("refuses a name that carries a control character or is only whitespace", () => {
    for (const value of ["   ", "Renamed\u0000Indexer", "Renamed\nIndexer", "x".repeat(101)]) {
      expect(expectRefused("indexers", [{ name: "name", value }])).toMatchObject({
        code: "invalid_input",
        message: expect.stringContaining("must be a name"),
      });
    }
  });
});

describe("explicit removal", () => {
  it("treats a null value as a mistake and names the removal channel", () => {
    expect(expectRefused("indexers", [{ name: "minimumSeeders", value: null }])).toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("name it as a removal to clear it"),
    });
  });

  it("clears an allowlisted setting, a credential, or the whole tag list", () => {
    const patch = expectCompiled("download_clients", [], ["movieCategory", "password", "tags"]);

    expect(patch.removals).toEqual([
      { target: "field", name: "movieCategory" },
      { target: "field", name: "password" },
      { target: "tags", name: "tags" },
    ]);
    expect(patch.assignments).toEqual([]);
  });

  it("refuses to clear a field this server cannot describe", () => {
    expect(expectRefused("indexers", [], ["baseUrl"])).toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("is not a field this server can clear"),
    });
  });

  it("refuses a field that is both set and removed, and a name stated twice", () => {
    expect(
      expectRefused("indexers", [{ name: "minimumSeeders", value: 2 }], ["minimumSeeders"]),
    ).toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("both set and removed"),
    });
    expect(
      expectRefused("indexers", [
        { name: "priority", value: 1 },
        { name: "priority", value: 2 },
      ]),
    ).toMatchObject({ code: "invalid_input", message: expect.stringContaining("named twice") });
    expect(expectRefused("indexers", [], ["categories", "categories"])).toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("removed twice"),
    });
  });

  it("has no removable fields outside the provider family", () => {
    expect(expectRefused("quality_profiles", [], ["name"])).toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("no removable fields"),
    });
  });
});

describe("what a desired state may target", () => {
  it("accepts the scalar policy of a quality profile and the label of a tag", () => {
    expect(
      expectCompiled("quality_profiles", [
        { name: "name", value: "Example HD" },
        { name: "upgradeAllowed", value: false },
        { name: "minFormatScore", value: -10 },
      ]).assignments,
    ).toEqual([
      { target: "property", name: "minFormatScore", property: "minFormatScore", value: -10 },
      { target: "property", name: "name", property: "name", value: "Example HD" },
      { target: "property", name: "upgradeAllowed", property: "upgradeAllowed", value: false },
    ]);

    // A tag stores its name in `label`, so the managed name and the upstream
    // property deliberately differ.
    expect(
      expectCompiled("tags", [{ name: "name", value: "example-archive" }]).assignments,
    ).toEqual([{ target: "property", name: "name", property: "label", value: "example-archive" }]);
  });

  it("reports a domain it cannot yet reconcile as an unsupported capability", () => {
    for (const domain of [
      "remote_path_mappings",
      "root_folders",
      "import_list_exclusions",
      "custom_formats",
      "delay_profiles",
    ] as const) {
      expect(expectRefused(domain, [{ name: "name", value: "anything" }])).toMatchObject({
        code: "unsupported_capability",
        message: expect.stringContaining("cannot be reconciled"),
      });
    }
  });

  it("refuses a desired state that names nothing at all", () => {
    expect(expectRefused("indexers", [])).toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("at least one field"),
    });
  });
});
