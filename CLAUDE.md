# CLAUDE.md

Guidance for Claude (and other coding agents) working in this repository.

## What this is

Combray is a data donation tool for qualitative, lab-supported research. Participants load their data download packages (Google Takeout, TikTok, etc.), explore and reflect on them with visualisations and questions, and optionally donate parts to a study. Read [README.md](README.md) first, then [docs/README.md](docs/README.md).

**Current status: design phase.** There is no code yet. The docs under `docs/` are the source of truth for intent. When code and docs disagree, raise it rather than silently picking one, and update the docs in the same change when a design decision changes.

## Planned layout

The monorepo layout is proposed in [docs/architecture.md](docs/architecture.md#monorepo-layout). In short:

- `apps/web` React + TypeScript SPA (Vite)
- `crates/` Rust workspace: `combray-core` (tree, schema, paths, aggregation; compiled to native and WASM), `combray-crypto`, `combray-server`, `combray-cli`
- `importers/` declarative importer specs with synthetic fixtures
- `deploy/` docker compose and example configs
- `docs/` design documents and decision records (`docs/decisions/NNNN-*.md`)

Build and test commands will be added here once the skeleton exists.

## Non-negotiable privacy rules

These apply to every change, however small.

1. **No participant data leaves the browser without explicit, specific consent.** That includes enrichment requests, telemetry and error reports. If a new feature needs to send anything, it must go through the consent layer described in [docs/privacy-and-encryption.md](docs/privacy-and-encryption.md).
2. **Donations are encrypted client-side to the study's public key.** The server must never need, and never receive, plaintext donation data or the researcher's private key.
3. **Never log data values.** Server logs may contain request counts, timings and error classes, never URLs, usernames, file contents, or paths from a participant's tree. Client console logging of data is debug-only and stripped from production builds.
4. **Schema metadata contains structure only.** Keys, types, HTML tag/id/class, bucketed counts. No values, and dictionary-like keys (usernames, dates used as keys) are collapsed. See [docs/universal-importer.md](docs/universal-importer.md#structure-metadata).
5. **No real participant data in the repo.** Fixtures are synthetic. Do not commit real takeout files, even your own.
6. **Sandboxed code stays sandboxed.** QuickJS importer scripts and WASM plugins get no network, no DOM, and bounded memory and time. Do not add host functions that break this without a design discussion.
7. **The AI helper never sees participant data.** It receives only structure metadata and declared-safe local results, and returns instructions that run locally. See [docs/ai-helper.md](docs/ai-helper.md).
8. **Crypto uses vetted libraries and documented constructions only.** No home-made primitives. Changes to `combray-crypto` or the client crypto module need a note in the PR on what changed and why.

## Conventions

- TypeScript strict mode in the client; heavy processing runs in web workers, never on the main thread.
- Rust: stable toolchain, `clippy` clean, no `unsafe` without a comment explaining why.
- Keep the server small. If something can run in the browser, it runs in the browser.
- UI copy is warm, plain and non-judgemental (see [docs/design-identity.md](docs/design-identity.md#tone-of-voice)). All user-facing strings go through i18n; Dutch and English are first-class.
- Accessibility: WCAG 2.2 AA, keyboard navigable, respects `prefers-reduced-motion`.
- Decisions that are hard to reverse get a short ADR in `docs/decisions/`.

## Reference repositories

The predecessors are useful for prior art, not for copying wholesale:

- `ccs-amsterdam/DigitalFootprintsLab`: IndexedDB store (`src/apis/db.tsx`), donation flow and question forms (`src/components/donate/`), Vega dashboards (`src/components/explore/`).
- `kasperwelbers/data-donation-importers`: recipe format (`src/recipes.js`), parsers for JSON/CSV/HTML (`src/lib/parsers/`), transformer functions (`src/lib/transformers/`), and the recipe GUI (`src/AppComponents/`).
