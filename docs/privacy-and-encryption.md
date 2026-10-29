# Privacy and encryption

Privacy is the reason a participant can trust Combray with years of their search history. This document sets out the threat model, how data is protected in the browser, how keys are handled, and how donations are encrypted so that only the researcher can read them.

> All constructions here are proposals and need review by someone with applied cryptography experience before implementation. We use standard, vetted constructions and libraries only.

## Principles

1. **Local by default.** Imported data lives in the participant's browser, encrypted at rest.
2. **Explicit, specific consent for every outbound flow.** Enrichment, donation and structure metadata each have their own consent step with a preview of exactly what is sent. The AI helper never receives data at all, only structure metadata (see [ai-helper.md](ai-helper.md)).
3. **End-to-end encryption for donations.** Donations are encrypted in the browser to the study's public key. The server stores ciphertext and cannot read it.
4. **Separation of keys and data.** No single machine or credential holds both the encrypted data and the key to open it.
5. **Minimal server knowledge.** The server learns as little as possible about who requested what, and keeps even less.
6. **Post-quantum by default for long-lived secrets.** Donations may be stored for ten years or more, so "harvest now, decrypt later" is a real concern. Donation encryption uses a hybrid classical plus post-quantum KEM.

## Threat model

| Adversary | Example | What we defend | How |
| --- | --- | --- | --- |
| Next user of a shared lab machine | Opens the browser after the participant left | Local data | Encrypted store; key needs server login; auto-lock and explicit end-of-session wipe |
| Someone with a copy of the disk | Stolen laptop, backup image | Local data | Store key wrapped by a server-held key that is never written to disk |
| Curious or compromised server operator | Admin browses the database or bucket | Donations, vault copies | End-to-end encryption; private key not on the server; vault needs a participant secret too |
| Compromised bucket | Leaked S3 credentials | Donations, vault copies | Ciphertext only; separate credentials from the key vault |
| Network attacker | Café Wi-Fi in browser mode | Everything in transit | TLS everywhere; payloads already encrypted |
| Future quantum adversary | Records ciphertext now, decrypts in 2040 | Donations | Hybrid X25519 + ML-KEM-768 (X-Wing) |
| Malicious importer or plugin | A shared importer script tries to exfiltrate data | Local data | QuickJS and WASM sandboxes without network or DOM access |
| AI model provider | Hosted model logs prompts | Local data | The helper only ever receives structure metadata; instructions run locally |
| Enrichment observer | Server or its logs link a participant to the URLs they watched | Behavioural profile | Consent-scoped, sanitised URL batches; unlinkable cache; no URL logging (see [enrichment.md](enrichment.md)) |
| Substituted study key | Attacker swaps the public key in the study config | Donations | Signed study configs, pinned signing key, fingerprint shown to staff and participant |

Out of scope, stated honestly: malware running as the participant on the same machine while the store is unlocked; a compromised server that serves malicious JavaScript to the browser (an inherent limit of web apps; see "Code integrity" below for mitigations); participants who screenshot or retype their own data.

## Local store

Data imported by the participant is stored in IndexedDB, as in DigitalFootprintsLab, but every record is encrypted.

### Layout

- **Records** are chunks of a dataset (e.g. 5,000 nodes per chunk), serialised compactly (MessagePack or a binary tree format from `combray-core`), then encrypted with **AES-256-GCM** using the store's data key.
- Each record has a random 96-bit nonce. The additional authenticated data binds the ciphertext to its context: `store_id || dataset_id || chunk_index || format_version`, so chunks cannot be swapped or replayed between datasets.
- An unencrypted **index** holds only what is needed to list and open datasets without revealing content: random ids, chunk counts, sizes rounded up to buckets, format version. Dataset names, importer names and dates are inside the encrypted manifest.
- Large binary chunks may go to OPFS instead of IndexedDB; the encryption is identical.

### Keys

```
  DEK            random AES-256 key that encrypts all records
   │ unwrapKey with server KEK = HKDF(server_secret, salt = store_id)
  inner blob     = AES-KW(server KEK, DEK)
   │ decrypt with device key (non-extractable AES-GCM key in IndexedDB)
  wrappedDEK     = AES-GCM(device key, inner blob)   ← what is stored in IndexedDB
```

