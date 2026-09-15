# syntax=docker/dockerfile:1

# Builds the dsh CLI (apps/cli) and its web frontend (apps/web) from source.
# The workspace's in-box bundles (@deepseek-ai/dsh-web-app, @deepseek-ai/dsh-headless, ...)
# resolve through node_modules at runtime rather than bundling statically, so the
# runtime image keeps the whole built workspace tree, not just apps/cli's output.

FROM node:22-bookworm-slim AS builder

# python3/make/g++ satisfy pnpm's allowed native build scripts (esbuild, node-pty, koffi).
# git is required by scripts/build.ts, which embeds the current commit hash.
# musl-tools builds the Landlock launcher below.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates musl-tools \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable

WORKDIR /app

COPY . .

RUN pnpm install --frozen-lockfile
# The bash sandbox probes for the static Landlock launcher in the workspace's
# linux-x64 platform package. The workspace ships its C source, not the
# binary, so build it here; without it every sandboxed bash call fails closed
# (the image has no bwrap either). The binary lands under native/ and rides
# the /app copy into the runtime stage.
RUN pnpm --dir native/landlock-run run build:native
RUN pnpm run build
# .git is only needed to stamp the build; the runtime image doesn't ship repository history.
RUN rm -rf .git

FROM node:22-bookworm-slim AS runtime

# git is the agent's push path: docker-compose.yml mounts a system gitconfig
# and credential helper that drive it over HTTPS. Installing it here rather
# than inside a running container keeps it across `docker compose up`, which
# recreates the container from this image. ca-certificates lets git verify
# github.com. The upgrade applies the Debian security updates published since
# upstream last rebuilt the base tag; a cached layer keeps the packages of the
# build that created it, so release builds pass --no-cache.
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get upgrade -y --no-install-recommends \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable

WORKDIR /app

COPY --from=builder /app /app

ENV NODE_ENV=production
ENV DSH_HOME=/root/.dsh

ENTRYPOINT ["node", "/app/apps/cli/lib/bin.js"]
CMD ["--help"]
