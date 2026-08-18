FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# Without this, the first pnpm call in the runtime stage prompts "Do you want to
# continue? [Y/n]" and hangs forever under `docker compose up -d` (no TTY).
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

FROM base AS deps
WORKDIR /app
# python3/make/g++ are required to compile better-sqlite3 from source.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM base AS runtime
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
# pnpm-workspace.yaml and the lockfile must reach the runtime stage too: pnpm 11
# runs a dependency-state check before every script, and without them it tries to
# re-resolve, loses the build allowlist, and dies with ERR_PNPM_IGNORED_BUILDS.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
# Bake pnpm into the image so the container never downloads it at start.
# Version comes from package.json's packageManager field — no duplication.
RUN corepack prepare --activate
COPY migrations ./migrations
COPY src ./src

# A runtime container's node_modules is baked into the image and immutable, so
# re-verifying it before every command is pure downside — it can only fail.
ENV npm_config_verify_deps_before_run=false
ENV BELLWETHER_DB=/data/bellwether.db
ENV BELLWETHER_EXPORT_DIR=/app/web/public/data
ENV TZ=America/Chicago

ENTRYPOINT ["pnpm", "bw"]
CMD ["doctor"]
