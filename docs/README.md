# Combray design documents

These documents describe what Combray should become and why. They are written to be argued with: each one ends with its open questions, and the cross-cutting ones are collected in [open-questions.md](open-questions.md).

Suggested reading order:

1. [vision.md](vision.md): who it is for and the principles everything else follows from
2. [architecture.md](architecture.md): the three components (Studio, web client, server) and the monorepo
3. [privacy-and-encryption.md](privacy-and-encryption.md): threat model and crypto
   - [security.md](security.md): every security choice that is implemented, and why
4. [universal-importer.md](universal-importer.md): files as trees, importer specs
5. [enrichment.md](enrichment.md): URL metadata with consent
6. [visualization.md](visualization.md): presenting data and prompting reflection
7. [plugins.md](plugins.md): local WASM modules and QuickJS
8. [ai-helper.md](ai-helper.md): the assistant
9. [deployment.md](deployment.md): docker compose and binary
10. [design-identity.md](design-identity.md): the warm look and feel
11. [roadmap.md](roadmap.md) and [open-questions.md](open-questions.md)

Decision records live in [decisions/](decisions/): [0001 server language](decisions/0001-server-language.md), [0002 modular components](decisions/0002-modular-components.md) [0003 TypeScript core and key tool](decisions/0003-typescript-core-and-key-tool.md) [0004 server-held store keys](decisions/0004-server-held-store-keys.md) and [0005 projects scope stores](decisions/0005-projects-scope-stores.md).

## Glossary

| Term | Meaning |
| --- | --- |
| **DDP** | Data download package: the archive a platform gives you under GDPR Art. 15/20 (e.g. Google Takeout). |
| **Tree** | Combray's uniform in-memory representation of any file or archive. |
| **Path** | An address of one or more nodes in a tree, e.g. `Takeout/YouTube/**/watch-history.json/[*].subtitles[0].name`. |
| **Shape** | The structure of a tree with all values removed. Safe to share as metadata. |
| **Importer** | A declarative spec that selects paths from a tree and converts them into a dataset. Successor of the "recipe". |
| **Dataset** | The result of running an importer: a tree (often a list of records) stored encrypted in the browser. |
| **Enrichment** | Fetching public metadata (title, thumbnail, description) for URLs in a dataset, via the server, with consent. |
| **Project** | A study as configured in Studio and registered on a server: importers, views, questions, donation pipeline, plus the project public key. |
| **Studio** | Combray Studio, the researcher tool that runs on the researcher's own computer and holds the project private key. |
| **Server** | A Combray server, typically one per university, shared by many researchers and projects. |
| **Session** | One participant's sitting, usually with lab staff present. A participant may have several sessions (diary use). |
| **Probe** | A visualisation paired with a question or reflection prompt. |
