# Key design: stores, donations and withdrawal

This document follows one participant's data from the moment it is loaded to the moment a researcher analyses it, and names every key on the way. It is the agreed plan ([ADR 0006](decisions/0006-revocable-donation-keys.md)). The local store part is built; donations, the package export and the researcher tools are not yet. [security.md](security.md) records the details of what is built, and [privacy-and-encryption.md](privacy-and-encryption.md) the threat model and constructions.

For a plain-language version with pictures, see [the explainer](explainer/keys.html).

## In one paragraph

The participant's data is encrypted in their browser with a **data key**. The data key is kept in a **locked box** on the device; the key to that box is on the server and is handed out only for the participant's password. When the participant donates, the browser takes only what they chose, encrypts it with a fresh **donation key**, and locks that donation key in a box that only the **researcher key** opens. The server keeps the donation and its locked key apart. Researchers fetch the locked keys every time they analyse, and never save them. If a participant withdraws, the server throws the locked key away, and every copy of that donation, wherever it is, becomes unreadable.

## The keys

| Key | What it is | Where it lives | Who can use it |
| --- | --- | --- | --- |
| **Data key** (store DEK) | Random AES-256 key that encrypts everything in the participant's local store | Only in the browser's data worker, non-extractable, while the store is open | The participant's open session |
| **Locked box** (wrapped DEK) | The data key, encrypted with AES-KW under the box key | On the device, in the store's metadata; also in a Combray package | Nobody, without the box key |
| **Box key** (store KEK) | Derived on the server from the store master key and a per-store salt | On the server; sent to the browser for the right password, used once, wiped | The server, and the browser for a moment after login |
| **Password** | Chosen by the participant, at least 8 characters | Only in the participant's head; the server keeps an Argon2id hash | The participant |
| **Donation key** | Fresh random AES-256 key for one donation | Made in the browser at donation time; only ever stored sealed | The researcher's tools, in memory |
| **Sealed donation key** | The donation key, sealed with HPKE (X-Wing) to a researcher public key | On the server, in a key table separate from the donations | Whoever holds the researcher private key **and** may fetch it from the server |
| **Researcher key pair** | X-Wing (X25519 + ML-KEM-768) key pair for the project | Public key in the signed project config; private key only on researchers' computers | The project's researchers |
| **Researcher access token** | A credential that lets a researcher list donations and fetch sealed keys | Server stores a hash; one per researcher, revocable | One researcher |
| **Withdrawal token** | Random secret from the donation receipt | Kept by the participant (device, package, or printed receipt); server stores a hash | The participant |

Two things never meet in one place by design: the locked box and its key (device and server), and the sealed donation keys and the researcher private key (server and researcher's computer).

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
3. It seals the donation key to each researcher public key in the signed project config, with HPKE (X-Wing, HKDF-SHA-256, AES-256-GCM). The HPKE `info` binds the project id and donation id, so a sealed key cannot be moved to another donation.
4. It uploads the envelope and the sealed keys together. The server stores the envelope in donation storage and the sealed keys in a separate key database, and returns a **withdrawal token**. The token goes into the participant's receipt.

The store's data key is never sealed for the researcher. See [why](#rejected-a-researcher-copy-of-the-data-key).

### 5. Analysing (fetch on use)

Researchers may keep the encrypted donations on their own computer: they are useless there without the sealed keys. Every analysis starts by fetching the sealed keys from the server:

1. The tool (local key tool, R package, later Python) syncs the encrypted envelopes it does not have yet into a local cache, and learns which donations were withdrawn.
2. It deletes the local envelopes of withdrawn donations.
3. It fetches the sealed keys for the donations it needs, with the researcher's access token, opens them with the private key, decrypts in memory, and hands the data to the analysis.
4. It never writes a donation key or plaintext to disk.

A researcher who exports or saves decrypted data takes on the responsibility for that copy under the GDPR, including deleting it when a participant withdraws. The tools make the safe way the easy way; they cannot stop a researcher who sets out to keep a copy.

The collaborator model follows from this. Each researcher gets their own access token. A researcher who leaves the project has their token revoked and can no longer fetch keys. That does not protect against someone who saved keys or data while they had access, and nothing could.

### 6. Withdrawing

A participant withdraws with their withdrawal token, or asks the researcher, who withdraws on their behalf. The server then:

1. deletes the sealed keys from the key database (with SQLite `secure_delete`),
2. deletes the envelope,
3. keeps a tombstone (donation id and the day it was withdrawn), so researcher tools know to delete their local copies.

From that moment no copy of the donation can be opened, wherever it is: not the researcher's local cache, not a backup of the donation storage.

**Backups are the weak spot.** A backup of the key database brings withdrawn keys back. The key database is therefore a separate file with a short, documented backup retention (proposed: 30 days), and participants are told that withdrawal is complete within that time. Donation storage can be backed up as long as the institution likes: without keys it is ciphertext.

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
| Server operator | Box keys, password hashes, envelopes, sealed keys | Only with the participant's device too | No (needs the researcher private key) |
| Someone who stole the server database | Same as operator, without the store master key if kept apart | No | No |
| Researcher | Private key, access token, local envelopes | No (never gets the data key) | Yes, while the donation is not withdrawn and their token is valid |
| Someone with a researcher's laptop | Private key, maybe local envelopes | No | Only with the researcher's token too |
| Future quantum computer | Recorded envelopes and sealed keys | No | No, as long as ML-KEM holds |

## Server side, planned

Donation storage and the key database are separate: different SQLite files (and on a VM, different volumes), so they can be backed up differently. Endpoints, under `/api/v1`:

| Endpoint | Caller | Purpose |
| --- | --- | --- |
| `POST /p/{project}/donations` | Web client | Upload an envelope and its sealed keys; returns the withdrawal token |
| `POST /donations/{id}/withdraw` | Web client | Withdraw with the withdrawal token |
| `GET /projects/{id}/donations` | Researcher | List donations (id, day, size bucket) and tombstones |
| `GET /projects/{id}/donations/{d}` | Researcher | Download one envelope |
| `POST /projects/{id}/donation-keys` | Researcher | Fetch sealed keys for a list of donation ids (`Cache-Control: no-store`) |
| `DELETE /projects/{id}/donations/{d}` | Researcher | Withdraw on a participant's behalf |

Researcher endpoints need an access token scoped to one project and one researcher. Until researcher accounts exist, the server operator issues and revokes them with a server command, as with reset links. The server logs counts of key fetches per token and day, never donation ids, so a project can show who accessed keys when.

## Researcher tools, sketched

Decryption is written once, in Rust (`combray-crypto`), and used by the local key tool and, through bindings, by R (extendr) and Python (PyO3). Nobody has to reimplement X-Wing.

A first sketch of the R package:

```r
library(combray)

con <- combray_connect(
  server  = "https://combray.uni.nl",
  project = "willow",
  token   = Sys.getenv("COMBRAY_TOKEN"),   # or keyring
  key     = "~/keys/willow.combraykey"     # asks for the key file's passphrase
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
