# 0034: Container Image

## Summary

Ship a container image of the published package and publish it to the GitHub Container Registry from CI. The image is built by installing the same tarball `npm publish` uploads, runs the Streamable HTTP service from [0030](./0030-streamable-http-transport.md) as a non-root user under `tini`, and carries no credential. CI builds it once, for both platforms, into one archive, smoke-tests each platform's image loaded from that archive, and only then copies that archive, unchanged, to the registry: development images from every push to `main`, release images only after a maintainer-merged release has been published to npm.

**Spec:** [Architecture](../specs/architecture/#packaging-and-release)
**Status:** complete
**Depends On:** 0030

## Motivation

[0030](./0030-streamable-http-transport.md) made the server deployable as a long-lived remote service, and listed a container image as a non-goal. Running that service today means installing Node.js on the host and supervising `npx mcp-arr` by hand. A container is how such a service is normally deployed — beside the *arr applications it manages, which are themselves almost always run as containers — and an image the project publishes is one an operator does not have to build, audit, or keep in step with releases.

An image is also a second distribution channel, and the existing release contract governs only npm. Without its own rules an image could be published from an unmerged commit, could tag a development build as `latest`, or could carry a token baked in at build time. The [Architecture — Packaging and Release](../specs/architecture/#packaging-and-release) requirements this change adds close each of those.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules (see [Architecture — Testing Contract](../specs/architecture/#testing-contract)). CI enforces these as merge gates:

- Exported behavior MUST have automated tests at the narrowest practical level.
- MCP tools MUST keep their protocol-level stdio integration tests, and the HTTP transport MUST keep its protocol-level integration tests against a real listener.
- Committed tests MUST NOT be focused, skipped, or dependent on live personal *arr instances.
- Build, type check, lint, tests, and package verification MUST pass in CI.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

Additionally, because the image is a release artifact that only a Docker daemon can run:

- The image MUST be smoke-tested by a script that runs against images loaded from the one archive CI built, for every published platform, never against a rebuild, and publication MUST depend on it passing.
- Publication MUST copy that archive to the registry unchanged rather than build again, and MUST assert that every published tag resolves to the archive's index digest. A rebuild, even from a warm cache, can publish bytes that were never tested.
- The smoke test MUST NOT be a test in the suite: the suite runs anywhere without a Docker daemon, and a test that skipped itself without one would be the conditional test the contract forbids. It runs only in the Docker workflows.
- The smoke test MUST hold the running container to the listener contract the package verifier already checks — an unauthenticated health check, a bearer challenge without the token, a stateless initialization with it reporting the package's own version, the tool listing — and additionally to its user, its health check, its refusal to start without a token, and a clean exit on `docker stop`.
- The smoke test MUST pass every credential to the container through the Docker CLI's environment, never on a command line, and MUST assert that none appears in the container's output.
- Every wait in the smoke test — each HTTP exchange, each Docker CLI call, the health wait, and the stop — MUST be bounded, and every container it started MUST be removed on every path, failures included, so a container that accepts and never answers fails the run rather than hanging it.

### Functional requirements

The [Architecture — Packaging and Release](../specs/architecture/#packaging-and-release) requirements and scenarios are this change's acceptance criteria and are not restated here. What implementing them requires of this change:

- The image MUST install the packed tarball rather than copy a build output, so it runs exactly what `npx mcp-arr` runs.
- The server's runtime behavior and defaults in `src/` MUST NOT change: the container defaults are environment variables in the image, and every startup rejection is the server's own.
- The build context MUST be an allowlist, and a local `.mcp.json` or environment file MUST NOT be able to enter it.
- Every action a workflow uses MUST be pinned to a released tag, and the Dockerfile MUST pin its base image to an exact Node.js release.
- The README MUST document the image, its tags, a run example, a Compose example, and the constraints of the remote service that still apply, with placeholders only.

## Design

### Approach

- **`Dockerfile`** — two stages on `node:22.23.4-bookworm-slim`. The build stage runs `npm ci`, `npm run build`, and `npm pack`, on the build host's platform because its output is platform-independent. The runtime stage installs `tini` from Debian, installs the packed tarball with `npm install --global --omit=dev` from a bind mount so the tarball never becomes a layer, sets `ARR_MCP_TRANSPORT=http`, `ARR_MCP_HTTP_HOST=0.0.0.0`, and `ARR_MCP_HTTP_PORT=9797`, runs as `1000:1000`, exposes `9797`, stops on `SIGTERM`, and declares a health check that requests `/healthz` with `node:http` through `node -e`. OCI labels are the fallback for hand-built images; CI writes its own over them.
- **`.dockerignore`** — `*`, then the files the build stage reads, then `**/.mcp.json` and `**/.env*` excluded again after the allowlist.
- **`scripts/verify-image.mjs`** — the smoke test, given a local image tag and optionally `--platform`. When that platform is not the Docker daemon's own, the image runs under emulation: every bound is widened, and PID 1 is accepted as the emulator running `/usr/bin/tini` rather than `tini` itself, while every other assertion holds unchanged. It inspects the image's configuration, lists its contents as root, starts it without a token, then starts it with a random 64-hex token and placeholder Sonarr settings on a free loopback port and runs the listener checks, the uid and PID 1 checks, the health wait, and `docker stop`. It removes every container it started. The assertion and HTTP helpers it shares with `scripts/verify-package.mjs` move to `scripts/verification.mjs`.
- **`scripts/image-archive.mjs`** — the archive's three operations. `check` asserts the archive holds one image index of exactly `linux/amd64` and `linux/arm64`, annotated with a source and a non-empty description, and that every blob the index reaches — each manifest, configuration, and layer — is present and matches the digest and size its descriptor declares, hashing layers as they stream; it prints the index digest. `load` and `publish` run the same validation before they act. `load` writes one platform's image from the archive as a Docker archive with `skopeo` and loads it, then asserts the loaded image has that platform's configuration from the archive: its OS and architecture, its uncompressed layer digests in order, and every runtime setting the configuration declares. The image ID the daemon assigns is not compared, because it depends on the conversion and on the daemon's image store rather than on the content. `publish` asserts the archive is still the verified digest, copies it with `skopeo copy --all --preserve-digests` to every tag, and reads each tag back to assert it resolves to that digest.
- **`.github/workflows/docker.yml`** — on pull requests and pushes to `main`, except documentation-only changes and release pull requests. A read-only `verify` job runs hadolint, computes the tags and labels, builds both platforms once into an OCI archive with the GitHub Actions cache, checks it, loads and verifies the amd64 image and then the arm64 image under QEMU, and uploads the archive as a one-day workflow artifact. A `publish` job that needs it, runs on a push only, and alone holds `packages: write` downloads the archive, logs in, and publishes it tagged `main` and `sha-<commit>`. Nothing in it builds.
- **`.github/workflows/release.yml`** — a read-only `verify-image` job that needs both `release-please` and `publish`, checks out the released tag, and builds, verifies, and uploads the archive the same way; then a `publish-image` job that needs it, alone holds `packages: write`, and copies that archive to `X.Y.Z`, `X.Y`, and `latest`. The existing jobs are unchanged.

### Decisions

- **Decision:** Install the packed tarball in the runtime stage rather than copying `dist/` and a production `node_modules` from the build stage.
  - **Why:** The spec requires the image to run the published artifact. Installing the tarball goes through the same `files` allowlist, the same `bin` link, and the same dependency resolution an npm user gets, so the image cannot drift from the package — a file the package forgets is missing from the image too, where the package verifier already catches it.
  - **Alternatives considered:** Copying `dist/` with `npm ci --omit=dev`'s `node_modules`, rejected because it would run a tree the npm package never contains and resolve transitive dependencies from the lockfile rather than as published; copying the repository and running from source, rejected because it puts sources in the image, which the spec forbids.
  - **Accepted cost:** Transitive dependencies resolve from the package's declared ranges at build time, exactly as `npx mcp-arr` resolves them, rather than from `package-lock.json`. The direct dependencies are exact pins.
- **Decision:** Node.js 22, pinned to 22.23.4.
  - **Why:** The package declares `engines >=20`; 22 is a maintained LTS line, and 22.23.4 was the newest 22.x release more than two weeks old when this was written. The quality gates still run on Node.js 20, the floor.
  - **Alternatives considered:** Node.js 20, rejected because its support ended in April 2026; Node.js 24, a reasonable later bump that would need nothing but this ARG.
- **Decision:** The action majors current at the time: `docker/setup-buildx-action@v4`, `docker/login-action@v4`, `docker/metadata-action@v6`, `docker/build-push-action@v7`, `docker/setup-qemu-action@v4`, `actions/checkout@v7`, `actions/setup-node@v7`, and `hadolint/hadolint-action@v3.5.0`.
  - **Why:** The fx/ob workflow this is modelled on uses the previous Docker majors. The current ones break only by moving to the Node.js 24 action runtime and dropping options this workflow does not use, and the previous ones run on the Node.js 20 action runtime GitHub is retiring. `checkout` and `setup-node` match `release.yml`, the workflow this change also edits. hadolint is pinned to an exact release, which bundles hadolint 2.15.1.
  - **Alternatives considered:** The fx/ob majors, rejected for the runtime above; `@v4` checkout and setup-node to match `ci.yml`, rejected because the new jobs sit beside `release.yml`'s.
- **Decision:** Build once, for both platforms, into an OCI archive; smoke-test each platform's image loaded from that archive; publish by copying the archive, so the published index digest is the tested artifact's.
  - **Why:** Publication has to ship the bytes that were tested. A second build for the push treats the cache as a guarantee when it is only an optimization: any cache miss — the unpinned `tini` layer after a Debian point release, an evicted cache entry — rebuilds a layer nobody tested, and pushes it. Copying the archive leaves nothing to rebuild, and reading every tag back proves the registry holds that index.
  - **Alternatives considered:** Rebuilding for the push from the verified build's cache, which this change first did, rejected for the cache miss above; `docker push` of the loaded image, as fx/ob does, rejected because it publishes amd64 only and pushes what the daemon re-encoded rather than the build's own manifests; smoke-testing amd64 only, rejected because the arm64 bytes would then ship untested.
  - **Accepted cost:** The arm64 smoke test runs under QEMU on every pull request and is several times slower than amd64, so its bounds are widened; the archive, both platforms' layers, is uploaded as an artifact on every run and kept for one day.
- **Decision:** `skopeo`, as the runner provides it, to read the archive and to publish it.
  - **Why:** The GitHub-hosted Ubuntu image ships it (1.13.3 at the time of writing), so nothing is downloaded at run time. It copies an OCI archive's whole index with `--all`, and `--preserve-digests` refuses any copy that would change a manifest, so the registry receives the archive byte for byte or the step fails. It reads the credentials `docker/login-action` writes, so the token never appears in an argument. The image is loaded through a Docker archive and `docker load`, which every daemon reads whichever image store it uses, and identified by its layers and configuration rather than by the ID the daemon gives it.
  - **Alternatives considered:** `crane`, `oras`, or `regctl`, each rejected only because it would be one more pinned download; skopeo's `docker-daemon:` transport, rejected in favour of `docker load`, which needs nothing of the daemon's API but the load itself.
- **Decision:** The image description is set explicitly in the CI metadata, for both labels and annotations.
  - **Why:** `docker/metadata-action` fills `org.opencontainers.image.description` from the repository's description, which is empty, and its labels override the Dockerfile's. Stating the Dockerfile's text there gives the image configuration, every manifest, and the index the same non-empty description, and the verifier and `check` assert it.
  - **Alternatives considered:** Setting a repository description, rejected because the workflow would then depend on a repository setting nobody reviews with the code.
- **Decision:** No provenance attestation in the index.
  - **Why:** The index then holds exactly the two platform images, and `image-archive.mjs check` asserts that, so everything published is something the smoke tests ran. An attestation manifest would also be one more manifest kind for the copy to carry unchanged.
  - **Alternatives considered:** Keeping `build-push-action`'s default provenance, deferred to a change that decides how attestations are verified and published.
- **Decision:** Verification and publication are separate jobs, and only the publishing job can write to the registry.
  - **Why:** A job's token scope is fixed for the whole job, and a step's condition does not narrow it. The verification job builds and runs code from a pull request, so it holds `contents: read` and nothing else on every event; the publishing job runs only on a push to `main`, or after a verified release, and holds `packages: write`. It copies the verification job's archive, and takes the tags and the digest it must publish from that job's outputs.
  - **Alternatives considered:** One job with the publish steps conditioned on the event, rejected because every pull request run would then hold registry write access.
- **Decision:** Release image tags `X.Y.Z`, `X.Y`, and `latest`, and no bare major tag.
  - **Why:** The package is 0.x, where every minor release may break, so a `0` tag would move across breaking changes. `X.Y` is the line an operator can follow without being surprised.
  - **Alternatives considered:** Adding `{{major}}` as fx/ob does, deferred until the package reaches 1.0.
- **Decision:** Release images publish from a job in `release.yml` that needs the npm `publish` job, not from a tag-triggered run of `docker.yml`.
  - **Why:** It makes the spec's ordering a dependency rather than a convention: the image exists only once the merged release passed its quality gates and reached npm, and a failed npm publish skips it.
  - **Alternatives considered:** A `push: tags` trigger on `docker.yml`, as fx/ob uses, rejected because a tag-triggered run starts when the tag is created, before and regardless of the npm publish.
- **Decision:** The image serves HTTP only.
  - **Why:** The image sets `ARR_MCP_HTTP_HOST` and `ARR_MCP_HTTP_PORT`, and the server rejects either under stdio by design, so the image cannot start over stdio without rewriting its environment. A stdio host already has `npx mcp-arr`, which needs no container.
  - **Alternatives considered:** Leaving the host and port unset, rejected because the default `127.0.0.1` listener is unreachable from outside a container; relaxing the server's rejection, rejected as a change to the server's behavior, which is out of scope.
- **Decision:** The health check probes loopback when the listener binds every interface, and the configured address otherwise.
  - **Why:** It reads the same variables the server does, so moving the port or binding one address does not turn a healthy container unhealthy. It uses the image's own Node.js, so no HTTP client is installed for it, and `node:http` with the address and port as separate options, so every value the server accepts is reachable. The request is destroyed after four seconds, inside the health check's own five-second timeout.
  - **Alternatives considered:** `curl`, as fx/ob uses, rejected as a package installed for one command; `fetch`, rejected because it refuses the ports the Fetch standard blocks — a listener on 6000 would be reported unhealthy — and a URL cannot carry a scoped IPv6 address.
- **Decision:** The README publishes the port on the host's loopback, `127.0.0.1:9797:9797`.
  - **Why:** The listener speaks plain HTTP and the token is its only defense, so the example an operator copies should not expose it to the network before the reverse proxy the README requires is in place.
  - **Alternatives considered:** `-p 9797:9797`, rejected as the unsafe default to copy.

### Non-Goals

- Docker Hub or any registry other than the GitHub Container Registry.
- Kubernetes manifests, Helm charts, or Compose files beyond the README example.
- TLS inside the container, or any change to the server's runtime behavior or defaults.
- A stdio image.
- Image signing, SBOMs, or provenance attestations.

## Tasks

- [x] Build the image
  - [x] Add `Dockerfile` with the two stages, `tini`, uid 1000, the HTTP defaults, `STOPSIGNAL SIGTERM`, the `/healthz` health check, and the OCI labels
  - [x] Add `.dockerignore` as an allowlist that re-excludes `.mcp.json` and environment files
  - [x] Add `scripts/verify-image.mjs`, sharing `scripts/verification.mjs` with `scripts/verify-package.mjs`, with `--platform` for the emulated arm64 run
  - [x] Add `scripts/image-archive.mjs` to check the archive, load each platform from it, and publish it unchanged
- [x] Publish from CI
  - [x] Add `.github/workflows/docker.yml`: a read-only `verify` job (hadolint, one two-platform archive build, both platforms verified, archive uploaded) and a `publish` job that copies that archive as the development image on `main` only
  - [x] Add the `verify-image` and `publish-image` jobs to `.github/workflows/release.yml` after the npm publish
- [x] Document and specify
  - [x] Add "Run with Docker" to `README.md`
  - [x] Add the container image requirements and scenarios to [Architecture — Packaging and Release](../specs/architecture/#packaging-and-release), with a changelog row
- [x] CI builds and smoke-tests the image on this PR — both platforms built into one archive, and the amd64 and emulated arm64 images loaded from it and verified; the publish job's copy to GHCR runs only on a push to `main` and is verified after merge

## Open Questions

- **Package visibility.** The first push creates `ghcr.io/fx/mcp-arr` as a private package, and the workflow token cannot change that. A maintainer makes it public once, under the package's settings on GitHub, after the first development image is published; until then `docker pull` needs authentication.

## References

- Spec: [Architecture](../specs/architecture/)
- Related changes: [0011-npm-publishing](./0011-npm-publishing.md), [0030-streamable-http-transport](./0030-streamable-http-transport.md)
