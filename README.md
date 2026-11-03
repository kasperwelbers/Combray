<p align="center">
  <!-- Placeholder until the Madeleine logo exists. See docs/design-identity.md -->
  <strong>🐚 Combray</strong>
</p>

<p align="center"><em>Revisiting your digital past, together.</em></p>

---

> *"And suddenly the memory revealed itself. The taste was that of the little piece of madeleine which on Sunday mornings at Combray (…) my aunt Léonie used to give me, dipping it first in her own cup of tea or tisane."*
> — Marcel Proust, *Swann's Way*

**Combray** is an open source data donation tool built for **qualitative research**. Participants load the data that platforms hold about them (Google Takeout, TikTok, Instagram, and so on), explore it, reflect on it, and, only if they choose, donate parts of it to a research project.

Most data donation tools are designed for survey participants who donate remotely and quickly.
Without throwing shade (since I've worked on some of them), the focus is on getting the data, and the participant experience is primarily a means to that end.
Combray is designed with a focus on the participant experience, and the data is a means to this experience.
Donating the data is only a possible outcome, not the goal.
Example use cases are:

* A participant looks at the data together with a researcher. The purpose of the data is to evoke memories and reflections (like Proust's madeleine).
* A participant explores their own data, in a lab or at home, and answers questions about the data and/or their own reflections.

> **Status:** early development, not yet used in a study. Participants can import a data download package in the browser, keep it encrypted on their computer, explore it and donate parts of it. Researchers can sign in, build an importer in the studio, and open donations on the key page with their passkey. Enrichment and hosting come next. Start with [docs/](docs/README.md).

## Development

This runs Combray on your own machine for development, with synthetic example projects. It is not a way to host Combray for a study: for that, see [docs/deployment.md](docs/deployment.md).

Requires Node 22.18+ (24 recommended) and pnpm 10.

```sh
pnpm install
pnpm build      # once: the web client and the key page
pnpm dev        # web client with hot reload on http://localhost:5173, plus the server on :8080
```

| Path | What it is |
| --- | --- |
| `/` | Landing page: what Combray is, with the way in for participants and researchers |
| `/p/` | Participant area: studies with data on this computer |
| `/p/example/` | Example study (participant id optional) |
| `/p/willow/#id=W-1234` | Example study that requires a participant id |
| `/studio/` | Researcher workspace |

Projects come from [deploy/examples/projects/](deploy/examples/projects/). The development server keeps its databases in `.dev/` and does not send mail: sign-in codes are written to `.dev/outbox/` as files.

### Signing in as a researcher

1. Add yourself to an example project (any address will do; no mail is sent):
   ```sh
   pnpm researcher example you@example.org
   ```
2. **Studio:** open http://localhost:5173/studio/, enter that address, and type the 8-digit code from the newest file in `.dev/outbox/`.
3. **Key page** (passkey, project key, opening donations): open http://keys.localhost:8080, choose "Sign in with an email code", use a code from `.dev/outbox/` again, and set up your passkey and recovery code. Then create the project key.
4. **A donation to open:** `pnpm synthetic-donation http://localhost:8080 example` seals a synthetic donation to the project key, which the key page can then open.

`pnpm serve` instead builds everything and serves it from the server alone, on http://localhost:8080. More in [docs/deployment.md](docs/deployment.md#development); all commands are in [CLAUDE.md](CLAUDE.md#commands).

## What makes Combray different

This different goal implies certain design principles. Also, after several iterations of the predecessor tools, we have learned a few things regarding what works and what doesn't. So Combray is (or well, will be) designed to be:

- **Returning to sessions.** Participants can revisit the tool and their own data. This allows some design features that are impossible in a one-shot donation, such as longer running enrichment processes, and the ability to recover from small problems in the data extraction process. To support this, Combray stores data locally in the browser's IndexedDB, encrypted with a key that can only be recovered through a password login on a server. The server protects the data, but cannot see it.
- **Easy to use.** Current tools are catered to technically skilled researchers. This is in part because of the complexity of designing efficient data extraction scripts that need to work the one time the participant uses the tool and a large number of participants. Scripts need to be robust for changes in data donation packages, and a small flaw can harm the primary goal of the study. When we shift the focus to a slower process, in studies where participants are assisted by researchers and/or expected to return to the tool, we need to anticipate less, and can recover from small problems. This enables a less complex approach to data extraction.
- **Easy to deploy.** Researchers that want to do in-person data donation do not need to set up complex secure servers. Combray can be installed locally to avoid needing a server at all. For remote use, an end-to-end encryption design makes it possible for researchers to safely use a shared server set up by a university or research institute.
- **End-to-end encryption.** Donated data is always encrypted by the client using a quantum-proof public key. Researchers sign in with a passkey, which also unlocks their keys on a small, separate key page; the server only ever stores keys it cannot open. Nothing to install.
- **Enrichment with consent.** Takeout data is often thin: a list of URLs or usernames. With the participant's consent, Combray can send a minimal, sanitised set of URLs (for example "the top 25 TikTok profiles I watched per month") to the server, which fetches public metadata such as titles and thumbnails so the data becomes something people recognise.
- **One universal importer.** Every file (JSON, CSV, HTML, XML, and whole zip archives) becomes a tree. Importers are small declarative specs that mark which paths to show to the participant, and which paths we ask them to donate. When a file is opened in the client, the tree structure of donations is stored on the server as metadata (with user approval and sanitized to not leak personal data). Creating and maintaining importers then becomes a simple (UI-supported) process of deciding what to do with each path (ignore, show, donate), and when the structure of donation packages changes, the researcher just needs to decide what to do with the new paths. Name changes can be dealt with by adding aliases. Combined with a research design where donation takes place after multiple sessions, this makes it possible to maintain importers without needing to anticipate every possible change in the data donation packages.
- **Trees, not just tables.** Data is presented as it is. Charts that need tables unfold the tree on demand, and all aggregation happens locally in web workers (in TypeScript, with WebAssembly only for parts that turn out to be too slow). Basically, instead of dealing with the complicated process of flattening a tree to a table for every donation, we focus on dealing with the much more complicated process of how to create an intuitive UI for exploring and visualizing tree data. Basically, addressing the problem at the root instead of the leaves (pun very much intended).
- **Pluggable local processing.** WebAssembly modules for anonymisation and classification run locally, sandboxed, without network access.
- **An AI helper that never sees your data.** One of the big challenges of data donation is the technical barrier (and working with tree data doesn't help in this regard). So here we'll lean on AIs, implemented in a way that doesn't harm privacy. If the researcher's documentation for how to download data is confusing, the AI can answer questions about it. If you don't know how to look up and visualize data (which we'll give participants full control over) they can ask the AI to do it for them. E.g., you can ask it to show your instagram activity over time, and it will send the query, aggregation and visualization instructions to the client without actually seeing the data. Not yet sure how well this will work based on just the tree metadata alone. If it's not good enough to do this blindly for participants, it can at least be used to help researchers write the importers and create visualizations.

## Planned architecture at a glance

Combray is three modular parts. A university runs **one shared server**; any researcher, without programming, uses it from the browser, with keys handled on a small, separate **key page** unlocked with a passkey; participants only need a **browser**.

```
 researcher's browser             university server                participant's browser
┌─────────────────────┐          ┌──────────────────────────┐ SPA, ┌──────────────────────────┐
│ Studio              ├─────────►│ Combray server           ├─────►│ Web client (React SPA)   │
│ • importers, views, │ project  │ • project registry       │config│ • import ─► tree         │
│   questions         │ tree     │ • store keys for the     │◄─────┤ • encrypted IndexedDB    │
├─────────────────────┤          │   participants' local    │unlock│ • web workers            │
│ Key page (own site) │ public   │   encrypted stores       │      │ • explore and reflect    │
│ • passkey unlocks   ├─────────►│ • keys sealed to         │◄─────┤ • consented URLs only    │
│   your keys 🔑      │ keys     │   researchers only       │      │                          │
│ • decrypt, export   │◄─────────┤ • enrichment + cache     │◄─────┤ • donate: encrypted to   │
│   (in memory only)  │ cipher-  │ • donation storage       │cipher│   the project public key │
└─────────────────────┘ text     └──────────────────────────┘ text └──────────────────────────┘
```

The server never sees unencrypted donation data and never holds the key to decrypt it.

See [docs/architecture.md](docs/architecture.md) for the full picture.

## Documentation

| Document | What it covers |
| --- | --- |
| [Vision and use cases](docs/vision.md) | Who Combray is for, research scenarios, guiding principles |
| [Architecture](docs/architecture.md) | Researcher tools, web client and shared server; monorepo layout; workers and WASM |
| [Modular components (ADR 0002)](docs/decisions/0002-modular-components.md) | Why researcher tool, web client and server are separate |
| [Server language (ADR 0010)](docs/decisions/0010-node-server.md) | TypeScript on Node, self-hosted first |
| [Privacy and encryption](docs/privacy-and-encryption.md) | Threat model, local encryption, key handling, donation crypto |
| [Universal tree importer](docs/universal-importer.md) | Files as trees, path language, importer specs, schema metadata, QuickJS |
| [Enrichment and scraping](docs/enrichment.md) | Consent-scoped URL enrichment, fast metadata fetching, privacy of requests |
| [Visualisation and reflection](docs/visualization.md) | Tree-aware charts, auto-unfolding, questions and annotations |
| [Local processing plugins](docs/plugins.md) | WASM modules for anonymisation and classification |
| [AI helper](docs/ai-helper.md) | Help and agentic tasks, and what the model may see |
| [Security](docs/security.md) | Every implemented security choice and why: local store, store keys, XSS |
| [Deployment](docs/deployment.md) | Docker compose, single binary |
| [Visual identity](docs/design-identity.md) | Madeleine, the town, colour, type and tone |
| [Roadmap](docs/roadmap.md) | Phased plan |
| [Open questions](docs/open-questions.md) | Decisions that still need to be made |

## Lineage

Combray builds on two earlier tools from the same team:

- [DigitalFootprintsLab](https://github.com/ccs-amsterdam/DigitalFootprintsLab), a client-only React app for importing, exploring and donating takeout data, storing it in IndexedDB.
- [data-donation-importers](https://github.com/kasperwelbers/data-donation-importers), a module and GUI for writing extraction recipes for JSON, CSV and HTML files in data download packages.

Both owe a debt to [Web Historian](https://github.com/erickaakcire/webhistorian) and were developed in conversation with the [OSD2F](https://github.com/uvacw/osd2f) team.

## License

[MIT](LICENSE).
