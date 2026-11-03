# ADR 0010: The server in TypeScript on Node, self-hosted first

- **Status:** accepted
- **Date:** 2026-11-03
- **Supersedes:** [ADR 0001](0001-server-language.md)

## Context

ADR 0001 chose Rust mainly so the server, a CLI and the browser could share one core and one crypto implementation through WebAssembly. That reason has gone: the core is TypeScript ([ADR 0003](0003-typescript-core-and-key-tool.md)), keys are handled on the browser key page in TypeScript ([ADR 0007](0007-browser-key-page.md)), and the Rust server shares no code with anything. Meanwhile the researcher's passkey now guards the donations, so the server holds less that matters, but it still matters: participants' store keys ([ADR 0004](0004-server-held-store-keys.md)), passkey and session checks, who receives sealed key copies, and later fetching URLs for enrichment.

Security-critical code needs reviewers who read it fluently. The maintainers and likely contributors read TypeScript, not Rust.

## Decision

1. **The server is TypeScript on Node** (current LTS), as a workspace package next to the web client and the key page. It uses widely used, maintained libraries only: a small HTTP framework, SQLite (`node:sqlite` or `better-sqlite3`), `@simplewebauthn/server` for passkeys, `@node-rs/argon2` for password hashing, `node:crypto` for HKDF, AES-GCM and random values, and `nodemailer` for mail. No home-made primitives (privacy rule 8 still holds).
2. **The same constructions, the same storage.** Store keys, Argon2id hashes, code hashes, cookies and the HTTP API stay as they are, so the web client and key page do not change, and existing databases keep working. SQLite for metadata; donation envelopes as files on disk.
3. **The port is checked by language-neutral tests.** HTTP tests in TypeScript that start a server and talk to it. They pass against the Rust server first, then against the Node server, before the Rust crate is removed.
4. **Self-hosted first.** The supported deployment is one container with one data volume (Docker Compose with Caddy for HTTPS), on an institution's own server or an EU host. Not a serverless platform such as Cloudflare Workers: it would see traffic in the clear (including participants' passwords and the key page as it is served), would complicate GDPR approval, and would need different storage and a different runtime.
5. **Plan, not built: object storage for large donations.** When donations can be large (videos), browsers upload encrypted envelopes straight to S3-compatible storage with presigned URLs, and the server keeps only the index, tombstones and sealed keys. Donation storage sits behind a small interface (save, read, delete an envelope) so this can be added without touching the rest.

## Consequences

- One language for everything but configuration; contributors can review the whole system.
- Node needs a runtime in the image and uses more memory than the Rust binary (tens of megabytes); irrelevant at this scale.
- npm's larger dependency trees are the main new risk. Keep server dependencies few, keep `minimumReleaseAge`, and pin exact versions.
- The single static binary goes; deployments use the Docker image, or Node directly.
