import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createSanitizer } from "../scripts/capture-sanitizer.mjs";
import {
  capturedBy,
  contextualFieldProbes,
  factFieldKeys,
  identifyingFieldKeys,
  structuralRules,
  validateFixture,
  validateSanitizedValue,
} from "./support/fixtures.js";

/**
 * Every structural rule and every identifying field the fixture contract
 * defines, probed with title-like values.
 *
 * The cases come from the contract's own tables, so a rule or a field added
 * later is probed without anyone writing a case for it. A rule that
 * recognizes a shape rather than a closed set of values — an identifier, a
 * capitalized word, anything ending in `Settings` or `Check` — admits one of
 * these probes, and this test fails for it. Each probe must be refused by the
 * screen with no legacy values allowed, and replaced by the capture with a
 * stand-in the screen then accepts.
 */

const textProbes = [
  "MyPrivateMovie",
  "My Private Movie",
  "myPrivateMovie",
  "MyPrivateMovieSettings",
  "MyPrivateMovieCheck",
  "my-private-movie",
  "my_private_movie",
  "MY PRIVATE MOVIE",
];

const probes: readonly unknown[] = [...textProbes, [["My Private Movie"]]];

/** Whether any form of the probe's words survived. */
const leaked = /private[ _-]?movie/iu;

interface Placement {
  readonly label: string;
  readonly key: string;
  readonly parent: Readonly<Record<string, unknown>>;
  readonly container?: string | undefined;
}

function placementsFor(value: unknown): Placement[] {
  const text = typeof value === "string" ? value : "My Private Movie";
  return [
    ...structuralRules.flatMap((rule, index) =>
      rule.keys.map((key) => {
        if (rule.probe === undefined) {
          throw new Error(`Structural rule ${index} (${rule.why}: ${key}) states no probe`);
        }
        const { parent, container } = rule.probe(text);
        return { label: `rule ${index} ${rule.why} ${key}`, key, parent, container };
      }),
    ),
    ...identifyingFieldKeys.map((key) => ({ label: `field ${key}`, key, parent: {} })),
    ...contextualFieldProbes.map(({ field, key, parent, container }) => ({
      label: `field ${field} as ${key}`,
      key,
      parent,
      container,
    })),
  ];
}

/** A body holding the value where the placement says it sits. */
function bodyFor(placement: Placement, value: unknown): unknown {
  const record = { ...placement.parent, [placement.key]: value };
  return placement.container === undefined ? [record] : [{ [placement.container]: [record] }];
}

function capture(body: unknown): unknown {
  const { sanitize } = createSanitizer(validateSanitizedValue, (message) => {
    throw new Error(message);
  });
  return sanitize(body);
}

describe("every structural rule and identifying field", () => {
  it("states where a value it judges sits", () => {
    for (const [index, rule] of structuralRules.entries()) {
      expect(rule.probe, `rule ${index} (${rule.why}: ${rule.keys.join(", ")})`).toBeTypeOf(
        "function",
      );
    }
    expect(identifyingFieldKeys.length).toBeGreaterThan(0);
  });

  for (const value of probes) {
    const name = JSON.stringify(value);

    it(`refuses ${name} in every one, with no legacy value allowed`, () => {
      for (const placement of placementsFor(value)) {
        const body = bodyFor(placement, value);
        expect(
          () => validateSanitizedValue(body, "body"),
          `${placement.label}: ${JSON.stringify(body)}`,
        ).toThrow(/is not neutralized|is not allowed/u);
      }
    });

    it(`captures ${name} in every one as a stand-in the screen accepts`, () => {
      for (const placement of placementsFor(value)) {
        const written = capture(bodyFor(placement, value));
        const label = `${placement.label}: ${JSON.stringify(written)}`;
        expect(JSON.stringify(written), label).not.toMatch(leaked);
        expect(() => validateSanitizedValue(written, "body"), label).not.toThrow();
      }
    });
  }
});

/**
 * Every fact a fixture recorded at a newer version may hold, probed in every
 * representation the applications write one in.
 *
 * A fact is screened by value only where a fixture recorded at a newer
 * version holds it, since a capture wrote that body and the minimum's predate
 * the shift. So each probe is placed in such a fixture, carrying the capture's
 * provenance, and must be refused; a byte count, which no value can show to
 * be scaled, must be refused without that provenance instead. The capture
 * must then write each probe in a form the same fixture accepts.
 */
const factProbes: readonly unknown[] = [
  123,
  "123",
  "1984",
  "English",
  { name: "English" },
  ["English"],
];

const fixtureRoot = fileURLToPath(new URL("./fixtures", import.meta.url));
const newerFile = `${fixtureRoot}/sonarr/v3/4.0.20.3014/qualityprofile.json`;

function newerFixture(body: unknown, marked = true) {
  return {
    metadata: {
      application: "sonarr",
      apiVersion: "v3",
      version: "4.0.20.3014",
      endpoint: "/api/v3/qualityprofile",
      ...(marked ? { capturedBy } : {}),
    },
    body,
  };
}

function validateNewer(body: unknown, marked = true) {
  return validateFixture(newerFixture(body, marked), {
    fixtureRoot,
    filePath: newerFile,
    legacy: false,
  });
}

describe("every fact a newer fixture holds", () => {
  it("names every fact field, and says how each is verified", () => {
    expect(factFieldKeys.map(({ field }) => field).sort()).toEqual(
      expect.arrayContaining([
        "airTime",
        "byteCount",
        "language",
        "languages",
        "popularity",
        "ratings",
        "runtime",
        "year",
      ]),
    );
  });

  for (const { key, field, verified } of factFieldKeys) {
    it(`refuses ${key} (${field}) in every representation, and captures each neutrally`, () => {
      for (const probe of factProbes) {
        const body = [{ [key]: probe }];
        const label = `${key}: ${JSON.stringify(probe)}`;
        const numeric = typeof probe === "number" || /^\d+$/u.test(String(probe));
        if (verified === "provenance" && numeric) {
          // No value shows a byte count was scaled; only the provenance can.
          expect(() => validateNewer(body, false), label).toThrow("carries no capture provenance");
        } else {
          expect(() => validateNewer(body), label).toThrow(/is not neutralized|is not shifted/u);
        }

        const written = capture(body);
        expect(JSON.stringify(written), label).not.toContain("English");
        expect(JSON.stringify(written), label).not.toMatch(/"(?:123|1984)"|:(?:123|1984)\b/u);
        expect(
          () => validateNewer(written),
          `${label} -> ${JSON.stringify(written)}`,
        ).not.toThrow();
      }
    });
  }
});
