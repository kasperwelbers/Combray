# Researcher keys: sign-in, passkeys and the key page

How researchers sign in, how their keys are made and kept, how a colleague is given access, and how donations are opened. Built for the pilot ([ADR 0007](decisions/0007-browser-key-page.md)). It replaces the local key tool planned in [ADR 0003](decisions/0003-typescript-core-and-key-tool.md). [key-design.md](key-design.md) follows a donation from the participant's side; [security.md](security.md#researcher-sign-in-and-keys) records the constructions.

## In one paragraph

A researcher signs in with a link sent by email, then with a **passkey** (Face ID, a fingerprint, a phone or a security key). The passkey does double duty: it is the second factor, and through the WebAuthn **PRF** extension it gives the browser a secret that unlocks the researcher's **personal key**. The server keeps the personal key only locked under that secret, so it cannot open it. Each project has one **project key**; every member with access has a copy of it sealed to their personal key. A colleague gets access when an existing member seals a copy for them in their own browser, after both compare a short **key code** by phone or in person. Donations are sealed to the project key and opened on the **key page**, a small page on its own address that does nothing else. A one-time **recovery code**, printed or saved when the key is made, replaces a lost passkey.

## The keys, and what researchers see

The same things have a technical name (in the code and these docs) and a name researchers see on screen. Researchers only ever meet the passkey, the recovery code, the project encryption key and the key code; the personal key is explained in the [researcher explainer](explainers/keys.html#chain), not asked about.

| On screen | In code and docs | What it is |
| --- | --- | --- |
| Passkey | Passkey | Signs the researcher in on the key page, alone, without email. Its PRF output unlocks the personal key. Whoever can use it has full access, so it belongs on the researcher's own devices only |
| Recovery code | Master secret | The researcher's personal key, written out. Replaces a lost passkey; store it well |
| (explained only) | Personal key | The researcher's own X-Wing key pair (called the researcher key in early notes). Opens their copies of project keys |
| Project encryption key, or "encryption key" where the project is clear | Project key | The project's X-Wing key pair. Donation keys are sealed to it; each member with access has a copy sealed to their personal key |
| Key code | Key code | A short fingerprint of a personal key, compared by phone before giving access |
| (not shown) | Donation key | A fresh key per donation, sealed to the project key |
| Email code | Email code | Proves the address once: for the first passkey, a device without a passkey, a lost passkey, or starting over |

## Why not a local tool, and why not keys on the server

The plan was a small local tool for key pairs and decryption. For the researchers Combray is for, installing and keeping a signed desktop tool is a real barrier, and a key file plus passphrase is something people lose. A browser page with a passkey asks for nothing to install and nothing new to remember.

Letting the server make and keep the keys would be simpler still, but then the server could open every donation, and the promise to participants ("only the researchers can read this") would rest on the server operator alone. Emailing keys has the same problem with more copies.

The honest limit of a browser page: the server serves the page, so a server that turns malicious could serve one that leaks the key. No web app can rule that out. The key page narrows it as far as a page can (below), and the release hash lets anyone check what is served. The difference from server-held keys is that an attack needs an active, detectable change to the page while a researcher uses it, rather than a quiet read of a database.

## Two addresses

The server answers on two host names: the main site (`COMBRAY_PUBLIC_URL`, for example `combray.uni.nl`) and the key site, by default the same name with `keys.` in front (`keys.combray.uni.nl`; `COMBRAY_KEYS_URL` sets another):

| | Main site | Key site |
| --- | --- | --- |
| Serves | Participant app, studio | The key page only |
| Passkeys | Blocked (`Permissions-Policy`) | Their RP ID is the key host |
| Sessions | Participant stores; studio sessions (only through a handoff from the key page) | Researcher sign-in: email code, passkey |
| Key material | Never | Sealed project keys, sealed donation keys, envelopes, wrapped personal keys |

Browsers keep origins apart, so a bug in the large participant app or the studio (React, charts, parsers) cannot read the key page's memory or use its passkeys. Key routes do not exist on the main site at all; asking for them there gives `404`. Any other host name gets `421`.

### Why not one address

Passkeys are usually on a site's own address, so why not serve the key page from the main site, say at `/keys/`? Because there a passkey only signs someone in, while here it unlocks the key to every donation. Within one origin, the browser gives no protection between pages. A script that got into the participant app or the studio, through XSS or, more likely, through one of the hundreds of packages they are built from, could:

- open the key page in a window and reach into it (same-origin windows can call each other's functions, whatever the key page's CSP says), and take the keys once the researcher unlocks;
- start a passkey request itself, because the passkeys would belong to that origin;
- send requests to the key API with the researcher's session cookie (`HttpOnly` cookies are sent with its requests too, and a cookie's `Path` is no barrier within an origin);
- install a service worker that changes the key page on later visits.

