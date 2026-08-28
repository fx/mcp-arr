import { describe, expect, it } from "vitest";
import { serializeProviderTemplate } from "../src/adapters/configuration/serialize.js";
import { fixtureBody } from "./support/library.js";

/**
 * One provider template, as the staleness check reads it.
 *
 * No observation returns the instance's catalogue, so this is the only place a
 * serialized template is examined rather than digested: the fingerprint covers
 * the field names, types, and credential flags, and a defect in any of them
 * would show up there only as a hash that moved or failed to.
 */

const context = {
  application: "sonarr",
  domain: "indexers",
  route: "indexer/schema",
  detail: "full",
} as const;

describe("serializing a provider template", () => {
  it("describes each field without valuing it", async () => {
    const schema = await fixtureBody<readonly Record<string, unknown>[]>(
      "sonarr",
      "indexer/schema",
    );
    const templates = schema.map((raw) => serializeProviderTemplate(context, raw));

    expect(templates.map((template) => template?.implementation)).toEqual(["Newznab", "Torznab"]);

    const newznab = templates[0];
    expect(newznab?.name).toBe("Newznab");
    expect(newznab?.configContract).toBe("NewznabSettings");
    expect(newznab?.fields).toEqual([
      { name: "baseUrl", label: "URL", type: "textbox", advanced: false, secret: false },
      { name: "apiPath", label: "API Path", type: "textbox", advanced: true, secret: false },
      { name: "apiKey", label: "API Key", type: "textbox", advanced: false, secret: true },
      { name: "categories", label: "Categories", type: "select", advanced: false, secret: false },
    ]);
  });

  it("drops a template that names no implementation rather than inventing one", () => {
    // The implementation is what a template is matched by, so one without a
    // name describes nothing the staleness check could compare against.
    expect(serializeProviderTemplate(context, { name: "Nameless", fields: [] })).toBeUndefined();
    expect(
      serializeProviderTemplate(context, { implementation: "  ", fields: [] }),
    ).toBeUndefined();
  });
});
