# Roadmap

A phased plan. Each phase ends with something usable, so the design can be tested with real (consenting team member) data early.

## Phase 0: design (done)

- These documents, reviewed and argued over.
- Decide the open questions marked as blocking in [open-questions.md](open-questions.md).

## Phase 1: local core, browser only

Goal: import a Google Takeout and a TikTok export, explore them, entirely in the browser.

- [x] Monorepo skeleton: pnpm workspaces, CI, `pnpm` scripts.
- [x] `packages/core` (TypeScript, [ADR 0003](decisions/0003-typescript-core-and-key-tool.md)): tree model, parsers (JSON, JSON Lines, CSV, HTML, XML, text, zip), path language, shape extraction.
- [x] Unfolding and aggregation for views (`query.ts`: unnesting while aggregating, filters, summaries, used by the studio's chart builder).
- [x] Importer spec format and runner ([reference](importer-spec.md)); QuickJS sandbox; converter for old data-donation-importers recipes; first platform packs (Google Takeout: YouTube, search, browsing; TikTok) with synthetic fixtures.
- [x] Encrypted local store, data worker, Comlink. Raw files kept as encrypted blobs.
- [x] Store-key service on the server (password unlock, Argon2id, lockout, crypto-shredding), pulled forward from Phase 2; passphrase unlock removed ([ADR 0004](decisions/0004-server-held-store-keys.md)).
- [x] Projects in the web client (`/p/{project}/`, [ADR 0008](decisions/0008-project-paths.md)), one store per project, participant ids from the link with a server-side pattern check, researcher-issued password reset links ([ADR 0005](decisions/0005-projects-scope-stores.md)).
- [x] XSS hardening: Trusted Types, safe links, banned HTML sinks ([security.md](security.md)).
- [x] Tree browser, structure view, memory lane, timeline and top items (linked: choosing a bar or an item filters memory lane).
- [x] Design system v0: palette, madeleine placeholder, town placeholder. [ ] Self-hosted fonts.
- [x] Minimal server (web client, health, read-only project configs), Docker image and compose file, pulled forward from Phase 2. TypeScript on Node ([ADR 0010](decisions/0010-node-server.md)).

## Phase 2: researcher tools, server and donation

Goal: a researcher with no programming experience creates a project, registers it on a shared server, runs sessions, and decrypts donations locally.

- [x] Researcher sign-in (email code and passkey) and the key page: personal keys under passkey PRF with a recovery code, project keys, grants after comparing key codes, opening donations to CSV ([ADR 0007](decisions/0007-browser-key-page.md), [researcher-keys.md](researcher-keys.md)). Replaces the local key tool. [ ] Signed project configs.
- Researcher UI in the browser: create a project, configure from platform packs, register on a server, create participant codes, download encrypted donations.
- Combray server: multi-tenant project registry, researcher accounts, embedded web client, signed project configs, participant sessions, donation storage on its own disk.
- [x] `packages/seal`: HPKE with X-Wing, envelope format, personal and project keys.
- [x] Revocable donation keys ([ADR 0006](decisions/0006-revocable-donation-keys.md)): sealed keys in a separate key database, fetch on use, withdrawal with tombstones re-applied on start.
- Combray package: export the encrypted store as one file and restore it on any device with the password ([key-design.md](key-design.md#8-planned-the-combray-package-export-and-restore)).
- R package for analysis (fetch keys, decrypt in memory, never store); Python later. Needs a way to hold a personal key without a passkey (a device key from the key page).
- Donation flow: preview, exclusions, consent receipts, probes and answers, the `#k=` key check, a receipt with the withdrawal token.
- [x] Researcher workspace with path decisions (ignore, show, donate) on the tree, derived tables, aliases and HTML normalisation ([tree-decisions.md](tree-decisions.md#implementation-plan)). Upload points, the participant view of derived tables (collections, other data, nested tables), "Read as" conversions, row filters, merge suggestions, Google Takeout and TikTok as project trees, and [finding the export in an upload](tree-decisions.md#finding-the-export-in-an-upload) (one uploader per platform, name patterns, required parts, skipping new parts, names first with fixed limits). [ ] The consent flow for new structure metadata ([security.md](security.md#structure-metadata-and-consent), with shared structures and merge checks from [structure-versions.md](structure-versions.md)) and missing-field requests; lifters.
- [x] Docker image and compose file; deployment guide for a pilot with two host names ([deployment.md](deployment.md#pilot-checklist)).
- External review of the crypto design.

## Phase 3: enrichment

Goal: TikTok and YouTube data become recognisable within a minute.

- Enricher format; oEmbed and `<head>` strategies; per-host rate limiting; shared cache; SSE streaming; thumbnail proxy.
- Consent-scoped selection presets in the client.
- Throughput spike and tuning (see [ADR 0001](decisions/0001-server-language.md)).

## Phase 4: reflection and research tooling

- Probe library and full project configuration in Studio.
- Facilitated mode and diary (multi-session) mode; remote vault.
- Importer Studio; structure metadata in donations; `combray shapes`.
- Illustration and logo by a designer; full Dutch and English copy.

## Phase 5: AI helper and plugins

- Help knowledge base from platform packs.
- Task mode with metadata-only context and local instruction execution (see [ai-helper.md](ai-helper.md)).
- WASM plugin interface; example anonymiser and classifier.

## Later

- Object storage for large donations (videos): browsers upload encrypted envelopes straight to S3-compatible storage with presigned URLs; the server keeps the index, tombstones and sealed keys ([ADR 0010](decisions/0010-node-server.md)).
- Passkey-protected private-key backup on the server; Windows service install; Tauri wrapper if labs want a desktop app; network and map views; public importer registry; Component Model plugins.