Two layers are needed because WebCrypto cannot feed a non-extractable key into a KDF: the device key opens the outer layer, the server-derived KEK opens the inner one, and the result is imported as a non-extractable DEK.

- **DEK** (data encryption key): generated with `crypto.subtle.generateKey`, used as a **non-extractable** `CryptoKey`. It exists unwrapped only in memory, inside the crypto worker, while the store is unlocked.
- **Device key**: a non-extractable `CryptoKey` generated on first use and stored in IndexedDB (structured clone keeps it non-extractable). JavaScript on the page can use it but cannot read it, which limits what an XSS bug could take away. It does not protect against someone reading the browser profile on disk, which is why it is combined with the server secret.
- **Server secret**: a random 256-bit value per participant store, held by the server's key service. The client receives it after the participant (or the facilitator, on their behalf) logs in, derives the server KEK, unwraps the DEK, and then forgets the server secret.
- **Participant secret** (optional): a high-entropy recovery code printed on a card or shown once (e.g. 8 words from a word list, about 88 bits), required for portable vaults. The server never stores it.

### Unlock modes

| Mode | KEK derived from | Use case |
| --- | --- | --- |
| **Server unlock** (default in lab) | device key + server secret | Store is unreadable at rest; logging in unlocks it on this device |
| **Server + code** | server secret + participant secret | Portable: the same store can be opened on another lab machine via the vault |
| **Passphrase** (browser-only mode) | Argon2id(passphrase) via WASM, fallback PBKDF2-SHA-256 (≥ 600k iterations) | No Combray server available |
| **Ephemeral** | in-memory only | Kiosk demos; nothing persists after the tab closes |

### Session hygiene on shared machines

- Auto-lock after a configurable idle period: the DEK is dropped from memory and the UI returns to a calm lock screen.
- "End session" offers two clear choices: *lock and keep for next time* or *delete everything from this computer*. Deletion removes the IndexedDB database, OPFS files and caches, and asks the server to destroy the server secret (crypto-shredding: even an old disk image becomes unreadable).
- The facilitator view can show which stores exist on the machine (by random id and participant code) so stale data is noticed and cleaned up.
- Deployment guide recommends a dedicated browser profile per lab machine, with sync, password saving and extensions disabled.

## Remote vault (optional)

For large stores, multi-session diary studies or moving between lab machines, the encrypted chunks can be uploaded to the server's blob storage or an S3 bucket. Chunks are already encrypted with the DEK, so the vault only ever sees ciphertext.

- **Same-device vault**: the DEK is wrapped only with device-derived keys. The bucket holds opaque blobs that are useless anywhere else. If the browser profile is lost, the data is lost, which is acceptable for a backup of data the participant can re-import.
- **Portable vault**: the DEK is additionally wrapped with a KEK from the server secret plus the participant secret. The server operator alone cannot decrypt (no participant secret); a participant who loses the code loses the data.
- The key service and vault storage use separate credentials and, on a VM deployment, separate volumes. Leaking the bucket does not leak keys; leaking the key database does not leak data.

## Consent layer

Every outbound flow goes through one client module, so it can be reviewed and tested in one place.

- Each flow has a **preview**: the exact items that will be sent, in human terms ("these 25 TikTok profiles"), with the option to remove items.
- Consent is **specific and recorded**: a consent receipt (what, when, which study text version, a hash of the payload) is stored locally and included in the donation.
- Flows: `enrich`, `donate`, `shapes` (structure metadata), `vault`. Each can be disabled per study. The AI helper is not a data flow: its context builder only accepts structure metadata and declared-safe aggregates.
- Withdrawal: a donation receipt id lets a participant request deletion later. The server can delete the envelope without being able to read it.

## Donation encryption

### Construction

Donations use **HPKE** (RFC 9180, base mode) with:

- **KEM:** X-Wing, the hybrid of X25519 and ML-KEM-768 (`draft-connolly-cfrg-xwing-kem`). Secure as long as either component holds.
- **KDF:** HKDF-SHA-256
- **AEAD:** AES-256-GCM (ChaCha20-Poly1305 as an alternative where hardware AES is unavailable)

