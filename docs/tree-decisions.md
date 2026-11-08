# Tree decisions: importers as filters on the tree

Status: **partly built** (see [Implementation plan](#implementation-plan)). Agreed with Kasper on 2026-10-29. It replaces the table-oriented importer spec ([importer-spec.md](importer-spec.md)) over time. It builds on the tree model and shapes in [universal-importer.md](universal-importer.md) and on the structure-metadata consent flow in [security.md](security.md#structure-metadata-and-consent). Names and matches replaced aliases and merging on 2026-11-04 ([ADR 0012](decisions/0012-names-and-matches.md)): the seen structures are kept apart from the researcher's configuration.

## Idea

Every upload becomes a tree, and **the tree is the data**. An importer does not build a table from it. It filters the tree. The researcher decides per node what happens to it. Tables are inferred from the structure so participants see the data in a readable way, but they are a view, not the import.

The current spec still thinks in tables: it selects a row path and named field paths. That makes researchers learn the path language and HTML structure, and it drops everything the spec does not name. Here the researcher works on a tree of all the structure the project has seen, and every node has a decision.

## The project tree

Each project has one **project tree** per upload point (see [Upload points](#upload-points-and-the-nameless-root)). It is the union of the shapes the project has seen: the researcher's own test exports and the structure metadata participants agreed to send. It holds structure only, never values ([CLAUDE.md](../CLAUDE.md) rule 4). The researcher's settings are a separate **configuration** whose nodes match keys in it ([Names and matches](#names-and-matches)). Participants' clients get both, so they can tell new parts from seen ones (see [structure-versions.md](structure-versions.md)).

Each project owns its own tree. A researcher can export theirs and another project can import it as a starting point, so platform packs become shared project trees rather than a separate format.

### Leaves and inner nodes

A **leaf** is a node that holds a value: a JSON or CSV value, an HTML text position or attribute (after [normalisation](#html)), or a blob. Everything else is an **inner node** (directories, maps, lists, elements).

| On a leaf | Meaning |
| --- | --- |
| `undecided` | The default. Imported, not requested; hidden from participants' processed view unless the tree's root has `undecided: show`. |
| `ignore` | Not imported. |
| `show` | Imported and shown, not requested for donation. |
| `donate` | Imported, shown, and requested for donation. |

| On an inner node | Meaning |
| --- | --- |
| `ignore` | Ignores the node and everything below it. If this overrides decisions on leaves below, the UI warns first. |

Show and donate are possible on leaves only, with one exception: a `{*}` node, whose keys are data (see [Keys that are data](#keys-that-are-data)), has a decision of its own for its keys. An inner node never passes `show` or `donate` down, so new children stay undecided. Its effective state is derived from its leaves:

- **donate** if any leaf below it is donate,
- else **show** if any leaf below it is show or undecided,
- else **ignore**.

Inner nodes are structure: the client keeps them so paths resolve, and shows them only as tables or breadcrumbs.

### Node properties

Besides the decision, a node in the project tree can have:

| Property | On | Purpose |
| --- | --- | --- |
| `match` | any | The keys this node stands for: exact keys and regular expressions. A node that matches several keys is a combined node (see [Names and matches](#names-and-matches)) |
| `name` | tables and fields | The name: the id stories, filters and donations use, shared by every node that has it ([ADR 0013](decisions/0013-names-labels-versions.md)). Without one, the name the key gives. Labels and descriptions participants see are project texts, per language, kept apart from the tree ([translation.md](translation.md#project-texts)) |
| `as`, `format`, `transform` | leaves | Conversion, as in the current field spec, now attached to the node: "Read as" in the researcher UI. `format` can be a list of date formats; the first that reads a value wins. Scripts are not ported yet |
| `role` | leaves | View hint: `date`, `title`, `url`, `group` (replaces `display`) |
| `raw` | donated leaves | Donate the value as it is in the file instead of transformed ([What is donated](#what-is-donated)) |
| `lifter` | inner | A sandboxed script that turns each row subtree into a map ([HTML](#html), layer 3) |
| `filter` | repeated (`[*]`, `{*}`) | Which rows to import: a list of tests on columns (`equals`, `in`, `contains`, `matches`, `empty`, `min`, `max`, each with an optional `not`), all of which must pass. A filter may test a column that is not shown, such as an ignored leaf or the size of a nested table |
| `required` | any | An upload only fits the tree when this node is there, by any of its matches ([Finding the export](#finding-the-export-in-an-upload)) |
| `newChildren` | inner | `ask` (the default) or `skip`: whether parts this node has never seen below it are read, shown and offered for structure sharing. Passed down until a node sets its own ([New parts](#new-parts-ask-or-skip)) |
| `find` | the root | Name patterns for finding the export inside a bigger upload, such as `Takeout` or `watch-history*.json` ([Finding the export](#finding-the-export-in-an-upload)) |
| derived fields, enrichers | table | Planned: fields computed from other columns (`from` + transform or script), and which columns may be enriched |

## Tables

Tables are **inferred from the structure**; researchers do not mark them. (An earlier version of this design had researchers mark table nodes. Kasper dropped that on 2026-10-29: marking a table was really a way of unnesting, and it would still need a choice between longer and wider. Nested data now stays nested.)

1. **A list of objects is a table.** Its items (`[*]`) are the rows. This is the first array above a leaf, which is what the old `rows_selector` pointed at.
2. **Objects in a row are more columns.** Leaves inside an item are cells, however deep they sit in objects: `stats/likes` is a column of the tweets table.
3. **Lists in a row stay nested.** A list of objects inside a row is a **nested table**. A list of plain values (`tags: ["tea", "baking"]`) is a list cell.
4. **Leaves outside any list** (profile information, settings) form a single record.
5. **Column names** are the leaf's label, or else the *shortest unique suffix* of its path from the row: `url` and `timestamp` normally, `h2/url` and `span/url` only when two would collide.
6. **Table names** are the label of the list (or of its items), or else the list's name. A table in an HTML file is named after the file, not after `div.mdl-grid`.

What researchers do is the same as for any node: decide on the leaves, and give tables and columns names. Tables that the same structure produces in several files (a language variant, a renamed file) are combined into one node or given the same name, like any other node.

### Nested tables

Tweets with comments: `tweets` is a table and `tweets/[*]/comments` is a nested table. In the tweets table, the comments column shows the size of each tweet's comments, as rows × columns (`3 × 4`). Choosing it opens the comments table, filtered to that tweet, with a way back. A list cell shows the number of items and opens to show them.

Next to the open table there is a **map of all tables**, nested ones under their parent:

```
tweets        6 × 7
  comments    7 × 3
  reactions  12 × 2
Your data     1 × 2
```

Each nested row keeps a link to its parent row. **Unnesting happens while aggregating, not while importing.** Counting comments per tweet iterates over the tweets and counts each tweet's comment rows. Plotting tweet likes against comment likes iterates over the tweets and then over their comments, repeating the tweet's likes for every comment. This is the unfold described in [visualization.md](visualization.md#trees-and-tables).

### Keys that are data

Sometimes keys are data rather than field names: `"comments": {"bob": "hey", "sarah": "yeah"}`, a diary keyed by date, an inbox keyed by username. Such a map is a table of key and value rows, nested where it sits: the tweets table gets a comments column, and its rows have a `key` and a `value` column.

These maps become `{*}` positions, so the names never reach the structure metadata:

- **Within one map**, the shape extractor already collapses maps whose keys look like data (dates, numbers, emails, ids) or that have many entries with the same structure.
- **Across rows**, the extractor now also looks at maps inside list items. If there are at least 5 different keys across the rows, and no key appears in more than half of the rows that have the map, the keys are data. Optional fields do not trigger this, because the same keys come back in many rows.
- **By hand.** With few rows this cannot be told apart from coincidence, so the researcher UI has a "the keys are data" action on any map or folder. It merges the children into one `{*}` position and drops their names; it does not keep them as matches, because they are data.

The keys themselves can be shown or donated: the `{*}` node has its own decision, separate from the values inside it. Below a `{*}` node, every key matches the one position, so new keys never add paths and are never offered in a consent request.

Set by hand, "the keys are data" is a correction in the configuration (`collapsed`); the seen structures are not edited. They are read through the corrections wherever it matters (`correctedShape` in `corrections.ts`): the structure file a platform saves and publishes leaves the keys out, and on a participant's device a key below a collapsed map compares as `{*}`, so a key nobody has seen is not a new part. Every case of keys that are data, per format, is in [formats/](formats/README.md).

## HTML

In JSON the keys say what a value is. In HTML the structure is positional and the labels are often values themselves: "Gezocht naar", a link and "5 mrt 2024" sit next to each other as text in one `div.content-cell`. The current shape makes this worse. Sibling elements with the same tag and classes merge without a count, so 3000 `div.outer-cell`s look like one, and all `#text` siblings merge into one node.

We handle HTML in three layers. Each produces a tree, so decisions, tables and names work the same afterwards. We start with layers 1 and 2 and look at real exports before deciding how much to automate further.

**Layer 1: normalisation (automatic).** A normalised view on top of the parsed tree. The raw tree is unchanged.

- **Implicit lists.** When an element has two or more children with the same tag and the same set of classes, they become a list, named like the elements (`div.mdl-cell.….outer-cell`). Rows repeat their classes exactly; cells within a row usually differ in one (`mdl-cell--6-col` and `--12-col`), so they stay separate positions.
- **Element names.** Inside list rows, an element keeps only the classes it has at that position in *every* row (positions are matched by tag, first class and order). Classes that vary between rows are dropped, so the same thing stays one node. Ids only count when they are the same in every row.
- **Single or repeated.** An element that is single in one place and repeated in another (one link in a row, or three) is one node in the project tree: the single element counts as the list's only item. The same goes for a JSON key that is `null` in some records and a list or map in others.
- **Positional text.** Text nodes are numbered among their text siblings: `#text[0]`, `#text[1]` (`<br>` already separates them). Each becomes a value with an inferred type, so the shape says "text 1 is date-like".
- **Data attributes.** `href`, `src`, `datetime`, `title`, `alt`, `value` and `content` become values named `@href` and so on. Empty elements (`<br>`, empty cells) are dropped.
- **Semantic HTML.** A `<table>` becomes a list of rows, each a map from column to cell. The header is the `<thead>` row, a first row of only `<th>` cells, or a first row of `<td>` cells that looks like a header: it names every column once in plain words that are not also values in their column, has as many cells as most rows, and has a sign, either set apart (bold cells, or a class no other row has) or words above values of another type in some column (`Date` above dates). Without such signs the first row stays data and columns are named by position: a table without names rather than wrong ones (`firstRowIsHeader` in `normalize.ts`). A column without a label whose name is only structure (positions such as `#cell[0]` and `#text[1]`, attributes such as `@href`, HTML elements) is `unnamed`: tables leave its header cell empty, and leave out the header row when no column has a name (screen readers still hear "Column 2"). Naming such columns automatically, with a classifier, is for later. When the importer cannot tell, the researcher can say so on the table: `headerRow` on its rows (`[*]`) means the first row holds the column names. Participants then see that row's text as the names of the columns without a label, and not as a row; the data keeps the row (the participant client stores it with the table, `DerivedTable.headerRow`), so a donation gives the table as it was. Top-level tables only, for now. A `<dl>` becomes a map from term to description. Header and term text is only used as a key when a node of the project tree matches it (`knownKeys`), because the participant's shape never contains text (see the privacy note below). Otherwise cells are named by position (`#cell[0]`) and a term stays a value next to its description (`#dt[0]`, `#dd[0]`). The researcher UI allows any header text as a key, because researchers work on their own exports; that is how header names get into the project tree.
- **Running text.** Inline elements mixed with text (`Watched <a>video</a> by <a>channel</a>`) are numbered by position (`a[0]`, `a[1]`) instead of becoming a list, so the video and the channel are separate columns.
- **Bare siblings.** Two siblings with the same tag and no classes only become a list when they hold the same kinds of things. Otherwise (a caption `div` and a date `div`) they are positions: `div[0]`, `div[1]`. Elements that are items by nature (`li`, `tr`, `option`, `article`) and three or more alike siblings are always a list.
- **Wrapping links.** A link around a single element, present in some rows and not in others, gives its `@href` to that element, so the element keeps one position.
- **Wrapper folding.** Chains of single-child elements fold into one step in the researcher UI.

After normalisation, Google My Activity is a list of `outer-cell` rows with leaves such as `content-cell…body-1/#text[0]` (string, "Searched for"), `a/@href` (url-like), `a/#text[0]` (the query) and `#text[1]` (date-like). That is an implicit table with typed but unnamed columns, named after the file. Synthetic examples of common export layouts (My Activity, Instagram, Facebook, Snapchat, an account page with a `<dl>`) are in `packages/core/test/html/`.

**Texts that are names (correction).** Where the names of fields are written as text next to their values (a `<span>url</span>` before the link, or a list of labels beside a list of values), the researcher marks the element, or its table, with `textNames` (studio: More › Texts here are names). It is then read as a `<dl>`: each label names the value next to it, with the same rule as headers and terms (a label is a key only when the project knows it; otherwise `#dt[i]` and `#dd[i]`). Whether the texts are pairs or two lists is fixed when the element is marked; rows that do not line up are left as they are. See [formats/html.md](formats/html.md#names-written-as-text) and `corrections.ts`.

**Layer 2: labels from the researcher.** The researcher works on their own export in the researcher UI, so they see the values next to the positions. They label the date-like text `date` and the link `url`. Types do most of the work, since there is usually one date-like and one url-like position per row. Participants only see labels.

**Layer 3: lifters.** For formats that resist (large old Google, Facebook or Instagram HTML exports), a `lifter` on the row node is a QuickJS function from a row subtree to a map, run in the existing sandbox with the same limits as importer scripts. Only the researcher who writes the lifter needs to understand the HTML.

A node with a lifter hides its children from the decision tree. The lifter node itself gets one decision (ignore, show or donate), and every key it outputs is a leaf with that same decision. Its output shape is not stored in the project tree. A researcher who wants only some fields writes the lifter to output only those.

**Privacy note.** Text that is the same in every row ("Producten:", "Gezocht naar") is structure in practice, but it can also be personal, such as a header with an account name. So participant shapes never include text, not even constant text. The client can match constant text locally against the keys and names in the project tree, which come from the researcher's own exports.

Layer 1 needs changes to `extractShape` (counts for repeated siblings, positional text, stable classes) and a normalisation pass in `@combray/core`. The thresholds need tuning on real exports.

## Upload points and the nameless root

A project defines **upload points**, each for one platform: "TikTok", "Google Takeout". Participants get **one uploader per upload point**, and each uploader only matches its own platform's tree. One tree could technically hold several platforms, but we recommend one platform per upload point: the messages to participants name the platform, and matching stays predictable.

- **The upload is a nameless root.** The name of the uploaded file or folder is never recorded or sent, and nothing checks it. `kaspers_tiktok.json` and `mygoogledata/` reveal nothing, and renaming does not create a new tree.
- **There are no file nodes.** Files and folders inside the root are ordinary nodes, matched by their matches like keys inside a file. Paths start at the root: `YouTube and YouTube Music/history/watch-history.json/[*]/title` for a Takeout, or `Activity/Like List/ItemFavoriteList/[*]/Date` for TikTok, whose root is the JSON file itself.
- **The format comes from sniffing the content**, with the extension as a hint, not from the name.
- **Split archives merge.** Google Takeout can come as `takeout-…-001.zip`, `-002.zip`. Picking several archives merges them into one root.
- **Per-user names inside the root** (`messages/inbox/johnsmith_1234/`) go through the existing dictionary collapse and name screening, so they become `inbox/{*}/`.

In the project config, `uploads` lists the upload points. Each names a platform pack (`{"id": "youtube", "pack": "google-takeout", "name": {...}}`), whose project tree the client matches uploads against. Without `uploads`, the YAML importers run as before, on everything that was picked.

This also limits the size of the project tree. Ten participants with ten differently named files produce one tree, and identical structure is stored once because the tree is a union. The client still caps how many new paths it offers to send at once (around 500), and shows a summary instead of a long list when there are many.

## Finding the export in an upload

Agreed with Kasper on 2026-11-02. Participants pick a file, a folder or zips. Usually that is the export itself, but not always: a zip wraps a `Takeout/` folder, someone picks their whole Downloads folder, or (the worst case) their `C:` drive. Matching paths *inside* files alone is too risky: with partial matches, any file that happens to share a path would fit. So the client finds the root in four steps, looking at names before it opens anything.

1. **The upload is the root.** The picked file or folder (or the contents of the picked zips) is tried as the root, without looking at its name.
2. **Wrappers are stepped into.** If the upload holds exactly one entry, that entry is tried too, and so on, up to four levels: `takeout-….zip` › `Takeout/`, or a TikTok zip holding only `user_data_tiktok.json`. A zip found this way is opened. The tree decides which level fits, so a Takeout with only YouTube in it keeps `YouTube and YouTube Music/` as part of the tree instead of being stepped into.
3. **Optionally, the export is looked for inside a bigger upload.** If the upload itself does not fit and the tree's root has `find` patterns, every file, folder or zip in the upload whose name matches a pattern is a candidate, each with its own wrapper levels. Patterns are names with `*` wildcards, compared without regard to case: `Takeout`, `takeout-*.zip`, `user_data*.json`. A pattern must have at least three letters or digits besides an extension, so `*` and `*.json`, which would open every file, are refused. Without patterns there is no search: the upload has to be the export.
4. **The participant chooses when more than one fits.** We never guess silently. Folders can be chosen together (the parts of a split export); a file root is one file. The paths are shown on the device only.

### When does a root fit

A candidate fits the tree when:

- **every required node is there**, by any of its matches, and
- **something the study shows or asks for is there**: a path to a leaf with a `show` or `donate` decision.

A folder is checked on names alone: a file in it must lead, through folders the tree knows, to a file the study uses, and required folders and files must be present. A file root (TikTok's JSON) has no name to check, so it is opened and its structure compared; it must be the same kind as the tree's root (a map, a list, an HTML page). Required nodes inside files are checked once the root is read.

There is no threshold to tune. Researchers who want a stricter match mark more nodes required.

**Required nodes.** `required` is a toggle on any node. A combined node (matching `history` and `geschiedenis`) is satisfied by either key: a Dutch export with only `geschiedenis` still fits. Combining keeps the node required if either side was; taking a match off leaves the setting on the node. Use it for parts every export has. A participant whose export lacks a required part cannot add it, so a required leaf deep inside a list (every export must have at least one row with it) is rarely a good idea.

### Names first, and fixed limits

The order protects the participant:

1. **Only names are listed.** Picked zips are read to list their entries, but nothing is inflated. Zips inside the upload are only opened when they are a wrapper or their name matches a pattern.
2. **Only name matches are opened**, and only to check their structure.
3. **Only the chosen root is read**, and in it only the files the tree wants: files in ignored parts are left out (unless they hold a required node), and so are files the tree does not know below a node that skips new children. The raw bytes kept on the device are those files only, never the rest of the upload.

Combray sets hard limits that researchers cannot change (`UPLOAD_LIMITS` in `locate.ts`):

| Limit | Value | Above it, the participant is told |
| --- | --- | --- |
| Files in an upload, counted by name (archives' contents included) | 100,000 | to pick the export itself |
| Files or folders whose names match a pattern | 10 | to pick the export itself |
| Bytes read: archives opened, files checked, files of the root | 4 GiB | that it is too large, and to make a smaller export if they can |

When nothing fits, the participant is told that this does not look like an export of that platform, and to pick the zip or folder they downloaded. Nothing is stored in any of these cases. The values are first guesses: a full Takeout with photos is larger than 4 GiB, which is one reason the Takeout pack skips products it does not know.

### New parts: ask or skip

`newChildren: 'skip'` on an inner node means parts it has never seen below it (in the seen structures) are **not read, not shown, and not offered** for structure sharing. It is passed down: every node below follows it until one sets `ask` again. Known children are unaffected. The researcher accepts missing renamed or new parts there in return for a smaller, safer upload and shorter questions. New paths are never donated anyway (clients only get decided paths), so this only changes what is read, shown and asked about.

The Takeout pack sets `skip` on the root, because a Takeout holds every Google product the participant exported, and `ask` on the products it knows (Chrome, My Activity, YouTube), so new files there still come up. We start with this plain toggle; a glob of allowed new names is parked until a case needs it.

### Packs

- **Google Takeout**: the root is the Takeout folder's contents; `find`: `Takeout`, `takeout-*.zip`; skips unknown products.
- **TikTok**: the root is the JSON export itself, so `user_data.json` and `user_data_tiktok.json` need no matches; `find`: `user_data*.json`, for a JSON inside a bigger folder.

How strict paths should be when packages change (exact paths versus the shortest unique path, and near matches that ask the participant) is discussed in [plans/2026-11-05-matching-robustness.md](plans/2026-11-05-matching-robustness.md).

The researcher workspace reads the researcher's own exports without a tree to match: a file or picked folder as it is, a zip stepped into once if it holds one entry. The code is in `packages/core/src/locate.ts`.

## Names and matches

The seen structures are facts: the union of every shape the project has seen, never edited. The researcher's configuration is a tree of its own, whose nodes say which keys they **match** (exact keys or regular expressions). Positions in the seen structures that no configured node matches show as "not matched" rows, and become matched as soon as the researcher names or decides them. Every matched node has a name: its own, or its key. See [ADR 0012](decisions/0012-names-and-matches.md).

There are two ways to join variants, because both are common. In the studio both start from a part's name: giving a part a name another part has asks which one is meant ([the plan](plans/2026-11-05-researcher-experience.md#names-always)).

- **Combine into one node** ("merge into that node"). Siblings of the same kind (`watch-history.json` and `kijkgeschiedenis.json`) become one node with all their matches, one set of settings and one subtree. Use it when the variants need the same settings. Where both had a setting, the kept node's wins and the studio lists the conflict. Taking a match off splits it again: the key it matched is unconfigured again.
- **Give the same name** ("a new node with the same name"). Nodes keep their own settings and subtrees (Dutch and English dates are written differently) and share a name, so participants see one table or one column.
- **Nodes side by side are never combined.** A node that would match two keys in one structure is wrong. The studio checks every seen structure, not the union, and refuses with a count ("both are in 3 packages"); suggestions skip such pairs. Absence is no evidence: structures that have only one of the keys do not count. Giving the same name is always allowed.
- **Every matching node gets the data.** If a regular expression on one node and an exact key on another match the same key, both get the value. That is rare and visible in the studio, and simpler than precedence rules.
- **Suggestions.** When a structure has nodes next to known ones of the same kind, the studio marks them ("same as `timestamp`?") and the match dialog offers that name. Candidates are scored on their structure (the last three steps of every path below them) and, for inner nodes, also on name similarity; suggestions below 0.35 are not shown. This catches renames and translations (`kijkgeschiedenis.json`, `Your Activity` and `Je activiteit`). The code is in `suggest.ts`, the joins in `joins.ts`.
- **Regular expressions** also let researchers collapse dictionary-like keys that the extractor missed. The studio shows which seen keys a regular expression matches.

## How participants see the tree

Each upload has a **Processed / Raw data** switch. Processed (the default) is what the researcher's tree makes of it; **raw data** is everything in the upload as it is, to browse or see as a structure, whatever the researcher decided. Both are read from the participant's own computer only.

Undecided parts (including parts the project has not seen yet) are left out of the processed view, columns and values, unless the platform's tree has the root setting `undecided: show` (in `importer.json`; set in the studio's platform settings). Tables left without columns go too. In the processed view participants see:

1. **Collections**: the derived tables, with label, row count and the first few columns. Tables with donated columns come first.
2. **Other data** (only with `undecided: show`): undecided leaves and paths the project has not seen yet, arranged with the same rules: implicit tables at repeated nodes, columns by shortest unique suffix, lists as counts you can open.
3. **Breadcrumbs with folding**: a run of inner nodes without a label is shown as one step (`history › … › url`) and expands on request.

Built: collections (requested first), other data in a folded section, breadcrumbs with folding, and a table view with nested tables, dates and links formatted by `as` and `role`. Paths the project does not know are marked new; nothing is sent yet ([consent flows](#unknown-paths-and-consent) are next).

The researcher UI has a "view as participant" tab that renders the researcher's own export with the current decisions, which is the quickest check that they make sense. It follows the same rules as the participant client, including the `undecided` setting: by default it shows only what is set to show or donate (`asParticipantsSee` in `studio/model.ts`). A participant uploads one package, so it shows one at a time: by default the structure, with a placeholder for the kind of value in each column, or one loaded test package or example the researcher picks. The Decisions tab is where values from all loaded packages come together: each field shows its most common values on its row, and the row's settings show counts. A note above the tabs says whether the studio is working from the structure alone or with values. A structure counts once: loading the same package again changes nothing, and another package with the same structure adds values but nothing to the tree. In a project, every test package's structure is kept with its platform on the server (one copy per structure), and its values too when the researcher declares the package synthetic or not sensitive; kept values load again in the studio, for everyone in the project. Packages can also be loaded for one tab only ("Add a temporary file" in the Decisions and View as participant tabs): their values are never stored, their structure is. On the practice page everything is temporary. See [security.md](security.md) for the server side.

## Unknown paths and consent

This is the flow from [security.md](security.md#structure-metadata-and-consent), with the decisions above:

- A path is **unknown** when it is not in the seen structures. Clients get the configuration and the seen structures (names only, which participants shared or researchers loaded), so they can tell new parts apart from parts the researcher has seen but not decided on. Unknown leaves are treated as undecided: never requested, and shown only with `undecided: show`.
- **Donate never applies to unknown paths**, because show and donate are set on leaves the researcher has seen. New structure can never be donated by accident.
- Right after an upload, the client asks whether it may share the structure of the data (names only). Unknown paths are listed for the participant to review. The server stores each structure, so researchers know which nodes occur together and how common they are, and the researcher sees the unknown paths as new undecided nodes. See [structure-versions.md](structure-versions.md).

### Missing requested fields

When a leaf the project asks for (`donate`) is missing from a participant's data, and the same table has unknown leaves, the donation step asks about those leaves only:

> Your data is structured a little differently from what we have seen before. We were hoping to include *the time you watched each video*, but we can't find it, or it has a different name. These fields might be it: `watched_at`, `meta/ts`. Would you like to include them in your donation?

The sentence in italics is the missing leaf's `description`. Only unknown leaves in the same table as the missing one are offered, never all undecided data. The participant sees their values in the donation preview, as for every donation.

## What is donated

The donation contains the **transformed values, exactly as the participant sees them in the preview**, one entry per value with its raw path in the participant's data (`[i]` for list items, `{i}` for keys that are data) and the names it was donated as, so nothing depends on how tables were grouped or named. The key page places each value under the newest names by its path and exports relational tables: one per table, each row with an id and the id of the row it is in ([ADR 0015](decisions/0015-raw-paths-and-relational-export.md)). Lists become tables (a list of plain values a table of its own, `tweets_hashtags`); objects stay columns of their row; an object's lists can be read side by side as one table. Consent is given for what the participant saw. Transformations can make data less sensitive (a domain instead of a full URL), and sending the raw value as well would undo that. Most conversions (dates, numbers) lose nothing. The donation records the importer version, so researchers can reproduce the transformation; values are never converted again, even after the conversion changes.

When a study needs the value as it is in the file too, the researcher sets `raw` on a donated leaf that is converted. The value is then donated both ways, and the preview shows both, so the participant still sees exactly what is sent.

## Storage

A project tree is kept as two JSON documents, combined into one tree in the browser:

- **`structure.json`**: the seen structures, the union of every shape the project has seen. It grows as participants share their structure and researchers load test packages, and is never edited by hand.
- **`importer.json`**, owned by the researcher: the names and the configuration tree (matches, decisions, conversions, filters, lifters and scripts as strings). This is the part that is shared between projects.

Keeping them apart means new structure never collides with the researcher's edits, and joining nodes changes only `importer.json`. Clients receive both. Next to these, the server keeps every structure participants shared, without any participant id, one copy per distinct structure with a count. See [structure-versions.md](structure-versions.md).

## What happens to importer specs

Platform packs become shared `importer.json` files plus a reference `structure.json`, versioned with synthetic fixtures like the current importers. This is done for Google Takeout and TikTok (`importers/*/importer.json`); `structure.json` is built from the fixtures by a test, which also checks that the derived rows match the YAML importers' expected output. The researcher UI edits them, and hand-editing stays possible. Current specs convert mechanically:

| Current spec | Project tree |
| --- | --- |
| `match.file` with `{a,b}` | Nodes under the root with several matches |
| `select.rows` | Nothing: the list it points at is a table anyway |
| `fields.*.path` | Donated or shown leaves, with labels |
| `as`, `format`, `transform`, `script` | The same, on the leaf |
| `from` (derived fields), `where` | Derived fields and filter on the table |
| `display` | `role` on leaves |
| `nth`, `all`, `join` | Positional text, list cells, and unnesting in views |

The current runner stays until the derivation covers all platform packs. Datasets keep recording which project tree version produced them.

## Feasibility

- **JSON, JSON Lines, CSV**: straightforward. Lists and maps already say where rows and keys are. The work is the decision model, table derivation, names and matches and the researcher UI.
- **Directories and zips**: straightforward once the root is nameless and split archives merge.
- **HTML**: feasible with normalisation and researcher labels. The risk is in tuning: class noise, inconsistent nesting between rows, and very large files (an open question already in [universal-importer.md](universal-importer.md#open-questions)). Lifters cover the cases that resist.
- **Performance**: matching a participant tree against a project tree is one pass and runs in the data worker. Deriving tables reuses the unfold planned for views.

## Implementation plan

1. **Core** (built: `config.ts`, `decisions.ts`, `joins.ts`, `projectFiles.ts`). The configuration and the working tree built from it with the seen structures, effective decisions, matches, combining and names, comparing a participant shape with a project tree (known, unknown, missing), and the two JSON files.
2. **Nameless root and upload points** (built: `locate.ts`, `mergeDirs`, `uploads` in the project config). Root without a name, merging split zips, one uploader per upload point, and [finding the export](#finding-the-export-in-an-upload): wrapper levels, `find` patterns, required nodes, names first with fixed limits, and the participant choosing between candidates. `newChildren` is respected when reading, showing and comparing structure.
3. **Table inference** (built: `derive.ts`). Every list of objects is a table, nested where it sits; maps whose keys are data become key and value tables; shortest unique suffix. Conversions and row filters are applied (`deriveRows` with `raw: true` turns both off).
4. **HTML normalisation** (built: `normalize.ts`). Implicit lists, stable classes, positional text, data attributes, single-or-repeated twins, `<table>` and `<dl>`, running text, bare siblings, wrapping links. Still to do: tuning on team members' own exports.
5. **Researcher UI** (built: `/studio/` in the web client, in a project's data explorer, also in the example projects at `/studio/example/{id}/`; tabs for test packages, decisions, view as participant, charts and importer files). Tree with decisions, names, matches, combining and giving the same name (one by one or in select mode), "the keys are data", and "view as participant" with a map of all tables, saving and opening `structure.json` and `importer.json`. Exports stay in a worker's memory; only structure and settings are kept, in the project's draft on the server (or, for an example project, in the browser tab). A "tables and fields" view, rows coloured by state with decisions in a menu on each row and settings in a popover, value formats and a first chart builder are described in [exploration.md](exploration.md). Suggestions to combine or name (skipping nodes that occur side by side in a seen structure, which also cannot be combined), "Read as" conversions, roles and row filters are built. Still to do: lifter editing, registering the files with a server project.
6. **Participant UI** (built: `worker/derived.ts`, `screens/TableView.tsx`). Collections, other data, breadcrumbs with folding, nested table navigation, new paths marked locally.
7. **Consent flows.** Sharing structure after upload and checking joins against shared structures ([structure-versions.md](structure-versions.md)); then missing-field requests in the donation step.
8. **Conversion** (packs converted; runner kept). Google Takeout and TikTok are project trees whose outputs match the YAML importers. The row/field runner stays as the fallback for projects without upload points, until the consent flows are built and new packs are written as project trees.

## Decided questions

Answered by Kasper on 2026-10-29:

- **Who decides what a table is.** Nobody: tables are inferred (every list of objects; maps whose keys are data). Researchers label tables and columns. There are no table markers and no `unnest` setting; nested data stays nested and views unnest while aggregating.
- **Leaves in other tables.** Not needed: pulling a parent's value into a nested table is unnesting. Each nested row links to its parent row, and views repeat parent values when they unnest.
- **Classes and ids.** Kept only when stable across repeated rows (see [HTML](#html)).
- **Raw or transformed.** Transformed, as shown in the preview, with a `raw` flag per donated leaf (see [What is donated](#what-is-donated)).
- **Lifter output.** One decision on the lifter node covers every key it outputs; the output shape is not stored.
- **Leaf in one version, inner node in another.** Nodes with different kinds are different nodes, as `mergeAll` and `matchChild` already do.
- **Format.** JSON, split into `structure.json` and `importer.json`, with scripts as strings (see [Storage](#storage)).

Answered by Kasper on 2026-11-01 ([structure-versions.md](structure-versions.md)):

- **Structure versions.** Not stored as named versions. Participants are asked right after upload to share their full structure (names only), reviewing only the names that are new. Each structure is stored, and two nodes that occur side by side in one are never combined.
- **What clients receive.** Changed on 2026-11-04 by [ADR 0012](decisions/0012-names-and-matches.md): clients get the configuration and the seen structures (names only), so they can tell new parts from seen ones.

Answered by Kasper on 2026-11-02 ([Finding the export](#finding-the-export-in-an-upload)):

- **Matching the root.** The upload is the root, without a name check, and wrappers are stepped into. Searching a bigger upload needs name patterns on the tree's root (globs, no catch-alls), plus the same structure check. When several candidates fit, the participant chooses.
- **One platform per uploader.** Recommended, not enforced.
- **Required nodes.** A toggle on any node; any match satisfies it, combined nodes keep it.
- **New parts.** A plain `ask` or `skip` on inner nodes, passed down. No glob of allowed names for now.
- **Protecting the participant.** Names first, then only name matches are opened, then only the root is read. Combray's limits on files, candidates and bytes are fixed.
- **Single files placed in a tree.** The client no longer places a single file (`watch-history.json`) into a folder tree by its name. Participants pick the export they downloaded; a project that wants single files gives them an upload point whose tree is that file.

## Open questions

- Whether shared project trees go through a public registry, and how they are reviewed.
- Whether views should ever pivot a nested table wider (first items as columns), or always keep it nested and unnest while aggregating. For now: always nested.
- The thresholds for keys that are data across rows (5 keys, at most half of the rows) are first guesses; they need tuning on real exports, like the dictionary thresholds.
- Combining tables beyond names, for example two different files that describe the same events.
