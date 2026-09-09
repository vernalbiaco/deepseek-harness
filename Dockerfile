# syntax=docker/dockerfile:1

# Builds the dsh CLI (apps/cli) and its web frontend (apps/web) from source.
# The workspace's in-box bundles (@deepseek-ai/dsh-web-app, @deepseek-ai/dsh-headless, ...)
# resolve through node_modules at runtime rather than bundling statically, so the
# runtime image keeps the whole built workspace tree, not just apps/cli's output.

FROM node:22-bookworm-slim AS builder

# python3/make/g++ satisfy pnpm's allowed native build scripts (esbuild, node-pty, koffi).
# git is required by scripts/build.ts, which embeds the current commit hash.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable

WORKDIR /app

COPY . .

RUN pnpm install --frozen-lockfile
RUN pnpm run build
# .git is only needed to stamp the build; the runtime image doesn't ship repository history.
RUN rm -rf .git

FROM node:22-bookworm-slim AS runtime

# git is the agent's push path: docker-compose.yml mounts a system gitconfig
# and credential helper that drive it over HTTPS. Installing it here rather
# than inside a running container keeps it across `docker compose up`, which
# recreates the container from this image. ca-certificates lets git verify
# github.com.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable

WORKDIR /app

COPY --from=builder /app /app

ENV NODE_ENV=production
ENV DSH_HOME=/root/.dsh

ENTRYPOINT ["node", "/app/apps/cli/lib/bin.js"]
CMD ["--help"]
