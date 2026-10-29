# Deployment

Researchers and IT staff should be able to run Combray with one command, on hardware they already have, and understand what is running.

## Targets

| Target | How | Who |
| --- | --- | --- |
| **Lab laptop** | Download one binary, run `combray serve`, open `http://localhost:8080` | A researcher running sessions in a room |
| **University VM** | `docker compose up -d` with TLS through Caddy | Research support / IT, several lab machines and remote participants |
| **Browser only** | Static files on any web host | Remote, low-touch studies without enrichment |

## Single binary

The `combray` binary (Rust, statically linked) embeds the built SPA, so it has no runtime dependencies. It stores state in a data directory:

```
combray-data/
├── combray.toml        config
├── combray.sqlite      studies, sessions, receipts, enrichment cache
├── studies/            signed study configs and platform packs
├── donations/          encrypted envelopes (unless S3 is configured)
└── keys/               server secrets for local-store unlock (encrypted with the master key)
```

The master key that protects `keys/` comes from an environment variable or a file outside the data directory (e.g. a Docker secret), so a backup of the data directory alone does not contain usable keys.

## Docker compose

A sketch of the default stack:

```yaml
services:
  combray:
    image: ghcr.io/kasperwelbers/combray:latest
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

## Browser-only build

`pnpm build --mode static` produces a static site that works without a Combray server:

- Local store unlocked with a passphrase (see [privacy-and-encryption.md](privacy-and-encryption.md#unlock-modes)).
- No enrichment and no server-side AI proxy.
- Donations either go to a configured endpoint that accepts Combray envelopes (for example a minimal intake service, or an existing platform like OSD2F if it adds support), or are downloaded by the participant as an encrypted file to upload elsewhere.

## Study setup, end to end

1. `combray study keygen --study willow` on the researcher's own machine. Keep the private key safe.
2. Write `willow.study.yaml`: platform packs, importers, probes, enrichers, donation pipeline, public key.
3. `combray study sign willow.study.yaml`, then upload to the server (CLI or researcher UI).
4. Create participant codes (`combray participants create --study willow --count 40`), print them on cards.
5. Run sessions.
6. `combray donations pull --study willow` and `combray donations decrypt` on the researcher's machine; export to Parquet or CSV.

## Operations

- Health endpoint, structured logs without data values, Prometheus metrics (counts and timings only).
- Backups: the data directory and the bucket contain only ciphertext and metadata; the master key and study private keys are backed up separately.
- Upgrades: database migrations run on startup; the binary refuses to start if a migration would lose data without an explicit flag.
- Releases: signed binaries for Linux (x86_64, aarch64), macOS and Windows, and a multi-arch image on GHCR, with published SPA bundle hashes.

## Open questions

- Do we need Windows lab laptops as a first-class target (likely yes in many universities), and should the binary install itself as a service there?
- Should the researcher UI (study builder, Importer Studio, donation dashboard) be part of the same server, or a separate admin binary? Recommendation: same binary, separate authenticated routes.
- Is S3 needed in v1, or is the filesystem plus regular backups enough for most labs?
