# CLAUDE.md

Guidance for Claude (and other coding agents) working in this repository.

## What this is

Combray is a data donation tool for qualitative, lab-supported research. Participants load their data download packages (Google Takeout, TikTok, etc.), explore and reflect on them with visualisations and questions, and optionally donate parts to a study. Read [README.md](README.md) first, then [docs/README.md](docs/README.md).

**Current status: Phase 1.** The participant web client, the TypeScript core, the encrypted local store and a minimal server exist. The docs under `docs/` are the source of truth for intent. When code and docs disagree, raise it rather than silently picking one, and update the docs in the same change when a design decision changes.

## Layout

See [docs/architecture.md](docs/architecture.md#monorepo-layout). Separately deployable components ([ADR 0002](docs/decisions/0002-modular-components.md), amended by [ADR 0003](docs/decisions/0003-typescript-core-and-key-tool.md) and [ADR 0007](docs/decisions/0007-browser-key-page.md)): the **web client** for participants, with the researcher studio; the **key page**, a small dependency-free page on its own origin where researchers sign in with a passkey, hold their keys and decrypt donations ([docs/researcher-keys.md](docs/researcher-keys.md)); and a shared, multi-tenant **Combray server** (store keys, researcher accounts, enrichment, encrypted donation storage).

- `apps/web` participant web client: React + TypeScript SPA (Vite). All parsing, encryption and querying run in `src/worker/data.worker.ts`. The researcher workspace is `src/studio/` (served at `/studio/`); it never handles keys.
- `apps/keys` the key page: one HTML file, no framework, hash-pinned CSP. Keys in memory only.
- `packages/core` tree model, parsers, path language, shape extraction (TypeScript; WASM only for measured bottlenecks)
- `packages/store` encrypted IndexedDB store (WebCrypto); keys from the server's key service ([ADR 0004](docs/decisions/0004-server-held-store-keys.md))
- `packages/seal` donation envelopes and researcher/project keys (HPKE with X-Wing)
- `importers` platform packs: importer specs (YAML) with synthetic fixtures; format in [docs/importer-spec.md](docs/importer-spec.md)
- `apps/server` the server: TypeScript on Node, no framework (`node:http`, `node:sqlite` with Drizzle); HTTP tests that start a real server in `apps/server/test` ([ADR 0010](docs/decisions/0010-node-server.md))
- `deploy/` docker compose, Caddyfile, example project configs
- `docs/` design documents and decision records (`docs/decisions/NNNN-*.md`)

## Commands

Requires Node 22.18+ (24 recommended) and pnpm 10. The server runs from its TypeScript sources; there is no build step for it.

```sh
pnpm install
pnpm dev           # web client on http://localhost:5173 (researcher workspace at /studio/) and
                   # the server on :8080, side by side; Vite passes /api to it
pnpm serve         # build the web client and key page, run the server on http://localhost:8080
                   # (key page on http://keys.localhost:8080, sign-in mails in .dev/outbox)
pnpm test          # all tests; pnpm test:client (web client, key page, packages) or pnpm test:server
pnpm typecheck     # type checks
pnpm e2e           # key page end to end in Chromium with a virtual passkey
pnpm docker        # build the server image
pnpm researcher example you@example.org   # add a researcher to a project on the dev server
```

The development server's settings are in `deploy/dev.env` (and `deploy/dev-hot.env` for `pnpm dev`); its databases, store master key and sign-in mails go to `.dev/`, which is not committed.

## Non-negotiable privacy rules

These apply to every change, however small.

1. **No participant data leaves the browser without explicit, specific consent.** That includes enrichment requests, telemetry and error reports. If a new feature needs to send anything, it must go through the consent layer described in [docs/privacy-and-encryption.md](docs/privacy-and-encryption.md).
2. **Donations are encrypted client-side to the project's public key.** The server must never need, and never receive, plaintext donation data, an unsealed project key, a researcher's master secret or a passkey's PRF output. Only the key page decrypts, in memory. The participant app and the studio never handle keys.
3. **Never log data values.** Server logs may contain request counts, timings and error classes, never URLs, usernames, file contents, or paths from a participant's tree. Client console logging of data is debug-only and stripped from production builds.
4. **Schema metadata contains structure only.** Keys, types, HTML tag/id/class, bucketed counts. No values, and dictionary-like keys (usernames, dates used as keys) are collapsed. See [docs/universal-importer.md](docs/universal-importer.md#structure-metadata).
5. **No real participant data in the repo.** Fixtures are synthetic. Do not commit real takeout files, even your own.
6. **Sandboxed code stays sandboxed.** QuickJS importer scripts and WASM plugins get no network, no DOM, and bounded memory and time. Do not add host functions that break this without a design discussion.
7. **The AI helper never sees participant data.** It receives only structure metadata and declared-safe local results, and returns instructions that run locally. See [docs/ai-helper.md](docs/ai-helper.md).
8. **Crypto uses vetted libraries and documented constructions only.** No home-made primitives. Changes to `packages/seal`, `packages/store/src/crypto.ts`, the key page (`apps/keys`), researcher sign-in (`apps/server/src/accounts.ts`, `research.ts`), the server's key service (`apps/server/src/keys.ts`) or other crypto need a note in the PR on what changed and why, and an update to [docs/security.md](docs/security.md).
9. **Data is never rendered as HTML.** No `innerHTML`, `dangerouslySetInnerHTML`, `eval` or `new Function` (a test enforces this); links from data go through `safeHref`. The CSP enforces Trusted Types; do not weaken it. See [docs/security.md](docs/security.md#xss-and-code-integrity).

## Conventions

- TypeScript strict mode in the client; heavy processing runs in web workers, never on the main thread.
- Server: plain Node, as few dependencies as possible, pinned to exact versions. Every change in server behaviour gets an HTTP test in `apps/server/test`. The database schema is in `apps/server/src/db/`; after changing it, run `pnpm --filter @combray/server db:generate` and commit the migration in `apps/server/drizzle/`. Never edit a migration that has been released.
- Keep the server small. If something can run in the browser, it runs in the browser.
- UI copy is warm, plain and non-judgemental (see [docs/design-identity.md](docs/design-identity.md#tone-of-voice)). All participant-facing strings go through i18n (`apps/web/src/locales/{language}/{feature}.json`, see [docs/translation.md](docs/translation.md)); Dutch and English are first-class, and a test checks they match. Researcher tools and docs are English only.
- Accessibility: WCAG 2.2 AA, keyboard navigable, respects `prefers-reduced-motion`.
- Decisions that are hard to reverse get a short ADR in `docs/decisions/`.

## Reference repositories

The predecessors are useful for prior art, not for copying wholesale:

- `ccs-amsterdam/DigitalFootprintsLab`: IndexedDB store (`src/apis/db.tsx`), donation flow and question forms (`src/components/donate/`), Vega dashboards (`src/components/explore/`).
- `kasperwelbers/data-donation-importers`: recipe format (`src/recipes.js`), parsers for JSON/CSV/HTML (`src/lib/parsers/`), transformer functions (`src/lib/transformers/`), and the recipe GUI (`src/AppComponents/`).
