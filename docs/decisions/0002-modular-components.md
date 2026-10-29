# ADR 0002: Three components: researcher tool, web client, shared server

- **Status:** proposed
- **Date:** 2026-10-29

## Context

Many researchers who want to run data donation studies have no programming experience and no infrastructure of their own. Universities, on the other hand, can run one service for everyone. At the same time, the project's private key must never be held by that shared service, because the server must never be able to read donation data.

## Decision

Combray consists of three separately deployable components (details in [architecture.md](../architecture.md)):

1. **Combray Studio**, a local researcher tool. It creates projects and their key pairs, keeps the private key on the researcher's machine (the researcher is responsible for storing it; Studio guides them), registers projects on a server, and downloads and decrypts donations locally.
2. **Web client**, a React SPA for participants, served by the server.
3. **Combray server**, multi-tenant and run by a university, lab or individual. It hosts registered projects and the web client, stores the symmetric keys that lock participants' local IndexedDB stores, does enrichment, and stores encrypted donations on its own storage.

## Consequences

- A university sets up one server; any researcher with Studio can use it without programming.
- Trust is split: the server holds ciphertext and store keys, Studio holds the private key. Neither alone can read donated data, and the server cannot read it at all.
- Project configs must be signed in Studio and verified in the web client, so a compromised server cannot swap in its own public key (see [privacy-and-encryption.md](../privacy-and-encryption.md#key-management)).
- The server needs accounts, roles and quotas (multi-tenancy), which adds some scope compared to a one-study server.
- We ship two binaries (server, Studio) plus the web client, all from one monorepo.
- A passkey-protected private-key backup on the server is possible later as an opt-in, without changing this split.

## Alternatives considered

- **Single server with a researcher web UI.** Simpler to ship, but the private key would be generated or handled by pages served by the shared server, which is the trust we want to avoid.
- **One server per study run by each researcher.** Keeps everything in one place, but requires each researcher to deploy and maintain infrastructure.
