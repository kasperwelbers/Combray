# Tree decisions: importers as filters on the tree

Status: **partly built** (see [Implementation plan](#implementation-plan)). Agreed with Kasper on 2026-10-29. It replaces the table-oriented importer spec ([importer-spec.md](importer-spec.md)) over time. It builds on the tree model and shapes in [universal-importer.md](universal-importer.md) and on the structure-metadata consent flow in [security.md](security.md#structure-metadata-and-consent).

## Idea

Every upload becomes a tree, and **the tree is the data**. An importer does not build a table from it. It filters the tree. The researcher decides per node what happens to it. Tables are inferred from the structure so participants see the data in a readable way, but they are a view, not the import.

The current spec still thinks in tables: it selects a row path and named field paths. That makes researchers learn the path language and HTML structure, and it drops everything the spec does not name. Here the researcher works on a tree of all the structure the project has seen, and every node has a decision.

## The project tree

Each project has one **project tree** per upload point (see [Upload points](#upload-points-and-the-nameless-root)). It is the union of the shapes the project has seen: the researcher's own test exports and the structure metadata participants agreed to send. It holds structure only, never values ([CLAUDE.md](../CLAUDE.md) rule 4).

Each project owns its own tree. A researcher can export theirs and another project can import it as a starting point, so platform packs become shared project trees rather than a separate format.

### Leaves and inner nodes

A **leaf** is a node that holds a value: a JSON or CSV value, an HTML text position or attribute (after [normalisation](#html)), or a blob. Everything else is an **inner node** (directories, maps, lists, elements).

| On a leaf | Meaning |
| --- | --- |
| `undecided` | The default. Imported and shown, not requested. |
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
| `label` | any | Display name per language (`{en: Date, nl: Datum}`): table names, column names |
| `description` | donated leaves | One participant-facing sentence ("the time you watched each video"), used in donation previews and in [missing-field requests](#missing-requested-fields) |
| `aliases` | any | Other names for the same node: literal, glob or regular expression (see [Aliases](#aliases-and-merging)) |
| `as`, `format`, `transform`, `script` | leaves | Conversion, as in the current field spec, now attached to the node |
| `role` | leaves | View hint: `date`, `title`, `url`, `group` (replaces `display`) |
| `raw` | donated leaves | Donate the value as it is in the file instead of transformed ([What is donated](#what-is-donated)) |
| `lifter` | inner | A sandboxed script that turns each row subtree into a map ([HTML](#html), layer 3) |
| `where`, derived fields, enrichers | table | Row filter, fields computed from other columns (`from` + transform or script), and which columns may be enriched |

## Tables

Tables are **inferred from the structure**; researchers do not mark them. (An earlier version of this design had researchers mark table nodes. Kasper dropped that on 2026-10-29: marking a table was really a way of unnesting, and it would still need a choice between longer and wider. Nested data now stays nested.)

1. **A list of objects is a table.** Its items (`[*]`) are the rows. This is the first array above a leaf, which is what the old `rows_selector` pointed at.
2. **Objects in a row are more columns.** Leaves inside an item are cells, however deep they sit in objects: `stats/likes` is a column of the tweets table.
3. **Lists in a row stay nested.** A list of objects inside a row is a **nested table**. A list of plain values (`tags: ["tea", "baking"]`) is a list cell.
4. **Leaves outside any list** (profile information, settings) form a single record.
5. **Column names** are the leaf's label, or else the *shortest unique suffix* of its path from the row: `url` and `timestamp` normally, `h2/url` and `span/url` only when two would collide.
6. **Table names** are the label of the list (or of its items), or else the list's name. A table in an HTML file is named after the file, not after `div.mdl-grid`.

What researchers do is the same as for any node: decide on the leaves, and give tables and columns labels and aliases. Tables that the same structure produces in several files (a language variant, a renamed file) are combined with aliases, like any other node.

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
- **By hand.** With few rows this cannot be told apart from coincidence, so the researcher UI has a "the keys are data" action on any map or folder. It merges the children into one `{*}` position and drops their names; it does not keep them as aliases, because they are data.

The keys themselves can be shown or donated: the `{*}` node has its own decision, separate from the values inside it. Below a `{*}` node, every key matches the one position, so new keys never add paths and are never offered in a consent request.

## HTML

In JSON the keys say what a value is. In HTML the structure is positional and the labels are often values themselves: "Gezocht naar", a link and "5 mrt 2024" sit next to each other as text in one `div.content-cell`. The current shape makes this worse. Sibling elements with the same tag and classes merge without a count, so 3000 `div.outer-cell`s look like one, and all `#text` siblings merge into one node.

We handle HTML in three layers. Each produces a tree, so decisions, tables and aliases work the same afterwards. We start with layers 1 and 2 and look at real exports before deciding how much to automate further.

**Layer 1: normalisation (automatic).** A normalised view on top of the parsed tree. The raw tree is unchanged.

- **Implicit lists.** When an element has two or more children with the same tag and the same set of classes, they become a list, named like the elements (`div.mdl-cell.….outer-cell`). Rows repeat their classes exactly; cells within a row usually differ in one (`mdl-cell--6-col` and `--12-col`), so they stay separate positions.
- **Element names.** Inside list rows, an element keeps only the classes it has at that position in *every* row (positions are matched by tag, first class and order). Classes that vary between rows are dropped, so the same thing stays one node. Ids only count when they are the same in every row.
- **Single or repeated.** An element that is single in one place and repeated in another (one link in a row, or three) is one node in the project tree: the single element counts as the list's only item. The same goes for a JSON key that is `null` in some records and a list or map in others.
- **Positional text.** Text nodes are numbered among their text siblings: `#text[0]`, `#text[1]` (`<br>` already separates them). Each becomes a value with an inferred type, so the shape says "text 1 is date-like".
- **Data attributes.** `href`, `src`, `datetime`, `title`, `alt`, `value` and `content` become values named `@href` and so on. Empty elements (`<br>`, empty cells) are dropped.
- **Semantic HTML.** A `<table>` with header cells becomes a list of maps keyed by header. A `<dl>` becomes a map from `dt` to `dd`. Header text is only used as a key when it matches a label or alias in the project tree, because the participant's shape never contains text (see the privacy note below).
- **Wrapper folding.** Chains of single-child elements fold into one step in the researcher UI.

After normalisation, Google My Activity is a list of `outer-cell` rows with leaves such as `content-cell…body-1/#text[0]` (string, "Searched for"), `a/@href` (url-like), `a/#text[0]` (the query) and `#text[1]` (date-like). That is an implicit table with typed but unnamed columns, named after the file. Semantic HTML (`<table>`, `<dl>`) is not handled yet.

**Layer 2: labels from the researcher.** The researcher works on their own export in the researcher UI, so they see the values next to the positions. They label the date-like text `date` and the link `url`. Types do most of the work, since there is usually one date-like and one url-like position per row. Participants only see labels.

**Layer 3: lifters.** For formats that resist (large old Google, Facebook or Instagram HTML exports), a `lifter` on the row node is a QuickJS function from a row subtree to a map, run in the existing sandbox with the same limits as importer scripts. Only the researcher who writes the lifter needs to understand the HTML.

A node with a lifter hides its children from the decision tree. The lifter node itself gets one decision (ignore, show or donate), and every key it outputs is a leaf with that same decision. Its output shape is not stored in the project tree. A researcher who wants only some fields writes the lifter to output only those.

**Privacy note.** Text that is the same in every row ("Producten:", "Gezocht naar") is structure in practice, but it can also be personal, such as a header with an account name. So participant shapes never include text, not even constant text. The client can match constant text locally against labels and aliases in the project tree, which come from the researcher's own exports.

Layer 1 needs changes to `extractShape` (counts for repeated siblings, positional text, stable classes) and a normalisation pass in `@combray/core`. The thresholds need tuning on real exports.

## Upload points and the nameless root

A project defines **upload points**, each for one platform: "TikTok (zip or JSON)", "Google Takeout (zip)". An upload point says what it accepts (a file, a folder or zips) and in which formats.

- **The upload is a nameless root.** The name of the uploaded file or folder is never recorded or sent. `kaspers_tiktok.csv` and `mygoogledata/` reveal nothing, and renaming does not create a new tree.
- **There are no file nodes.** Files and folders inside the root are ordinary nodes, matched by name and aliases like keys inside a file. Paths start at the root: `Takeout/YouTube and YouTube Music/history/watch-history.json/[*]/title`, or `[*]/Date` for a single CSV.
- **The format comes from sniffing the content**, with the extension as a hint, not from the name.
- **Split archives merge.** Google Takeout can come as `takeout-…-001.zip`, `-002.zip`. An upload point accepts several and merges them into one root.
- **One top folder in an archive is unwrapped.** A zip whose entries all sit in `Takeout/` gives the same tree as picking the `Takeout` folder itself: the root holds `Chrome/`, `YouTube and YouTube Music/` and so on.
- **Per-user names inside the root** (`messages/inbox/johnsmith_1234/`) go through the existing dictionary collapse and name screening, so they become `inbox/{*}/`.

This also limits the size of the project tree. Ten participants with ten differently named files produce one tree, and identical structure is stored once because the tree is a union. The client still caps how many new paths it offers to send at once (around 500), and shows a summary instead of a long list when there are many.

## Aliases and merging

- A node has one canonical name and a set of aliases. A participant's path matches the canonical name first, then the aliases. The current `{watch-history.json,kijkgeschiedenis.json}` becomes a node `watch-history.json` with the alias `kijkgeschiedenis.json`.
- **Merging.** A new undecided node `date` next to a known `timestamp` can be merged into it in the researcher UI. This adds `date` as an alias and merges the children recursively. Children that exist on both sides with different decisions are listed for the researcher to resolve.
- **The tree view shows merged nodes once**, with their aliases as small tags.
- **Suggestions.** When a participant shape has a new node where a known node is missing, at the same position and with the same kind and type, the researcher UI suggests merging ("is `date` the same as `timestamp`?"). This catches renames and translations.
- Regular expression aliases also let researchers collapse dictionary-like keys that the extractor missed.

## How participants see the tree

Participants never browse the raw tree. They see:

1. **Collections**: the derived tables, with label, row count and the first few columns. Tables with donated columns come first.
2. **Other data**: undecided leaves and paths the project has not seen yet, arranged with the same rules: implicit tables at repeated nodes, columns by shortest unique suffix, lists as counts you can open.
3. **Breadcrumbs with folding**: a run of inner nodes without a label is shown as one step (`history › … › url`) and expands on request.

The researcher UI has a "view as participant" toggle that renders the researcher's own export with the current decisions, which is the quickest check that they make sense.

## Unknown paths and consent

This is the flow from [security.md](security.md#structure-metadata-and-consent), with the decisions above:

- A path is **unknown** when it is not in the project tree (canonical names and aliases). Unknown leaves are treated as undecided: shown, never requested.
- **Donate never applies to unknown paths**, because show and donate are set on leaves the researcher has seen. New structure can never be donated by accident.
- After an import, the client asks, as now, whether it may send the unknown paths (structure only). Once sent, the researcher sees them as new undecided nodes.

### Missing requested fields

When a leaf the project asks for (`donate`) is missing from a participant's data, and the same table has unknown leaves, the donation step asks about those leaves only:

> Your data is structured a little differently from what we have seen before. We were hoping to include *the time you watched each video*, but we can't find it, or it has a different name. These fields might be it: `watched_at`, `meta/ts`. Would you like to include them in your donation?

The sentence in italics is the missing leaf's `description`. Only unknown leaves in the same table as the missing one are offered, never all undecided data. The participant sees their values in the donation preview, as for every donation.

## What is donated

The donation contains the **transformed values, exactly as the participant sees them in the preview**. Consent is given for what the participant saw. Transformations can make data less sensitive (a domain instead of a full URL), and sending the raw value as well would undo that. Most conversions (dates, numbers) lose nothing. The donation records the importer version, so researchers can reproduce the transformation.

When a study needs a raw value, the researcher sets `raw` on that donated leaf. The preview then shows it raw, so the participant still sees exactly what is sent.

## Storage

A project tree is kept as two JSON documents, combined into one tree in the browser:

- **`structure.json`**, owned by the server: the union of every shape the project has seen. It grows as participants send structure metadata.
- **`importer.json`**, owned by the researcher: decisions, labels, descriptions, aliases, conversions, lifters and scripts (as strings), keyed by canonical path. This is the part that is signed with the project config and shared between projects.

Keeping them apart means the server adding new paths never collides with the researcher's edits. Merging nodes rewrites the paths in `importer.json`.

## What happens to importer specs

Platform packs become shared `importer.json` files plus a reference `structure.json`, versioned with synthetic fixtures like the current importers. The researcher UI edits them, and hand-editing stays possible. Current specs convert mechanically:

| Current spec | Project tree |
| --- | --- |
| `match.file` with `{a,b}` | Nodes under the root, with aliases |
| `select.rows` | Nothing: the list it points at is a table anyway |
| `fields.*.path` | Donated or shown leaves, with labels |
| `as`, `format`, `transform`, `script` | The same, on the leaf |
| `from` (derived fields), `where` | Derived fields and filter on the table |
| `display` | `role` on leaves |
| `nth`, `all`, `join` | Positional text, list cells, and unnesting in views |

The current runner stays until the derivation covers all platform packs. Datasets keep recording which project tree version produced them.

## Feasibility

- **JSON, JSON Lines, CSV**: straightforward. Lists and maps already say where rows and keys are. The work is the decision model, table derivation, aliases and the researcher UI.
- **Directories and zips**: straightforward once the root is nameless and split archives merge.
- **HTML**: feasible with normalisation and researcher labels. The risk is in tuning: class noise, inconsistent nesting between rows, and very large files (an open question already in [universal-importer.md](universal-importer.md#open-questions)). Lifters cover the cases that resist.
- **Performance**: matching a participant tree against a project tree is one pass and runs in the data worker. Deriving tables reuses the unfold planned for views.

## Implementation plan

1. **Core** (built: `decisions.ts`, `projectFiles.ts`). Project tree types, effective decisions, alias matching, merging, comparing a participant shape with a project tree (known, unknown, missing), and the two JSON files.
2. **Nameless root and upload points** (partly built: `uploadRoot`, `mergeDirs`). Root without a name, unwrapping one top folder, merging split zips. Still to do: upload points in the project config.
3. **Table inference** (built: `derive.ts`). Every list of objects is a table, nested where it sits; maps whose keys are data become key and value tables; shortest unique suffix. Conversions (`as`) are not applied yet.
4. **HTML normalisation** (built: `normalize.ts`). Implicit lists, stable classes, positional text, data attributes, single-or-repeated twins. Still to do: `<table>` and `<dl>`, and tuning on team members' own exports.
5. **Researcher UI** (built: `/studio/` in the web client). Tree with decisions, labels, descriptions, aliases, merging, "the keys are data", and "view as participant" with a map of all tables, saving and opening `structure.json` and `importer.json`. Exports stay in a worker's memory; only structure and settings are kept as a draft in `localStorage`. A "tables and fields" view, rows coloured by state with decisions in the side panel, value formats and a first chart builder are described in [exploration.md](exploration.md). Still to do: merge suggestions, lifter editing, registering the files with a server project.
6. **Participant UI.** Collections, other data, breadcrumbs with folding, nested table navigation.
7. **Consent flows.** Sending unknown paths, then missing-field requests in the donation step.
8. **Conversion.** Convert the platform packs to project trees and retire the row/field runner once the outputs match.

## Decided questions

Answered by Kasper on 2026-10-29:

- **Who decides what a table is.** Nobody: tables are inferred (every list of objects; maps whose keys are data). Researchers label tables and columns. There are no table markers and no `unnest` setting; nested data stays nested and views unnest while aggregating.
- **Leaves in other tables.** Not needed: pulling a parent's value into a nested table is unnesting. Each nested row links to its parent row, and views repeat parent values when they unnest.
- **Classes and ids.** Kept only when stable across repeated rows (see [HTML](#html)).
- **Raw or transformed.** Transformed, as shown in the preview, with a `raw` flag per donated leaf (see [What is donated](#what-is-donated)).
- **Lifter output.** One decision on the lifter node covers every key it outputs; the output shape is not stored.
- **Leaf in one version, inner node in another.** Nodes with different kinds are different nodes, as `mergeAll` and `matchChild` already do.
- **Format.** JSON, split into `structure.json` and `importer.json`, with scripts as strings (see [Storage](#storage)).

## Open questions

- Whether shared project trees go through a public registry, and how they are reviewed.
- Whether views should ever pivot a nested table wider (first items as columns), or always keep it nested and unnest while aggregating. For now: always nested.
- The thresholds for keys that are data across rows (5 keys, at most half of the rows) are first guesses; they need tuning on real exports, like the dictionary thresholds.
- Combining tables beyond aliases, for example two different files that describe the same events.
