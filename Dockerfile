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
RUN bun run build && mkdir -p /out/data/defi /out/data/cefi

FROM gcr.io/distroless/base-debian12:nonroot AS runtime
WORKDIR /app
COPY --from=build /app/build/zxstim-api /app/zxstim-api
# Applied on startup, relative to WORKDIR: drizzle/defi/ by src/lib/db.ts,
# drizzle/cefi/ by src/modules/cefi/db.ts.
COPY drizzle ./drizzle
# One folder per DB, each its own volume mount: /data/defi (DeFi indexer DB,
# disposable) and /data/cefi (CeFi accounts DB, keep). A new named volume
# takes the directory's owner, so nonroot can write the DBs and their WAL files.
COPY --from=build --chown=65532:65532 /out/data /data
ENV HOST=0.0.0.0 \
    PORT=8000 \
    CEFI_PORT=8001 \
    DEFI_DATABASE_PATH=/data/defi/defi.db \
    CEFI_DATABASE_PATH=/data/cefi/cefi.db
USER nonroot
# 8000: main API (api.zxstim.com). 8001: CeFi API (api.cefi.vn), only when CEFI_ENABLED=1.
EXPOSE 8000 8001
ENTRYPOINT ["/app/zxstim-api"]
