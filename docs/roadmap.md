# Roadmap

A phased plan. Each phase ends with something usable, so the design can be tested with real (consenting team member) data early.

## Phase 0: design (now)

- These documents, reviewed and argued over.
- Decide the open questions marked as blocking in [open-questions.md](open-questions.md).

## Phase 1: local core, browser only

Goal: import a Google Takeout and a TikTok export, explore them, entirely in the browser.

- Monorepo skeleton: pnpm + Cargo workspaces, CI, `justfile`.
- `combray-core`: tree model, parsers (JSON, CSV, HTML, zip), path language, shape extraction, unfolding. Native and WASM builds with shared tests.
- Importer spec format and runner; QuickJS sandbox; converter for old data-donation-importers recipes; first platform packs (Google Takeout: YouTube, search, browsing; TikTok).
- Encrypted local store (passphrase unlock), workers, Comlink.
- First views: memory lane, timeline, top items, tree browser.
- Design system v0: palette, type, madeleine placeholder, town placeholder.

## Phase 2: server and donation

Goal: a lab can run sessions with participant codes and receive encrypted donations.

- `combray serve`: embedded SPA, study configs, participant codes and sessions, key service (server unlock), donation intake to filesystem.
- `combray-crypto`: HPKE with X-Wing, envelope format, test vectors shared with the client.
- CLI: `study keygen/sign`, `participants create`, `donations pull/decrypt/export`.
- Donation flow: preview, exclusions, consent receipts, probes and answers.
- Docker image and compose file; deployment guide.
- External review of the crypto design.

## Phase 3: enrichment

Goal: TikTok and YouTube data become recognisable within a minute.

- Enricher format; oEmbed and `<head>` strategies; per-host rate limiting; shared cache; SSE streaming; thumbnail proxy.
- Consent-scoped selection presets in the client.
- Throughput spike and tuning (see [ADR 0001](decisions/0001-server-language.md)).

## Phase 4: reflection and research tooling

- Probe library and study builder in the researcher UI.
- Facilitated mode and diary (multi-session) mode; remote vault.
- Importer Studio; structure metadata in donations; `combray shapes`.
- Illustration and logo by a designer; full Dutch and English copy.

## Phase 5: AI helper and plugins

- Help knowledge base from platform packs.
- Task mode with metadata-only context and local instruction execution (see [ai-helper.md](ai-helper.md)).
- WASM plugin interface; example anonymiser and classifier.

## Later

- S3 storage; Windows service install; Tauri wrapper if labs want a desktop app; network and map views; public importer registry; Component Model plugins.
