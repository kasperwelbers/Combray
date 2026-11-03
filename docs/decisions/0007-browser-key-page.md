# ADR 0007: Researcher keys on a browser key page, locked under passkeys

- **Status:** accepted (built for the pilot)
- **Date:** 2026-11-02
- **Amends:** [ADR 0003](0003-typescript-core-and-key-tool.md) (the local key tool) and [ADR 0006](0006-revocable-donation-keys.md) (sealing to each researcher key, access tokens)

## Context

Combray is moving towards a first pilot. ADR 0003 planned a small local tool to create the project key pair, sign configs and decrypt donations. For the researchers Combray is for, installing a desktop tool and keeping a key file with a passphrase is a real barrier, and a lost key file means lost donations. Letting the server create and keep the keys, or emailing them, would mean the server could read every donation.

The WebAuthn PRF extension now works on the main platforms, including a phone used by QR code from a computer, so a passkey can unlock a key in the browser without the server learning anything that opens it.

## Decision

1. **A key page replaces the local key tool.** It is a single, dependency-free HTML file on its own origin (`COMBRAY_KEYS_URL`), with its script and style pinned by hash in a strict CSP, published with its SHA-256 in each release. The participant app and the studio never handle keys.
2. **Researchers sign in with an email code and a passkey.** No passwords. (Amended by [ADR 0009](0009-researcher-sign-in.md): an emailed code instead of a link; the studio signs in with the code alone; the key page with the passkey alone.) Sign-in is pluggable, so an institutional login can replace the email step.
3. **Each researcher has a personal X-Wing key**, made in the browser. The server stores the public key, and the private key only locked under the passkey's PRF output. A recovery code (the master secret) is downloaded or printed once.
4. **Each project has one project key.** Donations are sealed to it. Each member with access has a copy sealed to their personal key. An existing member grants access in their own browser after both compare a key code.
5. **Researcher access is a session, not a token.** The API checks project membership; sealed keys and envelopes are served on the key site only.
6. **No signed configs for the pilot.** The participant link carries the project key fingerprint (`#k=`), and the donate screen checks it.

The design is in [researcher-keys.md](../researcher-keys.md); the constructions are in [security.md](../security.md#researcher-sign-in-and-keys).

## Consequences

- Nothing to install. A synced passkey survives a lost phone; the recovery code covers losing every device.
- The server could serve a malicious key page while a researcher uses it. That is the inherent limit of web-based end-to-end encryption; the separate origin, the single hash-pinned file and the release hash make it an active, checkable attack.
- Passkeys without PRF (Windows 10, some password managers) can sign in but not hold the key; those researchers use the recovery code to unlock.
- If every member with access loses both passkey and recovery code, the project's donations cannot be opened.
- The R and Python packages cannot use a passkey and need another way to get a personal key (open).
- `combray-crypto` (Rust) is not needed: nothing on the server opens anything, and `packages/seal` serves the client and the key page.

## Alternatives considered

- **The local key tool** (ADR 0003). Strongest separation from the server, but a barrier to install and a key file to lose.
- **Server-held keys** or **emailed keys**. Simplest, but the server (or every mailbox on the way) could read donations.
- **Keys handled inside the studio.** One app fewer, but a bug anywhere in a large React app with charts and parsers would reach keys.
- **The standalone file run from disk.** Passkeys are bound to an origin and do not work on `file://`; the release file is for checking the served page instead.
