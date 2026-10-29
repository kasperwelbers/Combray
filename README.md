<p align="center">
  <!-- Placeholder until the Madeleine logo exists. See docs/design-identity.md -->
  <strong>🐚 Combray</strong>
</p>

<p align="center"><em>Revisiting your digital past, together.</em></p>

---

> *"And suddenly the memory revealed itself. The taste was that of the little piece of madeleine which on Sunday mornings at Combray (…) my aunt Léonie used to give me, dipping it first in her own cup of tea or tisane."*
> — Marcel Proust, *Swann's Way*

**Combray** is an open source data donation tool built for **qualitative research**. Participants load the data that platforms hold about them (Google Takeout, TikTok, Instagram, and so on), explore it, reflect on it, and, only if they choose, donate parts of it to a research project.

Most data donation tools are designed for survey participants who donate remotely and quickly. Combray is designed for the opposite case: a participant sitting in a lab or an interview room, supported by research staff, spending real time with their own traces. The traces become the madeleine. They evoke memories, prompt stories, and let participants analyse their own digital life as a kind of diary.

> **Status:** design phase. This repository currently contains the plan, not the tool. Start with [docs/](docs/README.md).

## What makes Combray different

- **Presentation first.** The core of the tool is showing participants their own data in ways that are rich, warm and easy to understand, and asking them questions about it. Donation is one possible step at the end, not the point of the interface.
- **Local first, browser capable.** Combray runs on a lab laptop or a university VM with a single command, and the client also works as a plain website in the browser.
- **Private by construction.** Data is stored encrypted in the browser. Nothing reaches a server without explicit consent, and donated data is encrypted in the browser to the researcher's key with hybrid post-quantum encryption, so the server only ever holds ciphertext.
- **Enrichment with consent.** Takeout data is often thin: a list of URLs or usernames. With the participant's consent, Combray can send a minimal, sanitised set of URLs (for example "the top 25 TikTok profiles I watched") to the server, which fetches public metadata such as titles and thumbnails so the data becomes something people recognise.
- **One universal importer.** Every file (JSON, CSV, HTML, XML, and whole zip archives) becomes a tree. Importers are small declarative specs that mark which paths to keep and how to convert them, with sandboxed JavaScript (QuickJS) for the odd case. The structure of donated files, stripped of all values, can be shared to help researchers maintain importers.
- **Trees, not just tables.** Data is presented as it is. Charts that need tables unfold the tree on demand, and all aggregation happens locally in web workers (with Rust compiled to WebAssembly for the heavy parts).
- **Pluggable local processing.** WebAssembly modules for anonymisation and classification run locally, sandboxed, without network access.
- **An AI helper that never sees your data.** Participants can ask how to download their Google Takeout, or ask "what does my data say about my music taste?". The model only sees structure metadata (keys and types) and non-sensitive local results, and sends back instructions that run locally, so the visualisation appears for the participant without the data ever reaching the AI.
- **Warm by design.** A madeleine as the logo, the town of Combray in the background, soft colours and gentle language. Looking at your own data should feel like looking through an old photo album, not filling in a form.

## Planned architecture at a glance

```
┌──────────────────────── participant's browser ────────────────────────┐
│  React SPA                                                            │
│   ├─ import: zip/files ─► universal tree ─► importer specs            │
│   ├─ encrypted store (IndexedDB, AES-GCM, non-extractable keys)       │
│   ├─ web workers: aggregation (Rust/WASM), QuickJS, WASM plugins       │
│   ├─ explore & reflect: visualisations, questions, annotations        │
│   └─ donate: preview ─► consent ─► encrypt to researcher key (HPKE)   │
└───────────────┬───────────────────────────────┬───────────────────────┘
                │ consented URLs only            │ ciphertext only
┌───────────────▼───────────────────────────────▼───────────────────────┐
│  combray server (single binary, Docker image)                         │
│   ├─ serves the SPA and study configs                                 │
│   ├─ sessions and key unwrapping for the local store                  │
│   ├─ enrichment: fetch public URL metadata, shared cache              │
│   └─ receives encrypted donations ─► disk or S3                       │
└───────────────────────────────────────────────────────────────────────┘
        researcher's private key lives offline or in a separate vault
```

See [docs/architecture.md](docs/architecture.md) for the full picture.

## Documentation

| Document | What it covers |
| --- | --- |
| [Vision and use cases](docs/vision.md) | Who Combray is for, research scenarios, guiding principles |
| [Architecture](docs/architecture.md) | Monorepo layout, client, server, workers, WASM |
| [Server language (ADR 0001)](docs/decisions/0001-server-language.md) | Rust or Go, with a recommendation |
| [Privacy and encryption](docs/privacy-and-encryption.md) | Threat model, local encryption, key handling, donation crypto |
| [Universal tree importer](docs/universal-importer.md) | Files as trees, path language, importer specs, schema metadata, QuickJS |
| [Enrichment and scraping](docs/enrichment.md) | Consent-scoped URL enrichment, fast metadata fetching, privacy of requests |
| [Visualisation and reflection](docs/visualization.md) | Tree-aware charts, auto-unfolding, questions and annotations |
| [Local processing plugins](docs/plugins.md) | WASM modules for anonymisation and classification |
| [AI helper](docs/ai-helper.md) | Help and agentic tasks, and what the model may see |
| [Deployment](docs/deployment.md) | Docker compose, single binary, browser-only mode |
| [Visual identity](docs/design-identity.md) | Madeleine, the town, colour, type and tone |
| [Roadmap](docs/roadmap.md) | Phased plan |
| [Open questions](docs/open-questions.md) | Decisions that still need to be made |

## Lineage

Combray builds on two earlier tools from the same team:

- [DigitalFootprintsLab](https://github.com/ccs-amsterdam/DigitalFootprintsLab), a client-only React app for importing, exploring and donating takeout data, storing it in IndexedDB.
- [data-donation-importers](https://github.com/kasperwelbers/data-donation-importers), a module and GUI for writing extraction recipes for JSON, CSV and HTML files in data download packages.

Both owe a debt to [Web Historian](https://github.com/erickaakcire/webhistorian) and were developed in conversation with the [OSD2F](https://github.com/uvacw/osd2f) team.

## License

To be decided (the predecessors are MIT licensed). See [docs/open-questions.md](docs/open-questions.md).
