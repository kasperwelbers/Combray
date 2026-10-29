# ADR 0005: Projects scope local stores; participant ids and researcher-issued resets

- **Status:** accepted
- **Date:** 2026-10-29
- **Amends:** [ADR 0004](0004-server-held-store-keys.md)

## Context

After ADR 0004, a browser had a single local store, unlocked with one password, and not tied to any study. A Combray server hosts many projects, though, and researchers are responsible for the participants in their own project. Participants who forget their password also need a way back that does not lose their data. The predecessor had two modes: anonymous use of the site, and links with a participant id.

## Decision

1. **Every store belongs to one project.** The participant URL is `/{project}/`. Each project gets its own IndexedDB database on the device, and its own server record and KEK. The page at `/` lists the projects that have a store on this device, read locally.
2. **Projects choose how participants are identified:** `anonymous`, `optional` or `required`. Ids come from the link's fragment (`#id=…`), and the server checks them against an optional pattern from the project config, which is never sent to clients.
3. **Researchers can issue one-time reset links** for a participant id in their project, after verifying the person. A reset replaces the password hash and keeps the KEK, so the participant's data opens again on their own device. Anonymous stores cannot be reset.
4. **No email or phone identity for now.** Participant ids from researchers are the only identity.

Details and reasoning are in [security.md](../security.md#projects-and-participants).

## Consequences

- A forgotten password only affects one project, and participants with an id can recover.
- Whoever can create reset links for a project can set a new password for a participant's store. They still need that participant's device to read anything, but on a shared lab computer they have it. Studies that must rule this out use anonymous mode.
- Until researcher accounts exist, reset links are created with a server command by the operator.
- The server stores participant ids (pseudonyms) with store records.
