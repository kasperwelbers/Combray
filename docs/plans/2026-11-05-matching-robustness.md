# Plan: exact paths and near matches

Status: **plan, for discussion** (written 2026-11-05 with Kasper). Nothing here is built. Before we decide, we want to see many more real data download packages ([what to look for](#what-to-look-for-in-real-packages)), because the right balance depends on which problems actually happen.

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

1. **What a near match is.** For each table the study shows or asks for, the studio works out its **distinguishing path** when it publishes: the shortest end of its path that is unique among the seen structures of the platform (`YouTube/history/watch-history.json` → `watch-history.json`, or `activity/[*]` → `Browser/activity/[*]`). It is stored in the published version, so it is fixed per version: what a version matches does not change when new structures arrive later. A near match is a part of a package that is not matched exactly, but whose path ends with a table's distinguishing path.
2. **Tables, not fields.** Near matches are about where a table is. Inside a near-matched table, fields are matched exactly, relative to the table, and at least one donated field must be there. A field renamed inside a table is not guessed; that is what new matches are for.
3. **Never guess between candidates.** If the distinguishing path matches more than one place in a package, or a table is already matched exactly, there is no near match.
4. **Showing is free, donating is asked.** Showing a near-matched table sends nothing, so participants simply see it, marked as found in another place. To donate it, the review shows it separately: "We found something that looks like your **watch history**, but in a different place than the researchers expected. Do you want to share it too?" It is unticked until the participant ticks it.
5. **The donation says so.** Values from a near match keep their raw path (as all values do), and the donation marks the table as near-matched, so researchers can filter or check those rows. The key page adds a column for it.
6. **The researcher closes the gap.** Structure sharing reports the new place. The studio suggests adding it as an exact match for the next version, with one click.
7. **A single file is a near match.** When nothing fits as the root and the upload is one file whose name is a table's distinguishing path, it is read as that table, with the same question to the participant. This brings back the case dropped on 2026-11-02, without a separate mechanism.
8. **A switch per platform**, on by default: "Offer near matches when the package is organised differently." A researcher who wants strict exact locations turns it off.

Privacy stays as it is: matching runs on the device, nothing new is sent, and the principle becomes "the researcher marks the exact locations, and the participant approves anything outside them."

Not proposed: similarity scores or fuzzy name matching at runtime, matching individual fields by name anywhere in a package, and rematching old donations.

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

- How short may a distinguishing path be? A file name alone (`watch-history.json`) seems fine; a generic name (`data.json`, `[*]`, `items`) should probably need at least one parent.
- Should near matches count for `required` nodes, so that a package with a moved required part still fits?
- Is the participant question clear enough without showing the path? The path is on their device only, so it may be shown to them.
- Should the switch default to on, or should a researcher opt in after seeing a near match reported?
