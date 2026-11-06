# ADR 0014: Participant passwords and backup files

- **Status:** accepted
- **Date:** 2026-11-06
- **Amends:** [ADR 0004](0004-server-held-store-keys.md) (what the server sees of the password), [ADR 0006](0006-revocable-donation-keys.md) (point 6, the Combray package, now built as the backup file)

## Context

Participants unlock their local store with a password: the server releases the store's key (KEK) for it, after an Argon2id check with an increasing lockout. Before a pilot we looked again at how participants unlock, move to another computer, recover, and delete. Ideas on the table were a PIN instead of a password, one device key and password across projects, a "move to another device" secret or recovery link, a researcher re-locking the data key into a new box, and passkeys for participants.

Three facts shaped the decision. Guessing is online only, against the server's lockout, so a short password is enough. The local data never leaves the device, so without the participant's own copy there is nothing to recover except donations, which the receipt code already covers. And the planned Combray package already moves a store to another device with nothing but the password.

## Decision

1. **A password of at least 6 characters**, with no composition rules and no list of refused passwords. The app warns, without refusing, when a password looks easy to guess (a simple estimate in our own code, no dependency).
2. **The browser never sends the password.** It sends PBKDF2-SHA-256(password, salt), with a random salt kept in the store on the device (and in backup files). The server checks that value with Argon2id, as before.
3. **A hard lock after 50 failed tries** since the last correct password. The store then refuses every password until a researcher's reset link (participants with an id) or until it is deleted (anyone, with the delete token). Nothing is deleted by the lock.
4. **The backup file** (the Combray package of ADR 0006): the store's encrypted records, copied as they are, in a file the participant keeps. It opens on any device with the password. Offered below the participant's uploads, with the advice to delete the original download afterwards. The browser also asks for persistent storage.
5. **Not done:** no recovery link, no download of data from the server, no device key or password shared across projects, no researcher-held copy of the data key, and no passkeys for participants for now.

Details are in [key-design.md](../key-design.md#8-the-backup-file) and [security.md](../security.md#passwords-and-guessing).

## Consequences

- Participants have three things, each with one job: the **password** opens their data on this computer or from a backup; the **backup file** keeps it safe and moves it; the **receipt code** withdraws a donation from anywhere.
- The server can no longer learn participants' passwords, so reusing one is harmless to them. Together with a participant's device or backup file, the server operator could guess the password offline, but they could already open that data with the KEK.
- An attacker with the device or a backup file gets 50 guesses in total. An anonymous participant who types 50 wrong passwords loses access, as with a forgotten password.
- One password per project remains. A shared device key would let one server link a person across studies, and few people join several studies on one computer.
- Passkeys for participants are parked: PRF support is still missing on many Windows laptops and in some password managers (2026), and a deleted passkey would mean lost data. Because the data key is wrapped, a passkey can later be added as a second way to unlock without re-encrypting anything.
- Stores made before this change keep sending the password as typed until they are made again.
