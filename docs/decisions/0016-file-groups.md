# ADR 0016: File groups: files first, then their contents

- **Status:** accepted
- **Date:** 2026-11-08
- **Amends:** [ADR 0012](0012-names-and-matches.md) (files are no longer nodes of the extractor), [ADR 0015](0015-raw-paths-and-relational-export.md) (the name map matches files through groups); replaces step 1 of [the matching robustness plan](../plans/2026-11-05-matching-robustness.md)
- **Discussion:** the thread "Split extractor editor into files and contents" (2026-11-08)

## Context

The extractor was one tree from the upload's root down: folders, files and the keys inside the files, all nodes of the same kind. That made common work hard.

- **The same content under different names** (`watch-history.json` and `kijkgeschiedenis.json`, or the JSON and the HTML export of a history) had to be combined node by node, folder by folder, and the folders around them differ by language too.
- **A file that moved** to another folder in a newer export was a new path, and nothing in the tree said it was the same file.
- **The tree was long.** A Takeout has dozens of folders and files; the few a study wants sat deep inside them, next to many it does not.

Researchers think of an export as files first ("the watch history, the searches") and what is in them second.

## Decision

1. **Two steps.** The extractor is edited in two steps: **files** (which files of a package are read) and **contents** (what is taken from them). The files step looks like a file browser on purpose, so it is not mistaken for the contents.
2. **File groups.** The root of a configuration holds file groups. A group has a name and the files it reads; the files of one group hold the same content. A group's content is one tree, the union of its files: the files' roots are one position, whatever they are called. Files of different kinds (a JSON list and an HTML page) are two branches of that tree, and their tables join by being given the same name (ADR 0012).
3. **How a group finds its files.**
   - **By exact path** (folders and name, each step a match), the default. Files in different folders can be in one group.
   - **By name in any folder**, for files that move between exports. Only for names that occur once in the seen packages: the studio refuses it otherwise, with the reason.
   - **By a name pattern** (`message_*.json`), for exports split into parts.
   - The upload itself, when it is one file (TikTok's JSON), is the path `[]`. Platforms whose packages are one file have no files step: their file is read by the group `export`.
4. **A file is read by one group.** Exact paths are tried first, in the order of the groups, then names in any folder. **A name found in more than one folder of one package reads none of them**: which one was meant cannot be told, and guessing could read the wrong data. The studio marks such names.
5. **Only files a group reads are opened**, on the participant's device as in the studio. Files no group reads are never parsed, shown or kept, and new files next to known ones are not read either: a study reads what the researcher picked. (This replaces the folder settings `newChildren`, `ignore` and `required` on folders, which are dropped.) A group can be required: an upload then fits only when it has one of the group's files.
6. **A single file picked on its own** is read when a group finds it by name in any folder. Exact paths need the folders, so a lone file never fits them.
7. **Raw paths do not change.** Groups decide which files are read, never what a value's path is: donations still carry the path of real keys from the upload's root (ADR 0015). The name map (`combray-names/2`) gives groups their file matches (`g`), with exact paths before names, so the key page places a value whichever folder its file was in. Group names organise the studio only: they are never exported, and tables keep their own names.
8. **No combining folders.** Folders are not nodes any more, so there is nothing to combine; files are joined by putting them in one group.
9. **Copy settings between groups.** Groups whose files are built the same way (the `MyActivity.json` of two Google products) can copy the content settings of another group. The files each reads stay its own.
10. **Suggestions.** A seen file that no group reads, and that looks like the files of a group by its content (or, at a discount, by its name), is marked with that group ("looks like watch_history"). The researcher decides.

## File formats

- **Importer files** are `combray-importer@3`. Version 2 files are upgraded when read: every file becomes a group with the paths of its folders (each combination of the folders' matches, at most 64), and files with the same table name and a different kind (a JSON and an HTML history) share a group. Folder settings are dropped. Packs are migrated.
- **Name maps** are `combray-names/2`; the key page still reads `combray-names/1`.

## Consequences

- A Takeout extractor is a short list of groups (`watch_history`, `searches`, `subscriptions`) instead of a deep tree, and translated or moved files are handled where they are seen: in the files step.
- What is read is narrower and easier to explain: the files the researcher picked, and nothing else. A participant whose export has a file the study does not know does not share or see it, also when undecided parts are shown.
- The key page's matcher grows by one rule (file groups), and its tests cover exact paths before names. See [security.md](../security.md#the-key-page).
- Near matches inside files (step 2 of the matching robustness plan) are still open; step 1 (files that moved) is this ADR's "any folder".
