# Structure reports: knowing which nodes occur together

Status: **designed; the check is built in the studio** (`combineConflicts` in `joins.ts`, see point 5), and the server keeps test packages' structures. Sharing after upload is not built. Point 1 was changed on 2026-11-04 by [ADR 0012](decisions/0012-names-and-matches.md). Agreed with Kasper on 2026-11-01. It replaces the "only new paths" consent flow in [tree-decisions.md](tree-decisions.md#unknown-paths-and-consent) and [security.md](security.md#structure-metadata-and-consent).

## Why

Exports of one platform come in several real structures (format changes, account languages), and every person's export is a partial copy of one of them, because people only have the data they produced. Researchers join variants with [names and matches](tree-decisions.md#names-and-matches). One rule keeps that safe:

> **Two nodes that occur side by side in one export are never the same node.** They must not be combined into one.

To apply it, researchers need to know which nodes occur together. A plain union of shapes (today's `structure.json`) does not say that. Absence proves nothing (a missing branch can be a platform change, a language, or a person without that data), so only full structures, side by side, give the answer. They also give counts: how common each part is.

## The design

1. **Clients get the configuration and the seen structures** (`importer.json` and `structure.json`), so they can tell parts that are new from parts the researcher has seen. The seen structures hold names only, which participants reviewed before sharing them (originally only the published tree went to clients; ADR 0012 changed that).
2. **Right after an upload, the participant is asked to share its structure**: the names of the parts of their data, never the content. Asking right away lets researchers spot platform changes early. In a lab, the researcher can decide on new paths while the participant explores, and later the server can help with automated suggestions.
3. **New names are reviewed.** If the structure contains paths that are not in the seen structures, the prompt lists them for review, because only those can carry something unexpected. Every other name is one the researcher already approved. The text says that the shared structure also shows which known parts they have (such as whether they have uploads). Below a node set to skip new parts (`newChildren: 'skip'`, see [tree-decisions.md](tree-decisions.md#new-parts-ask-or-skip)) new paths are never read, so they are never listed or shared; `compareShape` leaves them out.
4. **The server stores each structure** without any participant id, session or exact time, and keeps one copy of identical structures with a count. New paths are added to `structure.json` as undecided.
5. **The studio refuses to combine nodes that occur side by side** in a stored structure, and suggestions skip them. The researcher's own exports count too. Built for the structures known to the studio (`combineConflicts` in `packages/core/src/joins.ts`): it combines the nodes and checks each structure for a node that matches two keys. Giving the same name is always allowed. Stored participant structures come with the server work.
6. **Before donating, the client refreshes the configuration** (a conditional request with an ETag, so it is cheap when nothing changed), so decisions the researcher made during the session apply.

A participant who has paths the researcher has not decided on yet will be asked to review them again, until the researcher decides. That is accepted: it is one consent step, and it adds evidence.

### Consent text

Roughly, translated through i18n:

> **May we see how your data is organised?** Only the names of the parts, such as "watch history", never what you watched, wrote or searched for. It helps the researchers keep the study working. It does show which kinds of data you have.
>
> These names are new to the researchers. Please check them: `uploads/[*]/visibility`, `history/[*]/time`

Answers: *Yes, share*, *No, these names contain private information* (the refusal is recorded without the names) and *No, for another reason*. Without new names the prompt is the first paragraph only. The client caps the list at around 500 new paths and summarises long lists by file.

## Later, if real data shows we need it

These were discussed and parked:

- Hash ids for paths, ids of paths waiting for review (to stop asking again), and a threshold of *k* reports before publishing them.
- Grouping nodes that always switch together into variants (a whole language at once), and showing how much evidence a "never together" claim rests on.
- Using the shape item of donations as extra structures, after decryption in the key tool.

## Open questions

Richer structure for finding synonyms (Kasper, 2026-11-01). Shapes already carry types and date formats. What more could help researchers, and algorithms, recognise that two names are the same thing?

- **More specific types**, for example a categorical leaf with five answer options, an id, a URL or free text. Without values, this needs statistics computed locally.
- **Leaves with several types** (sometimes a number, sometimes text): keep one leaf with several types, as now, or split them into separate leaves.
- **Local value statistics in the shape**, such as bucketed counts of unique values. This must stay structure only ([CLAUDE.md](../CLAUDE.md) rule 4).
- **Structure from donated data**: after decryption, the key tool or the local part of the studio could compare donations side by side and infer categories.
- **Example values**: set by the researcher, or drawn from the researcher's own exports, never from participants.
