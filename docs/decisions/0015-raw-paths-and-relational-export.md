# ADR 0015: Raw paths, names on export, relational tables

- **Status:** accepted
- **Date:** 2026-11-08
- **Amends:** [ADR 0012](0012-names-and-matches.md) (point 8, what a donation holds), [ADR 0013](0013-names-labels-versions.md) (points 12, 14 and 15: no rematching, names freeze, renames are breaking)
- **Discussion:** the thread "Decide on relational tables from raw paths" (2026-11-08)

## Context

Donations were already a long list of values, each with the path of real keys it was found at, the table and field it was matched to, and its value (ADR 0012). Each donation records the project version it was made with and is never changed (ADR 0013). Three problems remained.

- **Names were stuck in the donation.** A rename after publishing made earlier and later donations disagree, so names froze on first publish and every rename sat behind a "breaking" warning. Researchers were told to align versions by hand, in R.
- **Paths were not stable.** The path of a value depended on the configuration: keys under a node marked "keys are data" were written by position (`{3}`), and as the key otherwise. HTML elements were written by their tag only, so two siblings with the same tag shared a path, and a single element where other files have a list got no path at all. Keys that look like data (an email address used as a key) went into paths as they were.
- **Tables were nested.** A table inside a table came out as a count in the parent's row, and lists of plain values as JSON in a cell. That is hard to analyse and hard to join.

## Decision

### The donation is fixed, the names are not

1. **Extraction is fixed when someone donates.** Which values are donated and how they are read (Read as, date formats, cleaning) is decided by the version the participant donated with, and never computed again. Not even when the raw value is in the donation: the key page stays small, fast and easy to check.
2. **Every value carries its raw path**: the keys from the upload's root, with a position for every list item (`[3]`) and every key that is data (`{3}`). Together with the platform, the path says where the value is, whatever the configuration called it. A donation also carries the names it was made with, and its version.
3. **Names are matched on export.** The key page reads each value's path against the **name map** of the newest published version, and exports it under the names that map gives. A rename, combining, splitting or giving the same name now changes the names of every donation, earlier ones included.
4. **Deprecated paths.** A path the newest name map no longer matches is *deprecated*. The export leaves deprecated values out by default; with "include deprecated paths" they come along in the long list, under the names they were donated with, marked as deprecated.
5. **Original names.** With "include original names" the long list also gives, for every value, the table and field it was donated as.

### Stable paths

6. **A path step is the key as screened in shapes** (`screenName`: keys that look like data become markers, never the data itself). An HTML element's step is its shape name (`div.content-cell`), never just its tag.
7. **A single element where the project expects a list** (HTML, where one row in one file is a list of many in another) gets the item step `[0]`, so it has the same path as the first item of a list. Name maps also read a path without that step as the list's only item, so donations made before the list was known still match.
8. **Keys that are data** are written by position (`{3}`) wherever the version says the keys are data, and as the (screened) key elsewhere. Switching "keys are data" on or off, or marking texts as names, changes the paths of new donations: earlier values at the old paths become deprecated, and the publish card says so.

### Rows and relations

9. **Lists are tables.** Every list of objects or maps, and every map whose keys are data, is a table, as before. **Objects stay columns** of the row they are in: they are one to one with it.
10. **Lists of plain values become their own table** in the export: `{table}_{field}` (`tweets_hashtags`), with one column named after the field. Participants keep seeing them as a list in a cell.
11. **Side by side.** A researcher can read an object whose children are lists as one table, the lists side by side (`engagement` with `liked_by` and `shared_by`): row *i* holds item *i* of each list. Lists of different lengths leave the rest of the row empty; nothing is repeated. This changes only how the rows are grouped, never the paths. By default each list is a table of its own.
12. **Every row is known by its path.** The export numbers the rows of each table per donation (`.id`), and gives every row the id of the row it is in, for every table up (`.tweets_id`). Tables with the same name from different places in the files are one table, their rows apart.
13. **Table names stay flat**, unique per platform (`tweet_comments`, not `tweets.comments`). The name is the id and the path holds the structure; the parent ids in the export show the structure where it is analysed.
14. **Donated tables need a real name.** A table may keep the name its key or file gives, but while a donated table is called by HTML structure (`div_mdl_cell`) or a position, publishing is refused.

### Donating

15. **The donation is built fresh at donate time.** Left-out rows are dropped, and the positions in the remaining paths are numbered again without gaps, in their original order. A gap would show how many rows a participant left out, and where.
16. **The payload is compact**: a dictionary of paths (each with the platform, its names when donated and how its rows are grouped), then every value as a reference into it with its positions, and the whole payload gzipped before it is sealed (`combray-donation/2`).
17. **Order is kept.** Positions are never shuffled: order is often the data (a history, a ranking, replies).

### Uploads, left-out rows and annotations

18. **One upload per platform.** An upload can be several files picked together (a Takeout split into parts); a new upload for a platform replaces the old one.
19. **Annotations and left-out rows never use positions.** A row the participant leaves out is kept as a hash of its raw values with the general path of its table (positions written `[*]`), so it stays out after a new upload or a new version. A search the participant leaves out ("rows with bob") is kept as a rule: the table and the text, matched on raw and read values alike, case-insensitively. Both live in the encrypted local store, are applied before a donation is built, and can be undone on the review screen.

### Changes after publishing

20. **The publish card** (ADR 0013 point 15) calls a rename **safe**: earlier donations follow. **Breaking** are only changes in how values are read; earlier donations keep their reading, and their version says which. A donated path the new version no longer matches is listed as **deprecated**. Names no longer freeze on first publish.

## Consequences

- Researchers can fix names whenever they like; the export always uses the newest ones, and says which version each value was read with.
- The key page gains a small path matcher and the relational export, but no extractor: it never parses files or converts values. The name map is structure only (keys, regular expressions and names), published with the project.
- One column per field: if a version changed how a field is read, its column holds values of both readings, and the `.version` of each row and `fields.csv` (the reading per field and version) say which is which.
- A donation is no longer readable without its dictionary, and older `combray-donation/1` payloads are not read (none exist outside tests).
- Values found in a participant's files at paths the newest version never saw, and that no match covers, come out as deprecated even if an older match caught them.
- If one path is read in two ways (two fields on one value, ADR 0012 point 4), each new field takes the value of the old field with its name, else the first.
- Not done: a value index or in-memory database for large uploads (measure first), and a chart builder that groups across related tables automatically (the parent ids make it possible).
