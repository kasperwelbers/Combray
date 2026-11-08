# Plan: exact paths and near matches

Status: **plan, for discussion** (written 2026-11-05 with Kasper). **Update 2026-11-08:** the first step (folders may differ) and the single-file case (rule 8) are replaced by file groups ([ADR 0016](../decisions/0016-file-groups.md)): a group can find a file by its name in any folder, only for names that occur once in the seen packages, and a name found in two folders reads neither. The researcher chooses it per file instead of a switch per platform, and nothing is asked of the participant, since the file is the one the researcher picked. Near matches inside files (the second step) are still open. The rest is not built. Before we decide, we want to see many more real data download packages ([what to look for](#what-to-look-for-in-real-packages)), because the right balance depends on which problems actually happen.

## The question

A researcher marks where the data is: a node in the extractor matches a path in the seen structures. How strictly should a participant's package follow that path?

- **The full path.** Every step from the root of the export must match. This is high precision: data is only taken from places the researcher looked at. But a small change in the package, such as a folder renamed or a file moved one level deeper, means the data is not found.
- **The shortest unique path.** Only as much of the path as is needed to tell the node apart in the seen data: often just its name, sometimes the name and a few parents. This has higher recall and survives moves. But a part with the same name in a new place may hold something else, and the participant would donate data nobody reviewed.

## Two philosophies

Both make sense, and earlier tools chose differently.

| | Exact locations | Resilient extraction |
| --- | --- | --- |
| Principle | We read the package's tree structure and mark the exact locations of the data we need. Nothing else is taken. | Packages change all the time, and every change means lost donations. A human can judge that a `history` key will not suddenly hold something unrelated and more sensitive. |
| Risk | Lost data after a platform change, until the researcher adds a match. | Data taken from a place nobody reviewed. Hard to explain to an ethics board, and results depend on what else is in the package. |
| Who fixes it | The researcher, after structure sharing reports the new place. | Nobody needs to, until the guess is wrong. |
| Used by | Combray today. | Many script-based importers, which look for a file by its name anywhere in the package. |

Combray's design leans on exact locations, for two reasons: the participant consents to what the study asks for, and each published version says exactly what is taken ([ADR 0013](../decisions/0013-names-labels-versions.md#versions)). A runtime rule like "match on the name, and if several match, walk up until one is closest" breaks the second: which data you get would depend on the package itself, and a name that is unique today can stop being unique when new structures arrive.

But we keep the full path and the seen data, and that gives a new angle. **We can tell when a package does not match the full path but does match a unique shorter path, and ask the participant** instead of guessing silently or losing the data.

## What happens today

Paths are matched from the root of the export, and the root is found flexibly ([Finding the export](../tree-decisions.md#finding-the-export-in-an-upload)).

| Case | Today |
| --- | --- |
| The zip, or the folder from the zip | Works. |
| A folder holding only the zip (or wrappers, up to four levels) | Works: single wrappers are stepped into. |
| A bigger folder with the export inside | Works only when the platform has name patterns (`find`) that match the export, such as `Takeout` or `takeout-*.zip`. |
| One file taken out of a folder export (`watch-history.json` from a Takeout) | Does not work. Placing a single file in the tree by its name was dropped on 2026-11-02 to keep things simple. A platform whose export is one file (TikTok) works. |
| A file or table moved, or a folder renamed, in a new version of the export | Not found. The new place shows as a new part, and structure sharing lists it for the researcher. |
| A key renamed inside a file | Not found, the same way. The researcher adds the new key as a match. |
| A new language (`geschiedenis` for `history`) | Not found until the researcher adds a match; regular expressions can cover variants up front. |
| The same key reused for other data | Taken, if the full path is the same. Exact paths do not protect against this either; reading values as a date or a link catches some of it. |

## Proposal: exact matches stay the rule; near matches ask the participant

1. **Only new paths are candidates.** A near match is only ever found at a path that is not in the union of the seen structures. A known path that does not lead to the table is known to hold something else (a table we saw next to ours, the search history next to the watch history), so it is never a candidate, in a file or across files. Clients already get the union of the seen structures ([ADR 0012](../decisions/0012-names-and-matches.md)), so this needs nothing new. Checking which parts occur together per structure version would add little: a known path reused for our table in an entirely new structure is not something versions would catch either.
2. **The distinguishing path.** For each table the study shows or asks for, the studio works out, when it publishes, the shortest end of its path that is unique among the seen paths of the platform: `watch-history.json` when only one file has that name, `YouTube/MyActivity.html` when a Takeout also has `Search/MyActivity.html`, or `browse_history/[*]` inside a file that also has `search_history/[*]`. A near match is a new path (rule 1) that ends with it. It is stored in the published version, so what a version matches does not change when new structures arrive later.
3. **Across folders first, inside files later.** Two steps, to build in this order:
   - **Folders may differ.** The file name and the path inside the file stay exact; only the folders above the file differ. This covers a moved file, extra wrapper folders and a single file taken out of the zip.
   - **Inside a file.** The file stays the same, and the path inside it may differ (a table moved one level deeper in a JSON file, or wrapped in another `div` in an HTML export). This is where similarly built tables are most common, so rules 1 and 4 carry the safety. Real packages should show whether it is needed ([what to look for](#what-to-look-for-in-real-packages)).

4. **The fingerprint.** A file name alone can still hold something else (a `data.json`). So a near match also needs every field that was **always present** in that table in the seen data: the table's fingerprint. "Always" means in every seen structure that has the table, not in every row, since fields that some rows lack are common. The fingerprint is worked out at publish time, stored in the version, and shown on the table in the studio. A table whose fingerprint has fewer than two fields has no clear fingerprint, and gets no near matches; the studio says so. Generic tables (an HTML `div` with a link and a time) are the reason: their fields alone would fit half of every package, which is why only new paths are candidates (rule 1).

The outcome for each table the study shows or asks for:

| Found | Shown | Donated | Structure |
| --- | --- | --- | --- |
| At the exact path | Yes | Yes, as always | |
| At a new path ending with the distinguishing path, with the full fingerprint, at one place only | Yes, marked as found elsewhere | With extra attention (below), unticked at first | |
| Elsewhere, with part of the fingerprint, or at several places | No (participants still see it under "Raw data") | No | The participant is asked to share the structure, and the researcher decides |
| Elsewhere, for a table without a unique path or a clear fingerprint | No | No | Asked, as above |

5. **Participants are asked to look closer.** Participants already see everything they are asked to donate, so the only difference is emphasis. A near-matched table is shown, marked as found in another place. In the review it is set apart: "We found something that looks like your **watch history**, but in a different place than the researchers expected. Please check it before you share it." It is unticked until the participant ticks it.
6. **The donation says so.** Values from a near match keep their raw path (as all values do), and the donation marks the table as near-matched, so researchers can filter or check those rows. The key page adds a column for it.
7. **The researcher closes the gap.** Structure sharing reports the new place. The studio suggests adding it as an exact match for the next version, with one click.
8. **A single file is a near match.** When nothing fits as the root and the upload is one file whose name is a table's whole distinguishing path (so not for `YouTube/MyActivity.html`, which needs its folder), it is read as that table, with the same question to the participant. This brings back the case dropped on 2026-11-02, without a separate mechanism.
9. **A switch per platform**, on by default: "Offer near matches when the package is organised differently." A researcher who wants strict exact locations turns it off.

In short: **we choose precision, and so the protection of participants' data, and when we only find a partial match we say so and ask the participant for help.** Privacy stays as it is: matching runs on the device, nothing new is sent, and the researcher marks the exact locations while the participant approves anything outside them.

Not proposed: similarity scores or fuzzy name matching at runtime, near matches across files, matching individual fields by name anywhere in a package, and rematching old donations. A separate request for the structure of every donated or shown part with each donation was considered (Kasper, 2026-11-05) and left out: donated values already carry their raw paths, shown parts matched exactly by definition, and the structure we lack, of partial and new cases, is asked for in the last two rows above. Note that sharing structure after upload is not built yet, so this would be its first use.

## What to look for in real packages

The choice depends on which failures are common. For each platform, over as many package versions, languages and account types as we can get:

- **Moves**: how often a file or table moves to another folder or depth between versions, keeping its name.
- **Renames**: how often a file or key gets a new name in the same place. Near matches do not help here; matches and regular expressions do.
- **Language variants**: file and key names per account language.
- **Wrapping**: how participants actually upload (the zip, the extracted folder, a parent folder, single files), from pilot sessions.
- **Partial packages**: parts missing because a person has no such data, so that absence is not mistaken for a change.
- **Reused names**: the same name used for different data in different places, the risk near matches carry. Distinguishing paths that end in a generic name (`data.json`, `[*]`) are where this would bite.

A small script can measure this once we have the structures: for each pair of package versions, how many shown or donated tables match exactly, would be near matches, or are lost. Sources are our own packages over time, structures shared by participants, the history of the importer recipes in `data-donation-importers`, and, where available, structures that other data donation projects publish.

## Open questions

- Should a generic file name (`data.json`, `index.html`) need at least one folder in its distinguishing path, even when it is unique in the seen data?
- With few seen structures, the fingerprint is strict (every field is "always present"). Is a minimum of two fields right, or should one of them be a donated field?
- Do HTML exports change inside files more often than folders move? That decides how soon near matches inside a file are worth building.
- Should near matches count for `required` nodes, so that a package with a moved required part still fits?
- Is the participant question clear enough without showing the path? The path is on their device only, so it may be shown to them.
- Should the switch default to on, or should a researcher opt in after seeing a near match reported?
