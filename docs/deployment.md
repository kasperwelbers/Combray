# Deployment

Combray has three parts (see [architecture.md](architecture.md)): the **web client** with the researcher studio, the **key page** where researchers hold their keys, and a shared **server** that serves both. The intended setup is that a university runs one server, and any researcher, with no programming experience, uses it from the browser.

## Targets

| Target | How | Who |
| --- | --- | --- |
| **University server** | `docker compose up -d` on a VM, TLS through Caddy | University IT or research support, once, for all researchers |
| **Researchers** | A browser and a passkey (phone, laptop or security key) | Every researcher; nothing to install |
| **Lab or institute server** | The same `docker compose up -d` on a small VM or host | A lab or institute without a shared university server |

Combray is server first ([ADR 0011](decisions/0011-server-first.md)): there is no offline or laptop mode. Running it on your own machine is for development ([below](#development)).

## Pilot checklist

For a first, small study on one VM. Each step is explained below.

1. **Two host names** pointing at the VM: the Combray name and the same with `keys.` in front, for example `combray.uni.nl` and `keys.combray.uni.nl`. The key page must have its own name: passkeys are bound to it, and it keeps keys away from the larger participant app ([researcher-keys.md](researcher-keys.md#two-addresses)). If IT cannot give you `keys.` under the Combray name, use another name and set `COMBRAY_KEYS_URL`.
2. **An SMTP account** that may send from an address at the university, for researcher sign-in codes.
3. **Docker** with compose on the VM, ports 80 and 443 open.
4. In `deploy/`: create `secrets/store-master.key`, the data folders and `.env` ([below](#docker-compose)).
5. `docker compose up -d`, then check `https://combray.uni.nl/api/v1/health` and `https://keys.combray.uni.nl/`.
6. **Check the key page** against the release: `curl -s https://keys.combray.uni.nl/ | sha256sum` must match `combray-keys.html.sha256` of the release you deployed.
7. **Add the researchers.** They create their projects themselves in the studio; or put a first researcher on a project you create or import:
   ```sh
   docker compose run --rm combray researcher add ada@uni.nl
   docker compose run --rm combray project create willow "Willow diary study"
   docker compose run --rm combray project add-researcher willow ada@uni.nl
   ```
8. The researcher signs in at `https://keys.combray.uni.nl/`, sets up a passkey, saves the recovery code and creates the project key. The key page then shows the **participant link** (`https://combray.uni.nl/p/willow/#k=…`). Use that link, with its `#k=` part, in invitations and on printed cards.
9. Colleagues: the first researcher adds them on the key page and gives them access after comparing key codes.
10. **Backups**: `combray-data` and `secrets/store-master.key` separately, and `combray-donation-keys` with retention no longer than `COMBRAY_KEY_BACKUP_RETENTION_DAYS` ([below](#backups)).
11. **Run the manual passkey test** ([researcher-keys.md](researcher-keys.md#manual-test-checklist-before-the-pilot)) with the devices your researchers will use, and a synthetic donation: `node apps/keys/scripts/run.mjs synthetic-donation https://combray.uni.nl willow` from a checkout of the repository.

## Docker compose

The stack in `deploy/` has two services: `combray` (the server image: the Node server, built web client and key page) and `caddy` (TLS with automatic certificates, HSTS, no access logs). From `deploy/`, once:

```sh
mkdir -p secrets combray-data combray-donation-keys && cp -r examples/projects combray-data/
head -c 32 /dev/urandom > secrets/store-master.key && chmod 600 secrets/store-master.key
cp env.example .env   # set COMBRAY_DOMAIN and the mail settings
docker compose up -d
```

The Caddyfile serves `{$COMBRAY_DOMAIN}` and `keys.{$COMBRAY_DOMAIN}` and passes both to the server, which tells them apart by the `Host` header and refuses any other name. Without `COMBRAY_DOMAIN`, Caddy serves `https://localhost` and `https://keys.localhost` with a local certificate.

The server container runs as a non-root user, with a read-only root filesystem, all capabilities dropped and `no-new-privileges`. The store master key comes in as a Docker secret.

### Settings

| Variable | Default | What it does |
| --- | --- | --- |
| `COMBRAY_PUBLIC_URL` | (none) | The participant app and studio, e.g. `https://combray.uni.nl` |
| `COMBRAY_KEYS_URL` | `keys.` in front of the public host | The key page, e.g. `https://keys.combray.uni.nl`. Set it only for another name, such as `https://combray-keys.uni.nl`; it must be a different host name, not just another port. Researcher sign-in and donations are on when `COMBRAY_PUBLIC_URL` is set. Requests for any other host name then get `421` (the health check answers on any name) |
| `COMBRAY_SMTP_URL` | (none) | `smtps://user:password@host:465`, or `smtp://user:password@host:587?tls=required` for STARTTLS |
| `COMBRAY_MAIL_FROM` | (none) | `Combray <combray@uni.nl>` |
| `COMBRAY_MAIL_OUTBOX` | (none) | Development only: write mails to this folder instead of sending them |
| `COMBRAY_DB` | `{data}/combray.sqlite` | The main database: store key records, researchers, passkeys, sessions, members, sealed project keys, the donation index |
| `COMBRAY_DONATION_KEYS_DB` | `{data}/donation-keys.sqlite` | Sealed donation keys; in compose, on its own volume |
| `COMBRAY_STUDIO_IDLE_SECS` | `3600` | A studio session ends after this long without activity |
| `COMBRAY_STUDIO_MAX_SECS` | `43200` | and at most this long after the passkey sign-in |
| `COMBRAY_KEY_BACKUP_RETENTION_DAYS` | `30` | Told to participants as the time within which a withdrawal is complete |
| `COMBRAY_MAX_DONATION_MB` | `64` | Largest donation the server accepts |
| `COMBRAY_KEYS_PAGE` | `/app/keys/index.html` in the image | The built key page. The server reads it at start; restart after replacing it |
| `COMBRAY_CLIENT_IP_HEADER` | (none) | `x-forwarded-for` behind Caddy, used only for rate limits |

Without mail settings, the server starts, but researchers cannot sign in; it logs a warning.

## The server's data

```
combray-data/
├── combray.sqlite        the main database: store key records (no keys without the store master
│                         key), researchers, passkeys, members, sealed project keys, donation index
├── donations/{project}/  encrypted donation envelopes
combray-donation-keys/
└── donation-keys.sqlite  sealed donation keys (its own volume)
secrets/
└── store-master.key      32 random bytes; every store key is derived from it
```

The server creates both databases on first start and applies pending migrations (`apps/server/drizzle/`) whenever it starts, so upgrading is replacing the image and restarting. Back up first.

Nothing in these folders can be opened by the server: donations and their keys are sealed to project keys, which are sealed to researchers, whose keys are locked under their passkeys. Projects live in the main database: a draft that researchers edit in the studio, and the published version participants get, which a researcher publishes on the key page. A project's platforms (upload points) each carry the project tree that participants' data is read with; a platform can start from a bundled platform pack, such as `google-takeout` or `tiktok` ([tree-decisions.md](tree-decisions.md#upload-points-and-the-nameless-root)).

### Backups

| What | How long | Why |
| --- | --- | --- |
| `combray-data` | As your institution likes | Only ciphertext and metadata |
| `secrets/store-master.key` | Kept apart from `combray-data` | Losing it makes every participant's local store unreadable; together with the data it is what the server needs to release store keys |
| `combray-donation-keys` | **No longer than `COMBRAY_KEY_BACKUP_RETENTION_DAYS`** | A withdrawn donation is gone for good only when no backup holds its key. Participants are told this number |

On start, the server deletes every sealed key that has a withdrawal tombstone, so restoring an old key backup does not bring a withdrawn donation back ([key-design.md](key-design.md#6-withdrawing)).

## Server commands

Run with `docker compose run --rm combray …`:

| Command | What it does |
| --- | --- |
| `researcher add <email>` | Let someone sign in as a researcher |
| `researcher list` | List researchers, and whether they have set up a key |
| `researcher remove <email>` | Remove a researcher, their passkeys, memberships and copies of project keys. Unlike removing a member on the key page, this does not stop at the last member with access: make sure a colleague has access first |
| `researcher reset-key <email>` | For a researcher who lost both passkey and recovery code: removes their key and their copies of project keys, so they can set up a new key and be given access again |
| `project create <project> <name>` | Create a project (researchers can also create projects in the studio) |
| `project import <file.json> […]` | Create or replace projects from config files and publish them, e.g. the examples in `deploy/examples/projects/` |
| `project add-researcher <project> <email>` | Put a researcher on a project, creating the account if needed (members can add colleagues on the key page too) |
| `reset-link <project> <participant-id>` | A one-time password reset link for a participant ([below](#password-reset-links)) |

## Checking what the server serves

The key page is one file, built deterministically, with its script and style pinned by hash in its Content Security Policy. Each release publishes it as `combray-keys.html` with `combray-keys.html.sha256`. To check a server:

```sh
curl -s https://keys.combray.uni.nl/ | sha256sum
```

The hash must match the release. Researchers can do the same, or compare the version in the page footer. See [researcher-keys.md](researcher-keys.md#the-key-page).

## Protecting the host names

Whoever controls the DNS of the key page's name can serve their own key page there, with a valid certificate, and the researchers' passkeys will work on it. The server cannot tell, and no check by the server can: an attacker can serve the real page to anyone who checks. This is true of every web application, and of the main site too. What helps:

- **Protect the DNS and registrar account** as well as the server: two-factor sign-in (a security key if possible), few people with access, and the registrar's transfer lock on.
- **Certificate alerts.** Turn on Certificate Transparency monitoring for the domain (Cloudflare and several other DNS providers offer it, or a service such as Cert Spotter), so you hear when anyone gets a certificate for one of its names.
- **Keep both names in one DNS zone** with one provider, so there is only one account to protect.
- **No names under the key host** (`x.keys.combray.uni.nl`): a page there could use the key page's passkeys. Avoid wildcard records that would cover them.
- **Remove DNS records before the server or address they point at.** A record left pointing at an address someone else later gets lets them serve pages under your name.

Ideas for going further (serving the key page from somewhere the server cannot change, or checking its hash on the way) are in [open-questions.md](open-questions.md).

## Password reset links

Until the researcher UI exists, the operator creates reset links on the researcher's behalf, after the researcher has verified who the participant is:

```sh
docker compose run --rm combray reset-link <project> <participant-id>
```

It prints a one-time link (valid for 72 hours) that the participant opens on the computer that holds their data. See [security.md](security.md#password-reset).

## Development

`pnpm serve` builds the web client and key page and runs the server with the example projects: the app on `http://localhost:8080`, the key page on `http://keys.localhost:8080` (browsers resolve `*.localhost` to the local machine and treat it as secure, so passkeys work). Its settings are in `deploy/dev.env`; databases, the store master key and sign-in mails go to `.dev/`. Sign-in mails (with the code) are written to `.dev/outbox/`, and the pages say so. Add yourself first with `pnpm admin project add-researcher example you@example.org` (`pnpm admin` runs the operator commands of the table above on the development server), and send a synthetic donation with `pnpm synthetic-donation http://localhost:8080 example` (under `pnpm dev`, use `http://localhost:5173`, the main site there). `pnpm e2e` runs the key page end to end with a virtual passkey. For hot reload, use `pnpm dev`: the web client on http://localhost:5173 next to the same server, which then treats :5173 as the main site (`deploy/dev-hot.env`), so studio sign-in works there too.

## Later

- A released image pins the web client and key page, so a deployment runs exactly a released version.
- A multi-arch image on GHCR with each release.
- Institutional sign-in (SURFconext, OIDC) in place of the email code.
- Health metrics (counts and timings only).

## Open questions

- Should the server have a small admin web UI for IT (accounts, quotas, health), or is a CLI enough? Recommendation: CLI first.
- Is S3 needed in v1, or is the filesystem plus regular backups enough for most labs?
