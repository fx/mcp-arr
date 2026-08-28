export declare const approvedFixtureTuples: readonly [
  { readonly application: "sonarr"; readonly apiVersion: "v3"; readonly version: "4.0.19.2979" },
  { readonly application: "radarr"; readonly apiVersion: "v3"; readonly version: "6.3.0.10514" },
  { readonly application: "prowlarr"; readonly apiVersion: "v1"; readonly version: "2.5.2.5491" },
];

export type FixtureApplication = (typeof approvedFixtureTuples)[number]["application"];
export type FixtureApiVersion = (typeof approvedFixtureTuples)[number]["apiVersion"];
export type FixtureVersion = (typeof approvedFixtureTuples)[number]["version"];

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
