/**
 * The fixture contract, as the test suite reads it.
 *
 * The rules themselves live in `scripts/fixture-contract.mjs` so the operator
 * capture procedure can hold a captured body to exactly the screens this suite
 * enforces, rather than carrying a second copy that would drift. Tests keep
 * importing this module: a fixture is addressed by its upstream route through
 * {@link fixturePathFor}, never by file name.
 */

export type {
  ApprovedFixture,
  FixtureApiVersion,
  FixtureApplication,
  FixtureMetadata,
  FixtureTuple,
  FixtureVersion,
  VersionedFixture,
} from "../../scripts/fixture-contract.mjs";
export {
  approvedFixtureInventory,
  approvedFixtures,
  approvedFixtureTuples,
  fixtureFileForRoute,
  fixturePathFor,
  loadFixture,
  validateFixture,
  validateSanitizedValue,
} from "../../scripts/fixture-contract.mjs";
