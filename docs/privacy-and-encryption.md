# Privacy and encryption

Privacy is the reason a participant can trust Combray with years of their search history. This document sets out the threat model, how data is protected in the browser, how keys are handled, and how donations are encrypted so that only the researcher can read them. What is implemented today, with the reasoning behind each choice, is in [security.md](security.md).

> All constructions here are proposals and need review by someone with applied cryptography experience before implementation. We use standard, vetted constructions and libraries only.

## Principles

1. **Local by default.** Imported data lives in the participant's browser, encrypted at rest.
2. **Explicit, specific consent for every outbound flow.** Enrichment, donation and structure metadata each have their own consent step with a preview of exactly what is sent. The AI helper never receives data at all, only structure metadata (see [ai-helper.md](ai-helper.md)).
3. **End-to-end encryption for donations.** Donations are encrypted in the browser to the project's public key, whose private key the server only ever holds sealed to the project's researchers. It is opened only on the key page, in the researcher's browser ([researcher-keys.md](researcher-keys.md)). The server stores ciphertext and cannot read it.
4. **Separation of keys and data.** No single machine or credential holds both the encrypted data and the key to open it.
5. **Minimal server knowledge.** The server learns as little as possible about who requested what, and keeps even less.
6. **Post-quantum by default for long-lived secrets.** Donations may be stored for ten years or more, so "harvest now, decrypt later" is a real concern. Donation encryption uses a hybrid classical plus post-quantum KEM.

## Threat model

| Adversary | Example | What we defend | How |
| --- | --- | --- | --- |
| Next user of a shared lab machine | Opens the browser after the participant left | Local data | Encrypted store; key released by the server only for the participant's password; auto-lock and explicit end-of-session wipe |
| Someone with a copy of the disk | Stolen laptop, backup image | Local data | Data key wrapped by a server-held key that is never written to the device; password guessing only online, under a lockout |
| Curious or compromised server operator | Admin of the shared university server browses its storage | Donations, vault copies | End-to-end encryption; project key stored only sealed to researchers' personal keys, which are locked under their passkeys; vault needs a participant secret too |
| Compromised storage | Stolen server disk or leaked S3 credentials | Donations, vault copies | Ciphertext only; store keys kept separately under a store master key |
| Network attacker | Café Wi-Fi in browser mode | Everything in transit | TLS everywhere; payloads already encrypted |
| Future quantum adversary | Records ciphertext now, decrypts in 2040 | Donations | Hybrid X25519 + ML-KEM-768 (X-Wing) |
| Malicious importer or plugin | A shared importer script tries to exfiltrate data | Local data | QuickJS and WASM sandboxes without network or DOM access |
| AI model provider | Hosted model logs prompts | Local data | The helper only ever receives structure metadata; instructions run locally |
| Enrichment observer | Server or its logs link a participant to the URLs they watched | Behavioural profile | Consent-scoped, sanitised URL batches; unlinkable cache; no URL logging (see [enrichment.md](enrichment.md)) |
| Substituted project key | Server or attacker swaps the public key in a project config | Donations | Project key fingerprint in the participant link's URL fragment (`#k=`), checked before sealing; signed configs later |
| Substituted researcher key | Server slips in its own public key when a colleague is given access | Donations | Both researchers compare a key code before the project key is sealed to the colleague |
| Malicious page from the server | Server serves a key page that leaks keys | Project keys | Key page on its own origin, a single hash-pinned file with a published release hash; an active, visible attack, not ruled out |

Out of scope, stated honestly: malware running as the participant on the same machine while the store is unlocked; a compromised server that serves malicious JavaScript to the browser (an inherent limit of web apps; see "Code integrity" below for mitigations); participants who screenshot or retype their own data.

## Local store

