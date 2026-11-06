# Open questions

Cross-cutting decisions that still need an answer, with the current recommendation. Each design document also lists its own smaller questions at the end. **Blocking** means Phase 1 or 2 work depends on it.

| # | Question | Options | Recommendation | Blocking |
| --- | --- | --- | --- | --- |
| 1 | Server language | Rust, Go, Node | **Decided:** TypeScript on Node ([ADR 0010](decisions/0010-node-server.md), replacing [ADR 0001](decisions/0001-server-language.md)) | Done |
| 2 | Core implementation language | A compiled language from the start, or TypeScript first | **Decided:** TypeScript; WASM only for measured bottlenecks ([ADR 0003](decisions/0003-typescript-core-and-key-tool.md)) | Done |
| 3 | Client framework | React, Svelte, Solid | **Decided:** React SPA with Vite | Done |
| 4 | Local store unlock | Server secret only, device key + server secret, passphrase | **Decided:** server-held KEK released for the participant's password; no passphrase mode, no device key ([ADR 0004](decisions/0004-server-held-store-keys.md)) | Done |
| 4b | How participants are identified | Researcher-issued participant ids, email or phone, none | **Decided:** per project anonymous, optional or required participant ids; email/phone not for now ([ADR 0005](decisions/0005-projects-scope-stores.md)) | Done |
| 5 | Donation crypto | HPKE with X-Wing, custom hybrid, classical only | **Decided and built:** HPKE with X-Wing (X25519 + ML-KEM-768), AES-256-GCM (`packages/seal`) | Done |
| 6 | Where the project private key lives | Only in a local tool, passkey-protected copy on the server, held by the server | **Decided:** sealed to each member's personal key, which the server keeps locked under their passkey (PRF) and they keep as a recovery code; opened only on the key page ([ADR 0007](decisions/0007-browser-key-page.md)) | Done |
| 6b | Studio form factor | Local binary with localhost UI, Tauri app, small key tool plus browser UI | **Decided:** everything in the browser: the studio, and a separate key page for keys ([ADR 0007](decisions/0007-browser-key-page.md), superseding the key tool of [ADR 0003](decisions/0003-typescript-core-and-key-tool.md)) | Done |
| 6c | Researcher login on a university server | Passkeys, OIDC/SAML SSO (e.g. SURFconext), both | **Pilot:** email code plus passkey, no passwords. SSO can replace the email step later; the passkey stays, because it holds the key | Phase 2 |
| 6e | R and Python access to donations | Device key added from the key page, recovery code, none | Device key, designed with the R package | Phase 2 |
| 6d | Server storage | Own disk storage, S3 | Own storage (SQLite + data directory) by default, S3 optional | Phase 2 |
| 7 | Importer spec format | YAML, JSON | **Decided:** project trees as JSON (`structure.json` and `importer.json`, validated in `projectFiles.ts`), see [tree-decisions](tree-decisions.md#storage). The YAML specs stay as the fallback runner until the consent flows are built | Done |
| 8 | Chart library | Vega-Lite, Observable Plot, custom | Vega-Lite, lazily loaded, plus custom item views. The first timeline is a small custom SVG chart: Vega compiles expressions with `new Function`, which our CSP forbids, so adopting it needs `vega-interpreter` | Phase 1 |
| 9 | Enrichment cache scope | Shared across studies, per study, none | Shared by default, per study or none configurable | Phase 3 |
| 10 | AI providers | Local (OpenAI-compatible), Anthropic API, both | Both, behind one provider interface; the model only ever sees metadata | Phase 5 |
| 11 | Which classifier labels are safe to show the AI | Any, declared list, none | Declared per plugin, enabled per study | Phase 5 |
| 12 | Facilitator view | Same screen, second device synced via server | Same screen first; second device later | No |
| 13 | Licence | MIT (as predecessors), Apache-2.0, AGPL-3.0 | **Decided:** MIT | Done |
| 14 | Relationship to OSD2F and other platforms | Independent, compatible donation format, shared backend | Independent, but document the envelope format so others can accept Combray donations | No |
| 15 | Name usage | "Combray" everywhere, or Proust terms in code too | "Combray" for the product; plain names in code | No |
| 6f | Hardening the key page's source against a compromised server | Leave it served by the server (checked against the release hash), a static host the server cannot write to (deployed from a release), a proxy in front of the key host (for example a Cloudflare Worker) that refuses a page whose hash is not the release's | Revisit after the pilot. The proxy needs no change to Combray and adds no new party to trust if the same account already holds the DNS; a static host needs the API to accept the key page from another origin. Neither helps against whoever controls the DNS ([deployment.md](deployment.md#protecting-the-host-names)) | No |
| 16 | Who reviews crypto and privacy design | University security group, external audit | Internal review before Phase 2, external audit before a large study | Phase 2 |
| 17 | Hard cases of file formats that are still open: label and value lists in JSON and CSV ([J4](formats/json.md#j4-lists-of-label-and-value-objects), [C2](formats/csv.md#c2-two-columns-of-field-and-value)), XML attributes ([X1](formats/html.md#x1-xml-attributes)), structured lines in text ([F3](formats/files.md#f3-plain-text)) | Extend the existing corrections ("Texts here are names"), preprocessors per format, researcher scripts in the QuickJS sandbox | Document every case in [formats/](formats/README.md) first, with a test; add a feature when a study needs one and we have seen real packages with it | No |
