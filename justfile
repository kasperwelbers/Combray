# Common tasks. Install just: https://github.com/casey/just

default:
    @just --list

# Install JavaScript dependencies
install:
    pnpm install

# Run the web client with hot reload (http://localhost:5173)
dev:
    pnpm --filter @combray/web dev

# Development settings for the server: the example projects, with every database, the store
# master key and sign-in mails under target/dev, which is not committed.
dev_env := "COMBRAY_WEB_DIR=apps/web/dist COMBRAY_DATA_DIR=deploy/examples COMBRAY_BIND=127.0.0.1:8080 COMBRAY_DB=target/dev/combray.sqlite COMBRAY_STORE_MASTER_KEY_FILE=target/dev/store-master.key COMBRAY_RESEARCH_DB=target/dev/research.sqlite COMBRAY_DONATION_KEYS_DB=target/dev/donation-keys.sqlite COMBRAY_PUBLIC_URL=http://localhost:8080 COMBRAY_KEYS_URL=http://keys.localhost:8080 COMBRAY_MAIL_OUTBOX=target/dev/outbox"

# Run the server: participant app and studio on http://localhost:8080, the key page on
# http://keys.localhost:8080. Sign-in links are written to target/dev/outbox instead of mailed.
# Donations go to deploy/examples/donations (ignored by git).
serve: build-web build-keys
    {{dev_env}} cargo run -p combray-server

# Add a researcher to the development server and a project: just researcher ada@uni.example example
researcher email project:
    {{dev_env}} cargo run -q -p combray-server -- researcher add {{email}}
    {{dev_env}} cargo run -q -p combray-server -- project add-researcher {{project}} {{email}}

# Seal a synthetic donation to a project's key and send it: just synthetic-donation http://localhost:8080 example
synthetic-donation server project:
    node apps/keys/scripts/run.mjs synthetic-donation {{server}} {{project}}

# Run all tests
test:
    pnpm -r test
    cargo test --workspace

# Type checks, lints and formatting checks
check:
    pnpm -r typecheck
    cargo fmt --all --check
    cargo clippy --workspace --all-targets -- -D warnings

build-web:
    pnpm --filter @combray/web build

# The key page as one HTML file, with its SHA-256 (apps/keys/dist)
build-keys:
    pnpm --filter @combray/keys build

# The key page end to end: real server, Chromium with a virtual passkey
e2e: build-web build-keys
    cargo build -p combray-server
    pnpm --filter @combray/keys e2e

# Build everything
build: build-web build-keys
    cargo build --release -p combray-server

# Build the server image
docker:
    docker build -t combray-server:dev .
