# Deployment

Combray has three components (see [architecture.md](architecture.md)): **Studio** on each researcher's computer, the **web client** in participants' browsers, and a shared **server**. The intended setup is that a university runs one server, and any researcher, with no programming experience, uses it from Studio.

## Targets

| Target | How | Who |
| --- | --- | --- |
| **University server** | `docker compose up -d` on a VM, TLS through Caddy | University IT or research support, once, for all researchers |
| **Researcher tool** | Download Combray Studio for Windows, macOS or Linux, double-click | Every researcher |
| **Lab laptop** | One `combray-server` binary on the laptop, plus Studio | A lab without a university server, or offline sessions |

## Combray Studio

A single signed binary per platform. It starts a local web UI on `127.0.0.1` (random port, per-launch token) and opens it in the default browser. It keeps its own data folder (projects, encrypted private key files, downloaded donations, exports) in the user's documents or app-data directory, and never listens on the network. Updates are offered from inside Studio and verified against release signatures.

## Server as a single binary

The `combray-server` binary (Rust, statically linked) embeds the built web client, so it has no runtime dependencies. It is multi-tenant: many researchers and projects on one installation. It stores state in its own data directory:

```
combray-data/
├── combray.toml        config
├── combray.sqlite      store key records (built); later researcher accounts, projects, sessions, receipts, enrichment cache
├── projects/           signed project configs and platform packs
├── donations/          encrypted envelopes (unless S3 is configured)
```

No object storage is needed: donations and vault blobs live in this directory by default. S3 is an optional backend.

The **master key** (32 random bytes) from which every store's key is derived comes from a file outside the data directory (`COMBRAY_MASTER_KEY_FILE`, a Docker secret in the compose setup), so a backup of the data directory alone contains no usable keys. Back it up separately: losing it makes every participant's local store unreadable. See [security.md](security.md#store-keys).

## Docker compose

A sketch of the default stack:

```yaml
services:
  combray:
    image: ghcr.io/kasperwelbers/combray-server:latest
    restart: unless-stopped
    environment:
      COMBRAY_PUBLIC_URL: https://combray.example.edu
      COMBRAY_MASTER_KEY_FILE: /run/secrets/combray_master_key
      # COMBRAY_S3_URL: s3://combray-donations
    secrets: [combray_master_key]
    volumes:
      - ./combray-data:/data
    read_only: true
    cap_drop: [ALL]

  caddy:
    image: caddy:2
    ports: ["80:80", "443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data

  # Optional services, enabled with compose profiles:
  minio:           # S3-compatible storage for donations and vault   (profile: s3)
  browser:         # headless Chromium for JavaScript-only enrichers (profile: browser)
  llm:             # local model for the AI helper (llama.cpp/Ollama) (profile: ai)

secrets:
  combray_master_key:
    file: ./secrets/master_key

volumes:
  caddy-data:
```

`docker compose --profile s3 --profile ai up -d` adds the optional parts. The main image is built `FROM scratch` (or distroless) and runs as a non-root user with a read-only root filesystem.

## A project, end to end

1. **IT** sets up the university server once and creates researcher accounts (or enables SSO).
2. **The researcher** installs Studio and creates a project. Studio generates the key pair and walks them through saving the private key (encrypted key file, printed recovery sheet, a copy with the data steward).
3. In Studio, they pick platform packs, importers, views and questions, and preview the participant experience.
4. They connect Studio to the university server, log in, and register the project. Studio uploads the signed config and public key.
5. Studio creates participant codes and printable cards with QR links (which carry the signing key fingerprint, see [privacy-and-encryption.md](privacy-and-encryption.md#key-management)).
6. Sessions run in the lab: participants open the link in a browser.
7. The researcher downloads encrypted donations in Studio and decrypts and exports them locally.

Everything in Studio is also available as CLI commands (`combray project create`, `combray project register`, `combray donations decrypt`, and so on) for those who prefer scripts.

## Operations

- Health endpoint, structured logs without data values, Prometheus metrics (counts and timings only).
- Backups: the data directory and the bucket contain only ciphertext and metadata; the master key and project private keys are backed up separately.
- Upgrades: database migrations run on startup; the binary refuses to start if a migration would lose data without an explicit flag.
- Releases: signed binaries for Linux (x86_64, aarch64), macOS and Windows, and a multi-arch image on GHCR, with published SPA bundle hashes.

## Open questions

- Do we need Windows lab laptops as a first-class target (likely yes in many universities), and should the binary install itself as a service there?
- Should the server have a small admin web UI for IT (accounts, quotas, health), or is a CLI enough? Recommendation: CLI first.
- Should Studio be code-signed and notarised from the first release? Unsigned binaries trigger scary warnings on Windows and macOS, which matters for non-technical researchers. Recommendation: yes.
- Is S3 needed in v1, or is the filesystem plus regular backups enough for most labs?
