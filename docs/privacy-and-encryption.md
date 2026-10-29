# Privacy and encryption

Privacy is the reason a participant can trust Combray with years of their search history. This document sets out the threat model, how data is protected in the browser, how keys are handled, and how donations are encrypted so that only the researcher can read them.

> All constructions here are proposals and need review by someone with applied cryptography experience before implementation. We use standard, vetted constructions and libraries only.

## Principles

1. **Local by default.** Imported data lives in the participant's browser, encrypted at rest.
2. **Explicit, specific consent for every outbound flow.** Enrichment, donation and structure metadata each have their own consent step with a preview of exactly what is sent. The AI helper never receives data at all, only structure metadata (see [ai-helper.md](ai-helper.md)).
3. **End-to-end encryption for donations.** Donations are encrypted in the browser to the project's public key, whose private key exists only in the researcher's local Studio. The server stores ciphertext and cannot read it.
4. **Separation of keys and data.** No single machine or credential holds both the encrypted data and the key to open it.
5. **Minimal server knowledge.** The server learns as little as possible about who requested what, and keeps even less.
6. **Post-quantum by default for long-lived secrets.** Donations may be stored for ten years or more, so "harvest now, decrypt later" is a real concern. Donation encryption uses a hybrid classical plus post-quantum KEM.

## Threat model

| Adversary | Example | What we defend | How |
| --- | --- | --- | --- |
| Next user of a shared lab machine | Opens the browser after the participant left | Local data | Encrypted store; key needs server login; auto-lock and explicit end-of-session wipe |
| Someone with a copy of the disk | Stolen laptop, backup image | Local data | Store key wrapped by a server-held key that is never written to disk |
| Curious or compromised server operator | Admin of the shared university server browses its storage | Donations, vault copies | End-to-end encryption; private key only in the researcher's Studio; vault needs a participant secret too |
| Compromised storage | Stolen server disk or leaked S3 credentials | Donations, vault copies | Ciphertext only; store keys kept separately under a master key |
| Network attacker | Café Wi-Fi in browser mode | Everything in transit | TLS everywhere; payloads already encrypted |
| Future quantum adversary | Records ciphertext now, decrypts in 2040 | Donations | Hybrid X25519 + ML-KEM-768 (X-Wing) |
| Malicious importer or plugin | A shared importer script tries to exfiltrate data | Local data | QuickJS and WASM sandboxes without network or DOM access |
| AI model provider | Hosted model logs prompts | Local data | The helper only ever receives structure metadata; instructions run locally |
| Enrichment observer | Server or its logs link a participant to the URLs they watched | Behavioural profile | Consent-scoped, sanitised URL batches; unlinkable cache; no URL logging (see [enrichment.md](enrichment.md)) |
| Substituted project key | Server or attacker swaps the public key in a project config | Donations | Configs signed in Studio; signing key fingerprint in the participant link's URL fragment; fingerprint shown to staff and participant |

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
- The key service and vault storage use separate credentials and, on a VM deployment, separate volumes. Leaking the vault storage does not leak keys; leaking the key database does not leak data.

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
│   ├─ version, project_id, key_ids (fingerprints of project public keys)
│   ├─ hpke_enc per recipient key (X-Wing encapsulation, 1120 bytes each)
│   ├─ chunk_size, chunk_count
│   └─ created_at (rounded to the day)
├─ chunk 0..n  AEAD(content_key, nonce_i, data_i, aad = H(header) || i || is_last)
└─ (padding to a size bucket, to hide exact donation size)
```

Decrypted, the payload is a manifest plus data: selected datasets and items, answers to questions, annotations, consent receipts, importer ids and versions, client version, and (if consented) structure shapes.

### Key management

The project key pair is created and held in **Combray Studio**, the researcher tool on the researcher's own computer (see [architecture.md](architecture.md#combray-studio-researcher-tool)). The shared server only ever receives the public key.

- **Creation.** Studio generates an X-Wing key pair for encryption and an Ed25519 key pair (optionally hybrid with ML-DSA-65) for signing project configs.
- **The researcher is responsible for the private key**, and Studio makes that easy to do well:
  - an encrypted key file (passphrase, Argon2id plus AEAD, age-style), saved where the researcher chooses;
  - a printable **recovery sheet** (the key as words or a QR code) to keep in a locked drawer or with the data steward;
  - suggestions per situation: university-managed encrypted storage, a second copy with a co-investigator, never in email or shared drives in plain form;
  - Studio refuses to register the project until the researcher has confirmed at least one backup, and can test a backup by decrypting a test envelope.
- **Decryption happens only in Studio**, on the researcher's machine. Studio downloads ciphertext from the server and decrypts locally.
- **Signed project configs.** Each config, including the public key, is signed in Studio. The web client verifies the signature before encrypting anything. Because one university server hosts many projects, the client needs a trust anchor the server cannot change: the participant link carries the signing key fingerprint in the URL fragment (`https://combray.uni.nl/p/willow#k=7F3A91C2…`), which browsers never send to the server. Printed participant cards carry the same link as a QR code. The donation screen also shows a short fingerprint ("encrypted for project Willow, key 7F3A-91C2") that lab staff can check against Studio.
- **Key rotation.** A project can list several public keys; new donations use the newest. Studio keeps old private keys to decrypt older donations.
- **Collaborators.** A project can have several researcher keys; donations are encrypted to all of them (one HPKE encapsulation per recipient), so a team does not need to share one private key.

### Optional: passkey-protected key backup

Later, a researcher may opt in to storing a copy of the private key on the server, encrypted under a key derived from a **passkey** (WebAuthn with the PRF extension, which gives a per-credential secret only the authenticator can produce). The server then holds a blob it cannot open; the researcher can recover the key on a new computer with their passkey.

The catch is where the PRF secret is evaluated. If the passkey ceremony runs in a page served by the shared server, that page's JavaScript sees the secret, and a compromised server could take it. The ceremony must therefore run in Studio, not in server-served code, which raises questions about which relying-party ID the passkey is bound to and whether synced passkeys work for it. This needs a design spike before it is offered.

## Server-side data minimisation

- No request bodies or URLs in logs. Access logs record method, route template, status and duration only. IP addresses are not stored by default.
- Participant identifiers are pseudonymous codes; the mapping to real identities, if any, stays with the researcher (e.g. in the survey tool).
- The enrichment cache is not linked to sessions (see [enrichment.md](enrichment.md)).
- Retention settings per project; the server can crypto-shred a participant's server secret to make their local store and portable vault unreadable.

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
- Is the passkey-protected key backup worth offering, given that the passkey ceremony must run in Studio rather than in server-served code?
- Do we want a hybrid signature (Ed25519 + ML-DSA) on project configs from v1, or Ed25519 only and upgrade later? Signatures are verified at use time, so the quantum risk is lower than for encryption.
- Who reviews the crypto design? A university security group, or an external audit once the format is stable?
- Size bucket padding: what granularity is acceptable given storage costs?
