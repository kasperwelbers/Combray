# Vision and use cases

## The problem

Data donation tools have mostly been built for quantitative, survey-style research: a participant receives a link, uploads a takeout file, a script extracts a few variables, and the participant clicks "donate". That design optimises for speed, scale and remote use. It treats the participant's own view of the data as a hurdle (a consent screen) rather than as the research instrument.

A growing body of qualitative work uses digital traces differently: as prompts in interviews, as material for participants to reflect on, as a kind of externalised diary. Researchers sit next to participants, scroll through years of YouTube history together, and ask "what was going on in your life here?". Today they do that with spreadsheets, screenshots, or tools that were never designed for it. Specifically:

- The data is often unreadable as delivered. A TikTok export lists usernames and video links, not faces or titles. Without enrichment, a participant cannot recognise their own history, and enrichment takes time.
- Existing tools assume a table. Takeout files are nested, and forcing them into a flat table early throws away context that matters in a conversation.
- Existing tools are built around the donation step, so exploration is shallow.
- Lab sessions happen on shared computers, so locally stored data needs better protection than "it is in the browser".

## What Combray is

Combray is a tool for **presenting a person's digital traces back to them**, in a supported setting, so they can explore, remember and reflect, and then decide what, if anything, to share.

The name comes from the fictional village in Proust's *In Search of Lost Time*. The narrator tastes a madeleine dipped in tea and the whole of Combray rises up from memory. Digital traces can work the same way: one old search query can bring back a whole period of someone's life. Combray should feel like a place you visit, not a form you fill in.

## Primary users

1. **Participants.** Not necessarily technical. Usually sitting in a lab or interview room with a researcher or research assistant. May come back for several sessions.
2. **Lab staff and interviewers.** Guide the session, help with downloads, and use visualisations as interview prompts. Need a "facilitator" view that is quick to operate.
3. **Researchers.** Configure studies, write or pick importers, choose visualisations and questions, and receive encrypted donations.
4. **Importer authors.** Often the same researchers. Need an easy way to describe how to read a new or changed DDP format.
5. **IT and research support.** Deploy Combray on a laptop or university VM. Need it to be boring to install and easy to audit.

## Research scenarios

**Memory elicitation interview.** A participant loads their YouTube and Google search history. The interviewer opens a timeline, picks a dense month from three years ago and asks what happened then. Enriched thumbnails help the participant recognise videos. The participant flags a few items as meaningful and adds a spoken or typed note. At the end they donate the flagged items and notes, but not the rest.

**Self-analysis as diary.** Over four weekly sessions, participants look at their TikTok watch history for the past week, answer reflection prompts ("which of these did you not choose to see?"), and annotate. The data persists encrypted between sessions on the lab machine, or in an encrypted remote store, and can only be unlocked after logging in.

**Enrichment-dependent study.** A study wants participants to talk about the creators they watch. The raw export contains only usernames. The participant consents to sending "the 50 TikTok profiles you watched most" to the server, which fetches profile names and avatars. Everything else stays local.

**Classic donation, done gently.** A study just wants a few variables from many participants, remotely. Combray supports this too (browser-only mode, short flow), but it is not the design centre.

## Guiding principles

1. **Show first, ask second, donate last.** The interface is built around exploring and reflecting. Donation is an explicit, separate, reviewable step.
2. **The participant is in control.** They see exactly what will leave the device, can remove items, and can stop at any time. Nothing leaves without explicit, specific consent.
3. **Least data, least trust.** The server does as little as possible and sees as little as possible. Donations are end-to-end encrypted to the researcher.
4. **Local first, browser capable.** Everything should work on one laptop without internet (except enrichment and AI features that need it). The same client also runs on the web.
5. **Trees before tables.** Keep the structure of the data until a specific view needs it flattened.
6. **Easy for researchers.** Writing an importer for a new DDP should take minutes, not days. Deploying should take one command.
7. **Warm and calm.** The design is comforting and unhurried. No dark patterns, no gamified pressure to donate.
8. **Open and auditable.** Open source, small dependency surface, reproducible builds, documented crypto.

## Non-goals (for now)

- Large-scale panel infrastructure (participant recruitment, payments, quotas). Combray should integrate with survey tools via return URLs and IDs, not replace them.
- Live data collection via browser extensions or platform APIs. Combray works with downloaded packages.
- A native desktop app built with Electron. The local experience is a small server plus a browser.
- Server-side analysis of donated data. Researchers decrypt and analyse with their own tools; Combray provides export helpers.

## Open questions

- How should the facilitator view work: same screen, second screen, or a separate device that controls the participant's screen?
- Should audio notes (participant speaking about an item) be a first-class annotation type? This affects storage size and consent.
- How much of the classic remote donation flow do we keep supporting, given limited development time?
