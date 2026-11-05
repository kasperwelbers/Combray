# ADR 0013: Names, labels and versions

- **Status:** accepted
- **Date:** 2026-11-05
- **Amends:** [ADR 0012](0012-names-and-matches.md) (points 2, 6 and 11)
- **Plan:** the "Names, labels and translations" plan, and [plans/2026-11-05-researcher-experience.md](../plans/2026-11-05-researcher-experience.md)

## Context

ADR 0012 gave config nodes a hidden random id and put labels on names. That left three things unclear. Researchers saw a name, but stories, filters and donations referred to something else, so renaming was either invisible or broke things. Labels were the only multilingual text, while the app texts, the story and the consent texts each had their own place, and there was no way to hand all of it to a translator. And a published project changed in place: a donation could not say which extractor it was made with, and participants' stored tables kept the shape of the version they were made with.

## Decision

### Names are ids

1. **The name is the id.** Tables and fields are referred to by their name everywhere: stories, filters, exports, donations and the key page's CSV files. There are no hidden ids (`core/src/names.ts`).
2. **A name** is lowercase letters, digits and underscores, starting with a letter (`watch_history`). Typed text is converted as you type (`Video title` and `videoTitle` become `video_title`).
3. **Only tables and fields have names.** A table is named on the list or file its rows come from, a field on its value. Folders and objects are matched for their settings only.
4. **Names can be inferred.** A table or field without a name of its own is called by the name its key gives, and keeps that name once it is shown or donated (`keepNames`), so a later rename of the key in the data does not rename it.
5. **Shared names**: fields with the same name in one table are one column, tables with the same name in the same table are one table, and elsewhere a name is used once. Parts that share a name are numbered #1, #2 and marked with a coloured bar. When a row has a value for more than one of them, the first gives it.
6. **Renaming** a name others share renames all of them, or only this part. Either way the story follows when asked (`renameInStory`).

### Labels and texts are presentation

7. **Labels** are what participants see, per language, and are never used to find data. Without a label, participants see the platform pack's label, or else the name with spaces (`defaultLabel`).
8. **A project's texts** are kept apart from the extractor: one `texts` part of the draft (`ProjectTexts`) with the project's languages, labels and descriptions per platform, table and field, and the app texts the project words its own way. They are published with the project. Changing them never changes the data.
9. **App texts** inside a study (donating, the lock, explanations) can be worded per project. Texts about privacy and keys can be changed too, and the studio warns that they must stay true.
10. **One file to translate.** Everything participants read (labels, the changed app texts, the story and the consent texts) is exported as one YAML file and read back in. Reading changes only texts. See [translation.md](../translation.md#project-texts).

### Versions

11. **Every published version is kept** as a snapshot on the server (`project_versions`), and the live configuration carries its number. Each donation records the version it was made with, and is never changed.
12. **No rematching.** The key page never rematches old donations against a new extractor: donations keep their raw paths, so donations from different versions can be aligned by hand, in R for example. This keeps the key page small.
13. **Participants follow the live version.** Tables a participant already loaded are derived again from their stored data when the study publishes a new version, so they see what the study now shows.
14. **Names freeze on first publish.** After that, a change that reads the same data in another way sits behind a clear warning.

### Changes after publishing

15. **Publishing lists what changes for donations** from now on (`core/src/versions.ts`), comparing the donated tables and fields of each platform by name:
    - **safe**: more is asked (a field, a table, a platform, another date format to try after the existing ones, a filter taken off);
    - **narrowing**: less is asked (no longer donated, a filter added or changed, a platform removed);
    - **breaking**: the same data under another name, or read in another way, so earlier and later donations differ for the same field.
16. **Several date formats.** A field can have several formats; the first that reads a value wins. Adding one at the end is safe.

## Consequences

- Researchers see the ids they will analyse with, and renaming is an explicit, visible action.
- Inferred names from HTML keys can be ugly (`div_mdl_cell`); researchers rename them.
- ADR 0012's "no versions" no longer holds: donations carry `version`, and old payloads without one are still read.
- The texts can grow large; the server limits their size.
- Translating is a round trip through one file, so an AI or a translator never needs access to the studio.