Data imported by the participant is stored in IndexedDB, as in DigitalFootprintsLab, but every record is encrypted. The details (storage model, record encryption, key handling, parameters and limits) are in [security.md](security.md#local-store). In short:

- **Layout.** Each uploaded file is kept as one logical blob of its raw bytes, encrypted in 4 MiB slices, plus chunked caches of the parsed tree and importer tables. IndexedDB is used as a blob store, never queried by content. An unencrypted index holds only random ids, chunk counts, size buckets and format versions.
- **Records** are encrypted with **AES-256-GCM** under the store's data key (DEK), with a random 96-bit nonce and additional data that binds each ciphertext to its store, dataset and position.
- **Keys** ([ADR 0004](decisions/0004-server-held-store-keys.md)). The data stays on the device and the key stays on the server:

```
  DEK            random AES-256 key, non-extractable, only in the data worker; never leaves the device
   │ wrapped with AES-KW under
  KEK            = HKDF-SHA-256(store master key, per-store salt, label || store id)
                   released by the server's key service only for the store's password
                   (Argon2id, per-store lockout, per-IP rate limits)
```

- **One store per project.** Each study has its own store and key on the device. Participants with an id can get a one-time reset link from the researchers ([ADR 0005](decisions/0005-projects-scope-stores.md)).
- **Server unlock is the only mode.** There is no passphrase or browser-only mode, and no device-key layer (see [security.md](security.md#no-passphrase-only-mode) for why).
- **Participant secret** (later, optional): a high-entropy recovery code for portable vaults, which the server never stores.

### Session hygiene on shared machines

- Auto-lock after a configurable idle period: the DEK is dropped from memory and the UI returns to a calm lock screen.
- "End session" offers two clear choices: *lock and keep for next time* or *delete everything from this computer*. Deletion asks the server to forget the store's KEK (crypto-shredding: even an old disk image becomes unreadable), then removes the IndexedDB database, OPFS files and caches. Implemented: auto-lock, lock, and delete with crypto-shredding.
- The facilitator view can show which stores exist on the machine (by random id and participant code) so stale data is noticed and cleaned up.
- Deployment guide recommends a dedicated browser profile per lab machine, with sync, password saving and extensions disabled.

## Remote vault (optional)

For large stores, multi-session diary studies or moving between lab machines, the encrypted chunks can be uploaded to the server's blob storage or an S3 bucket. Chunks are already encrypted with the DEK, so the vault only ever sees ciphertext.

- **Same-device vault**: the DEK stays wrapped only under the server KEK, and the wrapped DEK stays on the device. The bucket holds opaque blobs that are useless without the device. If the browser profile is lost, the data is lost, which is acceptable for a backup of data the participant can re-import.
- **Portable vault**: the DEK is additionally wrapped with a KEK from the server key plus the participant secret. The server operator alone cannot decrypt (no participant secret); a participant who loses the code loses the data.
- The key service and vault storage use separate credentials and, on a VM deployment, separate volumes. Leaking the vault storage does not leak keys; leaking the key database does not leak data.

## Consent layer

Every outbound flow goes through one client module, so it can be reviewed and tested in one place.

- Each flow has a **preview**: the exact items that will be sent, in human terms ("these 25 TikTok profiles"), with the option to remove items.
- Consent is **specific and recorded**: a consent receipt (what, when, which study text version, a hash of the payload) is stored locally and included in the donation.
- Flows: `enrich`, `donate`, `shapes` (structure metadata), `vault`. Each can be disabled per study. The AI helper is not a data flow: its context builder only accepts structure metadata and declared-safe aggregates.
- Withdrawal: the donation receipt carries a withdrawal token. Withdrawing deletes the donation's sealed key on the server, which makes every copy of the envelope unreadable, including copies researchers downloaded ([ADR 0006](decisions/0006-revocable-donation-keys.md), [key-design.md](key-design.md#6-withdrawing)).

## Donation encryption

### Construction

Donations use **HPKE** (RFC 9180, base mode) with:

- **KEM:** X-Wing, the hybrid of X25519 and ML-KEM-768 (`draft-connolly-cfrg-xwing-kem`). Secure as long as either component holds.
- **KDF:** HKDF-SHA-256
- **AEAD:** AES-256-GCM

HPKE seals a fresh random per-donation key to the **project key**. The sealed key is stored on the server apart from the envelope, so withdrawing a donation only has to delete it ([ADR 0006](decisions/0006-revocable-donation-keys.md)). The HPKE `info` binds the project id and donation id, and the envelope header hash is its additional data. The payload is encrypted in chunks with the donation key, STREAM-style (counter nonces and a last-chunk flag), so reordering, dropping or truncating chunks is detected.

Libraries: `@hpke/core` with `@hpke/hybridkem-x-wing` in `packages/seal`, used by both the participant client and the key page. The server never opens anything. WebCrypto provides AES-GCM, HKDF and SHA-256.

### Envelope format

```
"CMBRDON1" | u32 header length | header (JSON) | chunk* (u32 length | AES-256-GCM ciphertext)

header: { v, project, donation, key (project key fingerprint), chunkBytes, chunks, created (day) }
chunk i: nonce = 11-byte big-endian i || last flag; aad = SHA-256(magic || header)
```

The sealed donation key travels next to the envelope, never in it, and the server keeps it in its own database. Exact constructions are in [security.md](security.md#donation-envelope). Size padding is not done yet.

Decrypted, the payload is `{ format: "combray-donation/1", tables: [{ id, name, columns, rows }], answers }`. Consent receipts, importer versions and annotations are to be added with the donate screen.

### Key management

Built for the pilot; the full design is in [researcher-keys.md](researcher-keys.md) ([ADR 0007](decisions/0007-browser-key-page.md)). It replaces the local key tool and the passkey-backup idea that used to be here.

- **Each researcher has a personal key** (X-Wing), made in their browser on the key page. The server keeps its public key, and the private key only locked under the researcher's passkey (WebAuthn PRF) and, offline, as a recovery code the researcher saves.
- **Each project has one project key** (X-Wing). Donations are sealed to it. The server keeps one sealed copy per member with access, and cannot open any of them.
- **Access is granted browser to browser.** A member's key page seals the project key to a colleague's personal key, after both compare a key code derived from the colleague's public key.
- **Decryption happens on the key page**, a dependency-free page on its own origin with a hash-pinned CSP, in memory only. It fetches the sealed donation keys on every use and never stores keys or plaintext ([key-design.md](key-design.md#5-analysing-fetch-on-use)).
- **The participant link pins the project key**: `https://combray.uni.nl/p/willow/#k=<fingerprint>`. The fragment never reaches the server; the donate screen checks the config's key against it before sealing.
- **Signed project configs** (an Ed25519 key, perhaps with ML-DSA) are deferred. The fingerprint covers the key, which is what matters for confidentiality; signing would also cover the rest of the config.
- **Key rotation** is not built. A new project key would mean a new project for now.

### Why a passkey can hold the key safely

The worry with keys behind a passkey in a web page was that the page sees the PRF secret, so a compromised server could serve a page that takes it. That is still true, and it is the general limit of every web-based end-to-end encrypted service. What changed is how far the page is narrowed: it runs on its own origin that the participant app and studio cannot reach, it is one file whose script and style are pinned by hash in its CSP, and its release hash is published so anyone can check what a server serves. The passkey's relying party is the key host, so passkeys cannot be used from the main site at all. See [researcher-keys.md](researcher-keys.md#why-not-a-local-tool-and-why-not-keys-on-the-server) for the weighing against a local tool.

## Server-side data minimisation

- No request bodies or URLs in logs. Access logs record method, route template, status and duration only. IP addresses are not stored by default.
- Participant identifiers are pseudonymous codes; the mapping to real identities, if any, stays with the researcher (e.g. in the survey tool).
- The enrichment cache is not linked to sessions (see [enrichment.md](enrichment.md)).
- Retention settings per project; the server can crypto-shred a participant's server secret to make their local store and portable vault unreadable.

## Code integrity

Browser crypto is only as trustworthy as the JavaScript that runs it. The measures (strict CSP with Trusted Types, never rendering data as HTML, self-hosted code only, reproducible builds with published hashes) and why "only run code we signed" is not available on the web are described in [security.md](security.md#xss-and-code-integrity).

## Legal and ethics support

Not a substitute for a DPIA, but Combray should ship with: a data flow description suitable for ethics committees, template information letters, a description of what is and is not visible to researchers, and guidance on retention and deletion.

## Open questions

- ~~Is the device key plus server secret combination worth its complexity?~~ Decided: server key only ([ADR 0004](decisions/0004-server-held-store-keys.md)).
- Should participants be able to unlock with a QR code on a card (scan with the lab webcam) instead of typing a code?
- ~~Is the passkey-protected key backup worth offering?~~ Decided: passkeys hold researcher keys, on a separate key page ([ADR 0007](decisions/0007-browser-key-page.md)).
- How do the R and Python packages get the personal key, since they cannot use a passkey? A device key added from the key page is the likely answer.
- Do we want a hybrid signature (Ed25519 + ML-DSA) on project configs from v1, or Ed25519 only and upgrade later? Signatures are verified at use time, so the quantum risk is lower than for encryption.
- Who reviews the crypto design? A university security group, or an external audit once the format is stable?
- Size bucket padding: what granularity is acceptable given storage costs?
