# Open questions

Cross-cutting decisions that still need an answer, with the current recommendation. Each design document also lists its own smaller questions at the end. **Blocking** means Phase 1 or 2 work depends on it.

| # | Question | Options | Recommendation | Blocking |
| --- | --- | --- | --- | --- |
| 1 | Server language | Rust, Go, split | Rust, for sharing the core and crypto with the browser via WASM ([ADR 0001](decisions/0001-server-language.md)) | Yes |
| 2 | Core implementation language | Rust from the start, or TypeScript first and port later | Define formats in Rust from the start; allow TS for simple operations while WASM matures | Yes |
| 3 | Client framework | React, Svelte, Solid | React SPA with Vite | Yes |
| 4 | Local store unlock | Server secret only, device key + server secret, passphrase | Device key + server secret in lab mode; passphrase in browser mode | Phase 2 |
| 5 | Donation crypto | HPKE with X-Wing, custom hybrid, classical only | HPKE with X-Wing (X25519 + ML-KEM-768), AES-256-GCM | Phase 2 |
| 6 | Where the study private key lives | Offline file, separate vault container | Offline by default; vault container as an option | Phase 2 |
| 7 | Importer spec format | YAML, JSON | YAML on disk, JSON Schema for validation | Yes |
| 8 | Chart library | Vega-Lite, Observable Plot, custom | Vega-Lite, lazily loaded, plus custom item views | Phase 1 |
| 9 | Enrichment cache scope | Shared across studies, per study, none | Shared by default, per study or none configurable | Phase 3 |
| 10 | AI providers | Local (OpenAI-compatible), Anthropic API, both | Both, behind one provider interface; the model only ever sees metadata | Phase 5 |
| 11 | Which classifier labels are safe to show the AI | Any, declared list, none | Declared per plugin, enabled per study | Phase 5 |
| 12 | Facilitator view | Same screen, second device synced via server | Same screen first; second device later | No |
| 13 | Licence | MIT (as predecessors), Apache-2.0, AGPL-3.0 | MIT or Apache-2.0 for easy reuse; AGPL if we want hosted forks to stay open | Before first release |
| 14 | Relationship to OSD2F and other platforms | Independent, compatible donation format, shared backend | Independent, but document the envelope format so others can accept Combray donations | No |
| 15 | Name usage | "Combray" everywhere, or Proust terms in code too | "Combray" for the product; plain names in code | No |
| 16 | Who reviews crypto and privacy design | University security group, external audit | Internal review before Phase 2, external audit before a large study | Phase 2 |
