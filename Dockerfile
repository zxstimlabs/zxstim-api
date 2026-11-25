# syntax=docker/dockerfile:1
#
# Stages:
#   deps     — dependencies from bun.lock only (frozen; no re-resolution)
#   build    — compiles the standalone binary (flags live in package.json "build")
#   runtime  — the binary plus committed migrations on distroless: non-root,
#              no shell, no package manager
#
# No secrets are baked in: ARBITRUM_SEPOLIA_RPC_URL and
# HOT_MANAGER_WALLET_PRIVATE_KEY are supplied at container start. The image is
# safe to publish.

ARG BUN_VERSION=1.4.5

FROM oven/bun:${BUN_VERSION} AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN bun run build && mkdir -p /out/data

FROM gcr.io/distroless/base-debian12:nonroot AS runtime
WORKDIR /app
COPY --from=build /app/build/zxstim-api /app/zxstim-api
# Applied on startup (src/lib/db.ts), relative to WORKDIR.
COPY drizzle ./drizzle
# The SQLite volume mounts here. A new named volume takes this directory's
# owner, so nonroot can write the DB and its WAL files.
COPY --from=build --chown=65532:65532 /out/data /data
ENV HOST=0.0.0.0 \
    PORT=8000 \
    DATABASE_PATH=/data/sqlite.db
USER nonroot
EXPOSE 8000
ENTRYPOINT ["/app/zxstim-api"]
