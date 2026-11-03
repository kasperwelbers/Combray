# ADR 0011: Server first

- **Status:** accepted
- **Date:** 2026-11-03

## Context

The early design had Combray work without a server too: installed on a lab laptop, usable offline, with a local tool for researchers' keys. Since then, every part of the design has come to rely on a server:

- Participants' local data is encrypted with a key that the server releases only after a password check ([ADR 0004](0004-server-held-store-keys.md)). There is deliberately no offline or passphrase-only mode, because it would bring back offline guessing ([security.md](../security.md#local-store)).
- Researchers sign in with an emailed code and a passkey, on two host names ([ADR 0007](0007-browser-key-page.md), [ADR 0009](0009-researcher-sign-in.md)). A laptop without a network has none of that.
- The local key tool was replaced by the key page.

In practice, Combray already needs a server. And what sets it apart is not where it runs, but how it is used: participants have sessions they come back to, with their data encrypted on their own computer in between; researchers set up a study without writing code; and it is built for supported, qualitative settings rather than quick remote donation.

## Decision

1. **Combray is server first.** Every deployment is a server: one shared server for a university or institute, or a lab's own. Participants and researchers only need a browser.
2. **Running without a server is not a goal.** No offline lab-laptop mode, no offline sign-in. A lab without a university server runs the same Docker setup on a small VM or host.
3. **Hosting comes next.** A pilot server running a first study is the priority, ahead of features that only matter locally.

## Consequences

- One deployment shape to document, test and secure. The security story stays simple: data is always unlocked through a server, which keeps it safe between sessions.
- A lab session needs a network connection to the server.
- The web client can still be installable (PWA) so a lab computer keeps a known version, but working offline is not a requirement.
- Running Combray on your own machine (`pnpm dev`) is for development only.
