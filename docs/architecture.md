# Architecture

## Three components

Combray is built from three separately deployable parts, so that a university can run **one shared server** that any researcher can use, without programming, from a **local researcher tool**, while participants only ever need a **browser**.

| Component | Who runs it | Where | What it does |
| --- | --- | --- | --- |
| **Combray Studio** (researcher tool) | Each researcher | Their own computer | Create projects, generate and hold the project's private key, configure importers, views and questions, register the project on a server, download and decrypt donations |
| **Web client** | Participants (with lab staff) | Any modern browser | Import, store encrypted, explore, reflect, enrich with consent, donate encrypted |
| **Combray server** | A university, a lab, or one researcher | A VM, a lab laptop, or a container host | Host projects and the web client, hold the symmetric keys for participants' local stores, enrich URLs, store encrypted donations |

A shared **core** library (`packages/core`, TypeScript) implements the tree model, parsers, path language and shape extraction, and runs in a web worker in the browser. A Rust/WASM layer is only added for hot paths once measurements show it is needed ([ADR 0003](decisions/0003-typescript-core-and-key-tool.md)).

> **Update ([ADR 0003](decisions/0003-typescript-core-and-key-tool.md)):** the researcher tool is reduced to a small local tool that creates the key pair, signs project configs and decrypts donations. The rest of what this document calls Studio (configuring projects, participants, importers) can be a browser UI, because it never handles the private key.

```
  researcher's computer                 university VM                     participant's browser
 ┌──────────────────────┐          ┌──────────────────────────┐        ┌──────────────────────────┐
 │  Combray Studio      │ register │  Combray server          │  SPA,  │  Web client (React SPA)  │
 │  ├─ create project   ├─────────►│  ├─ project registry     ├───────►│  ├─ import ─► tree       │
 │  ├─ private key  🔑  │ signed   │  │   (signed configs,    │ config │  ├─ encrypted IndexedDB  │
 │  │   (never leaves)  │ config + │  │    public keys)       │        │  ├─ workers / WASM       │
 │  ├─ importers, views │ pub key  │  ├─ store-key service ◄──┼────────┤  │   (store key from    │
 │  │   and questions   │          │  │   (symmetric keys for │ unlock │  │    server on login)  │
 │  ├─ download         │◄─────────┤  │    local stores)      │        │  ├─ explore & reflect    │
 │  │   ciphertext      │ encrypted│  ├─ enrichment + cache ◄─┼────────┤  │  consented URLs only │
 │  └─ decrypt, export  │ donations│  └─ donation storage  ◄──┼────────┤  └─ donate: encrypt to  │
 │     (local only)     │          │      (own disk storage)  │cipher- │      project public key  │
 └──────────────────────┘          └──────────────────────────┘ text   └──────────────────────────┘
```

The key property: **the server never sees unencrypted donation data, and never holds the private key needed to decrypt it.** It only holds ciphertext, public keys, and the symmetric keys that lock participants' local stores (which protect data that never leaves the browser).

## Combray Studio (researcher tool)

Studio is for researchers with no programming experience. It runs locally so the project's private key never has to leave the researcher's machine.

**What researchers do in Studio**