Each of these could be patched, but then every response of the main site must get every header right, forever. With two host names the browser does it. The other ways to get a second origin do not work: another port shares passkeys and cookies (both ignore ports), a sandboxed page cannot use passkeys, and suborigins never shipped.

The email code does not come from the second address: any design needs a way to know a researcher before their first passkey exists. What the second address adds is the trip from the studio to the key page and back. Its own risks are covered in [deployment.md](deployment.md#protecting-the-host-names).

## The key page

`apps/keys` builds one HTML file with its script and style inlined, unminified so it can be read as served. It depends on `@combray/seal` (HPKE with X-Wing) and nothing else at runtime: no framework, no third-party scripts, no fonts. Its Content Security Policy allows exactly the hashes of its own script and style and nothing else:

```
default-src 'none'; script-src 'sha256-…'; style-src 'sha256-…'; connect-src 'self';
img-src 'self' data: blob:; form-action 'none'; base-uri 'none'; object-src 'none';
require-trusted-types-for 'script'; trusted-types 'none'; frame-ancestors 'none'
```

The page builds every element with `textContent`, never HTML (the repo's test bans `innerHTML` and `eval` here too). Keys live in the page's memory only: closing or leaving the tab, pressing Lock, or 15 minutes without input wipe them, and opening again needs the passkey.

**Checking the page.** The build is deterministic. Each release attaches `combray-keys.html` and its SHA-256. To check what a server serves:

```sh
curl -s https://keys.combray.uni.nl/ | sha256sum
```

and compare with the release. The page shows its version in the footer. The release file is for checking; it does not run from disk, because passkeys and the API need the key site's origin.

## Accounts and sign-in

The server operator adds researchers and puts them on projects with a server command (`combray-server researcher add <email>`, `combray-server project add-researcher <project> <email>`). Members can then add colleagues on the key page; the server emails them an invitation.

On the key page, a researcher with a passkey on this device **signs in with the passkey alone**: one tap, no email. The browser offers the passkeys it holds for the key page, and the server finds the researcher from the passkey's user handle (a discoverable credential). The answer also carries the personal key wrapped under that passkey, so the page opens straight to the keys. The email code is for setting up the first passkey, for a device without a passkey, and for losing it:

1. **Email code.** The researcher enters their address on the key page; the server mails an 8-digit code, which they type on the same page. The code only works in the browser that asked for it: the request sets an `HttpOnly` cookie holding a random 256-bit secret, and the server stores the code hashed together with that secret. It works once, for 10 minutes, and stops working after 5 wrong tries. Requests are rate limited per address and per IP, and the answer (cookie included) is the same whether or not the address is known. A code instead of a link, because university mail filters open links to scan them, which would use up a sign-in link before the researcher clicks it; a mail without a link also looks less like phishing.
2. **Passkey.** The code gives a short email-level session (15 minutes) that can only register or use a passkey, or use the recovery code. Using the passkey upgrades it to a full session (2 hours on the key site). The session id is rotated on every upgrade.
3. **No passwords.** There is nothing to reuse, phish or reset by email alone: the email code is never enough on its own.

Sessions are `HttpOnly`, `SameSite=Strict`, host-only cookies (`__Host-` on https). Every request that changes something must carry an `Origin` header for the site it is sent to, and `Sec-Fetch-Site` must be `same-origin` or `none`.

Sign-in is a module of its own (`apps/server/src/accounts.ts`, `research.ts`), so an institutional login (SURFconext, OIDC) can later replace the email code without touching keys.

### The studio

The studio, on the main site, has no sign-in of its own. "Sign in with your passkey" there takes the researcher to the key page (`#studio=/studio/…`), which signs them in (passkey; the first time an email code and setting up the passkey) and sends them straight back with a one-time handoff code. The studio session ends after an hour without activity and at most twelve hours after the passkey. A studio session can list the researcher's projects, create new ones (becoming their first member), and edit a project's draft in tabs (`/studio/p/{project}/{tab}/`): details, information and consent, the data explorer (per platform: data donation packages, own or synthetic examples, and the tree editor), researchers, and donations. The draft is saved on the server, in parts. **Publishing** the draft, which makes it what participants see and are asked to donate, happens on the key page with the passkey. It never gets key material, and cannot make handoffs. Opening donations, creating a project's encryption key and publishing happen on the key page; publishing also needs access to the encryption key. A new project shows its setup steps (encryption key, platforms, publish), and a member without access to the encryption key sees that a colleague needs to give it. Example projects (`/studio/example/{id}/`) open without signing in: the same project screens over a project kept in the browser tab (sessionStorage, so it starts over when the tab closes), with synthetic test packages, no researchers or donations, and no way to publish. On a server without researcher accounts, they are all the studio shows.

"Open the studio" on the key page also signs in to the studio: it asks the server for a one-time code (valid two minutes, used once) and opens `https://combray…/studio/#handoff=<code>`, which the studio trades for a studio session.

## The personal key

On first sign-in, the page creates a 32-byte **master secret** and derives from it, with HKDF-SHA-256:

- the seed of the **personal key**, an X-Wing key pair (`combray/personal-key/v1`);
- a **recovery sign-in secret** (`combray/recovery-sign-in/v1`), whose SHA-256 the server keeps to check the recovery code.

The public key goes to the server. The master secret is then locked twice:

- **Under the passkey.** The page asks the passkey for its PRF output on a fixed salt (`SHA-256("combray/prf-salt/v1")`), derives a wrapping key from it with HKDF (`combray/personal-key-wrap/v1`), and encrypts the master secret with AES-256-GCM, binding the researcher id and the credential id. The server stores the result per passkey and returns it only in the answer to a successful passkey sign-in. The PRF output itself never leaves the browser: the page builds the WebAuthn JSON by hand and sends no client extension results.
- **As the recovery code.** The master secret itself, written in Crockford base32 with a two-character check, in nine groups of six (`7K3M9Q-…`). The page offers it as a file and for printing, and asks the researcher to confirm they saved it before going on. The server never sees it.

Every time the page opens the personal key, it checks the public key it derives against the one on the server, and stops with a warning if they differ.

**Several passkeys.** A researcher can add passkeys (up to ten), for example a phone and a laptop. Each holds its own locked copy. The last one cannot be removed.

**Losing the passkey.** Sign in by email, choose "I lost my passkey", and enter the recovery code (or open the file). The server checks the recovery sign-in secret (rate limited: five tries an hour), the page derives the personal key, checks it against the server's public key, and asks for a new passkey.

**Losing both.** After the email code, "I lost my recovery code too" lets the researcher **start over**: the server removes their personal key, passkeys, sessions and copies of project keys, and mails them that it happened. They set up a new passkey and key, and a colleague on each project gives them access again, after comparing key codes. The server refuses while the researcher is the only member with access to a project, and names those projects: starting over would leave nobody able to open their donations. For that case the operator can still run `combray-server researcher reset-key <email>`, knowing the project's existing donations cannot be opened by anyone again: that is the price of a server that cannot open them.

Someone who gets into a researcher's email can start over on their account too. That locks the researcher out until they start over themselves, but gives the intruder nothing: a colleague only gives access after comparing key codes with the real person, and the mail warns the researcher.

### Which passkey to use

We recommend a **synced passkey**: iCloud Keychain on Apple devices, Google Password Manager on Android and Chrome, or a password manager such as 1Password. It survives a lost phone and works on the researcher's other devices. A phone can also be used from a computer through the QR code the browser shows ("use a phone or tablet"). A hardware security key works, but is a single device: keep the recovery code safe.

Not every passkey supports PRF. When one does not, the page says so during setup, and the researcher unlocks with the recovery code each time instead. See [PRF support](#prf-support).

## The project key

A project has one X-Wing key pair. The first member to open the project on the key page creates it. The page:

1. creates the seed, derives the public key and its **fingerprint** (base64url of the first 16 bytes of `SHA-256("combray/key-fingerprint/v1\0" || public key)`);
2. seals the seed to its own personal key with HPKE (`info = "combray/project-key/v1" \0 project \0 researcher`);
3. sends the public key, fingerprint and sealed copy to the server.

The server publishes the public key and fingerprint in the project config (`GET /api/v1/p/{id}/config`, field `donation_key`). Participants' browsers seal donation keys to it.

**The participant link pins the key.** The key page shows the link to give participants: `https://combray…/p/{project}/#k=<fingerprint>`. The donate screen checks that the config's key has this fingerprint before sealing anything (and remembers it on the participant's device for later visits), so a server that swaps the project key is caught by every participant who arrived through the researcher's link. This stands in for signed configs during the pilot.

### Giving a colleague access

1. A member adds the colleague's email on the key page. The server creates the account if needed and mails an invitation.
2. The colleague signs in and sets up their personal key. Their key page shows their **key code**: 80 bits of `SHA-256("combray/key-code/v1\0" || public key)`, in four groups of four (`K7Q2-…`).
3. The member clicks "Give access". Their page shows the code it computes from the public key the server returned, and asks them to compare it with the colleague, by phone or in person.
4. Only if the codes match, the member's page opens the project key and seals a copy to the colleague's public key.

The code comparison is what keeps a server from slipping in its own public key under the colleague's name. It is the one step we ask researchers to take on trust in each other rather than in the server.

**Removing a member** deletes their sealed copy and their access to the API. It cannot take back what they saw or saved while they had access. The last member with access cannot be removed.

## Opening donations

"Open and download" on the key page:

1. lists the project's donations and withdrawals;
2. fetches the sealed donation keys in batches, opens each with the project key, and downloads and opens each envelope ([key-design.md](key-design.md#5-analysing-fetch-on-use));
3. fetches the name map of the project's newest published version, and places every value under its names by the value's raw path ([ADR 0015](decisions/0015-raw-paths-and-relational-export.md));
4. drops the sealed keys, and offers one zip with one CSV per platform and table (`{platform}-{table}.csv`: `.donation`, `.day`, `.version`, the row's `.id` and the `.{table}_id` of every row it is in, then a column per field), `donations.csv` with each donation's day, the project version it was made with and the participant's language, `values.csv` with every value and the path where it was in the participant's files, `fields.csv` with how each field was read per version, CSVs of answers, questions and consent, and the full JSON.

Two options, both off by default: **include deprecated paths** puts values at paths the newest version no longer matches in `values.csv`, under the names they were donated with and marked; **include original names** adds the table and field each value was donated as to `values.csv`. Values are never converted again: a field whose reading changed between versions holds both readings in one column, and `.version` with `fields.csv` say which.

Nothing is stored by the page. Values a spreadsheet would run as a formula (starting with `=`, `+`, `-`, `@`, tab or carriage return) get a leading apostrophe. Saved files are the researcher's responsibility under the GDPR, and the page says so.

Researchers can withdraw a donation for a participant by its id. The server then deletes the sealed key and the envelope, and keeps a tombstone.

## Donations on the server

| What | Where | Backups |
| --- | --- | --- |
| Envelopes | `data/donations/{project}/{id}` | As long as the institution likes (ciphertext only) |
| Donation index and tombstones | The main database (`COMBRAY_DB`) | With the envelopes |
| Sealed donation keys | `COMBRAY_DONATION_KEYS_DB`, its own file and volume, `secure_delete` | Short retention, matching the withdrawal promise |
| Accounts, passkeys, sealed project keys | The main database (`COMBRAY_DB`) | Regular |

A donation is one request: `u32 length | sealed donation key (JSON) | envelope`. The server checks that the envelope header names this project, a fresh random id, and the project key's fingerprint, stores the envelope and the key apart, and returns a withdrawal token. On start it re-applies every tombstone to the key database, so restoring an old key backup cannot bring a withdrawn donation back. The envelope format is in [security.md](security.md#donation-envelope).

## PRF support

PRF is what lets a passkey hold the key. Support has grown quickly; as of late 2026 (from the [Corbado PRF overview](https://www.corbado.com/blog/passkeys-prf-webauthn), August 2026, and the browsers' release notes):

| Where | PRF on this device | Phone by QR code (hybrid) |
| --- | --- | --- |
| macOS 15+, Safari 18+, Chrome 132+, Firefox 139+ (iCloud Keychain) | Yes | Yes |
| iOS / iPadOS 18.4+ (all browsers use WebKit) | Yes | Yes (18.0 to 18.3 had bugs) |
| Android, Chrome or Samsung Internet (Google Password Manager) | Yes | Yes |
| Android, Firefox 149+ | Yes | Not measured |
| Windows 11 with the February 2026 update, Chrome/Edge 147+, Firefox 148+ | Yes (Windows Hello) | Yes |
| Windows 11 before that update | No (Windows Hello) | Yes |
| Windows 10 | No | No |
| 1Password, Proton Pass, Keeper, Enpass | Yes | — |
| Bitwarden | Partly | — |
| Dashlane, NordPass | No | — |
| Microsoft Password Manager | Create only, then fails | — |
| Samsung Pass | Only from the second use | — |
| Security keys with `hmac-secret` | Yes (some Safari bugs before 26.4) | — |

What this means in practice:

- **The phone QR flow works** when the phone's passkey supports PRF (any recent iPhone or Android phone with the built-in password manager), and the computer runs macOS, Linux, ChromeOS or Windows 11. It is the recommended path for a researcher whose computer has no passkey of its own, for example older Windows Hello.
- **PRF at creation is not always returned.** Some providers only give the PRF output when the passkey is used, not when it is made. The page handles this: if the passkey says it supports PRF but returned nothing, it asks for "one more touch" to lock the key.
- **No PRF at all** (Windows 10, Dashlane, NordPass): the page explains that this passkey can sign in but not hold the key, and the researcher unlocks with the recovery code each time. It works, but the code is then used often, so they should prefer another passkey.

We test the flow in CI with Chromium's virtual authenticator (`apps/keys/test/e2e.test.ts`). The QR flow cannot be automated; before the pilot, test it by hand with the checklist below.

### Manual test checklist (before the pilot)

For each researcher setup in the pilot, and at least: a Mac with Safari, a Windows 11 laptop with Chrome using an iPhone by QR code, and an Android phone on its own.

1. Sign in by email; create a passkey. Note whether the page asked for one more touch, and whether it said the passkey cannot hold the key.
2. Save the recovery code; continue. Note the key code.
3. Reload; unlock with the passkey. The project list appears without the recovery code.
4. Lock; unlock again by QR code from the phone (on a computer).
5. On a second device, sign in by email and unlock with the same synced passkey.
6. Sign in by email in a private window and use "I lost my passkey" with the recovery code; add a new passkey.
7. With a test project: create the project key, seal a synthetic donation (`pnpm synthetic-donation`), open and download it.
8. Give a second researcher access after comparing key codes; they open the same donation.

Write down browser, OS and passkey provider for each run, with the result, in the pilot log.

## Limits

- **The server serves the page.** A server that turns malicious could serve a page that leaks keys while a researcher uses it. The hash-pinned single file, the release hash, and the separate origin make this a visible, active attack rather than a quiet one, but they do not rule it out. The same holds for every web-based end-to-end encrypted service.
- **Key codes need a second channel.** If researchers skip the comparison, a malicious server could get a copy of the project key.
- **The recovery code is the key.** Anyone with it and the researcher's email can open their keys. It belongs in a safe place, not in the same password manager as the passkey if that manager could be lost with it.
- **No config signing yet.** The `#k=` fingerprint protects participants who use the researcher's link; someone who opens the project's address without it trusts the server's config.
- **The R and Python packages** ([key-design.md](key-design.md#researcher-tools-sketched)) cannot use a passkey. They will need their own way to get the personal key (for example a device key added from the key page); this is open.
