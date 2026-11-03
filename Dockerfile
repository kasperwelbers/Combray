# Combray server image: the Node server, the built web client and the key page.
# Build from the repository root:  docker build -t combray-server .

FROM node:24-bookworm-slim AS build
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/web/package.json apps/web/
COPY apps/keys/package.json apps/keys/
COPY apps/server/package.json apps/server/
COPY packages/core/package.json packages/core/
COPY packages/store/package.json packages/store/
COPY packages/seal/package.json packages/seal/
COPY importers/package.json importers/
RUN pnpm install --frozen-lockfile
COPY apps apps
COPY packages packages
COPY importers importers
RUN pnpm --filter @combray/web build && pnpm --filter @combray/keys build
# The server with its production dependencies only, in a folder of its own.
RUN pnpm --filter @combray/server deploy --prod --legacy /out/server

# Distroless: Node and nothing else (no shell, no package manager), running as a non-root user.
FROM gcr.io/distroless/nodejs24-debian12:nonroot
COPY --from=build /out/server /app/server
COPY --from=build /src/apps/web/dist /app/web
COPY --from=build /src/apps/keys/dist /app/keys
ENV NODE_ENV=production \
    COMBRAY_BIND=0.0.0.0:8080 \
    COMBRAY_WEB_DIR=/app/web \
    COMBRAY_KEYS_PAGE=/app/keys/index.html \
    COMBRAY_DATA_DIR=/data \
    COMBRAY_STORE_MASTER_KEY_FILE=/run/secrets/combray_store_master_key
EXPOSE 8080
WORKDIR /app/server
# Without arguments it runs the server; with arguments, an operator command, e.g.
#   docker compose run --rm combray researcher add ada@uni.example
# (node:sqlite still reports itself as experimental, hence the flag).
ENTRYPOINT ["/nodejs/bin/node", "--disable-warning=ExperimentalWarning", "/app/server/src/main.ts"]