1. **Create a project.** Name, description, information letter, languages.
2. **Create the project key.** Studio generates the project key pair (see [privacy-and-encryption.md](privacy-and-encryption.md#key-management)). It then walks the researcher through storing the private key safely: save an encrypted key file, print a paper recovery sheet, put a copy with the data steward. Studio does not let the researcher continue until a backup has been confirmed.
3. **Configure.** Pick platform packs and importers, views and probes (questions), enrichment options, the donation pipeline (anonymisation and aggregation plugins), and whether the AI helper is enabled. Preview the participant experience with synthetic or the researcher's own data.
4. **Register on a server.** Enter the server URL and log in with a researcher account. Studio uploads the signed project config and public key, and receives participant links or codes to print.
5. **Collect.** Download encrypted donations and decrypt them locally. Export to CSV, JSON or Parquet, with a codebook. Inspect donated structure metadata to see format variants.
6. **Maintain.** Update importers in Importer Studio (see [universal-importer.md](universal-importer.md#importer-studio)), publish a new config version, rotate keys, close the project and request deletion on the server.

**Form factor.** Studio is a small native binary (the same Rust workspace) that serves its React UI on `127.0.0.1` only and opens it in the default browser. No Electron, no Node, no runtime to install. One download per platform, double-click to run.

| Option | For | Against |
| --- | --- | --- |
| **Local binary + browser UI on localhost** | Tiny, one codebase with the web client's UI kit, works on all platforms | Feels slightly less "app-like"; must guard the localhost server (random port, per-launch token, `Host`/`Origin` checks) |
| Tauri desktop app | Native window and installer, OS keychain integration, still small | Per-platform signing and packaging work; WebView differences across OSes |
| Studio as a page of the server | Nothing to install | The private key would be handled by a page served by the shared server, which is exactly the trust we want to avoid |

Recommendation: **local binary with a localhost UI** first, designed so it can be wrapped in Tauri later if researchers prefer a native app. Keys can be stored in the OS keychain where available, but the encrypted key file plus paper backup is the primary mechanism, because keychains are tied to one machine.

Power users get the same functions as a CLI (`combray project create`, `combray donations decrypt`, and so on).

## Web client

**Framework.** React with TypeScript, built with Vite, as a single-page app served by the Combray server (or as static files in browser-only mode). React keeps continuity with DigitalFootprintsLab, has the largest pool of contributors in research software teams, and has good libraries for charts and accessibility.

| Option | For | Against |
| --- | --- | --- |
| **React SPA (Vite)** | Familiar, huge ecosystem, works as static files | Larger runtime than Svelte/Solid; needs discipline to keep heavy work off the main thread |
| Svelte / SolidJS | Smaller bundles, fine-grained reactivity | Smaller ecosystem, fewer contributors know it |
| Next.js / Remix | Routing and SSR conveniences | SSR is the opposite of what we want; implies a Node server |

Recommendation: **React SPA with Vite**, installable as a PWA so a lab laptop keeps a known version and can work offline. Studio's UI is a second app in the same monorepo sharing the UI kit and core bindings.

**State and storage.** UI state in a small store (Zustand or React context; no Redux). Persistent data lives in IndexedDB, encrypted per record with a symmetric key that is unlocked through the server's store-key service (see [privacy-and-encryption.md](privacy-and-encryption.md#local-store)). Large datasets are stored in chunks so they can be decrypted and streamed into workers without loading everything at once. OPFS is an option for large binary chunks, with the same encryption.

**Workers.** All parsing, querying and aggregation run in web workers, accessed with Comlink. The main thread only renders.

- *import worker*: unzips (streaming), detects file types, parses into the tree, extracts the shape, runs importers.
- *query worker*: unfolds trees into the columns a view needs, filters, groups and aggregates. Hot paths in Rust/WASM.
- *sandbox worker*: runs QuickJS importer scripts and WASM plugins with no network and bounded resources (see [plugins.md](plugins.md)).
- *crypto worker*: bulk encryption and decryption, HPKE for donations.

**TypeScript first, Rust/WASM where measured.** The core is TypeScript in a worker ([ADR 0003](decisions/0003-typescript-core-and-key-tool.md)). Parsing a 2 GB Takeout and aggregating millions of nodes is where JavaScript may struggle; if measurements show that, the hot path moves to Rust compiled to WASM, tested against the same cases. DuckDB-WASM is an alternative for tabular aggregation; powerful but several megabytes and table-centric, so better as an optional plugin than as the foundation.

**Internationalisation.** i18next, as in DigitalFootprintsLab. English and Dutch from day one; importers carry language variants of file and key names.

## Combray server

The server is intentionally small, and **multi-tenant**: one installation serves many researchers and projects. Responsibilities:

1. **Project registry.** Researcher accounts; projects registered from Studio with their signed config and public key; participant codes and links.
2. **Serve the web client** (embedded in the binary) and each project's signed config.
3. **Store-key service.** Hold the per-participant symmetric secrets that unlock participants' encrypted IndexedDB stores, released after login. These keys protect data that stays in the browser; they cannot decrypt donations.
4. **Enrichment.** Accept batches of sanitised URLs, fetch public metadata quickly and politely, cache it without linking it to participants, stream results back (see [enrichment.md](enrichment.md)).
5. **Donation storage.** Accept encrypted donation envelopes, verify size and format, store them, hand them to the project's researchers in Studio, and delete them on request.
6. **Optional AI proxy.** Forward helper requests (metadata only, see [ai-helper.md](ai-helper.md)) to a configured model, so API keys never reach the browser.
7. **Optional private-key escrow** (later): store a copy of a project's private key encrypted under a researcher passkey (see [privacy-and-encryption.md](privacy-and-encryption.md#optional-passkey-protected-key-backup)).

Not the server's job: parsing DDPs, running importers, analysing data, and above all decrypting donations.

**Storage.** The server has its own storage by default: SQLite for metadata and a data directory on disk for donation envelopes and vault blobs. That keeps a university deployment to one container and one volume. S3-compatible object storage is an optional backend (via the `object_store` crate) for institutions that prefer it, not a requirement.

Language: **Rust** (axum + tokio), see [ADR 0001](decisions/0001-server-language.md). The component split itself is recorded in [ADR 0002](decisions/0002-modular-components.md).

**API sketch** (JSON over HTTPS, versioned under `/api/v1`):

| Endpoint | Caller | Purpose |
| --- | --- | --- |
| `POST /api/v1/projects` | Studio | Register a project: signed config, public key, signing key |
| `PUT /api/v1/projects/{id}/config` | Studio | Publish a new signed config version |
| `POST /api/v1/projects/{id}/participants` | Studio | Create participant codes |
| `GET /api/v1/projects/{id}/donations` | Studio | List and download encrypted envelopes |
| `DELETE /api/v1/projects/{id}/donations/{d}` | Studio | Delete a donation (withdrawal) |
| `GET /api/v1/p/{id}/config` | Web client | Signed project config |
| `POST /api/v1/sessions` | Web client | Exchange a participant code for a session token |
| `POST /api/v1/store-keys/{store}` | Web client | Release the store secret for this session |
| `POST /api/v1/enrich` | Web client | Submit a batch of URLs; returns a job id |
| `GET /api/v1/enrich/{job}/events` | Web client | Server-sent events with metadata as it arrives |
| `PUT /api/v1/vault/{blob}` | Web client | Encrypted remote copy of the local store (optional) |
| `POST /api/v1/donations` | Web client | Upload an encrypted donation envelope |
| `POST /api/v1/assistant` | Web client | Optional AI helper proxy |

**Accounts and roles.** Server admins (university IT) manage researcher accounts and quotas; researchers own projects and can add collaborators; participants have only session tokens bound to one project. Researcher login supports passkeys (WebAuthn) and, for universities, SSO via OIDC or SAML (e.g. SURFconext) as an option.

## Monorepo layout

What exists now is marked with ✓; the rest is planned.

```
combray/
├── apps/
│   └── web/                  ✓ participant web client (React SPA, Vite)
├── packages/
│   ├── core/                 ✓ tree model, parsers, paths, shapes (TypeScript)
│   ├── store/                ✓ encrypted local IndexedDB store
│   ├── ui/                   design system: tokens, components, illustrations
│   ├── crypto/               donation crypto (HPKE), test vectors shared with Rust
│   └── viz/                  tree-aware visualisation components
├── crates/
│   ├── combray-server/       ✓ shared server (axum)
│   ├── combray-crypto/       envelope format, HPKE, signatures, key files
│   └── combray-keys/         local key tool: key pairs, config signing, decryption
├── importers/                ✓ importer specs (YAML) + synthetic fixtures + expected output
├── plugins/                  example WASM plugins (anonymiser, classifier)
├── deploy/                   ✓ docker compose, Caddyfile, example project configs
└── docs/
```

Tooling: pnpm workspaces for TypeScript, a Cargo workspace for Rust, and a `justfile` with common tasks (`just dev`, `just test`, `just check`, `just build`, `just docker`). CI runs type checks, tests, clippy and a Docker build; later it publishes the server image and signed key-tool binaries.

## Deployment shapes

| Shape | Server | Studio | Notes |
| --- | --- | --- | --- |
| **University server** | One docker compose stack on a university VM | Each researcher installs Studio | The main target: zero programming for researchers |
| **Lab laptop** | `combray-server` runs on the same laptop | Same laptop or the researcher's own | Offline sessions; enrichment needs internet |
| **Browser only** | None (static hosting) | Studio exports a static bundle with the signed config | Passphrase-locked local store, no enrichment; donations downloaded as an encrypted file or sent to a server |

See [deployment.md](deployment.md).

## Open questions

- ~~Start the core in TypeScript and port to Rust, or start in Rust?~~ Decided: TypeScript first ([ADR 0003](decisions/0003-typescript-core-and-key-tool.md)).
- ~~Studio as localhost binary first, Tauri later, or Tauri from the start?~~ Decided: a small local key tool, researcher UI in the browser ([ADR 0003](decisions/0003-typescript-core-and-key-tool.md)).
- Can several servers federate (a project registered on two servers), or is a project always bound to one server? Recommendation: one server per project.
- Facilitator view: same app on a second device, synced through the server? That would mean the server relays encrypted UI state, which needs its own design.
