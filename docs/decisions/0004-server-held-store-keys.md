# ADR 0004: Server-held store keys, no passphrase mode

- **Status:** accepted
- **Date:** 2026-10-29
- **Amends:** [privacy-and-encryption.md](../privacy-and-encryption.md#local-store) (unlock modes) and open question 4

## Context

Phase 1 shipped an encrypted local store unlocked with a passphrase: the data key was wrapped under a key derived with PBKDF2 from the passphrase, all on the device. That leaves the passphrase open to offline guessing by anyone with a copy of the disk, and participants choose short passphrases. The design documents also described a "device key plus server secret" scheme and a browser-only passphrase mode.

## Decision

1. **The data stays on the device and the key stays on the server.** The server's key service holds a key encryption key (KEK) per store, derived with HKDF from a store master key and a per-store salt, and releases it only for the store's password (Argon2id, with a per-store lockout and per-IP rate limits). The device keeps the data key (DEK) wrapped under the KEK. Neither side alone can read the data.
2. **The DEK is wrapped, not stored on the server**, so the data key never leaves the device, and the server key can be rotated or a second unlock path added without re-encrypting the data.
3. **No passphrase-only or browser-only mode.** Every deployment has a server. If a study ever needs offline use, it gets its own design.
4. **No device-key layer.** It would sit on the same disk as the data and add nothing.
5. **Deleting a store crypto-shreds it** through a delete token kept on the device.

The full reasoning, parameters and limits are in [security.md](../security.md#store-keys).

## Consequences

- Password guessing is online only and rate limited, so 8-character participant passwords are acceptable.
- The web client needs the server to unlock. A lab without a network can run the server on the lab laptop.
- The store master key becomes critical: losing it makes every store unreadable, so it is backed up separately from the data.
- A forgotten password means the data cannot be opened again, until a recovery path is designed. Participants can import their export again.
- The browser-only deployment shape is removed from the design documents.
