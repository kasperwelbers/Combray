# ADR 0009: Researcher sign-in: email code for the studio, passkey for keys

- **Status:** accepted, built
- **Date:** 2026-11-03
- **Amends:** [ADR 0007](0007-browser-key-page.md) (decision 2, how researchers sign in)

## Context

ADR 0007 had researchers sign in on the key page with an emailed link and then a passkey, and the studio got its session from the key page. In practice:

- University mail filters open links to scan them, which used up the one-time link before the researcher clicked it.
- The studio showed its workbench to anyone, with a sign-in card next to it, which was confusing.
- Most studio work (projects, importers, drafts) needs no keys, yet every visit went through the key page and the passkey.
- A researcher who lost both passkey and recovery code needed the server operator, although colleagues can give access again by themselves.

## Decision

1. **The email step is an 8-digit code**, typed in the browser that asked for it. The code is tied to that browser by an `HttpOnly` cookie with a random secret, and to the site it was asked for on. It works once, for 10 minutes, with 5 tries.
2. **The studio signs in through the key page, with the passkey** (amended 2026-11-03; first it signed in with the email code alone, for 30 days). The studio sends researchers to the key page and back with a one-time handoff; the session ends after an hour without activity and at most twelve hours after the passkey. Opening a project is something only a passkey allows: with the email code alone, nobody reaches a researcher's projects. A studio session never receives key material. Each project has its own workspace (`/studio/p/{project}/`).
3. **The key page signs in with the passkey alone** (a discoverable credential). The email code is for the first passkey, a new device or a lost passkey. Key page sessions stay short (2 hours), because they open donations.
4. **Researchers can start over** after losing both passkey and recovery code: after the email code, the server forgets their key, and colleagues give access again after comparing key codes. Refused while they are the only member with access to a project.
5. **Publishing project changes will need the passkey** (not built yet): the studio sends the researcher to the key page to confirm, which is also where project configs can be signed.

Details are in [researcher-keys.md](../researcher-keys.md#accounts-and-sign-in) and [security.md](../security.md#sessions).

## Consequences

- Someone with a researcher's email alone cannot reach their projects. Someone at their unlocked, signed-in browser can, for up to an hour of inactivity and twelve hours in all, but cannot open donations or publish without the passkey.
- Publishing needs access to the project's encryption key. For researchers, the project key is called the **encryption key**.
- Someone with a researcher's email can start over on their account, locking the researcher out until they do the same; they get no access, because colleagues compare key codes with the real person.
- The operator's `reset-key` remains for a researcher who alone had access and lost everything; that project's existing donations are then lost.
- Under `pnpm dev`, the server treats :5173 as the main site, so studio sign-in works with hot reload.
