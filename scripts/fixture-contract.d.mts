/**
 * The declared surface of `fixture-contract.mjs`.
 *
 * The approved tuples themselves live in that module and nowhere else. What is
 * restated here is only which labels are possible, and the contract test
 * asserts the whole inventory those labels produce — so a version raised in one
 * file and not the other fails the suite rather than passing quietly.
 */
export type MinimumFixtureTuple =
  | { readonly application: "sonarr"; readonly apiVersion: "v3"; readonly version: "4.0.19.2979" }
  | { readonly application: "radarr"; readonly apiVersion: "v3"; readonly version: "6.3.0.10514" }
  | {
      readonly application: "prowlarr";
      readonly apiVersion: "v1";
      readonly version: "2.5.2.5491";
    };

/**
 * Every recorded version: each application's minimum, and the newer versions
 * a fixture may also be captured from.
 */
export type FixtureTuple =
  | MinimumFixtureTuple
  | { readonly application: "sonarr"; readonly apiVersion: "v3"; readonly version: "4.0.20.3014" }
  | { readonly application: "radarr"; readonly apiVersion: "v3"; readonly version: "6.4.4.10685" }
  | {
      readonly application: "prowlarr";
      readonly apiVersion: "v1";
      readonly version: "2.7.0.5723";
    };

// Derived from the one declared list above rather than restated, so a label
// cannot exist here in a combination the inventory does not approve.
export type FixtureApplication = FixtureTuple["application"];
export type FixtureApiVersion = FixtureTuple["apiVersion"];
export type FixtureVersion = FixtureTuple["version"];

/** The versions one application records fixtures at. */
export type FixtureVersionOf<TApplication extends FixtureApplication> = Extract<
  FixtureTuple,
  { readonly application: TApplication }
>["version"];

export declare const approvedFixtureTuples: readonly FixtureTuple[];

export declare const minimumFixtureTuples: readonly MinimumFixtureTuple[];

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

/**
 * Without `options.version`, the fixture recorded at the application's minimum
 * supported version; with it, the one recorded at exactly that version.
 */
export declare function fixturePathFor<TApplication extends FixtureApplication>(
  application: TApplication,
  route: string,
  options?: { readonly version?: FixtureVersionOf<TApplication> },
): string;

export type CaptureTarget<TFixture = ApprovedFixture> =
  | { readonly kind: "approved"; readonly fixture: TFixture }
  | { readonly kind: "unrecorded-version"; readonly recordedVersions: readonly string[] }
  | { readonly kind: "route-not-recorded-at-version"; readonly routeVersions: readonly string[] };

export declare function captureTargetFor(
  application: string,
  route: string,
  reportedVersion: string | undefined,
): CaptureTarget;

/**
 * The shape of the recorded-version record, for exercising the derivation with
 * labels the real record does not hold. Labels are plain strings here: the
 * narrow unions above describe the real record only.
 */
export interface RecordedApplication {
  readonly apiVersion: string;
  readonly minimum: string;
  readonly routes: Readonly<Record<string, readonly string[]>>;
}

export interface RecordedFixture {
  readonly application: string;
  readonly apiVersion: string;
  readonly version: string;
  readonly route: string;
  readonly endpoint: string;
  readonly relativePath: string;
}

export interface FixtureInventory {
  readonly tuples: readonly {
    readonly application: string;
    readonly apiVersion: string;
    readonly version: string;
  }[];
  readonly minimumTuples: FixtureInventory["tuples"];
  readonly fixtures: readonly RecordedFixture[];
  readonly inventory: readonly string[];
  pathFor(application: string, route: string, options?: { readonly version?: string }): string;
  forReportedVersion(
    application: string,
    route: string,
    reportedVersion: string | undefined,
  ): CaptureTarget<RecordedFixture>;
}

export declare function createFixtureInventory(
  recorded: Readonly<Record<string, RecordedApplication>>,
): FixtureInventory;

export declare function validateSanitizedValue(
  value: unknown,
  location: string,
  legacy?: Readonly<Record<string, readonly unknown[]>>,
  container?: string,
): void;

export declare function validateFixture<TBody = unknown>(
  value: unknown,
  options: { filePath: string; fixtureRoot: string; legacy?: boolean },
): VersionedFixture<TBody>;

export declare function loadFixture<TBody = unknown>(
  fixtureRoot: string,
  relativePath: string,
): Promise<VersionedFixture<TBody>>;
