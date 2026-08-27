import { describe, expect, it } from "vitest";
import {
  classifyProviderField,
  classifyProviderFields,
  countWithheldProperties,
  describeSecret,
  isSecretFieldName,
  maxSafeFieldValueItems,
  maxSafeFieldValueLength,
  providerFieldAllowlist,
  safeFieldValue,
} from "../src/adapters/configuration/fields.js";

describe("provider field classification", () => {
  it("classifies a credential by name before anything else looks at it", () => {
    for (const name of [
      "apiKey",
      "API_KEY",
      "password",
      "passKey",
      "rssKey",
      "authToken",
      "sessionCookie",
      "clientSecret",
      "username",
      "loginName",
      "cardigannCaptcha",
      "notificationEmail",
    ]) {
      expect(isSecretFieldName(name)).toBe(true);
      expect(classifyProviderField({ name })).toBe("secret");
    }
  });

  it("reports an allowlisted operational field and withholds everything else", () => {
    expect(classifyProviderField({ name: "minimumSeeders" })).toBe("safe");
    expect(classifyProviderField({ name: "useSsl" })).toBe("safe");

    for (const name of ["baseUrl", "host", "port", "definitionFile", "additionalParameters"]) {
      expect(classifyProviderField({ name })).toBe("withheld");
    }
  });

  it("lets upstream privacy metadata escalate a field but never de-escalate one", () => {
    // A definition file that declares its own credential "normal" is not believed.
    expect(classifyProviderField({ name: "passkey", privacy: "normal" })).toBe("secret");
    // A field the allowlist never named stays withheld whatever privacy claims.
    expect(classifyProviderField({ name: "definitionFile", privacy: "normal" })).toBe("withheld");
    // An unremarkable name the instance marks private is treated as a credential.
    expect(classifyProviderField({ name: "definitionValue", privacy: "password" })).toBe("secret");
    expect(classifyProviderField({ name: "minimumSeeders", privacy: "apiKey" })).toBe("secret");
  });

  it("keeps every credential name out of the allowlist", () => {
    for (const name of providerFieldAllowlist.keys()) {
      expect(isSecretFieldName(name)).toBe(false);
    }
  });
});

describe("safe field values", () => {
  it("passes bounded primitives and bounded primitive arrays", () => {
    expect(safeFieldValue("example")).toBe("example");
    expect(safeFieldValue(12)).toBe(12);
    expect(safeFieldValue(false)).toBe(false);
    expect(safeFieldValue([5030, 5040])).toEqual([5030, 5040]);
  });

  it("refuses a shape or a size the output model has no room for", () => {
    expect(safeFieldValue({ nested: true })).toBeUndefined();
    expect(safeFieldValue([[1]])).toBeUndefined();
    expect(safeFieldValue(null)).toBeUndefined();
    expect(safeFieldValue(undefined)).toBeUndefined();
    expect(safeFieldValue(Number.NaN)).toBeUndefined();
    expect(safeFieldValue("x".repeat(maxSafeFieldValueLength))).toHaveLength(
      maxSafeFieldValueLength,
    );
    expect(safeFieldValue("x".repeat(maxSafeFieldValueLength + 1))).toBeUndefined();
    expect(
      safeFieldValue(Array.from({ length: maxSafeFieldValueItems + 1 }, () => 1)),
    ).toBeUndefined();
  });

  it("refuses an allowlisted name whose value is not the kind that name carries", () => {
    // The attack the kinds exist to stop: a definition file names a field
    // `minimumSeeders` and puts a passkey in it.
    expect(safeFieldValue("CANARY-PASSKEY", "number")).toBeUndefined();
    expect(safeFieldValue(2, "number")).toBe(2);
    expect(safeFieldValue("true", "boolean")).toBeUndefined();
    expect(safeFieldValue(false, "boolean")).toBe(false);
    expect(safeFieldValue(7, "string")).toBeUndefined();
    expect(safeFieldValue("radarr", "string")).toBe("radarr");
    expect(safeFieldValue(["CANARY-PASSKEY"], "numberList")).toBeUndefined();
    expect(safeFieldValue([5030, 5040], "numberList")).toEqual([5030, 5040]);
    expect(safeFieldValue(5030, "numberList")).toBeUndefined();
  });

  it("refuses a value that carries a URL even under an allowlisted name", () => {
    expect(safeFieldValue("https://example-indexer")).toBeUndefined();
    expect(safeFieldValue(["http://example-indexer"])).toBeUndefined();
  });
});

