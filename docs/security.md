# Security

This document records every security choice in Combray that exists in code today, why we made it, and what it does not protect against. [privacy-and-encryption.md](privacy-and-encryption.md) describes the wider design, including donation encryption, which is not built yet. Where the two overlap, this document describes what is implemented.

Changing anything in the local store, the store key service, the Content Security Policy or the server's handling of requests means updating this document in the same change. Decisions that are hard to reverse also get an ADR. The store key design is [ADR 0004](decisions/0004-server-held-store-keys.md).

> Nothing here has had an external review yet. The constructions are standard ones from vetted libraries (WebCrypto in the browser; RustCrypto's `argon2`, `hkdf` and `sha2` on the server), and no primitives are home-made.

## Contents

1. [What we protect](#what-we-protect)
2. [Local store](#local-store)
3. [Store keys](#store-keys)
4. [Session hygiene](#session-hygiene)
5. [XSS and code integrity](#xss-and-code-integrity)
6. [Server](#server)
7. [Transport](#transport)
8. [Structure metadata and consent](#structure-metadata-and-consent)
9. [Supply chain](#supply-chain)
10. [Decision log](#decision-log)
11. [Open questions](#open-questions)

## What we protect

The participant's data download package, and everything derived from it, stays on the participant's device. It is encrypted there and leaves only through an explicit, consented flow, such as a donation (later) or structure metadata (see below).

| Who | Example | Defence |
| --- | --- | --- |
| The next user of a shared lab computer | Opens the browser after the participant left | Data is encrypted at rest. The key is only released by the server for the participant's password. The store auto-locks when idle. |
| Someone with a copy of the disk | A stolen laptop or backup image | The disk holds only ciphertext and a wrapped data key. The key that unwraps it is on the server, and the password can only be guessed online, under a lockout. |
| Someone with a copy of the server's database | A leaked backup | The database holds no keys, only per-store salts and password hashes. Keys also need the master key, which is kept apart. Even with the keys, the data itself is on participants' devices. |
| A script injected into the page (XSS) | A crafted title in an imported file | The data is never rendered as HTML. Trusted Types are enforced. CSP blocks other origins. The data key is non-extractable and lives in a worker. |
| A network attacker | Café Wi-Fi | TLS everywhere, with HSTS. |
| A malicious importer script | A shared importer tries to exfiltrate | A QuickJS sandbox with no network or DOM (see [plugins.md](plugins.md)). |

**Out of scope**, stated honestly:

- Malware running as the participant on their device while the store is unlocked.
- **A compromised or malicious server operator who serves altered JavaScript.** Any web app trusts the origin that serves its code, and no shipped browser feature lets us require that only code we signed runs (see [below](#why-not-only-signed-code)). This is also why holding the store key on the server does not weaken anything: a server that wanted the data could already ship code that reads it after unlock.
- Participants who screenshot or copy their own data.

## Local store

`packages/store`. It is used only from the data worker (`apps/web/src/worker/data.worker.ts`).

### We encrypt, because IndexedDB does not

IndexedDB has no encryption or lock mode. Browsers store it as ordinary files in the profile directory, readable by anyone with access to the disk, unless the operating system encrypts the disk. So every record is encrypted with WebCrypto before it is written, and "unlocking" means getting the data key into memory.

### Storage model: blobs, not a database

IndexedDB is used as a key-value store for encrypted blobs. It is never queried by content. Querying IndexedDB record by record is slow, and it would require plaintext indexes. The worker decrypts what it needs into memory and processes it there.

| Kind | What | Stored as |
| --- | --- | --- |
| `bytes` | **Each uploaded file's raw bytes**, as one logical blob per file. This is the source of truth, so a better importer can re-read the original later. | Slices of 4 MiB, each encrypted separately |
| `items` | Derived data: the parsed tree of a source and the tables importers found. This is a cache, for fast reopening. | MessagePack arrays of 5,000 items, each chunk encrypted separately |

A file is one logical blob, but it is encrypted in slices because WebCrypto's AES-GCM has no streaming interface. Encrypting a 2 GB Takeout in one call would need the plaintext and ciphertext in memory at once, and some browsers (Safari in particular) handle very large single IndexedDB values badly. Slices keep peak memory small and let us move them to OPFS later without changing the encryption.

Object stores (database `combray`, format version 2):

- `meta`: the store id (issued by the server), the wrapped data key and the delete token. No content.
- `index`: for each dataset, a random id, its kind, the chunk count, the total size rounded up to a power of two (so exact sizes do not show), and the format version. No names, dates or content.
- `manifests`: for each dataset, the encrypted manifest (name, file path, dates, summary).
- `chunks`: the encrypted chunks and slices.

### Record encryption

- **AES-256-GCM** with the data key (DEK), and a fresh random 96-bit nonce per record. With random nonces, a key is safe for about 2³² records. One store is far below that: even 2 GB is about 500 slices.
- **Additional authenticated data** binds each ciphertext to its place: `combray | format version | store id | dataset id | position`. Here, position is `manifest`, the chunk index, or `bytes` plus the slice index. A chunk moved to another dataset or position, or slices reordered, fails to decrypt instead of silently showing the wrong data. Tests cover both cases.
- The DEK is a random 256-bit key created with `crypto.subtle.generateKey`. It is only ever held as a **non-extractable** `CryptoKey`, and only inside the data worker. Script on the page cannot read its bytes, not even script that compromised the worker; it can only use it.

### Format changes

Format 1 (the passphrase-locked store from before any release) is dropped on upgrade, not migrated. From format 2 onwards, upgrades must migrate data.

## Store keys

The data stays on the device and the key stays on the server. Neither alone can read the data. Implemented in `crates/combray-server/src/keys.rs` (server) and `apps/web/src/worker/keyService.ts` (client).

```
 device (IndexedDB)                               server (combray.sqlite + master key)
 ─────────────────                                ─────────────────────────────────────
 ciphertext  ◄── AES-256-GCM ── DEK               store id, KEK salt, Argon2id(password),
 wrapped DEK = AES-KW(KEK, DEK)                   failure count, delete-token hash
 store id, delete token
                                                  KEK = HKDF-SHA-256(master key, KEK salt,
        ── POST /stores/{id}/unlock {password} ─►        "combray/store-kek/v1/" || store id)
        ◄──────────────── { kek } ──────────────
 import KEK (non-extractable) → unwrap DEK → wipe KEK bytes
```

### Why the key lives on the server

The aim is that a copy of the disk is useless, and that someone else at the same computer cannot open the data.

- **A key on the device**, even a non-extractable one, sits on the same disk as the data, so a copy of the disk would include both.
- **A key derived from a passphrase on the device** (as in format 1) lets anyone with a copy of the disk guess passphrases offline, as fast as their hardware allows. Participants' passphrases are short, so this is weak.
- **An encrypted httpOnly cookie** holding the key, opened by the server when the password is sent, gives the same properties as a server-held key. But cookies are easy to lose (browser cleaning, size limits, expiry), and it adds a second place where key material lives. Since the server needs state for sessions and structure metadata anyway, keeping the key there is simpler.

With the key on the server, guessing the password can only happen online, against the server's lockout. That is why an 8-character password is acceptable for participants. It also gives us **crypto-shredding**: once the server forgets a store's key, every copy of that store's data becomes unreadable.

### Why the key is wrapped

The server holds a key encryption key (KEK). The DEK that encrypts the data is created on the device, stored there wrapped (encrypted) under the KEK with AES-KW, and never leaves the device. This costs one WebCrypto call and buys us the following:

- The data key is never sent over the network or stored on the server.
- The server key can be rotated, or a second way to unlock added (for example, a facilitator recovery), by re-wrapping a 32-byte key instead of re-encrypting gigabytes.
- AES-KW's integrity check detects a wrong KEK. If the server's master key has been replaced, the client says the store can no longer be opened instead of showing garbage.

Against an attacker who has only the device or only the server, this is exactly as strong as a server-held DEK.

### How the server derives and protects keys

- **KEK = HKDF-SHA-256(master key, per-store random 32-byte salt, `combray/store-kek/v1/` + store id).** The database stores only the salt. A copy of the database without the master key gives no keys. Deleting the row is enough to crypto-shred the store, and SQLite runs with `secure_delete` so deleted rows are overwritten.
- **The master key** is 32 random bytes in a file outside the data directory (a Docker secret in the compose setup). Back it up separately from the data, because losing it makes every store unreadable. The server creates the file on first start if it is missing, with mode 0600. If it is configured at a read-only path, the server refuses to start rather than inventing a key.
- **Store ids** are 128 random bits, issued by the server.
- **Responses that carry a KEK** have `Cache-Control: no-store`.
- The client imports the KEK as a **non-extractable AES-KW key** and overwrites the received bytes right away.

### Passwords and guessing

- **Argon2id** with OWASP's recommended minimum: 19 MiB of memory, 2 passes, 1 lane, a 16-byte random salt, and a 32-byte output compared in constant time. The parameters are stored per store, so they can be raised later without breaking existing stores. Hashing runs on blocking threads, with a semaphore that bounds how many hashes run at once (one per CPU), so the memory cost cannot be used to exhaust the server.
- **Length:** at least 8 characters and at most 1,024 bytes. There are no composition rules, which mostly make passwords harder to remember, not harder to guess.
- **Per-store lockout:** each attempt is counted as a failure *before* the hash is checked, in the same transaction as the lockout check, so parallel guesses are counted too. A correct password resets the count. The first 5 failures are free. After that, the store waits 30 seconds, then doubling up to a maximum of 1 hour. The correct password is also refused during the wait. This gives an attacker at most about 24 guesses a day.
- **Per-IP rate limits:** 120 unlock attempts and 60 new stores per 10 minutes, in memory. These are generous because a whole lab can share one IP. They stop one client from spraying many stores or filling the disk. The client IP is read from the peer address, or from the last `X-Forwarded-For` entry when `COMBRAY_CLIENT_IP_HEADER` is set (Caddy overwrites that header). IPs are never stored or logged.
- **Responses** distinguish a wrong password (401, with `Retry-After` once the lockout starts), a lockout (429 with `Retry-After`) and an unknown store (404). Revealing whether a store exists does not matter, because ids are random and unguessable, and the client needs to know when a store has been deleted.

### Deleting a store

"Delete everything from this computer" first asks the server to forget the store's key, then deletes the local database. The request is authorised by a **delete token**: 32 random bytes the server issued when the store was created, kept on the device (the server stores only its SHA-256 hash). Keeping it on the device is harmless, because whoever can use it could just as well delete the local data. It means a participant who forgot their password can still start over cleanly. If the server cannot be reached, the local data is deleted anyway, and the orphaned server record is useless without the device data.

### No passphrase-only mode

Combray always unlocks through a server. There is no offline or browser-only passphrase mode: it would bring back offline guessing, and we have no use for it yet. If a study needs one, it gets its own design (for example, a long generated recovery code instead of a chosen passphrase), not a fallback.

### Dropped: a device key layer

An earlier design also wrapped the DEK with a non-extractable "device key" stored in IndexedDB. It is gone. That key lives on the same disk as the data, so it adds no protection against a copy of the disk. Against XSS, the DEK is already non-extractable.

### Known limits

- **The server sees the password** (over TLS) while it checks it. A password-authenticated key exchange (for example OPAQUE) would avoid that. It is a candidate for later, but it does not help against the out-of-scope case of a malicious server, which could serve altered code anyway.
- **Server and device together** (master key, database and a copy of the disk) can decrypt without the password once the Argon2 hash is cracked. Mixing a password-derived secret into the KEK would only raise the cost to that of cracking the hash, so we do not.
- **A forgotten password means lost data**, unless a recovery path is designed later (see open questions). Participants can always import their export again.
- **The master key cannot be rotated yet.** Rotating it would mean re-wrapping on each device at its next unlock.
- **Orphaned records** (a device whose browser data was cleared) stay on the server until a retention policy removes them. They are useless without the device data.

### Sessions, later

Participant sessions (project, participant code, structure metadata) will use an `httpOnly`, `Secure`, `SameSite=Strict` cookie, so injected script cannot read or move it. A session alone never releases a KEK: the KEK always needs the password. Otherwise, someone could reopen a store on a shared computer while a session is still active.

## Session hygiene

- **Auto-lock** after 15 minutes without input: the worker drops the DEK and every decrypted cache, and the UI returns to the lock screen.
- **Lock** does the same on demand.
- **Delete everything** crypto-shreds on the server and deletes the local database (see above).
- The deployment guide recommends a dedicated browser profile on lab computers, with sync, password saving and extensions turned off.

## XSS and code integrity

Once the store is unlocked, any script running in our origin can read the participant's data through the worker. XSS is therefore the most important threat to get right, and **prevention comes first**, because the other layers only limit damage.

### Imported data is attacker-controlled

A data download package contains text that strangers wrote: video titles, channel names, comments, URLs, and in some exports HTML. Rules:

- **Data is never rendered as HTML.** React escapes all text. `dangerouslySetInnerHTML`, `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval` and `new Function` are banned in client source, enforced by a test (`apps/web/test/security.test.ts`).
- **HTML files are parsed with `htmlparser2` in the worker**, which builds our own tree and never creates DOM nodes or runs anything.
- **Links from data go through `safeHref`**: only `http:` and `https:` URLs become links. `javascript:`, `data:`, `file:` and relative URLs are shown as plain text. React 19 also blocks `javascript:` URLs, but we do not rely on that.
- Importer scripts run in QuickJS with no DOM or network access.

### Content Security Policy

Sent by the server on every response (`CSP` in `crates/combray-server/src/lib.rs`):

| Directive | Why |
| --- | --- |
| `default-src 'self'` | Nothing from other origins unless listed below. |
| `script-src 'self' 'wasm-unsafe-eval'` | Only our own script files: no inline scripts, no `eval`, no CDNs. `wasm-unsafe-eval` allows compiling WebAssembly (the QuickJS sandbox). It does not allow JavaScript `eval`. |
| `style-src 'self'` | No inline styles from injected markup. |
| `img-src 'self' data: blob:` | Our images and locally generated ones. Enrichment thumbnails will come through our server. |
| `connect-src 'self'` | `fetch` and XHR can only reach our own server, which blocks the easy ways to send stolen data elsewhere. |
| `worker-src 'self'` | Workers only from our own files, not from `blob:` URLs. |
| `object-src 'none'`, `base-uri 'none'`, `form-action 'self'` | No plugins, no `<base>` hijacking, and forms cannot post elsewhere. |
| `frame-ancestors 'none'` | No framing (clickjacking). `X-Frame-Options: DENY` is sent as well, for older browsers. |
| `require-trusted-types-for 'script'`, `trusted-types default` | See below. |

### Trusted Types

With Trusted Types enforced, DOM sinks that can run code (`innerHTML`, script URLs, `eval` and so on) throw when given a plain string, unless a policy approves it. The CSP allows exactly one policy, `default`, defined in `apps/web/src/security.ts` and installed before anything else runs (`installPolicy.ts` is the first import of `main.tsx`):

- `createHTML` and `createScript` always throw: we never need raw HTML or script text.
- `createScriptURL` allows same-origin URLs only, which is what Vite needs for the data worker and code chunks.

So even if a bug somewhere passes data into an HTML sink, the browser refuses it. We checked this in Chromium against the real server: the app works with no violations, and `insertAdjacentHTML` from page script is blocked. Browsers without Trusted Types ignore these two directives and fall back on the rules above.

### Limiting damage

- The DEK is non-extractable and lives only in the worker. Injected script can ask the worker for data, but cannot take the key away to use later.
- `connect-src 'self'` stops `fetch` to other origins. It does **not** stop every channel: a script can still navigate the page to another site with data in the URL. CSP has no shipped directive against that, which is why prevention matters most.
- Auto-lock limits the window in which an unlocked store is exposed.

### Other headers

| Header | Value | Why |
| --- | --- | --- |
| `X-Content-Type-Options` | `nosniff` | Files are never interpreted as another type (for example, a data file as script). |
| `Referrer-Policy` | `no-referrer` | Our URLs (project ids, the key fingerprint later) never leak to other sites. |
| `Permissions-Policy` | camera, microphone, geolocation off | Not needed, so not available to injected script either. |
| `Cross-Origin-Opener-Policy` | `same-origin` | Other windows cannot get a handle on ours. |
| `Strict-Transport-Security` | one year (set by Caddy) | Browsers never fall back to plain HTTP. |
| `Cache-Control` | `no-store` on key responses | KEKs are never cached. |

### Why not "only signed code"

We would like the browser to run only code we signed. **No shipped web standard does that for a normal website**:

- **Subresource Integrity (SRI)** checks a script against a hash in the HTML. But the same server serves both the HTML and the scripts, so an attacker who can change one can change the other. SRI protects against a compromised third-party CDN, and we use none. We have not added it for now, because it would add a build plugin for no real protection. If we ever load anything from another origin, it gets SRI.
- **Signed exchanges, Web Bundles and Isolated Web Apps** let browsers verify signed packages, but they are Chromium-only and, for Isolated Web Apps, need installation and enterprise policy. That does not fit participants on arbitrary lab computers.
- **A verifying browser extension** (as Meta does for WhatsApp Web) is possible, but too much to ask of participants.

What we do instead:

- **Reproducible builds with published hashes** of the web client per release, so anyone can check what a server serves.
- **The server binary embeds the web client** (planned), so a deployment runs exactly a released version.
- **Installable PWA** (planned), so lab computers keep a known version.
- **No third-party code at runtime:** no analytics, fonts or CDNs. Everything is self-hosted.

### Visualisations

Vega compiles expressions with `new Function`, which our CSP forbids. If we adopt Vega or Vega-Lite, it must run with `vega-interpreter`, never by adding `'unsafe-eval'`.

## Server

- **Logs** contain the method, the route *template* (for example `/api/v1/stores/{id}/unlock`, without the id), the status and the duration. Never URLs, bodies, headers, passwords, store ids or IPs. Errors are logged by class only.
- **Input:** store ids are validated before any lookup, and project ids are restricted to `[a-z0-9-]`, which rules out path traversal. Request bodies to the key service are capped at 8 KiB. Passwords are capped at 1,024 bytes.
- **Container:** distroless base image, non-root user, read-only root filesystem, all capabilities dropped, `no-new-privileges`. The data directory is the only writable volume, and the master key comes in as a read-only Docker secret.
- **Storage:** SQLite in the data directory, with WAL and `secure_delete`. It holds no participant data and no keys.

## Transport

Caddy terminates TLS with automatic certificates and sends HSTS. The Combray server itself listens only on the internal compose network. In development, the Vite dev server proxies `/api` to the local server. The dev server does not send the CSP, so check security-relevant changes against `just serve`.

## Structure metadata and consent

The researcher decides, for every path in a platform's tree, what happens to it. For that, they need the structure of real data, including structure their own test export did not have. This is the one place where something derived from participant data is sent to the server outside a donation, so it gets its own consent step. It is designed but not built yet.

- **Researcher decisions.** In a low-tech researcher UI, each node of the tree gets a status: `ignore`, `show`, `donate` (which implies `show`), or `undecided` until the researcher chooses. The client treats `undecided` as `show`.
- **Only new paths are asked for.** The server sends the client the project's current structure metadata. After an import, the client compares the participant's shape with it locally. Only paths the server has never seen (not merely undecided ones) are candidates to send.
- **A specific request.** The participant sees a short, friendly explanation: their data is structured a little differently from what the researchers have seen, and knowing that helps them keep the study working. The client shows exactly the new paths it would send, and says plainly that only these paths are sent, not any content. The answers are:
  - *Yes, send these paths.*
  - *No, these paths contain private information.* (The refusal and its reason are recorded, without the paths, so researchers learn that the extractor missed something.)
  - *No, for another reason.*
- **Structure only.** Paths come from the shape extractor, which drops values, collapses dictionary-like keys (usernames, dates used as keys) and screens names that look like emails, numbers or tokens (see [universal-importer.md](universal-importer.md#structure-metadata)). Showing the paths before sending is the last check, for the rare key that is private anyway.

## Supply chain

- Lockfiles (`pnpm-lock.yaml`, `Cargo.lock`) are committed, and CI installs with `--frozen-lockfile` and `--locked`.
- pnpm only resolves package versions that have been published for at least a week (`minimumReleaseAge` in `pnpm-workspace.yaml`), so a hijacked release is likely to be caught before we pick it up.
- The client's crypto uses only WebCrypto. The server uses RustCrypto (`argon2`, `hkdf`, `sha2`, `subtle`), `getrandom` for randomness and `rusqlite` with bundled SQLite. New dependencies that touch data or keys need a reason in the PR.
- Rust code forbids `unsafe` (`unsafe_code = "forbid"` in the workspace).

## Decision log

| Choice | Alternatives considered | Why |
| --- | --- | --- |
| Encrypt every record ourselves with WebCrypto | Rely on IndexedDB or the OS | IndexedDB has no encryption, and we cannot rely on disk encryption being on |
| One logical blob per raw file, sliced into 4 MiB, plus chunked parsed caches | One IndexedDB record per item; one unsliced blob | Per-item records are slow and need plaintext indexes. Unsliced blobs blow up memory. |
| AES-256-GCM with random nonces and context-binding AAD | AES-CBC + HMAC; ChaCha20-Poly1305 | Native in WebCrypto, authenticated, hardware-accelerated |
| KEK on the server, wrapped DEK on the device | Key on the device; passphrase KDF on the device; encrypted cookie | Only option where neither the disk nor the server alone suffices, guessing is online-only, and crypto-shredding works |
| Wrap the DEK instead of keeping it on the server | Server stores the DEK | The data key never leaves the device; rotation and extra unlock paths without re-encryption |
| KEK derived with HKDF from a master key and a per-store salt | Random KEK stored encrypted in the database | Same protection, no key material in the database, deletion is crypto-shredding |
| Argon2id (19 MiB, t=2) with a per-store lockout | PBKDF2, bcrypt, rate limiting only | Memory-hard, OWASP-recommended; the lockout makes short passwords workable |
| No passphrase or no-server mode | Offline fallback | It brings back offline guessing, and no study needs it yet |
| No device-key layer | Device key + server secret | It sits on the same disk as the data, so it adds nothing |
| Delete token for crypto-shredding | Require the password to delete | Participants who forgot their password can still delete cleanly, and the token gives no read access |
| Strict CSP + Trusted Types with one restrictive default policy | CSP only; named policies everywhere | It blocks every DOM XSS sink, and Vite and React work with it |
| No SRI for now | SRI on all scripts | Same-origin scripts gain nothing; revisit if anything is ever loaded cross-origin |
| Reproducible builds and published hashes | "Signed code only" | No browser standard enforces signed code for a normal website |

## Open questions

- **Password recovery.** Should a facilitator be able to reset a participant's password in the lab, for example by wrapping the DEK a second time under a facilitator-released key? It is useful for multi-session studies, but it adds a second way in.
- **OPAQUE** (or another password-authenticated key exchange), so the server never sees passwords. It is worth it if it can be done with audited libraries on both sides.
- **Retention** of orphaned store records: expire them after a project's end date, or after N months unused?
- **Master key rotation** procedure.
- **Who reviews this?** An internal review before Phase 2 and an external audit before a large study (open question 16).
