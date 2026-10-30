# ADR 0006: Revocable donation keys, kept apart from donations

- **Status:** accepted (not built yet)
- **Date:** 2026-10-30
- **Amends:** [privacy-and-encryption.md](../privacy-and-encryption.md#donation-encryption) (envelope format, withdrawal)

## Context

The donation design sealed a per-donation content key to the researcher with HPKE (X-Wing) inside the envelope header. Withdrawal could then only delete the server's copy of the envelope: any copy a researcher had downloaded stayed readable forever. Researchers also need to analyse donations repeatedly, and downloading everything again each time is impractical.

Separately, an idea was raised to give the researcher a sealed copy of the store's data key when the store is created, so the researcher could help restore data on another device.

## Decision

1. **One fresh donation key per donation**, sealed with HPKE (X-Wing) to each researcher public key. The store's data key is never shared with the researcher; a donation covers only what the participant chose, and is sealed only at donation time.
2. **Sealed keys are stored apart from the envelopes**, in their own key database on the server. Envelopes no longer carry them.
3. **Researcher tools fetch sealed keys on every use** and never store keys or plaintext. Researchers may keep encrypted envelopes locally.
4. **Withdrawal deletes the sealed keys** (and the envelope), leaving a tombstone. This crypto-shreds every copy of the donation.
5. **Researcher access is per researcher, through revocable access tokens.**
6. **Participants can export a Combray package** (ciphertext, locked data key, store id, server and project), which opens on any device with their password. No researcher is involved in restoring.

The full flows and the rejected alternatives are in [key-design.md](../key-design.md).

## Consequences

- Withdrawal reaches local copies of the ciphertext, not plaintext that a researcher exported. Saving decrypted data makes the researcher responsible for it under the GDPR.
- Backups of the key database delay withdrawal; it gets a short documented retention, separate from donation storage.
- Analysis needs the server to be reachable, and researcher credentials. A stolen private key alone no longer opens donations.
- Decryption lives in one Rust crate (`combray-crypto`) with bindings for R and Python, so it is not reimplemented per language.
- The server needs researcher access tokens before donations can be fetched.
