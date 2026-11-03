# Key design: stores, donations and withdrawal

This document follows one participant's data from the moment it is loaded to the moment a researcher analyses it, and names every key on the way. It is the agreed plan ([ADR 0006](decisions/0006-revocable-donation-keys.md)). The local store, donation sealing and storage, withdrawal, and the researchers' key page are built; the participant donate screen and the package export are not yet. How researchers sign in and hold their keys is in [researcher-keys.md](researcher-keys.md) ([ADR 0007](decisions/0007-browser-key-page.md)). [security.md](security.md) records the details of what is built, and [privacy-and-encryption.md](privacy-and-encryption.md) the threat model and constructions.

For a version with pictures, see [the explainer for researchers](explainers/keys.html). Participants get the same story in the app, on the Questions page (`/p/{project}/faq`, `apps/web/src/screens/Faq.tsx`).

## In one paragraph

The participant's data is encrypted in their browser with a **data key**. The data key is kept in a **locked box** on the device; the key to that box is on the server and is handed out only for the participant's password. When the participant donates, the browser takes only what they chose, encrypts it with a fresh **donation key**, and locks that donation key in a box that only the **project key** opens. The project key itself is kept only in boxes that each researcher's passkey opens. The server keeps the donation and its locked key apart. Researchers fetch the locked keys every time they analyse, and never save them. If a participant withdraws, the server throws the locked key away, and every copy of that donation, wherever it is, becomes unreadable.

## The keys

| Key | What it is | Where it lives | Who can use it |
| --- | --- | --- | --- |
| **Data key** (store DEK) | Random AES-256 key that encrypts everything in the participant's local store | Only in the browser's data worker, non-extractable, while the store is open | The participant's open session |
| **Locked box** (wrapped DEK) | The data key, encrypted with AES-KW under the box key | On the device, in the store's metadata; also in a Combray package | Nobody, without the box key |
| **Box key** (store KEK) | Derived on the server from the store master key and a per-store salt | On the server; sent to the browser for the right password, used once, wiped | The server, and the browser for a moment after login |
| **Password** | Chosen by the participant, at least 8 characters | Only in the participant's head; the server keeps an Argon2id hash | The participant |
| **Donation key** | Fresh random AES-256 key for one donation | Made in the browser at donation time; only ever stored sealed | The researcher's tools, in memory |
| **Sealed donation key** | The donation key, sealed with HPKE (X-Wing) to the project key | On the server, in a key database separate from the donations | A member with access, on the key page, who may fetch it from the server |
| **Project key** | X-Wing (X25519 + ML-KEM-768) key pair for the project | Public key and fingerprint in the project config; the private key only sealed to each member's personal key | Members with access, on the key page, in memory |
| **Personal key** | X-Wing key pair per researcher, from a master secret | Public key on the server; master secret on the server only locked under the researcher's passkey (PRF), and as their recovery code | One researcher, after a passkey or the recovery code |
| **Researcher session** | Email link plus passkey | `HttpOnly` cookie on the key site; a separate studio session without key access | One researcher |
| **Withdrawal token** | Random secret from the donation receipt | Kept by the participant (device, package, or printed receipt); server stores a hash | The participant |

