# Architecture

## Overview

Combray has two deployable parts and one shared core:

- **Client**: a React single-page app that does nearly all the work: importing, storing, processing, visualising, asking questions, and encrypting donations. It runs in any modern browser.
- **Server**: a small, single binary that serves the client, handles sessions and key unwrapping, fetches URL metadata for consented enrichment, and accepts encrypted donations. It never sees plaintext participant data, except the specific URLs a participant consents to enrich.
- **Core**: a Rust library (`combray-core`) with the tree model, path language, shape extraction, unfolding and aggregation. It compiles to WebAssembly for the client and to native code for the server and CLI, so both sides agree exactly on formats.

```
                       ┌──────────────────────────────────────────────┐
                       │                  Browser                     │
                       │                                              │
  DDP (zip/files) ───► │  main thread: React UI (no heavy work)       │
                       │      │  Comlink                              │
                       │      ▼                                       │
                       │  workers                                     │
                       │   ├─ import worker: unzip, parse ─► tree     │
                       │   │    (combray-core wasm)                   │
                       │   ├─ query worker: unfold, filter, aggregate │
                       │   │    (combray-core wasm)                   │
                       │   ├─ sandbox worker: QuickJS, WASM plugins   │
                       │   └─ crypto worker: AES-GCM, HPKE            │
                       │      │                                       │
                       │      ▼                                       │
                       │  encrypted store: IndexedDB (+ OPFS blobs)   │
                       └───────┬──────────────┬──────────────┬────────┘
                               │ session/keys │ consented    │ ciphertext
                               │              │ URLs         │ donations
                       ┌───────▼──────────────▼──────────────▼────────┐
                       │  combray server (Rust, axum)                 │
                       │   ├─ static SPA + study configs              │
                       │   ├─ auth: participant codes, researchers    │
                       │   ├─ key service: wrap/unwrap store keys     │
                       │   ├─ enrichment: fetch queue + shared cache  │
                       │   └─ donation intake ─► filesystem or S3     │
                       │  SQLite for metadata                         │
                       └──────────────────────────────────────────────┘
                                         │
                         researcher CLI: keygen, decrypt, export
                         (private key offline or in a separate vault)
```

## Client

**Framework.** React with TypeScript, built with Vite, as a single-page app. React keeps continuity with DigitalFootprintsLab, has the largest pool of contributors in research software teams, and has good libraries for charts and accessibility. Alternatives considered:

| Option | For | Against |
| --- | --- | --- |
| **React SPA (Vite)** | Familiar, huge ecosystem, works as static files | Larger runtime than Svelte/Solid; needs discipline to keep heavy work off the main thread |
| Svelte / SolidJS | Smaller bundles, fine-grained reactivity | Smaller ecosystem, fewer contributors know it |
| Next.js / Remix | Routing and SSR conveniences | SSR is the opposite of what we want; implies a Node server |
| Tauri desktop app | Native packaging, Rust backend | Separate install per platform; loses "just open a URL"; still worth revisiting later as a wrapper |

Recommendation: **React SPA with Vite**. It also works as an installable PWA so a lab laptop can run it fully offline.

**State and storage.** UI state in a small store (Zustand or React context; no Redux). Persistent data lives in IndexedDB, encrypted per record (see [privacy-and-encryption.md](privacy-and-encryption.md)). Large datasets are stored in chunks so they can be decrypted and streamed into workers without loading everything at once. OPFS (origin private file system) is an option for large binary chunks; it is fast and available in workers, but the encryption design is the same.

**Workers.** All parsing, querying and aggregation run in web workers, accessed with Comlink. The main thread only renders. Workers:

- *import worker*: unzips (streaming, e.g. `fflate` or zip handling in Rust), detects file types, parses into the tree, extracts the shape, runs importers.
- *query worker*: unfolds trees into the columns a view needs, filters, groups and aggregates. Hot paths in Rust/WASM.
- *sandbox worker*: runs QuickJS importer scripts and third-party WASM plugins with no network and bounded resources (see [plugins.md](plugins.md)).
- *crypto worker*: bulk encryption and decryption, HPKE for donations.

**Why Rust/WASM in the client.** Parsing a 2 GB Takeout and aggregating millions of nodes is where JavaScript struggles. A Rust core gives predictable memory use, and sharing it with the server means the shape format, path language and importer semantics are implemented once. We should still measure: for many studies, plain TypeScript in a worker is fast enough, and the core can start in TypeScript and move to Rust where profiling shows it matters. DuckDB-WASM is an alternative for tabular aggregation; it is powerful but several megabytes and table-centric, so it is better as an optional plugin than as the foundation.

