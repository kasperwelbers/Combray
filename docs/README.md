# Combray design documents

These documents describe what Combray should become and why. They are written to be argued with: each one ends with its open questions, and the cross-cutting ones are collected in [open-questions.md](open-questions.md).

Suggested reading order:

1. [vision.md](vision.md): who it is for and the principles everything else follows from
2. [architecture.md](architecture.md): the components (web client with studio, key page, server) and the monorepo
3. [privacy-and-encryption.md](privacy-and-encryption.md): threat model and crypto
   - [security.md](security.md): every security choice that is implemented, and why
   - [researcher-keys.md](researcher-keys.md): researcher sign-in, passkeys, project keys and the key page (built for the pilot)
   - [key-design.md](key-design.md): every key from loading data to analysis and withdrawal, with an [explainer for researchers](explainers/keys.html); participants read the in-app Questions page
4. [universal-importer.md](universal-importer.md): files as trees, importer specs
   - [formats/](formats/README.md): how Combray reads JSON, HTML, CSV, text and folders, with every hard case we know and what researchers can do about it (for researchers and developers)
   - [tree-decisions.md](tree-decisions.md): importers as decisions on the tree, derived tables, HTML, names and matches (design)
   - [structure-versions.md](structure-versions.md): sharing structure after upload, which nodes occur together, and why that keeps joins safe (design)
   - [plans/2026-11-04-names-and-matches.md](plans/2026-11-04-names-and-matches.md): names and matches instead of aliases, seen structures kept apart from the researcher's tree, repetition instead of count ranges (plan, built)
   - [plans/2026-11-05-researcher-experience.md](plans/2026-11-05-researcher-experience.md): example projects without an account, names always with one match dialog, one panel per setting in the tree editor, a central help dialog (plan, built)
   - [plans/2026-11-05-stories-and-exploration.md](plans/2026-11-05-stories-and-exploration.md): **next up** — stories (slides that walk participants through their data), free exploration, removing data, what researchers get, AI support; the donate step first (plan, for discussion)
   - [plans/2026-11-05-matching-robustness.md](plans/2026-11-05-matching-robustness.md): exact paths versus resilient matching, and near matches that ask the participant; what to look for in real packages (plan, for discussion; the step for files that moved is replaced by file groups, ADR 0016)
   - [plans/2026-11-08-project-steps.md](plans/2026-11-08-project-steps.md): one numbered path through setting up a project, from describing the study to publishing, built on the setup checklist (plan, for discussion)
   - [exploration.md](exploration.md): value formats, the researcher's view of the tree, queries over nested tables, charts
5. [enrichment.md](enrichment.md): URL metadata with consent
6. [visualization.md](visualization.md): presenting data and prompting reflection
7. [plugins.md](plugins.md): local WASM modules and QuickJS
8. [ai-helper.md](ai-helper.md): the assistant
9. [deployment.md](deployment.md): docker compose, and the checklist for a pilot
10. [design-identity.md](design-identity.md): the warm look and feel
11. [translation.md](translation.md): how participant-facing text is translated, by people or with AI
12. [roadmap.md](roadmap.md) and [open-questions.md](open-questions.md)

Decision records live in [decisions/](decisions/): [0001 server language](decisions/0001-server-language.md), [0002 modular components](decisions/0002-modular-components.md), [0003 TypeScript core and key tool](decisions/0003-typescript-core-and-key-tool.md), [0004 server-held store keys](decisions/0004-server-held-store-keys.md), [0005 projects scope stores](decisions/0005-projects-scope-stores.md), [0006 revocable donation keys](decisions/0006-revocable-donation-keys.md), [0007 browser key page](decisions/0007-browser-key-page.md), [0008 project paths](decisions/0008-project-paths.md), [0009 researcher sign-in](decisions/0009-researcher-sign-in.md), [0010 Node server](decisions/0010-node-server.md), [0011 server first](decisions/0011-server-first.md), [0012 names and matches](decisions/0012-names-and-matches.md), [0013 names, labels and versions](decisions/0013-names-labels-versions.md), [0014 participant passwords and backups](decisions/0014-participant-passwords-and-backups.md) [0015 raw paths and relational export](decisions/0015-raw-paths-and-relational-export.md) and [0016 file groups](decisions/0016-file-groups.md).

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
| **Project** | A study as configured in the studio and registered on a server: importers, views, questions, donation pipeline, plus the project public key. |
| **Studio** | The researcher workspace at `/studio/`, in the browser. It never handles keys. |
| **Key page** | The small page on its own address where researchers sign in with a passkey, hold their keys, give colleagues access and open donations ([researcher-keys.md](researcher-keys.md)). |
| **Server** | A Combray server, typically one per university, shared by many researchers and projects. |
| **Session** | One participant's sitting, usually with lab staff present. A participant may have several sessions (diary use). |
| **Probe** | A visualisation paired with a question or reflection prompt. |