Two things never meet in one place by design: the locked box and its key (device and server), and the sealed donation keys and an open project key (server, and a researcher's key page while it is unlocked).

## The flows

### 1. Starting: create a password

The participant opens the project link and chooses a password. The server creates a store record (random 128-bit store id, KEK salt, Argon2id hash, a hash of the delete token) and returns the box key once. Built ([ADR 0004](decisions/0004-server-held-store-keys.md)).

Keeping the password hash on the server is what makes guessing slow: the server counts failures and locks out after a few. It also lets the participant log in on another device. A hash cannot open anything; the server could hand out the box key anyway.

### 2. Loading data

The browser creates the data key, encrypts every file in 4 MiB slices with AES-256-GCM, locks the data key in a box with the box key, wipes the box key, and stores ciphertext and box in IndexedDB. Built.

### 3. Working, locking, unlocking

While the store is open, the data key sits non-extractable in the data worker. After 15 minutes without input, on "lock", or when the tab closes, the worker drops the data key and every decrypted cache. What remains on the disk is ciphertext and a locked box, useless without the server. Unlocking asks for the password; the server checks it under its lockout and returns the box key; the browser opens the box and wipes the box key. Built.

### 4. Donating

Nothing reaches the researcher until this step, and only what the participant chose.

1. The participant previews the donation, removes items, answers questions and consents ([consent layer](privacy-and-encryption.md#consent-layer)).
2. The browser picks a random 128-bit donation id and a fresh donation key, and encrypts the payload in chunks (STREAM construction, AAD binding project id, donation id, chunk index and last-chunk flag).
3. It checks the project key against the fingerprint in the participant's link (`#k=`), then seals the donation key to it, with HPKE (X-Wing, HKDF-SHA-256, AES-256-GCM). The HPKE `info` binds the project id and donation id, so a sealed key cannot be moved to another donation.
4. It uploads the envelope and the sealed keys together. The server stores the envelope in donation storage and the sealed keys in a separate key database, and returns a **withdrawal token**. The token goes into the participant's receipt.

The store's data key is never sealed for the researcher. See [why](#rejected-a-researcher-copy-of-the-data-key).

### 5. Analysing (fetch on use)

Researchers may keep the encrypted donations on their own computer: they are useless there without the sealed keys. Every analysis starts by fetching the sealed keys from the server:

1. The tool (the key page now; an R package, later Python) syncs the encrypted envelopes it does not have yet into a local cache, and learns which donations were withdrawn.
2. It deletes the local envelopes of withdrawn donations.
3. It fetches the sealed keys for the donations it needs, in the researcher's session, opens them with the project key, decrypts in memory, and hands the data to the analysis.
4. It never writes a donation key or plaintext to disk.

A researcher who exports or saves decrypted data takes on the responsibility for that copy under the GDPR, including deleting it when a participant withdraws. The tools make the safe way the easy way; they cannot stop a researcher who sets out to keep a copy.

The collaborator model follows from this. Each researcher signs in on their own and has their own sealed copy of the project key. A researcher who leaves the project is removed: their copy is deleted and they can no longer fetch keys. That does not protect against someone who saved keys or data while they had access, and nothing could.

### 6. Withdrawing

A participant withdraws with their withdrawal token, or asks the researcher, who withdraws on their behalf. The server then:

1. deletes the sealed keys from the key database (with SQLite `secure_delete`),
2. deletes the envelope,
3. keeps a tombstone (donation id and the day it was withdrawn), so researcher tools know to delete their local copies.

From that moment no copy of the donation can be opened, wherever it is: not the researcher's local cache, not a backup of the donation storage.

**Backups are the weak spot.** A backup of the key database brings withdrawn keys back. The key database is therefore a separate file with its own backup retention, and participants are told that withdrawal is complete within that time. Donation storage can be backed up as long as the institution likes: without keys it is ciphertext.

- **A setting, `COMBRAY_KEY_BACKUP_RETENTION_DAYS`, 30 by default.** The server publishes it to the client, which shows it on the Questions page and the withdrawal screen. The deployment guide asks the institution to set its backups of the key database to match. Combray does not make the backups itself, so it cannot enforce the number; it states it.
- **Withdrawals survive a restore.** The withdrawal tombstones live in the donation database, not the key database. On start, the server deletes every sealed key that has a tombstone, so restoring an old key backup cannot bring a withdrawn donation back.
- **This matches the GDPR.** Erasure must happen "without undue delay" (Art. 17), and requests are answered within a month (Art. 12(3)). Supervisory authorities accept that backups expire on their normal cycle when the data is beyond use until then and the person is told.

### 7. Forgotten password

Built ([ADR 0005](decisions/0005-projects-scope-stores.md)): a participant with an id asks the researcher, who checks who they are and creates a one-time reset link. The server sets the new password and returns the same box key, so the data opens again. Whoever can create reset links (the researchers, and for now the server operator) could, with the participant's device in hand, open that local data. We accept this: the server operator already holds the box keys, and requiring the researcher key as well would not stop them.

### 8. Planned: the Combray package (export and restore)

A participant can download their store as one file, a **Combray package**:

```
CombrayPackage v1
├─ manifest: format version, server URL, project id, store id, created_at (day)
├─ locked box (the wrapped data key)
└─ encrypted slices and caches, exactly as in IndexedDB
```

It contains nothing that is not already on the disk, and it opens only by logging in with the password, on any device: the client imports the package, the participant enters the password, the server releases the box key for that store id, and the browser opens the box. The data key stays non-extractable throughout; the box is already plain bytes.

This gives participants a safe way to keep their data, move it to another computer, and protect it against the browser clearing its storage. We can advise them to download the package right away and delete the original download package from their computer. Deleting the store on the server makes every package unreadable, which is what makes "delete everything" true. The client should also ask the browser for persistent storage (`navigator.storage.persist()`), so IndexedDB is less likely to be evicted.

What we give up is that data is tied to one browser. The protection stays the same as for a copy of the disk: the file alone is not enough, and password guessing is online only.

## Who can see what

| Who | Has | Can read local data | Can read a donation |
| --- | --- | --- | --- |
| Someone with the participant's laptop or a package | Ciphertext, locked box | No (needs the password, guessed online only) | No |
| Server operator | Box keys, password hashes, envelopes, sealed keys, sealed project keys, locked personal keys | Only with the participant's device too | No (needs a researcher's passkey or recovery code), unless they serve a malicious key page ([limits](researcher-keys.md#limits)) |
| Someone who stole the server database | Same as operator, without the store master key if kept apart | No | No |
| Researcher | Passkey, recovery code, a session | No (never gets the data key) | Yes, while the donation is not withdrawn and they are a member |
| Someone with a researcher's email | Sign-in links | No | No: the link alone cannot use the passkey or recovery code |
| Someone with a researcher's unlocked phone or laptop | Their passkey | No | Yes, as that researcher. Remove the passkey and the member if a device is lost |
| Future quantum computer | Recorded envelopes and sealed keys | No | No, as long as ML-KEM holds |

## Server side

Donation storage and the key database are separate: different SQLite files (and on a VM, different volumes), so they can be backed up differently. Endpoints, under `/api/v1` (built):

| Endpoint | Caller | Purpose |
| --- | --- | --- |
| `POST /p/{project}/donations` | Web client | Upload an envelope and its sealed key; returns the withdrawal token |
| `POST /donations/{id}/withdraw` | Web client | Withdraw with the withdrawal token |
| `GET /projects/{id}/donations` | Researcher (key page, studio) | List donations (id, day) and tombstones |
| `GET /projects/{id}/donations/{d}` | Researcher (key page) | Download one envelope |
| `POST /projects/{id}/donation-keys` | Researcher (key page) | Fetch sealed keys for a list of donation ids (`Cache-Control: no-store`) |
| `DELETE /projects/{id}/donations/{d}` | Researcher (key page) | Withdraw on a participant's behalf |

Researcher endpoints need a signed-in member of the project; the key page's routes exist only on the key site. The server logs the number of sealed keys served, never donation ids.

## Researcher tools, sketched

The key page opens donations today. For R and Python, decryption would come from `packages/seal` (run in a small embedded JavaScript runtime) or a Rust port with shared test vectors. How these packages get the personal key without a passkey is open ([researcher-keys.md](researcher-keys.md#limits)); a device key added from the key page is the likely answer, and the sketch below assumes it.

A first sketch of the R package:

```r
library(combray)

con <- combray_connect(
  server  = "https://combray.uni.nl",
  project = "willow",
  key     = combray_device_key()            # added once from the key page, kept in the keyring
)

combray_sync(con)                 # download new envelopes, delete withdrawn ones
d <- combray_donations(con)       # tibble: id, day, datasets, status
yt <- combray_read(con, dataset = "youtube_watch_history")  # fetch keys, decrypt in memory
```

`combray_read` returns ordinary data frames and keeps nothing on disk. The package warns when R is set to save the workspace on exit (RStudio's default), because `.RData` would quietly hold decrypted data, and the setup guide tells researchers to turn it off.

## Rejected alternatives

### Rejected: keeping the password only in a cookie

An encrypted `httpOnly` cookie would sit on the same disk as the data. If it is opened with something derived from the password, anyone with a copy of the disk can guess passwords offline without any lockout. Storing an Argon2id hash on the server keeps guessing online, and is needed to log in on another device anyway.

### Rejected: a researcher copy of the data key

Sealing the store's data key to the researcher at the start would let the researcher, together with the device, read everything the participant loaded, including what they chose not to donate. In lab studies the device is often the lab's own laptop. Data would then reach the researcher through trust in the researcher, not through the participant's consent. A fresh key per donation, sealed at donation time, keeps the line where the participant draws it.

### Rejected: researcher-assisted restore with an asymmetric browser box

An earlier idea locked the data key for the browser with a key pair, so the researcher (holding a copy of the data key) could re-lock it for a new device. It needs the researcher copy above, and the researcher in every move. The Combray package does the same with only the password.

### Rejected: the sealed key inside the envelope

The first donation design put the HPKE encapsulation in the envelope header. Then every copy of an envelope carries its own key, and withdrawal can only delete the server's copy. With the sealed keys kept apart, deleting one small record withdraws every copy.

## Limits

- **Copies of plaintext.** Once decrypted, data can be copied. Withdrawal reaches every copy of the ciphertext, not data a researcher exported.
- **Key database backups** delay withdrawal until they expire.
- **The server operator together with a participant's device** can read that participant's local data (as today, see [security.md](security.md#known-limits)).
- **A malicious server could serve altered JavaScript**, which no web app can rule out; see [security.md](security.md#xss-and-code-integrity).
