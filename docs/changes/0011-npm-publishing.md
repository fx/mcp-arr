# 0011: npm Publishing

## Summary

Publish `mcp-arr` to the public npm registry through release-please, so a host can install and launch the server without cloning the repository, as required by the [Architecture spec](../specs/architecture/#packaging-and-release).

**Spec:** [Architecture](../specs/architecture/)
**Status:** draft
**Depends On:** —

## Motivation

The server is complete enough to be useful — `arr_capabilities` and `arr_library_query` work against real instances — but the only way to run it is to clone the repository and build it. There is no license, no repository metadata, no release automation, and no published artifact.

Distribution is also the cheapest thing to get wrong late. Version numbers, changelog, and tags drift the moment they are maintained by hand, and a registry credential added under time pressure becomes a long-lived secret nobody rotates. Establishing the release path now, while the surface is small, means every later change ships by the same route.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules (see [Architecture — Testing Contract](../specs/architecture/#testing-contract)). CI enforces these as merge gates:

- Exported behavior MUST have automated tests at the narrowest practical level.
- Adapter tests MUST use sanitized, version-labelled fixtures rather than personal live instances.
- Stdio integration tests MUST verify protocol framing and stdout cleanliness.
- Build, type check, lint, and tests MUST pass without focused or skipped tests.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

The existing package verifier already installs the built tarball and drives the installed binary over stdio. That verifier is this change's primary regression test and MUST continue to pass; publishing MUST NOT be wired in a way that bypasses it.

### Functional requirements

The [Architecture spec](../specs/architecture/#packaging-and-release) owns packaging, release, and publication behavior. Its scenarios are this change's acceptance criteria and are not restated here. What implementing them requires of this change:

- Package metadata MUST gain the license, repository, and registry fields the published artifact needs; the existing `files` allowlist already limits the tarball to build output and MUST NOT be widened.
- A `LICENSE` file MUST be added at the repository root carrying the MIT text.
- Release automation MUST derive the version from conventional commits already in use on this repository, and MUST NOT require a maintainer to edit a version by hand.
- Publication MUST be triggered by the release that a maintainer merges, and MUST run only after the standing quality gates pass on that commit.
- Publication MUST authenticate without storing a registry token in the repository.
- The release automation MUST act as the configured GitHub App rather than the default workflow token, so that release pull requests receive the same CI treatment as any other pull request.
- The documented default way to run the server MUST invoke the published package directly, without a checkout, an install step, or a build; instructions that require cloning MUST be demoted to a contributor section rather than remaining the primary path.
- Every host-configuration example in the project's documentation MUST use that invocation, so no example teaches a path that only works inside a checkout.

#### Scenario: Follow the documentation on a clean machine

- **GIVEN** a reader with a supported Node.js runtime, no checkout of this project, and no prior install
- **WHEN** they follow the project's documented setup exactly
- **THEN** the server runs from the published package, and no documented step requires cloning or building it

#### Scenario: A release pull request runs CI

- **GIVEN** commits have merged to the default branch since the last release
- **WHEN** the release automation opens or updates its release pull request
- **THEN** the standing quality-gate workflow runs on that pull request as it does for any other

#### Scenario: Publication follows the merged release

- **GIVEN** a maintainer merges the release pull request
- **WHEN** the release is created
- **THEN** the package is published to the registry from that commit, and the published version matches the tag and changelog entry

## Design

### Approach

- Add `license`, `repository`, `homepage`, `keywords`, and `publishConfig` to package metadata, and add the MIT `LICENSE` file.
- Add release-please configuration for a single Node package at the repository root, driven by the conventional commits the project already writes.
- Add a release workflow on the default branch that runs release-please, and a publish step gated on a release having been created.
- Mint a short-lived GitHub App token for the release step, so release pull requests trigger CI.
- Publish with npm provenance using the registry's OIDC trusted publishing, so no registry token exists in the repository.

### Decisions

- **Decision:** Use the MIT license.
  - **Why:** The user selected it. It is the prevailing license for MCP servers and npm command-line tools, and imposes nothing on hosts that embed the server.
  - **Alternatives considered:** Apache-2.0 for its explicit patent grant, AGPL-3.0 for copyleft. Neither fits a locally-run, single-user tool better than MIT.
- **Decision:** Authenticate to npm with OIDC trusted publishing rather than a stored token.
  - **Why:** The user selected it. It removes a long-lived credential from the repository entirely and attaches build provenance to the published artifact, which is exactly what the spec's no-long-lived-credential rule asks for.
  - **Alternatives considered:** An `NPM_TOKEN` repository secret is simpler to set up but is a standing credential requiring rotation. Trusted publishing requires the package to exist first, which the first-publish task below addresses.
- **Decision:** Run release-please as a GitHub App using the private key already added to repository secrets.
  - **Why:** A pull request opened with the default workflow token does not trigger other workflows, so a release pull request would merge without ever running the quality gates. The App token avoids that, and the user has already provisioned the key.
  - **Alternatives considered:** The default token, rejected for the reason above. A personal access token, rejected because it binds releases to one person's account.
- **Decision:** Document `npx mcp-arr` as the default invocation rather than a global install.
  - **Why:** A host launches the server as a command with environment variables, and `npx` resolves and runs the published package without the reader installing anything or keeping a checkout. It also keeps the documented command identical to what a host configuration file contains.
  - **Alternatives considered:** A global install adds a step and leaves the reader on a version they must remember to update. Documenting a cloned build as the primary path is what the current README does, and it is exactly what this change is removing.
- **Decision:** Keep the package a single root package rather than introducing a workspace.
  - **Why:** There is one artifact and no second package in prospect; a workspace would add release-please configuration surface for nothing.

### Non-Goals

- Publishing any distribution channel other than npm — no container image, no standalone binary, no registry mirror.
- Changing the runtime, transport, tool surface, or any behavior a host observes.
- Automating the merge of a release pull request. Merging a release stays a deliberate human act.
- Backfilling changelog entries for the already-merged changes 0001 through 0003.

## Tasks

- [ ] Prepare the package for publication
  - [ ] Add `license`, `repository`, `homepage`, and `keywords` to package metadata, and add the MIT `LICENSE` file
  - [ ] Confirm the packed tarball contains only build output and the documents needed to configure the server, and extend the package verifier to assert the license and repository metadata are present
  - [ ] Rewrite `README.md` around running the published package with `npx mcp-arr`, updating every host-configuration example to that invocation and demoting build-from-checkout to a contributor section
- [ ] Add release automation
  - [ ] Add release-please configuration and manifest for the root Node package
  - [ ] Add a release workflow on the default branch that authenticates as the GitHub App and opens or updates the release pull request
  - [ ] Verify the release pull request runs the standing quality-gate workflow
- [ ] Publish to the registry
  - [ ] Add a publish step that runs only when a release was created, publishing with provenance through OIDC trusted publishing
  - [ ] Perform the first publication and record any manual step it required
  - [ ] Verify a clean host can install the published package and start the server over stdio

## Open Questions

- [ ] The GitHub App ID is not present in the repository. `RELEASE_PLEASE_PRIVATE_KEY` is set, but minting an App token also needs the App's numeric ID, which is not secret and is normally a repository variable. Add it as a `RELEASE_PLEASE_APP_ID` variable, or supply the value to inline in the workflow. **This blocks the release automation task.**
- [ ] Trusted publishing requires the package name to exist on the registry before the trusted publisher can be configured against it. Confirm whether the first publication will be performed manually by a maintainer, with automation taking over from the second release onward.

## References

- Spec: [Architecture](../specs/architecture/)
- Related changes: [0001-project-foundation](./0001-project-foundation.md)
- External: [release-please](https://github.com/googleapis/release-please)
- External: [npm trusted publishing](https://docs.npmjs.com/trusted-publishers)
