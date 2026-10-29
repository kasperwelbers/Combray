# Open questions

Cross-cutting decisions that still need an answer, with the current recommendation. Each design document also lists its own smaller questions at the end. **Blocking** means Phase 1 or 2 work depends on it.

| # | Question | Options | Recommendation | Blocking |
| --- | --- | --- | --- | --- |
| 1 | Server language | Rust, Go, split | **Decided:** Rust ([ADR 0001](decisions/0001-server-language.md)) | Done |
| 2 | Core implementation language | Rust from the start, or TypeScript first and port later | **Decided:** TypeScript; Rust/WASM only for measured bottlenecks ([ADR 0003](decisions/0003-typescript-core-and-key-tool.md)) | Done |
| 3 | Client framework | React, Svelte, Solid | **Decided:** React SPA with Vite | Done |
| 4 | Local store unlock | Server secret only, device key + server secret, passphrase | **Decided:** server-held KEK released for the participant's password; no passphrase mode, no device key ([ADR 0004](decisions/0004-server-held-store-keys.md)) | Done |
| 5 | Donation crypto | HPKE with X-Wing, custom hybrid, classical only | HPKE with X-Wing (X25519 + ML-KEM-768), AES-256-GCM | Phase 2 |
| 6 | Where the project private key lives | Only in Studio (researcher responsible), passkey-protected copy on the server | Studio only, with guided backups; passkey backup later, after a spike ([privacy](privacy-and-encryption.md#optional-passkey-protected-key-backup)) | Phase 2 |
| 6b | Studio form factor | Local binary with localhost UI, Tauri app, small key tool plus browser UI | **Decided:** a small local key tool (keys, config signing, decryption); researcher UI in the browser ([ADR 0003](decisions/0003-typescript-core-and-key-tool.md)) | Done |
| 6c | Researcher login on a university server | Passkeys, OIDC/SAML SSO (e.g. SURFconext), both | Passkeys built in, SSO optional | Phase 2 |
| 6d | Server storage | Own disk storage, S3 | Own storage (SQLite + data directory) by default, S3 optional | Phase 2 |
| 7 | Importer spec format | YAML, JSON | YAML on disk, JSON Schema for validation (not built yet) | Yes |
| 8 | Chart library | Vega-Lite, Observable Plot, custom | Vega-Lite, lazily loaded, plus custom item views. The first timeline is a small custom SVG chart: Vega compiles expressions with `new Function`, which our CSP forbids, so adopting it needs `vega-interpreter` | Phase 1 |
| 9 | Enrichment cache scope | Shared across studies, per study, none | Shared by default, per study or none configurable | Phase 3 |
| 10 | AI providers | Local (OpenAI-compatible), Anthropic API, both | Both, behind one provider interface; the model only ever sees metadata | Phase 5 |
| 11 | Which classifier labels are safe to show the AI | Any, declared list, none | Declared per plugin, enabled per study | Phase 5 |
| 12 | Facilitator view | Same screen, second device synced via server | Same screen first; second device later | No |
| 13 | Licence | MIT (as predecessors), Apache-2.0, AGPL-3.0 | **Decided:** MIT | Done |
| 14 | Relationship to OSD2F and other platforms | Independent, compatible donation format, shared backend | Independent, but document the envelope format so others can accept Combray donations | No |
| 15 | Name usage | "Combray" everywhere, or Proust terms in code too | "Combray" for the product; plain names in code | No |
| 16 | Who reviews crypto and privacy design | University security group, external audit | Internal review before Phase 2, external audit before a large study | Phase 2 |
