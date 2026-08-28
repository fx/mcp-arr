/**
 * The declared surface of `fixture-contract.mjs`.
 *
 * The approved tuples themselves live in that module and nowhere else. What is
 * restated here is only which labels are possible, and the contract test
 * asserts the whole inventory those labels produce — so a version raised in one
 * file and not the other fails the suite rather than passing quietly.
 */
export type FixtureApplication = "sonarr" | "radarr" | "prowlarr";
export type FixtureApiVersion = "v1" | "v3";
export type FixtureVersion = "4.0.19.2979" | "6.3.0.10514" | "2.5.2.5491";

export interface FixtureTuple {
  readonly application: FixtureApplication;
  readonly apiVersion: FixtureApiVersion;
  readonly version: FixtureVersion;
}

export declare const approvedFixtureTuples: readonly FixtureTuple[];

export interface FixtureMetadata {
  application: FixtureApplication;
  apiVersion: FixtureApiVersion;
  version: FixtureVersion;
  endpoint: string;
}

export interface VersionedFixture<TBody = unknown> {
  metadata: FixtureMetadata;
  body: TBody;
}

export interface ApprovedFixture {
  readonly application: FixtureApplication;
  readonly apiVersion: FixtureApiVersion;
  readonly version: FixtureVersion;
  readonly route: string;
  readonly endpoint: string;
  readonly relativePath: string;
}

export declare const approvedFixtures: readonly ApprovedFixture[];

export declare const approvedFixtureInventory: string[];

export declare function fixtureFileForRoute(route: string): string;

export declare function fixturePathFor(application: FixtureApplication, route: string): string;

export declare function validateSanitizedValue(value: unknown, location: string): void;

export declare function validateFixture<TBody = unknown>(
  value: unknown,
  options: { filePath: string; fixtureRoot: string },
): VersionedFixture<TBody>;

export declare function loadFixture<TBody = unknown>(
  fixtureRoot: string,
  relativePath: string,
): Promise<VersionedFixture<TBody>>;
