# Combray server image: the Rust server, the built web client and the key page.
# Build from the repository root:  docker build -t combray-server .

FROM node:22-bookworm-slim AS web
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/web/package.json apps/web/
COPY apps/keys/package.json apps/keys/
COPY packages/core/package.json packages/core/
COPY packages/store/package.json packages/store/
COPY packages/seal/package.json packages/seal/
COPY importers/package.json importers/
RUN pnpm install --frozen-lockfile
COPY apps/web apps/web
COPY apps/keys apps/keys
COPY packages packages
COPY importers importers
RUN pnpm --filter @combray/web build && pnpm --filter @combray/keys build

FROM rust:1-slim-bookworm AS server
WORKDIR /src
# webauthn-rs and the mail client link OpenSSL; the distroless runtime ships libssl3.
RUN apt-get update && apt-get install -y --no-install-recommends pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY crates crates
RUN cargo build --release --locked -p combray-server

FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=server /src/target/release/combray-server /usr/local/bin/combray-server
COPY --from=web /src/apps/web/dist /app/web
COPY --from=web /src/apps/keys/dist /app/keys
ENV COMBRAY_BIND=0.0.0.0:8080 \
    COMBRAY_WEB_DIR=/app/web \
    COMBRAY_KEYS_PAGE=/app/keys/index.html \
    COMBRAY_DATA_DIR=/data \
    COMBRAY_STORE_MASTER_KEY_FILE=/run/secrets/combray_store_master_key
EXPOSE 8080
USER nonroot
ENTRYPOINT ["/usr/local/bin/combray-server"]
