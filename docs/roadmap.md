# Roadmap

A phased plan. Each phase ends with something usable, so the design can be tested with real (consenting team member) data early.

## Phase 0: design (done)

- These documents, reviewed and argued over.
- Decide the open questions marked as blocking in [open-questions.md](open-questions.md).

## Phase 1: local core, browser only

Goal: import a Google Takeout and a TikTok export, explore them, entirely in the browser.

- [x] Monorepo skeleton: pnpm + Cargo workspaces, CI, `justfile`.
- [x] `packages/core` (TypeScript, [ADR 0003](decisions/0003-typescript-core-and-key-tool.md)): tree model, parsers (JSON, JSON Lines, CSV, HTML, XML, text, zip), path language, shape extraction.
- [ ] Unfolding and aggregation for views.
- [ ] Importer spec format and runner; QuickJS sandbox; converter for old data-donation-importers recipes; first platform packs (Google Takeout: YouTube, search, browsing; TikTok).
- [x] Encrypted local store (passphrase unlock), data worker, Comlink.
- [x] Tree browser and structure view. [ ] Memory lane, timeline, top items.
- [x] Design system v0: palette, madeleine placeholder, town placeholder. [ ] Self-hosted fonts.
- [x] Minimal Rust server (web client, health, read-only project configs), Docker image and compose file, pulled forward from Phase 2.

## Phase 2: researcher tools, server and donation

Goal: a researcher with no programming experience creates a project, registers it on a shared server, runs sessions, and decrypts donations locally.

- Local key tool v0: generate keys with guided backup, sign project configs, decrypt donations, export ([ADR 0003](decisions/0003-typescript-core-and-key-tool.md)).
- Researcher UI in the browser: create a project, configure from platform packs, register on a server, create participant codes, download encrypted donations.
- Combray server: multi-tenant project registry, researcher accounts, embedded web client, signed project configs, participant sessions, store-key service (server unlock), donation storage on its own disk.
- `combray-crypto`: HPKE with X-Wing, envelope format, signatures, key files; test vectors shared with the client.
- CLI equivalents of the key tool functions for power users.
- Donation flow: preview, exclusions, consent receipts, probes and answers.
- Docker image and compose file; deployment guide.
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

- Passkey-protected private-key backup on the server; S3 storage; Windows service install; Tauri wrapper if labs want a desktop app; network and map views; public importer registry; Component Model plugins.