The HPKE context encrypts a random per-donation content key. The payload itself is encrypted in chunks with that content key using a STREAM-style construction (counter-based nonces and a final-chunk flag), so large donations can be encrypted and uploaded in a worker without holding everything in memory, and truncation is detected.

Candidate libraries (to confirm in a spike, with shared test vectors between client and Rust):

- Browser: `hpke-js` (`@hpke/core` with `@hpke/hybridkem-x-wing`), or `@noble/post-quantum` with `@noble/curves`. WebCrypto supports AES-GCM and HKDF natively and X25519 in current browsers; ML-KEM is not yet universally available in WebCrypto, so it comes from audited JavaScript or from our Rust core in WASM.
- Rust: `libcrux-ml-kem` (formally verified) or RustCrypto `ml-kem`, `x25519-dalek`, and an X-Wing combiner (`x-wing` crate or our own thin wrapper over the draft, reviewed).

### Envelope format

```
CombrayDonation v1
├─ header (authenticated, not encrypted)
│   ├─ version, study_id, key_id (fingerprint of study public key)
│   ├─ hpke_enc (X-Wing encapsulation, 1120 bytes)
│   ├─ chunk_size, chunk_count
│   └─ created_at (rounded to the day)
├─ chunk 0..n  AEAD(content_key, nonce_i, data_i, aad = H(header) || i || is_last)
└─ (padding to a size bucket, to hide exact donation size)
```

Decrypted, the payload is a manifest plus data: selected datasets and items, answers to questions, annotations, consent receipts, importer ids and versions, client version, and (if consented) structure shapes.

### Key management

- The researcher creates the study key pair with `combray study keygen` on their own machine. The private key is written encrypted with a passphrase (Argon2id plus AEAD, age-style). Recommended: keep it offline, with a backup with the data steward.
- Optional **key vault** for teams that need server-side custody: a separate container with its own volume and credentials, which stores the private key encrypted under a passphrase that is not on the server. Decryption still happens in the CLI on a researcher's machine; the server never decrypts.
- **Signed study configs.** Each study config, including the public key, is signed with the researcher's signing key (Ed25519, optionally hybrid with ML-DSA-65). The client verifies the signature against a pinned signing key fingerprint (built into the deployment config or the study link). The donation screen shows a short fingerprint ("encrypted for Study Willow, key 7F3A-91C2") that lab staff can check.
- Key rotation: a study can list several public keys; new donations use the newest.

## Server-side data minimisation

- No request bodies or URLs in logs. Access logs record method, route template, status and duration only. IP addresses are not stored by default.
- Participant identifiers are pseudonymous codes; the mapping to real identities, if any, stays with the researcher (e.g. in the survey tool).
- The enrichment cache is not linked to sessions (see [enrichment.md](enrichment.md)).
- Retention settings per study; the server can crypto-shred a participant's server secret to make their local store and portable vault unreadable.

## Code integrity

Browser crypto is only as trustworthy as the JavaScript that runs it. Mitigations:

- Strict Content Security Policy: no inline scripts, no third-party origins, `connect-src` limited to the Combray server.
- No third-party analytics, fonts or CDNs in production builds. Everything is self-hosted.
- Reproducible builds, with published hashes of the SPA bundle per release; the server binary embeds the bundle so a deployment runs exactly a released version.
- Installable PWA so lab machines keep a known version.
- Small, audited dependency set for anything that touches data or keys.

## Legal and ethics support

Not a substitute for a DPIA, but Combray should ship with: a data flow description suitable for ethics committees, template information letters, a description of what is and is not visible to researchers, and guidance on retention and deletion.

## Open questions

- Is the device key plus server secret combination worth its complexity, or is server secret only (in memory) enough for lab settings?
- Should participants be able to unlock with a QR code on a card (scan with the lab webcam) instead of typing a code?
- Do we want a hybrid signature (Ed25519 + ML-DSA) on study configs from v1, or Ed25519 only and upgrade later? Signatures are verified at use time, so the quantum risk is lower than for encryption.
- Who reviews the crypto design? A university security group, or an external audit once the format is stable?
- Size bucket padding: what granularity is acceptable given storage costs?
