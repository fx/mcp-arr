/**
 * The fixture contract, as the test suite reads it.
 *
 * The rules themselves live in `scripts/fixture-contract.mjs` so the operator
 * capture procedure can hold a captured body to exactly the screens this suite
 * enforces, rather than carrying a second copy that would drift. Tests keep
 * importing this module: a fixture is addressed by its upstream route through
 * {@link fixturePathFor}, never by file name — and, where a test reads a body
 * recorded at a newer version than the application's minimum, by that version
 * too, passed as `fixturePathFor(application, route, { version })`.
 */

export type {
  ApprovedFixture,
  CaptureTarget,
  FixtureApiVersion,
  FixtureApplication,
  FixtureInventory,
  FixtureMetadata,
  FixtureTuple,
  FixtureVersion,
  FixtureVersionOf,
  MinimumFixtureTuple,
  RecordedApplication,
  VersionedFixture,
} from "../../scripts/fixture-contract.mjs";
export {
  approvedFixtureInventory,
  approvedFixtures,
  approvedFixtureTuples,
  captureTargetFor,
  contextualFieldProbes,
  createFixtureInventory,
  fixtureFileForRoute,
  fixturePathFor,
  identifyingFieldKeys,
  loadFixture,
  minimumFixtureTuples,
  shippedLanguages,
  structuralRules,
  validateFixture,
  validateSanitizedValue,
} from "../../scripts/fixture-contract.mjs";
