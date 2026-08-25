import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { approvedFixtureInventory, loadFixture, validateFixture } from "./support/fixtures.js";

const fixtureRoot = fileURLToPath(new URL("./fixtures", import.meta.url));
const temporaryDirectories: string[] = [];

async function listFiles(root: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(path.join(root, prefix), { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const relativePath = path.join(prefix, entry.name);
      return entry.isDirectory() ? listFiles(root, relativePath) : [relativePath];
    }),
  );
  return files
    .flat()
    .map((file) => file.split(path.sep).join("/"))
    .sort();
}

function validFixture(): Record<string, unknown> {
  return {
    metadata: {
      application: "sonarr",
      apiVersion: "v3",
      version: "4.0.19.2979",
      endpoint: "/api/v3/system/status",
    },
    body: {
      appName: "Sonarr",
      version: "4.0.19.2979",
    },
  };
}

function validate(value: unknown, relativePath = approvedFixtureInventory[0] ?? "") {
  return validateFixture(value, {
    fixtureRoot,
    filePath: path.join(fixtureRoot, relativePath),
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("versioned fixture contract", () => {
  it("contains exactly the approved fixtures and validates every file", async () => {
    await expect(listFiles(fixtureRoot)).resolves.toEqual([...approvedFixtureInventory].sort());

    const fixtures = await Promise.all(
      approvedFixtureInventory.map((relativePath) => loadFixture(fixtureRoot, relativePath)),
    );
    expect(fixtures.map(({ metadata }) => metadata)).toEqual([
      {
        application: "sonarr",
        apiVersion: "v3",
        version: "4.0.19.2979",
        endpoint: "/api/v3/system/status",
      },
      {
        application: "radarr",
        apiVersion: "v3",
        version: "6.3.0.10514",
        endpoint: "/api/v3/system/status",
      },
      {
        application: "prowlarr",
        apiVersion: "v1",
        version: "2.5.2.5491",
        endpoint: "/api/v1/system/status",
      },
    ]);
  });

  it("rejects malformed JSON and malformed or missing metadata", async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), "mcp-arr-fixtures-"));
    temporaryDirectories.push(temporaryRoot);
    const relativePath = approvedFixtureInventory[0] ?? "";
    const fixturePath = path.join(temporaryRoot, relativePath);
    await mkdir(path.dirname(fixturePath), { recursive: true });
    await writeFile(fixturePath, "{", "utf8");
    await expect(loadFixture(temporaryRoot, relativePath)).rejects.toThrow(
      "Fixture is not valid JSON",
    );

    expect(() => validate(null)).toThrow("Fixture must be a JSON object");
    expect(() => validate({ body: {} })).toThrow("Fixture metadata must be an object");
    for (const field of ["application", "apiVersion", "version", "endpoint"] as const) {
      const fixture = validFixture();
      const metadata = fixture.metadata as Record<string, unknown>;
      delete metadata[field];
      expect(() => validate(fixture)).toThrow(`metadata.${field} must be a non-empty string`);
    }
  });

  it("rejects unapproved tuples and path, API, endpoint, and body-version mismatches", () => {
    const unapproved = validFixture();
    (unapproved.metadata as Record<string, unknown>).version = "0.0.0";
    expect(() => validate(unapproved)).toThrow("Unapproved fixture tuple");

    expect(() => validate(validFixture(), "radarr/v3/4.0.19.2979/system-status.json")).toThrow(
      "Fixture application label does not match metadata",
    );
    expect(() => validate(validFixture(), "sonarr/v1/4.0.19.2979/system-status.json")).toThrow(
      "Fixture API label does not match metadata",
    );
    expect(() => validate(validFixture(), "sonarr/v3/4.0.19.1/system-status.json")).toThrow(
      "Fixture version label does not match metadata",
    );

    const endpointMismatch = validFixture();
    (endpointMismatch.metadata as Record<string, unknown>).endpoint = "/api/v1/system/status";
    expect(() => validate(endpointMismatch)).toThrow("Fixture endpoint must use");

    const unsafeEndpoint = validFixture();
    (unsafeEndpoint.metadata as Record<string, unknown>).endpoint = [
      "https:",
      "",
      "fixture.invalid",
      "api/v3/system/status",
    ].join("/");
    expect(() => validate(unsafeEndpoint)).toThrow("Fixture endpoint must use");

    const bodyMismatch = validFixture();
    (bodyMismatch.body as Record<string, unknown>).version = "4.0.19.1";
    expect(() => validate(bodyMismatch)).toThrow("Fixture body version does not match metadata");
  });

  it("rejects recursive secret-bearing keys", () => {
    for (const key of ["apiKey", "authorization", "password", "client_secret", "sessionToken"]) {
      const fixture = validFixture();
      (fixture.body as Record<string, unknown>).nested = [{ safe: { [key]: "placeholder" } }];
      expect(() => validate(fixture)).toThrow("Secret-bearing key is not allowed");
    }
  });

  it("rejects email, URL, home, Windows, and UNC path values", () => {
    const unsafeValues = [
      ["email address", ["fixture", "example.invalid"].join("@")],
      ["URL", ["https:", "", "fixture.invalid", "path"].join("/")],
      ["home path", ["", "home", "fixture", "data"].join("/")],
      ["home path", ["", "Users", "fixture", "data"].join("/")],
      ["home path", ["", "root", "fixture"].join("/")],
      ["home path", ["~", "fixture", "data"].join("/")],
      ["Windows path", ["prefix=C:", "fixture", "data"].join("\\")],
      ["UNC path", `${"\\".repeat(2)}fixture\\share`],
    ] as const;

    for (const [description, unsafeValue] of unsafeValues) {
      const fixture = validFixture();
      (fixture.body as Record<string, unknown>).nested = [unsafeValue];
      expect(() => validate(fixture)).toThrow(`Sensitive ${description} is not allowed`);
    }
  });
});