**Internationalisation.** i18next, as in DigitalFootprintsLab. English and Dutch from day one; importers carry language variants of file and key names.

## Server

The server is intentionally small. Responsibilities:

1. Serve the built SPA (embedded in the binary) and study configuration files.
2. Authenticate participants (session codes issued by lab staff, or IDs passed from a survey tool) and researchers.
3. Key service: hold the server half of the local-store key wrapping so data at rest on a lab machine cannot be read without logging in.
4. Enrichment: accept batches of sanitised URLs, fetch public metadata quickly and politely, cache results without linking them to participants, stream results back.
5. Donation intake: accept encrypted donation envelopes, verify size and format, write to the filesystem or an S3-compatible bucket, record a receipt.
6. Optional AI proxy: forward helper requests to a configured model provider, so API keys never reach the browser.

Not the server's job: parsing DDPs, running importers, analysing data, decrypting donations.

Language: **Rust** (axum + tokio), see [ADR 0001](decisions/0001-server-language.md). Storage: SQLite for metadata (studies, sessions, receipts, enrichment cache), filesystem or S3 (via the `object_store` crate) for blobs.

**API sketch** (JSON over HTTPS, versioned under `/api/v1`):

| Endpoint | Purpose |
| --- | --- |
| `GET /api/v1/studies/{id}` | Signed study config: importers, views, questions, public key |
| `POST /api/v1/sessions` | Exchange a participant code for a session token |
| `POST /api/v1/keys/unwrap` | Unwrap the local store key (see privacy doc) |
| `POST /api/v1/enrich` | Submit a batch of URLs; returns a job id |
| `GET /api/v1/enrich/{job}/events` | Server-sent events with metadata as it arrives |
| `PUT /api/v1/vault/{blob}` | Encrypted remote copy of the local store (optional) |
| `POST /api/v1/donations` | Upload an encrypted donation envelope |
| `POST /api/v1/assistant` | Optional AI helper proxy |

## Researcher CLI

The same Rust workspace builds a `combray` CLI (the server is `combray serve`):

- `combray study keygen`: create the study key pair; prints the public key and fingerprint; writes the private key encrypted with a passphrase.
- `combray study sign`: sign a study config.
- `combray donations pull` / `decrypt` / `export`: fetch envelopes from disk or S3, decrypt locally, export to JSON, Parquet or CSV.
- `combray importer test`: run importer specs against fixtures.
- `combray shapes`: aggregate donated shape metadata to see format variants across participants.

## Monorepo layout

```
combray/
├── apps/
│   └── web/                  React SPA (participant, facilitator and researcher modes)
├── packages/
│   ├── ui/                   design system: tokens, components, illustrations
│   ├── core-js/              TypeScript bindings and fallbacks for combray-core
│   ├── crypto/               client crypto (WebCrypto + HPKE), test vectors shared with Rust
│   └── viz/                  tree-aware visualisation components
├── crates/
│   ├── combray-core/         tree, paths, shapes, unfold, aggregate (native + wasm)
│   ├── combray-crypto/       envelope format, HPKE, signatures
│   ├── combray-server/       axum server
│   └── combray-cli/          `combray` binary (serve, study, donations, importer)
├── importers/                importer specs (YAML) + synthetic fixtures + expected output
├── plugins/                  example WASM plugins (anonymiser, classifier)
├── deploy/
│   ├── docker-compose.yml
│   └── examples/             example study configs
└── docs/
```

Tooling: pnpm workspaces for TypeScript, a Cargo workspace for Rust, `wasm-pack` (or `wasm-bindgen` directly) to build the core for the browser, and a `justfile` with the common tasks (`just dev`, `just test`, `just build`, `just release`). CI builds the SPA, embeds it in the server binary, and publishes a multi-arch Docker image and static binaries.

## Modes

| Mode | Server | What works |
| --- | --- | --- |
| **Lab local** | `combray serve` on the same laptop, or docker compose | Everything; enrichment needs internet |
| **Lab VM** | docker compose on a university VM, behind TLS | Everything, for several lab machines and remote sessions |
| **Browser only** | Static hosting (e.g. GitHub Pages), no Combray server | Import, explore, questions; local store protected by a passphrase instead of a server key; donations to a configured endpoint or downloaded as an encrypted file; no enrichment |

## Open questions

- Start the core in TypeScript and port to Rust, or start in Rust? (Recommendation: define the formats in Rust from the start, but allow TypeScript implementations of simple operations while the WASM build matures.)
- Do we need a separate researcher web UI (study builder, importer studio), or is it a mode of the same SPA? Recommendation: same SPA, separate route and bundle chunk.
- Facilitator view: same app on a second device, synced through the server? That would mean the server relays encrypted UI state, which needs its own design.
