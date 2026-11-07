# syntax=docker/dockerfile:1.7
#
# Container image for mcp-arr, serving MCP over Streamable HTTP.
#
# The build stage packs the package exactly as `npm publish` would, and the
# runtime stage installs that tarball the way `npx mcp-arr` does, so the image
# runs the published artifact and nothing else: no sources, tests, fixtures,
# or development dependencies reach it.
#
# Pinned toolchain. Node.js 22 is a maintained LTS line inside the package's
# `engines` range of >=20; bump the exact patch deliberately. ARGs declared
# before the first FROM are global, and each stage that reads one redeclares it.
ARG NODE_VERSION=22.23.4

# ── Stage 1: build ───────────────────────────────────────────────────────────
# Its output is JavaScript and a tarball, identical on every platform, so it
# runs natively on the build host and only the runtime stage is built per
# target platform.
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /build

# Manifests first, so a source edit does not reinstall dependencies. `.npmrc`
# carries the engine-strict and strict-peer-deps settings CI installs with.
COPY package.json package-lock.json .npmrc ./
RUN npm ci --no-audit --no-fund

# `npm pack` adds README.md and LICENSE to the tarball, as it does on publish.
COPY tsconfig.json tsconfig.build.json README.md LICENSE ./
COPY src ./src
RUN npm run build \
 && mkdir /pack \
 && npm pack --pack-destination /pack \
 && mv /pack/mcp-arr-*.tgz /pack/mcp-arr.tgz

# ── Stage 2: runtime ─────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS runtime

# tini runs as PID 1 so SIGTERM reaches the server and orphans are reaped.
# Installed unpinned on purpose: Debian removes superseded versions from the
# archive on every point release, so an exact pin breaks unrelated builds; the
# pinned base image is what makes this layer reproducible. DL3008 asks for
# exactly that pin, so it is silenced for this one instruction.
# hadolint ignore=DL3008
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*

# The packed tarball is mounted rather than copied, so it never becomes a
# layer. Production dependencies only, resolved as an npm user's install
# resolves them, under the same engine check.
RUN --mount=type=bind,from=build,source=/pack,target=/pack \
    npm_config_engine_strict=true npm install --global --omit=dev --no-audit --no-fund \
      /pack/mcp-arr.tgz \
 && npm cache clean --force

# A container defaults to the HTTP transport on every interface. No token and
# no instance is set here: startup refuses until the operator supplies
# ARR_MCP_AUTH_TOKEN and at least one instance pair.
ENV ARR_MCP_TRANSPORT=http \
    ARR_MCP_HTTP_HOST=0.0.0.0 \
    ARR_MCP_HTTP_PORT=9797

# The base image's non-root `node` user, by number so a runtime can verify it.
USER 1000:1000
WORKDIR /home/node

EXPOSE 9797

# The server stops accepting connections on SIGTERM and lets requests in
# progress finish for no longer than ARR_UPSTREAM_TIMEOUT_MS (30 s by default).
STOPSIGNAL SIGTERM

# Liveness through the unauthenticated /healthz, using the image's own Node.js
# so no HTTP client is installed for it. It probes loopback when the listener
# binds every interface, and the configured address otherwise.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "const host = (process.env.ARR_MCP_HTTP_HOST ?? '').trim(); const target = host === '' || host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host; const port = (process.env.ARR_MCP_HTTP_PORT ?? '').trim() || '9797'; fetch(`http://${target}:${port}/healthz`, { signal: AbortSignal.timeout(4000) }).then((response) => process.exit(response.status === 200 ? 0 : 1), () => process.exit(1));"]

# OCI metadata. CI's metadata step writes its own labels over these; they are
# the fallback that lets a hand-built image describe itself. Declared last so
# a new revision invalidates no earlier layer.
ARG GIT_SHA=dev
ARG VERSION=dev
LABEL org.opencontainers.image.title="mcp-arr" \
      org.opencontainers.image.description="An MCP server for Sonarr, Radarr, and Prowlarr over Streamable HTTP" \
      org.opencontainers.image.source="https://github.com/fx/mcp-arr" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.licenses="MIT"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["mcp-arr"]