describe("configured-secret indicators", () => {
  it("reports whether a secret is set without reporting what it is", () => {
    expect(describeSecret("apiKey", "CANARY-VALUE")).toEqual({
      name: "apiKey",
      state: "configured",
      masked: false,
    });
    expect(describeSecret("apiKey", "")).toEqual({
      name: "apiKey",
      state: "unconfigured",
      masked: false,
    });
    expect(describeSecret("apiKey", "   ")).toEqual({
      name: "apiKey",
      state: "unconfigured",
      masked: false,
    });
    expect(describeSecret("apiKey", null)).toEqual({
      name: "apiKey",
      state: "unconfigured",
      masked: false,
    });
    expect(describeSecret("apiKey", undefined)).toEqual({
      name: "apiKey",
      state: "unconfigured",
      masked: false,
    });
  });

  it("recognizes the upstream mask as configured-but-unread", () => {
    expect(describeSecret("password", "********")).toEqual({
      name: "password",
      state: "configured",
      masked: true,
    });
    // A value that merely starts with asterisks is a value, not the sentinel.
    expect(describeSecret("password", "**real**")).toEqual({
      name: "password",
      state: "configured",
      masked: false,
    });
  });
});

describe("classifying a whole dynamic field list", () => {
  it("splits fields three ways and counts what it dropped", () => {
    const classified = classifyProviderFields([
      { name: "minimumSeeders", value: 2 },
      { name: "apiKey", value: "CANARY-VALUE" },
      { name: "definitionFile", value: "exampletracker" },
      { name: "useSsl", value: true },
      { name: "passkey", value: "" },
      // Allowlisted, but the value is a shape the model cannot carry.
      { name: "categories", value: { nested: true } },
    ]);

    expect(classified.fields).toEqual([
      { name: "minimumSeeders", value: 2 },
      { name: "useSsl", value: true },
    ]);
    expect(classified.secrets).toEqual([
      { name: "apiKey", state: "configured", masked: false },
      { name: "passkey", state: "unconfigured", masked: false },
    ]);
    expect(classified.withheldCount).toBe(2);
  });

  it("withholds a borrowed allowlisted name whose value is the wrong kind", () => {
    const classified = classifyProviderFields([
      // A dynamic definition naming its passkey after an operational setting.
      { name: "minimumSeeders", value: "CANARY-BORROWED-NAME" },
      { name: "categories", value: ["CANARY-BORROWED-LIST"] },
      { name: "minimumSeeders", value: 3 },
    ]);

    expect(classified.fields).toEqual([{ name: "minimumSeeders", value: 3 }]);
    expect(classified.secrets).toEqual([]);
    expect(classified.withheldCount).toBe(2);
  });

  it("withholds a credential-named switch rather than calling a toggle configured", () => {
    const classified = classifyProviderFields([
      { name: "useAuthentication", value: true },
      { name: "requireLogin", value: false },
      { name: "apiKey", value: "CANARY-VALUE" },
    ]);

    expect(classified.secrets).toEqual([{ name: "apiKey", state: "configured", masked: false }]);
    expect(classified.fields).toEqual([]);
    expect(classified.withheldCount).toBe(2);
  });

  it("keeps a repeated field name as two entries rather than merging them", () => {
    const classified = classifyProviderFields([
      { name: "apiKey", value: "" },
      { name: "apiKey", value: "CANARY-VALUE" },
    ]);

    expect(classified.secrets).toEqual([
      { name: "apiKey", state: "unconfigured", masked: false },
      { name: "apiKey", state: "configured", masked: false },
    ]);
  });
});

describe("withheld property counting", () => {
  it("counts a record's own keys that no mapping accounted for", () => {
    expect(countWithheldProperties({ id: 1, name: "x", extra: 1, other: 2 }, ["id", "name"])).toBe(
      2,
    );
    expect(countWithheldProperties({ id: 1 }, ["id", "label"])).toBe(0);
  });
});
