# Common tasks. Install just: https://github.com/casey/just

default:
    @just --list

# Install JavaScript dependencies
install:
    pnpm install

# Run the web client with hot reload (http://localhost:5173)
dev:
    pnpm --filter @combray/web dev

# Run the server against the built web client and the example projects. Store keys and a
# development master key go to target/dev, which is not committed.
serve: build-web
    COMBRAY_WEB_DIR=apps/web/dist COMBRAY_DATA_DIR=deploy/examples \
    COMBRAY_DB=target/dev/combray.sqlite COMBRAY_MASTER_KEY_FILE=target/dev/master.key \
    cargo run -p combray-server

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

# Build everything
build: build-web
    cargo build --release -p combray-server

# Build the server image
docker:
    docker build -t combray-server:dev .
