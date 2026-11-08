import { describe, expect, it } from "vitest";
import { createSanitizer } from "../scripts/capture-sanitizer.mjs";
import {
  contextualFieldProbes,
  identifyingFieldKeys,
  structuralRules,
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
