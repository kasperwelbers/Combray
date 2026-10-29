# Combray server image: the Rust server plus the built web client.
# Build from the repository root:  docker build -t combray-server .

FROM node:22-bookworm-slim AS web
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/web/package.json apps/web/
COPY packages/core/package.json packages/core/
COPY packages/store/package.json packages/store/
COPY importers/package.json importers/
RUN pnpm install --frozen-lockfile
COPY apps/web apps/web
COPY packages packages
COPY importers importers
RUN pnpm --filter @combray/web build

FROM rust:1-slim-bookworm AS server
WORKDIR /src
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY crates crates
RUN cargo build --release --locked -p combray-server

FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=server /src/target/release/combray-server /usr/local/bin/combray-server
COPY --from=web /src/apps/web/dist /app/web
ENV COMBRAY_BIND=0.0.0.0:8080 \
    COMBRAY_WEB_DIR=/app/web \
    COMBRAY_DATA_DIR=/data \
    COMBRAY_MASTER_KEY_FILE=/run/secrets/combray_master_key
EXPOSE 8080
USER nonroot
ENTRYPOINT ["/usr/local/bin/combray-server"]
