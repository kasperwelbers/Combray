# The tasks behind the scripts in package.json (`pnpm dev`, `pnpm test`, ...), which run them
# with the just that `pnpm install` provides. Add a script there for each new recipe.

default:
    @just --list

# Install JavaScript dependencies
install:
    pnpm install

# Run the web client with hot reload (http://localhost:5173) and the server it talks to (:8080)
dev:
    concurrently --kill-others --names web,server --prefix-colors auto "pnpm --filter @combray/web dev" "just server http://localhost:5173"

# Development settings for the server: the example projects, with every database, the store
# master key and sign-in mails under target/dev, which is not committed.
server_cmd := "node --disable-warning=ExperimentalWarning apps/server/src/main.ts"
dev_env := "COMBRAY_WEB_DIR=apps/web/dist COMBRAY_DATA_DIR=deploy/examples COMBRAY_BIND=127.0.0.1:8080 COMBRAY_DB=target/dev/combray.sqlite COMBRAY_STORE_MASTER_KEY_FILE=target/dev/store-master.key COMBRAY_RESEARCH_DB=target/dev/research.sqlite COMBRAY_DONATION_KEYS_DB=target/dev/donation-keys.sqlite COMBRAY_PUBLIC_URL=http://localhost:8080 COMBRAY_KEYS_URL=http://keys.localhost:8080 COMBRAY_MAIL_OUTBOX=target/dev/outbox"

# Serves whatever is in apps/web/dist and apps/keys/dist: participant app and studio on
# http://localhost:8080, the key page on http://keys.localhost:8080. Sign-in codes are written to
# target/dev/outbox instead of mailed. Donations go to deploy/examples/donations (ignored by git).
# Run the server without building first (`pnpm dev` runs it next to the web client, as the main
# site's address, so studio sign-in and the key page's links work there)
server public_url="http://localhost:8080":
    {{dev_env}} COMBRAY_PUBLIC_URL={{public_url}} {{server_cmd}}

# Build the web client and key page, then run the server (http://localhost:8080)
serve: build-web build-keys server

# Add a researcher to the development server and a project: pnpm researcher ada@uni.example example
researcher email project:
    {{dev_env}} {{server_cmd}} researcher add {{email}}
    {{dev_env}} {{server_cmd}} project add-researcher {{project}} {{email}}

# Seal a synthetic donation to a project's key and send it: pnpm synthetic-donation http://localhost:8080 example
synthetic-donation server project:
    node apps/keys/scripts/run.mjs synthetic-donation {{server}} {{project}}

# Run all tests
test: test-client test-server

# Web client, key page and packages
test-client:
    pnpm -r --filter '!@combray/server' test

# The server, over HTTP (apps/server/test)
test-server:
    pnpm --filter @combray/server test

# Type checks
check:
    pnpm -r typecheck

build-web:
    pnpm --filter @combray/web build

# The key page as one HTML file, with its SHA-256 (apps/keys/dist)
build-keys:
    pnpm --filter @combray/keys build

# The key page end to end: real server, Chromium with a virtual passkey
e2e: build-web build-keys
    pnpm --filter @combray/keys e2e

# Build everything (the server runs from its TypeScript sources and needs no build)
build: build-web build-keys

# Build the server image
docker:
    docker build -t combray-server:dev .
