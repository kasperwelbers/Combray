# Security

This document records every security choice in Combray that exists in code today, why we made it, and what it does not protect against. [privacy-and-encryption.md](privacy-and-encryption.md) describes the wider design. Donation sealing, storage and withdrawal, the participant donate screen, and researcher sign-in and keys are built for the pilot. Where the two overlap, this document describes what is implemented. [key-design.md](key-design.md) walks through every key, built and planned, in one place.

Changing anything in the local store, the store key service, `packages/seal`, researcher sign-in, the key page, the Content Security Policy or the server's handling of requests means updating this document in the same change. Decisions that are hard to reverse also get an ADR. The store key design is [ADR 0004](decisions/0004-server-held-store-keys.md); researcher keys are [ADR 0007](decisions/0007-browser-key-page.md).

> Nothing here has had an external review yet. The constructions are standard ones from vetted libraries (WebCrypto and `@hpke/core` with `@hpke/hybridkem-x-wing` in the browser; `node:crypto`, `@node-rs/argon2` and `@simplewebauthn/server` on the server), and no primitives are home-made.

## Contents

1. [What we protect](#what-we-protect)
2. [Local store](#local-store)
3. [Store keys](#store-keys)
   - [Projects and participants](#projects-and-participants)
   - [Password reset](#password-reset)
4. [Session hygiene](#session-hygiene)
5. [XSS and code integrity](#xss-and-code-integrity)
6. [Researcher sign-in and keys](#researcher-sign-in-and-keys)
   - [Donation envelope](#donation-envelope)
7. [Server](#server)
8. [Transport](#transport)
9. [Structure metadata and consent](#structure-metadata-and-consent)
10. [Supply chain](#supply-chain)
11. [Decision log](#decision-log)
12. [Open questions](#open-questions)

## What we protect

The participant's data download package, and everything derived from it, stays on the participant's device. It is encrypted there and leaves only through an explicit, consented flow, such as a donation (later) or structure metadata (see below).

| Who | Example | Defence |
| --- | --- | --- |
| The next user of a shared lab computer | Opens the browser after the participant left | Data is encrypted at rest. The key is only released by the server for the participant's password. The store auto-locks when idle. |
| Someone with a copy of the disk | A stolen laptop or backup image | The disk holds only ciphertext and a wrapped data key. The key that unwraps it is on the server, and the password can only be guessed online, under a lockout. |
| Someone with a copy of the server's database | A leaked backup | The database holds no keys, only per-store salts and password hashes. Keys also need the store master key, which is kept apart. Even with the keys, the data itself is on participants' devices. |
| A script injected into the page (XSS) | A crafted title in an imported file | The data is never rendered as HTML. Trusted Types are enforced. CSP blocks other origins. The data key is non-extractable and lives in a worker. |
| A network attacker | Café Wi-Fi | TLS everywhere, with HSTS. |
| A researcher of the project | Wants to read a participant's local data | A password reset needs the participant's device too, and only works for participants with an id in that project. The server never has the data. |
| A malicious importer script | A shared importer tries to exfiltrate | A QuickJS sandbox with no network or DOM (see [plugins.md](plugins.md)). |
| Someone with the server's databases | Reads donations and keys | Envelopes and donation keys are sealed to the project key, which the server holds only sealed to researchers' personal keys, which it holds only locked under their passkeys. |
| Someone with a researcher's email | Requests a sign-in code | The code only works in the browser that asked for it, and only allows using a passkey or the recovery code. It cannot open keys or reach donations. |
| Someone with a researcher's email | Starts over on their account (new key) | Locks the researcher out until they start over themselves, and the researcher is mailed. Gets no access: colleagues give access only after comparing key codes with the real person, and starting over is refused while the researcher alone has access to a project. |
| A bug or XSS in the participant app or studio | Tries to reach researcher keys | Keys exist only on the key page, on another origin. The studio session gets no key material, and the main site has no key routes. The studio shares the main site's origin with the participant app, so such a bug could use a signed-in researcher's studio session: list their projects and donation counts. |

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
| `bytes` | **The raw bytes of each file read from the upload's root**, as one logical blob per file. This is the source of truth, so a better importer can re-read the original later. Files outside the root (the rest of a picked Downloads folder) and files the project tree skips are never read, so never kept ([tree-decisions.md](tree-decisions.md#names-first-and-fixed-limits)). | Slices of 4 MiB, each encrypted separately |
| `items` | Derived data: the parsed tree of a source and the tables importers found. This is a cache, for fast reopening. | MessagePack arrays of 5,000 items, each chunk encrypted separately |

A file is one logical blob, but it is encrypted in slices because WebCrypto's AES-GCM has no streaming interface. Encrypting a 2 GB Takeout in one call would need the plaintext and ciphertext in memory at once, and some browsers (Safari in particular) handle very large single IndexedDB values badly. Slices keep peak memory small and let us move them to OPFS later without changing the encryption.

There is one store per project on each device, in its own IndexedDB database named `combray-{project id}`. A password, and the key it releases, only ever covers one project. The overview page at `/p/` lists the projects that have a store on this device by reading these databases locally, without asking the server.

Object stores (format version 2):

- `meta`: the project (its id and public name), the participant id if any, the store id (issued by the server), the wrapped data key and the delete token. No content.
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

The data stays on the device and the key stays on the server. Neither alone can read the data. Implemented in `apps/server/src/keys.ts` (server) and `apps/web/src/worker/keyService.ts` (client).

```
 device (IndexedDB)                               server (combray.sqlite + store master key)
 ─────────────────                                ─────────────────────────────────────
 ciphertext  ◄── AES-256-GCM ── DEK               store id, KEK salt, Argon2id(password),
 wrapped DEK = AES-KW(KEK, DEK)                   failure count, delete-token hash
 store id, delete token
                                                  KEK = HKDF-SHA-256(store master key, KEK salt,
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
- AES-KW's integrity check detects a wrong KEK. If the server's store master key has been replaced, the client says the store can no longer be opened instead of showing garbage.

Against an attacker who has only the device or only the server, this is exactly as strong as a server-held DEK.

### How the server derives and protects keys

- **KEK = HKDF-SHA-256(store master key, per-store random 32-byte salt, `combray/store-kek/v1/` + store id).** The database stores only the salt. A copy of the database without the store master key gives no keys. Deleting the row is enough to crypto-shred the store, and SQLite runs with `secure_delete` so deleted rows are overwritten.
- **The store master key** (not to be confused with a researcher's private key, which decrypts donations and never touches the server) is 32 random bytes in a file outside the data directory (a Docker secret in the compose setup). Back it up separately from the data, because losing it makes every store unreadable. The server creates the file on first start if it is missing, with mode 0600. If it is configured at a read-only path, the server refuses to start rather than inventing a key.
- **Store ids** are 128 random bits, issued by the server.
- **Responses that carry a KEK** have `Cache-Control: no-store`.
- The client imports the KEK as a **non-extractable AES-KW key** and overwrites the received bytes right away.

### Passwords and guessing

- **Argon2id** with OWASP's recommended minimum: 19 MiB of memory, 2 passes, 1 lane, a 16-byte random salt, and a 32-byte output compared in constant time. The parameters are stored per store, so they can be raised later without breaking existing stores. Hashing runs on blocking threads, with a semaphore that bounds how many hashes run at once (one per CPU), so the memory cost cannot be used to exhaust the server.
- **What the server sees:** not the password. The browser derives `PBKDF2-SHA-256(password (NFC), salt, 100,000 iterations)` as 32 bytes, base64url, and sends that. The salt is 32 random bytes made when the store is created, kept in the store's metadata on the device and in backup files, and never sent to the server. So the server (or anyone reading its traffic or logs) cannot learn the password, nor test guesses for it, and a password used elsewhere stays private. The server treats the derived value exactly as it treated a password: Argon2id, the lockout and the limits below. Stores created before the salt existed send the password as typed (`passwordForServer` in `packages/store/src/crypto.ts`, `forServer` in the data worker).
- **Length:** the participant app asks for at least 6 characters; the server accepts 6 characters to 1,024 bytes. There are no composition rules and no list of refused passwords, which mostly make passwords harder to remember, not harder to guess. The app warns, without refusing, when a password looks easy to guess: length times log2 of the character classes used, with runs and simple sequences counted once, under 25 bits (`apps/web/src/passwordStrength.ts`). With guessing online only and the hard lock below, an attacker gets at most 50 guesses, so the choice is the participant's.
- **Per-store lockout:** each attempt is counted as a failure *before* the hash is checked, in the same transaction as the lockout check, so parallel guesses are counted too. A correct password resets the count. The first 5 failures are free. After that, the store waits 30 seconds, then doubling up to a maximum of 1 hour. The correct password is also refused during the wait. This gives an attacker at most about 24 guesses a day.
- **Hard lock:** after 50 failures since the last correct password, the store refuses every password, also the right one, with 423 `store_locked` and no `Retry-After`. Only a [reset link](#password-reset) (which clears the count) or deleting the store helps. An attacker with the device or a backup file therefore gets 50 guesses in total, not 24 a day forever. Someone without the device cannot reach this, because store ids are random. An honest participant will not type 50 wrong passwords in a row.
- **Per-IP rate limits:** 120 unlock attempts and 60 new stores per 10 minutes, in memory. These are generous because a whole lab can share one IP. They stop one client from spraying many stores or filling the disk. The client IP is read from the peer address, or from the last `X-Forwarded-For` entry when `COMBRAY_CLIENT_IP_HEADER` is set (Caddy overwrites that header). IPs are never stored or logged.
- **Responses** distinguish a wrong password (401, with `Retry-After` once the lockout starts), a lockout (429 with `Retry-After`), a hard lock (423) and an unknown store (404). Revealing whether a store exists does not matter, because ids are random and unguessable, and the client needs to know when a store has been deleted.

### Deleting a store

"Delete everything from this computer" first asks the server to forget the store's key, then deletes the local database. The request is authorised by a **delete token**: 32 random bytes the server issued when the store was created, kept on the device (the server stores only its SHA-256 hash). Keeping it on the device is harmless, because whoever can use it could just as well delete the local data. It means a participant who forgot their password can still start over cleanly. If the server cannot be reached, the local data is deleted anyway, and the orphaned server record is useless without the device data.

### Backup files

`exportBackup` and `restoreBackup` in `packages/store` (format in `packages/store/src/backup.ts`, flow in [key-design.md](key-design.md#8-the-backup-file)). A backup file is the store's IndexedDB records, byte for byte, plus its metadata: store id, project, participant id, the wrapped DEK, the delete token and the password salt. Nothing is decrypted to make it.

- **Alone, the file is as safe as a copy of the disk:** reading it needs the KEK, which the server releases only for the password, with the lockout and hard lock above. The password salt in it is not a key.
- **The delete token is in the file.** Whoever has the file can make the server forget the KEK, which only destroys data, and is what lets a participant delete everything from another computer.
- **Restoring checks** that the file starts with the magic bytes, belongs to this server (origin) and project, has a supported version, valid ids and lengths, and an end marker whose counts match. On any problem the database is emptied again; the store's metadata is written last, so a half-restored store never exists. A changed byte inside a record is caught by AES-GCM and the record's additional data when it is read. Restoring is refused when this device already has a store for the project.
- **Memory:** the file is written as a Blob of Blobs, flushed every 32 MiB, and read frame by frame with `Blob.slice`, so neither direction holds the whole store in memory.
- **The server is not involved** in making or restoring a backup, and never stores one.

### No passphrase-only mode

Combray always unlocks through a server. There is no offline or browser-only passphrase mode: it would bring back offline guessing, and we have no use for it yet. If a study needs one, it gets its own design (for example, a long generated recovery code instead of a chosen passphrase), not a fallback.

### Dropped: a device key layer

An earlier design also wrapped the DEK with a non-extractable "device key" stored in IndexedDB. It is gone. That key lives on the same disk as the data, so it adds no protection against a copy of the disk. Against XSS, the DEK is already non-extractable.

### Known limits

- **The server sees a value derived from the password**, not the password. It cannot test guesses for the password without the device's salt. Together with the device (or a backup file), the server operator could guess the password offline; but they could already open the data with the KEK they hold. A malicious server could serve altered code that sends the password itself, which is out of scope as before.
- **Server and device together** (store master key, database and a copy of the disk) can decrypt without the password once the Argon2 hash is cracked. Mixing a password-derived secret into the KEK would only raise the cost to that of cracking the hash, so we do not.
- **A forgotten password means lost data for anonymous participants.** Participants with an id can get a [reset link](#password-reset). Anyone can import their export again. A [backup file](#backup-files) does not help here: it opens with the same password.
- **The store master key cannot be rotated yet.** Rotating it would mean re-wrapping on each device at its next unlock.
- **Orphaned records** (a device whose browser data was cleared) stay on the server until a retention policy removes them. They are useless without the device data.

### Projects and participants

A server hosts many projects. A participant opens `https://combray.example.edu/p/{project}/`, and every store belongs to exactly one project. Project ids are lowercase letters, digits and dashes. Because projects live under `/p/`, no id can collide with the web client's own paths, so none are reserved ([ADR 0008](decisions/0008-project-paths.md)).

Each project config says how participants are identified (`participants.mode`):

| Mode | Who can take part | Password reset |
| --- | --- | --- |
| `anonymous` | Anyone with the project link. Ids in links are ignored. | No: a forgotten password means starting over |
| `optional` (default) | Anyone; a participant id from the link is kept when there is one | Only for participants with an id |
| `required` | Only participants with an id that matches the project's pattern | Yes |

- **Participant ids come in the link's fragment**: `/p/{project}/#id=P1234`. Browsers never send the fragment to the server, so the id does not end up in any proxy or access log. The client removes it from the address bar straight away, so it is not on screen for the next person. It is kept in the tab's `sessionStorage` until the store exists, so a reload does not lose it.
- **The server enforces the policy** when a store is created. Ids are 1 to 64 characters from `A-Z a-z 0-9 . _ -`, and the whole id must match the project's `participants.pattern` (a regular expression from a safe subset: at most 100 characters, no quantified groups and at most two unbounded repetitions, because JavaScript regular expressions backtrack; a config with another pattern is refused as invalid). The pattern is never sent to clients. That gives the "allowed part of the id" check.
- **Participant ids are pseudonyms.** Only the researchers know who is behind them, and the server stores them with the store record because a reset needs them. Ids must never be names, emails or student numbers.
- **Email or phone instead of ids** would let participants identify themselves without a researcher, at the cost of the server holding contact details. We do not do this for now (see open questions).

### Password reset

Only for stores with a participant id. The researcher is in charge of the people in their project:

1. The participant tells the researcher they forgot their password. The researcher checks who they are, in whatever way the study uses (in the lab, by their usual contact details).
2. The researcher creates a reset link for that project and participant id. Until the researcher UI exists, this is a server command: `combray-server reset-link <project> <participant-id>`, which prints `https://…/p/{project}/#reset=<token>`.
3. The participant opens the link **on the device that holds their data**, and chooses a new password. The server replaces the password hash, lifts any lockout, and returns the same KEK, so the existing data opens again. On a device without a store for that project, the client explains that the link has to be opened where the data is.

The token is 32 random bytes in the link's fragment. The server stores only its SHA-256, together with the project, the participant id and an expiry of 72 hours. It works once, only for that participant's stores in that project, and is used up in the same transaction that checks it. Reset requests share the per-IP rate limit with unlock attempts.

**What this means:** whoever can create reset links for a project (its researchers, and for now the server operator) can choose a new password for a participant's store. With access to the participant's device too, for example a shared lab computer, they could then open that participant's local data. We accept this because researchers are responsible for their participants, and on a lab computer they already have physical access. A study that should not allow it uses `anonymous` mode. Every reset is visible to the participant, because their old password stops working.

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
- **Uploads are read names first.** A picked folder can be much more than an export (a Downloads folder, a whole drive). The worker lists names, opens only files whose names a project's patterns match, and reads only the root it finds, within fixed limits on files, candidates and bytes that projects cannot raise (`UPLOAD_LIMITS`, see [tree-decisions.md](tree-decisions.md#names-first-and-fixed-limits)). Zip entries are listed from the archive's directory and inflated only when read; the declared sizes count against the byte limit.

### Content Security Policy

Sent by the server on every response (`CSP` in `apps/server/src/app.ts`):

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
| `Permissions-Policy` | camera, microphone, geolocation off; on the main site also `publickey-credentials-get` and `-create` | Not needed, so not available to injected script either. Passkeys can only be used on the key page. |
| `Cross-Origin-Opener-Policy` | `same-origin` | Other windows cannot get a handle on ours. |
| `Strict-Transport-Security` | one year (set by Caddy) | Browsers never fall back to plain HTTP. |
| `Cache-Control` | `no-store` on key responses | KEKs, sealed keys and envelopes are never cached. |

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

The story's views (an amount, top values, counts over time, by hour or weekday) are computed in the data worker from the participant's own tables (`apps/web/src/worker/story.ts`); only counts reach the page, and nothing is sent. They are drawn with HTML and CSS by React, so labels are text. A story comes from the project config: the server stores it as researchers wrote it (an object with slides, at most 256 KB), and every device checks it block by block (`parseStory` in `packages/core`) before using it. Text in slides is plain text, split into paragraphs, never HTML; values in sentences (`{count}`) are filled in as text.

A project's texts ([ADR 0013](decisions/0013-names-labels-versions.md): labels, descriptions and the app texts a study words its own way) are researcher-written strings too, at most 256 KB, checked by `checkProjectTexts` on the server and again on every device. Labels are rendered as text. App texts replace i18n strings only for keys the app already has (`applyAppTexts`), so a study cannot add strings; where a string has tags (`<b>`), `<Trans>` turns only the tags the code names into React elements, never HTML. A study can reword the texts that explain privacy and keys; the studio warns that they must stay true, and the participant's protection never depends on them.

Vega compiles expressions with `new Function`, which our CSP forbids. If we adopt Vega or Vega-Lite, it must run with `vega-interpreter`, never by adding `'unsafe-eval'`.

## Researcher sign-in and keys

Built for the pilot. The design, with the reasons and the user flows, is in [researcher-keys.md](researcher-keys.md) ([ADR 0007](decisions/0007-browser-key-page.md)). This section records the constructions and the checks.

### Two origins

The server answers on two hosts: the main site (`COMBRAY_PUBLIC_URL`: participant app, studio) and the key site (`keys.` in front of the main host, or `COMBRAY_KEYS_URL`: the key page and the key API). The key site must have a host name of its own; another port is refused, because passkeys and cookies ignore ports. A request is routed by its `Host` header; any other host gets `421`, except the health check, so a forgotten DNS record or a wildcard never serves the app under a name of its own. Why the key page cannot share the main site's origin is in [researcher-keys.md](researcher-keys.md#why-not-one-address); DNS is the remaining trust, see [deployment.md](deployment.md#protecting-the-host-names). Routes that return key material (sealed project keys, sealed donation keys, envelopes, wrapped personal keys) and every passkey ceremony exist only on the key site. The passkey RP ID is the key host, and the main site's `Permissions-Policy` turns WebAuthn off.

### Sessions

| | Email level | Full |
| --- | --- | --- |
| How | Emailed 8-digit code, on the key site only, typed in the browser that asked for it (10 minutes, single use, 5 tries) | Key site: a passkey alone, or the passkey or recovery code after the email level. Studio: only a handoff from a full key site session |
| Lasts | 15 minutes | 2 hours on the key site. Studio: 1 hour without activity (each request pushes it forward), at most 12 hours (`COMBRAY_STUDIO_IDLE_SECS`, `COMBRAY_STUDIO_MAX_SECS`) |
| Can | Register or use a passkey, use the recovery code | Everything the researcher may do on that site |

- Cookies: `__Host-combray` on https (plain `combray` on http for development), `HttpOnly`, `Secure` on https, `SameSite=Strict`, `Path=/`, no `Domain`. Sessions are bound to their site: a key-site session does not work on the main site or the other way round.
- The server stores SHA-256 hashes of session ids, pending email sign-ins and handoff codes, never the values. Session ids are 256-bit random and rotated when a session is upgraded.
- **CSRF**: every request that is not `GET` or `HEAD` must carry an `Origin` equal to its site's origin, and `Sec-Fetch-Site`, when present, must be `same-origin` or `none`. Bodies are JSON or bytes, never forms.
- **Studio sessions** come only from the key page, after the passkey (or recovery code): the studio has no sign-in of its own, and sends researchers to the key page and back. So someone with a researcher's email alone cannot reach their projects. A studio session still never receives key material, cannot publish, and cannot make handoffs; it lists projects and donation counts and edits drafts. It ends after an hour without activity and at most twelve hours after the passkey; "Sign out" ends it on the server. With only the email code, a researcher can set up or use a passkey or recovery code, and see who is on their projects (whom to ask for access again).
- **Publishing** needs access to the project's encryption key (a sealed copy), not just membership, and happens on the key site only.
- **Email codes are tied to one browser and one site.** Asking for a code sets an `HttpOnly`, `SameSite=Strict` cookie on that site with a random 256-bit secret; the server keeps its SHA-256, and the code only as SHA-256 over the site, the secret and the code, so the database alone does not reveal a code, and a code asked for in the studio cannot be used on the key site or the other way round. Checking a code needs the cookie, so a code read from the mail on another device is useless. Each code allows 5 wrong tries, then the pending sign-in is deleted. With the rate limit of 3 codes per address per 15 minutes, someone guessing around the clock gets 1,440 tries a day at 100 million codes: about 1 in 70,000 per address per day. On the key site, success only reaches the email level, which still needs the passkey or recovery code, except on an account that has no passkey yet (where it allows registering the first one). In the studio it signs in, with the limits above. For an unknown address the server stores a pending sign-in all the same, with a code it never sends, so both cases behave alike.
- **Rate limits**: email codes 20 per IP per 10 minutes and 3 per address per 15 minutes; recovery codes 5 per researcher per hour; donations 60 per IP per 10 minutes. The email answer is the same for known and unknown addresses.
- **Studio handoff**: a one-time code (two minutes) created by a full key-site session, sent in the fragment to `/studio/`, and traded for a main-site session. Studio sessions cannot create handoffs.
- **Email** goes through SMTP with TLS (`nodemailer`: `smtps://`, or `smtp://…?tls=required` for STARTTLS that must succeed). The SMTP URL never appears in logs.

### Passkeys

`@simplewebauthn/server` checks registrations and assertions (user verification required, at most ten per researcher). Passkeys are stored as their COSE public key and counter; records written by the earlier server (in webauthn-rs's format) are converted when read. The page asks for discoverable credentials (`residentKey: "preferred"`), so a passkey alone can sign in: that flow has no session before it: the server reads the researcher id from the credential's user handle, looks up that researcher's passkey by credential id, and has `@simplewebauthn/server` verify the assertion against it; an unknown user or credential is rejected like a bad signature. Starting such a sign-in is unauthenticated, so it is rate limited (60 per IP per 10 minutes) and the server holds at most 10,000 ceremonies at once. Ceremony state is kept in server memory for five minutes and used once; a passkey-only sign-in has its own random ceremony id instead of a session. The page asks for the PRF extension on every ceremony with the salt `SHA-256("combray/prf-salt/v1")`. The JSON sent to the server is built by hand, with `extensions: {}`: the PRF output is never serialised. (`PublicKeyCredential.toJSON()` would include client extension results, so the page does not use it.)

### Constructions

All with `@hpke/core` 1.9 and `@hpke/hybridkem-x-wing` 0.7 (HPKE base mode, X-Wing, HKDF-SHA-256, AES-256-GCM) and WebCrypto, in `packages/seal`. HKDF calls use an empty salt and the label as `info`.

| What | Construction |
| --- | --- |
| Master secret | 32 random bytes (`crypto.getRandomValues`) |
| Personal key | X-Wing key pair from the seed `HKDF(master, "combray/personal-key/v1", 32)` |
| Recovery sign-in | The server keeps `SHA-256(HKDF(master, "combray/recovery-sign-in/v1", 32))` and compares in constant time |
| Recovery code | The master secret in Crockford base32, plus two check characters from `SHA-256("combray/recovery-check/v1" ‖ secret)`, in groups of six. Case and `I/L/O` are forgiven |
| Passkey lock | `key = HKDF(PRF output, "combray/personal-key-wrap/v1", 32)`; `nonce (12) ‖ AES-256-GCM(key, master, aad = "combray/personal-key-wrap/v1" \0 researcher \0 credential)`, 60 bytes |
| Project key | X-Wing key pair from a random 32-byte seed |
| Sealed project key | HPKE seal of the seed to a personal key, `info = "combray/project-key/v1" \0 project \0 researcher` |
| Fingerprint | base64url of `SHA-256("combray/key-fingerprint/v1\0" ‖ public key)[0..16]` |
| Key code | Crockford base32 of `SHA-256("combray/key-code/v1\0" ‖ public key)[0..10]`, four groups of four (80 bits) |

The page checks every personal key it opens against the public key the server has on record, and every project key against the project's public key, and refuses to go on when they differ. A server that substitutes a key is caught at the next use, except at a grant, which is what the key code comparison is for.

### Donation envelope

```
"CMBRDON1" | u32 header length | header (JSON) | chunk* (u32 length | AES-256-GCM ciphertext)
header = { v: 1, project, donation, key, chunkBytes, chunks, created }
```

- A fresh 256-bit **donation key** per donation. `donation` is a random 128-bit id; `key` is the project key fingerprint; `created` is the day only.
- Chunk `i` (1 MiB of plaintext) uses the nonce `i` as 11 bytes big-endian followed by 1 on the last chunk and 0 otherwise, and the additional data `SHA-256(magic ‖ header)`. The header fixes the chunk count, so reordered, dropped, added or truncated chunks fail.
- The donation key is HPKE-sealed to the project key with `info = "combray/donation-key/v1" \0 project \0 donation` and the header hash as additional data, so it opens only for this envelope.
- The client sends `u32 length ‖ sealed key (JSON) ‖ envelope` in one request. The server checks the header's project, a valid fresh id and the current fingerprint, then writes the envelope to `donations/{project}/{id}` and the sealed key to the separate key database (`secure_delete`), and returns a withdrawal token (the server keeps its SHA-256).
- Withdrawal deletes the sealed key and the envelope and keeps a tombstone in the donation index. On start, the server deletes any sealed key that has a tombstone, so a restored key backup cannot bring a withdrawal back.
- Sealed donation keys are served only to a member with access, on the key site, in batches of at most 500, with `no-store`. The server logs the count of keys served, never ids.
- **What is inside** (`combray-donation/2`, `packages/seal/src/payload.ts`, [ADR 0015](decisions/0015-raw-paths-and-relational-export.md)): a dictionary of paths (`entries`: each general path with its platform, the table and field it was donated as, how its rows are grouped and how it was read), then every donated value as a reference into it with its positions, its value as read, and the value as it was in the file where the researcher asked for it (`raw`). Paths use keys as shapes screen them (a key that looks like data becomes a marker, never the data itself; HTML elements by their shape name), `[i]` for list items and `{i}` for keys that are data, so a key that is data is never in a path: it is donated only as a key column the researcher asks for. Each says which published version of the project it was made with (`version`, a positive whole number; [ADR 0013](decisions/0013-names-labels-versions.md#versions)): the version is inside the sealed payload, so the server stores no more about a donation than before.
- **Positions are numbered again before sealing.** Left-out rows are dropped and the remaining positions of every list renumbered without gaps, keeping their order (`donationPayload` in `packages/core/src/donate.ts`): a gap would show how many rows a participant left out, and where. Order is never shuffled, as it is often the data.
- **Compressed, then sealed.** The JSON payload is gzipped (the browser's `CompressionStream`, no dependency) before it is encrypted; nothing is compressed after encryption, and nothing outside the sealed envelope. Compressing before encrypting can leak through the size (CRIME-style) when an attacker can put text of their own next to a secret and watch the ciphertext length over many tries. The server sees each envelope's size, and someone could put text in a participant's data (a message they send them), but a participant donates once or a few times, not in an adaptive loop, so this gives no practical attack; the size of an uncompressed donation says as much about how much was shared. The key page unpacks with `DecompressionStream` and stops at 512 MB (`MAX_PAYLOAD_BYTES`), so a crafted gzip cannot exhaust memory. It then checks every entry's and value's types (`decodePayload`) before using them; anything unexpected is refused, and `combray-donation/1` payloads are no longer read.

### The donate screen

- **What is sent is what was reviewed.** The data worker matches the stored uploads afresh with the study's current settings (fetched with `no-store`) and shows every value that would be sent, per table. Participants leave rows out one by one or by text ("everything with 'doctor'"); a row nested in a left-out row goes with it. A row left out is kept as a hash of its raw values with the general path of its table (never a position), and a search as a rule (table and text, matched on raw and read values alike, ignoring case), both in the encrypted local store, so they stay out after a new upload or a new version and can be put back on the review screen. The hash (cyrb53) only recognises rows on the participant's own device; it is never sent and is not a security measure. One upload per platform: a new upload replaces the old one. Before sealing, the worker fetches the settings again and refuses with "changed" if they differ from the reviewed ones, so a server cannot slip in a field after the review.
- **The key is checked before sealing.** The public key must match the fingerprint the server gives and, when the participant came in through a study link with `#k=`, that fingerprint. The fingerprint from the link is kept in `localStorage` per project, so a later visit without the link is still checked; a participant who never had the link trusts the server's config (see [researcher-keys.md](researcher-keys.md#limits)).
- Sealing happens in the data worker (`apps/web/src/worker/donate.ts`), with the same `packages/seal` code the key page uses to open. Only the sealed envelope and sealed key are sent.
- **Consent goes with the data.** The study's information and statements come from the same fresh config, are part of the settings that must not change before sending, and the donation records them as the participant read them, with the statement that they reviewed what is shared. They are plain text, shown as paragraphs, never HTML.
- **Answers go with the data, after the same review.** Answers to the story's questions are kept in the encrypted local store (an `answers` dataset), listed in the review with a way to remove each, and sent with the questions as the participant read them. The story is part of the settings that must not change between review and sending.
- **The receipt** (donation id and withdrawal token) is kept in the encrypted local store, so the participant can withdraw from the same page, and shown as a code to keep: with the id, researchers can withdraw a donation on a participant's request even when the local store is gone.

### The key page

- One HTML file, built deterministically (`apps/keys/build.mjs`). The script and style are inline and unminified; the CSP in a `<meta>` tag and the identical header pin them by SHA-256. Nothing else can run or load: `default-src 'none'`, `connect-src 'self'`, `form-action 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`, Trusted Types with no policies.
- Elements are built with `textContent` and attributes; the repo's test bans `innerHTML`, `eval` and `new Function` in `apps/keys` and `packages/seal`.
- Keys are held in module memory only, never in storage. Lock, `pagehide` and 15 minutes idle overwrite and drop them.
- Exports are CSV and JSON made in memory and saved with a `blob:` link, as one zip (stored, not compressed: `apps/keys/src/zip.ts`, a few lines of the plain zip format instead of a dependency; browsers stop a page that starts many downloads at once): one CSV per platform and table (`{platform}-{table}.csv`, with each row's `.id` and the ids of the rows it is in), one CSV with every donation and its project version, one with every value and its path (`values.csv`), how each field was read per version (`fields.csv`), the answers, and the full JSON.
- **Names are placed by a small matcher, never by running code from the server.** The key page fetches the name map of the project's newest published version (structure only: keys, regular expressions and names, checked by `parseNameMap` with limits on size and depth) and places each value by its raw path (`placements` in `packages/seal/src/names.ts`, no dependencies). Regular expressions come from the researchers' own project and run only against path keys: patterns over 500 characters and keys over 1000 are not tested, and a pattern that does not compile matches nothing. File groups ([ADR 0016](decisions/0016-file-groups.md), `combray-names/2`) add one rule: a group's files are found by exact path first, then by name in any folder, then as the upload itself, and the steps of the file are skipped before its content is matched; group names are not in the map. Version 1 maps are still read. Values are never converted again on the key page; each keeps the reading of the version it was donated with. CSV cells that start with `=`, `+`, `-`, `@`, tab or carriage return get a leading apostrophe, so a spreadsheet does not run participant data as a formula; paths and raw values go through the same function.
- The release publishes `combray-keys.html` and its SHA-256, so anyone can compare with what a server serves.

### What changed and why (pilot)

- **No local key tool.** Replaced by the key page with passkeys, because installing a tool and keeping a key file was the bigger risk for the researchers Combray is for. The cost is trusting the server not to serve a malicious key page; see [researcher-keys.md](researcher-keys.md#limits).
- **One project key with member copies**, instead of sealing each donation to every researcher. Adding a colleague then needs no change to existing donations, and removing one deletes their copy.
- **No signed configs.** The `#k=` fingerprint in the participant link pins the project key instead.
- **One crypto implementation.** Nothing on the server opens anything; one TypeScript implementation is used by the participant client and the key page.
- **File groups in the name map** (2026-11-08). The matcher learned to find a value's file by its group's file matches (exact paths before names in any folder), so a donation's raw path is placed wherever its file was. No crypto changed; the matcher is still structure only, with the same limits on patterns and keys, and `parseNameMap` accepts groups only in version 2 maps and only directly below the root.

## Server

- **Logs** contain the method, the route *template* (for example `/api/v1/stores/{id}/unlock`, without the id), the status and the duration. Never URLs, bodies, headers, passwords, store ids or IPs. Errors are logged by class only.
- **Input:** store ids are validated before any lookup, and project ids are restricted to `[a-z0-9-]`, which rules out path traversal. Request bodies to the key service are capped at 8 KiB. Passwords are capped at 1,024 bytes.
- **Container:** distroless base image, non-root user, read-only root filesystem, all capabilities dropped, `no-new-privileges`. The data directory is the only writable volume, and the store master key comes in as a read-only Docker secret.
- **Storage:** two SQLite databases, with WAL, `secure_delete` and foreign keys on, through Node's built-in driver and Drizzle; schema changes are migrations in `apps/server/drizzle/`, applied at start. The main database (`COMBRAY_DB`) holds store key records, researcher accounts, sessions, members, sealed project keys and the donation index: no participant data and no key that opens anything. The sealed donation keys (`COMBRAY_DONATION_KEYS_DB`) are a separate file, so they can have their own volume and a short backup retention (ADR 0006). Donations are ciphertext. Queries and transactions run synchronously on one connection per database, so a transaction is never interleaved with another request's statements.
- **Researcher input:** emails are normalised and capped; project ids, donation ids and credential ids are validated before any lookup; donation bodies are capped by `COMBRAY_MAX_DONATION_MB` (64 by default), other researcher bodies at 64 KiB.

## Transport

Caddy terminates TLS with automatic certificates and sends HSTS. The Combray server itself listens only on the internal compose network. In development, the Vite dev server proxies `/api` to the local server. The dev server does not send the CSP, so check security-relevant changes against `pnpm serve`.

## Structure metadata and consent

The researcher decides, for every path in a platform's tree, what happens to it. For that, they need the structure of real data, including structure their own test export did not have. This is the one place where something derived from participant data is sent to the server outside a donation, so it gets its own consent step. It is designed but not built yet. Until it is, the client compares an import with the project tree locally, marks new paths as new in the participant's view, and sends nothing.

- **Researcher decisions.** In a low-tech researcher UI, each leaf of the tree gets a status: `ignore`, `show`, `donate` (which implies `show`), or `undecided` until the researcher chooses. Inner nodes can only be ignored as a whole; tables are inferred. The keys of a map whose keys are data (`{*}`) have a decision of their own, and their names never enter the structure metadata. The client hides `undecided` parts from the processed view unless the tree's root says `undecided: show` (participants still see all of their own data under raw data), and `donate` never applies to paths the researcher has not seen. See [tree-decisions.md](tree-decisions.md).
- **Clients get the seen structures.** A published upload point carries the researcher's configuration and the structures seen so far (`structure.json`: names, kinds and types, no values), so the client can tell parts it has never seen (new, to be asked about) from parts that are known but not configured ([ADR 0012](decisions/0012-names-and-matches.md)). This replaces the earlier rule that clients get only decided paths. What makes it acceptable: the seen structures come from the researchers' own test packages, the bundled packs and, later, structure reports participants agreed to send after reviewing every new name; every one went through the shape extractor's screening (collapsed keys, names that look like emails, numbers or tokens replaced); and they say nothing about any one participant, since they are a union kept without participant ids. A researcher who sees a private name in a test package's structure should not publish it.
- **The full structure, with new names reviewed.** Right after an upload, the client asks whether it may share the structure of the data. It compares the shape with the seen structures locally, and lists the paths it does not know for review: only those can carry something unexpected, because every other name was approved by the researcher. The server stores the structure without any participant id, so researchers can tell which nodes occur side by side and never combine them.
- **A specific request.** The participant sees a short, friendly explanation: their data is structured a little differently from what the researchers have seen, and knowing that helps them keep the study working. The client shows exactly the new paths it would send. It says that the structure also shows which kinds of data they have, and plainly that only names are sent, not any content. The answers are:
  - *Yes, send these paths.*
  - *No, these paths contain private information.* (The refusal and its reason are recorded, without the paths, so researchers learn that the extractor missed something.)
  - *No, for another reason.*
- **Structure only.** Paths come from the shape extractor, which drops values, collapses dictionary-like keys (usernames, dates used as keys) and screens names that look like emails, numbers or tokens (see [universal-importer.md](universal-importer.md#structure-metadata)). Showing the paths before sending is the last check, for the rare key that is private anyway.
- **Formats, not values.** Shapes say how dates and timestamps are written (`YYYY-MM-DD`, `epoch-s`), so researchers can set up parsing without seeing a value. A format is made of tokens and separators only: if any part of a value is not a known token, it gets no format, so text from a value cannot end up in one. Structure files are checked against the same grammar, and keep at most 8 formats per position. Collapsed keys keep only their types and formats. See [exploration.md](exploration.md#value-formats).

## Researcher workspace

The researcher workspace (`/studio/`) works on the researcher's own exports. They are parsed in a separate worker and kept only in its memory: nothing is written to IndexedDB or sent anywhere, and closing the tab drops them. What is kept between visits is the project's draft on the server: the structures seen (names screened as in shapes) and the researcher's configuration, never values. Example projects (`/studio/example/{id}/`) keep their draft, and the structures of test packages added to them, in `sessionStorage` of that tab only, the values of added packages in the page's memory only, and send nothing; their bundled test packages are the synthetic fixtures. Values from the exports are shown only in the "view as participant" preview and the table views, as React text, like everywhere else. The studio lets HTML table headers and `<dl>` terms become names, because the export is the researcher's own; that is how such names reach the project tree. Participants' clients only use header text as a name when the project tree already has it (`knownKeys`), so text from a participant's file never becomes a name in their shape. Charts run their query in the same worker and only counts and summaries come back to the page; they are SVG drawn by React, so labels are text. The story editor previews slides on a platform's test packages that have values (below): they are read in the same worker, kept apart from the loaded exports, through the participant's own code (`deriveImport`, then the story views), and only counts come back. Test packages a researcher adds to a project are the exception to "nothing is sent": see below.

### Test packages

A project's platform keeps the test packages researchers add in the studio (`test_packages` in the main database), so colleagues can work on the same tree, and see values, without uploading the same export again.

- **What is stored.** Always the package's name and its shape: the structure only, as in structure reports, kept once per distinct structure (SHA-256 of its JSON text). The content, the parsed export with its values, only when the researcher declares, with each upload, that it is synthetic (such as a fake account made for the study) or not sensitive (`declaration: "synthetic-or-not-sensitive"`); without that the server refuses content (`declaration_required`). It is the researcher's responsibility that the declaration is true: a real person's data must not be kept this way.
- **Plaintext on the server.** Content is stored gzipped but not encrypted: the server operator could read it. That is acceptable only because of the declaration, and it is why the declaration is asked for every package. Donations stay end-to-end encrypted; this is not a way to share participants' data.
- **Who can read it.** Project members only, through the studio session, which starts with a passkey on the key page (a full session; an email code alone does not give one). Non-members get 404, as for the rest of the draft. Answers are `Cache-Control: no-store`.
- **Limits.** Content up to 25 MiB of JSON per package, at most 10 packages with content per platform (200 in all), shapes within the tree size limit (2 MiB). Bigger requests are refused (413 `too_big`, 409 `too_many`).
- **Deleting.** A researcher deletes a package; deleting the platform or the project deletes its packages. Names and content are never logged.

## Supply chain

- The lockfile (`pnpm-lock.yaml`) is committed, and CI installs with `--frozen-lockfile`. Server dependencies are pinned to exact versions.
- pnpm only resolves package versions that have been published for at least a week (`minimumReleaseAge` in `pnpm-workspace.yaml`), so a hijacked release is likely to be caught before we pick it up.
- The participant client's store crypto uses only WebCrypto. Donation sealing and researcher keys use `@hpke/core` and `@hpke/hybridkem-x-wing` (by the same author, pure TypeScript over WebCrypto and `@noble` primitives) in `packages/seal`. The server has four dependencies: `@simplewebauthn/server` for passkeys, `@node-rs/argon2` for password hashing (prebuilt per platform, no install scripts), `drizzle-orm` for queries and migrations (no dependencies of its own), and `nodemailer` for mail. Everything else is Node itself: `node:crypto` (HKDF, SHA-256, random values, constant-time comparison), `node:sqlite` and `node:http`. New dependencies that touch data or keys need a reason in the PR.
- Participant id patterns in project configs are limited to a safe subset (no quantified groups, at most two unbounded repetitions, 100 characters), because JavaScript regular expressions backtrack: a careless pattern could otherwise make matching very slow.

## Decision log

| Choice | Alternatives considered | Why |
| --- | --- | --- |
| Encrypt every record ourselves with WebCrypto | Rely on IndexedDB or the OS | IndexedDB has no encryption, and we cannot rely on disk encryption being on |
| One logical blob per raw file, sliced into 4 MiB, plus chunked parsed caches | One IndexedDB record per item; one unsliced blob | Per-item records are slow and need plaintext indexes. Unsliced blobs blow up memory. |
| AES-256-GCM with random nonces and context-binding AAD | AES-CBC + HMAC; ChaCha20-Poly1305 | Native in WebCrypto, authenticated, hardware-accelerated |
| KEK on the server, wrapped DEK on the device | Key on the device; passphrase KDF on the device; encrypted cookie | Only option where neither the disk nor the server alone suffices, guessing is online-only, and crypto-shredding works |
| Wrap the DEK instead of keeping it on the server | Server stores the DEK | The data key never leaves the device; rotation and extra unlock paths without re-encryption |
| KEK derived with HKDF from a store master key and a per-store salt | Random KEK stored encrypted in the database | Same protection, no key material in the database, deletion is crypto-shredding |
| Argon2id (19 MiB, t=2) with a per-store lockout | PBKDF2, bcrypt, rate limiting only | Memory-hard, OWASP-recommended; the lockout makes short passwords workable |
| Browser sends PBKDF2(password, device salt), not the password | Send the password; OPAQUE | The server never learns the password, at the cost of one WebCrypto call; OPAQUE needs a non-vetted library in the browser ([ADR 0014](decisions/0014-participant-passwords-and-backups.md)) |
| At least 6 characters, a warning for weak ones, hard lock after 50 failures | 8+ characters; a list of refused passwords; no hard lock | Guessing is online only and now capped at 50 guesses; lists are long to ship and keep current, and paternalistic |
| Backup file the participant keeps, opened with the password | Recovery link; download from the server; a device key shared across projects | No new secret to explain, nothing stored on the server, no linking across studies ([ADR 0014](decisions/0014-participant-passwords-and-backups.md)) |
| No passphrase or no-server mode | Offline fallback | It brings back offline guessing, and no study needs it yet |
| No device-key layer | Device key + server secret | It sits on the same disk as the data, so it adds nothing |
| Delete token for crypto-shredding | Require the password to delete | Participants who forgot their password can still delete cleanly, and the token gives no read access |
| One store and one key per project per device | One store per browser | A forgotten password or a deleted store only affects one study; researchers are in charge of their own participants |
| Participant ids in the link fragment, pattern checked on the server | Ids in the path or query; client-side checks | Fragments stay out of logs; the server is the only place a check can be trusted |
| Researcher-issued reset links that keep the KEK | No recovery; a facilitator-held second wrap of the DEK; email recovery | Recovery without a second key path and without contact details on the server; the participant's device is still needed |
| Strict CSP + Trusted Types with one restrictive default policy | CSP only; named policies everywhere | It blocks every DOM XSS sink, and Vite and React work with it |
| Full structure shared after upload, new names reviewed | Only new paths; named versions | Researchers need to know which nodes occur together to join them safely. Reviewing only new names keeps the effort small |
| Clients get the seen structures with the configuration | Decided nodes only; hashes of unreviewed paths | Telling new parts from known but unconfigured ones needs the seen names; they are screened structure from consented or researcher-owned sources, without values or participant ids ([ADR 0012](decisions/0012-names-and-matches.md)) |
| Donations as raw paths with values, names placed on export, raw values on request | Processed tables; names frozen in the donation | The configuration and its names can change after donating; keys that are data are written by position (`{i}`), never as names ([ADR 0015](decisions/0015-raw-paths-and-relational-export.md)) |
| Positions renumbered without gaps, order kept | Positions as in the file; shuffled order | Gaps would show which rows were left out; order is often the data |
| Gzip inside the envelope, capped on opening | No compression; compression outside | Payloads with many paths shrink a lot; compressing after encryption gains nothing and the cap stops gzip bombs |
| No SRI for now | SRI on all scripts | Same-origin scripts gain nothing; revisit if anything is ever loaded cross-origin |
| Reproducible builds and published hashes | "Signed code only" | No browser standard enforces signed code for a normal website |
| Researcher keys on a browser key page, locked under passkey PRF | Local key tool; keys held by the server; keys by email | Nothing to install or lose for low-tech researchers, while the server still cannot open donations ([ADR 0007](decisions/0007-browser-key-page.md)) |
| Key page on its own origin, one hash-pinned file | Key handling inside the studio | A bug in the large apps cannot reach keys; the page can be read and checked against a release hash |
| Email code plus passkey, no passwords | Passwords with TOTP; institutional login now | Nothing to reuse or phish; institutional login can replace the email step later |
| One project key with sealed member copies, granted after comparing key codes | Seal each donation to every researcher | Colleagues can be added without touching donations; the code comparison stops a server-substituted key |
| Recovery code (the master secret) as the only fallback | Server-side recovery; a second passkey only | The server must not be able to recover keys; a printed code survives losing every device |
| `#k=` key fingerprint in the participant link | Signed configs now | Pins the key, which is what confidentiality needs, without a signing key to manage in the pilot |
| Donations matched afresh at donation time, refused if the settings changed since the review | Storing the donation when the upload is read | Settings the researcher fixes during a session apply, and what is sent is always what the participant reviewed |
| Stories checked on the participant's device, stored as written on the server | A full schema check on the server too | One check, in `packages/core`, used by the studio and the participant app; the server keeps a size limit and the shape it needs (a list of slides) |

## Open questions

- **R and Python access** to donations without a passkey: a device key added from the key page, or the recovery code on a trusted machine?
- **Who reviews the key page and `packages/seal`** before a study with real participants beyond the pilot.
- **Identity by email or phone**, as an alternative to researcher-issued participant ids. It would allow self-service password reset, but the server would hold contact details. For now, we stick to participant ids.
- **Who may create reset links** once researcher accounts exist: every researcher of a project, or only its owners? And should a project be able to switch resets off while still using ids?
- **OPAQUE** (or another password-authenticated key exchange), so the server never sees passwords. It is worth it if it can be done with audited libraries on both sides.
- **Retention** of orphaned store records: expire them after a project's end date, or after N months unused?
- **Store master key rotation** procedure.
- **Who reviews this?** An internal review before Phase 2 and an external audit before a large study (open question 16).
