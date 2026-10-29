# Tree decisions: importers as filters on the tree

Status: **design, not built**. Agreed with Kasper on 2026-10-29. It replaces the table-oriented importer spec ([importer-spec.md](importer-spec.md)) over time. It builds on the tree model and shapes in [universal-importer.md](universal-importer.md) and on the structure-metadata consent flow in [security.md](security.md#structure-metadata-and-consent).

## Idea

Every upload becomes a tree, and **the tree is the data**. An importer does not build a table from it. It filters the tree. The researcher decides per node what happens to it. Tables are something we derive from those decisions so participants see the data in a readable way, but they are a view, not the import.

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
| `table` | A marker, not a decision: rows of this node form a table (see [Tables](#tables)). |

Show and donate are possible on leaves only. An inner node never passes `show` or `donate` down, so new children stay undecided. Its effective state is derived from its leaves:

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
| `unnest` | inner, repeated | Default for nested lists inside a table: `count` (default), `longer` or `wider` |
| `lifter` | inner | A sandboxed script that turns each row subtree into a map ([HTML](#html), layer 3) |
| `where`, derived fields, enrichers | table | Row filter, fields computed from other columns (`from` + transform or script), and which columns may be enriched |

## Tables

Tables are derived from the decisions:

1. **Rows.** A table node's rows are its repeated children: list items (`[*]`), entries of a collapsed dictionary (`{*}`), or a repeated HTML block. If a table node is not itself repeated (for example `history`, which holds one list), its rows are those of the nearest repeated node below it.
2. **Columns.** Every leaf that is shown, undecided or donated ends up in the **nearest table ancestor**.
3. **Column names** are the leaf's label, or else the *shortest unique suffix* of its path from the row: `url` and `timestamp` normally, `h2/url` and `span/url` only when two would collide.
4. **Table names** are the table node's label, or else its own name.
5. **Without table nodes**, the client uses the same rule with the nearest repeated ancestor as an implicit table, so undecided data is still readable. Leaves with no repeated ancestor (profile information, settings) form a single record, shown as a card of label and value.
6. The researcher UI **suggests** table nodes at repeated nodes, so marking one is usually a single click.

### Nested tables

A table node inside another table node is a **nested table**. Tweets with comments: `tweets` is a table and `tweets/[*]/comments` is a table. In the tweets table, the comments column shows the number of comments per tweet. Choosing it opens the comments table, filtered to that tweet, with a way back. Each nested row keeps a link to its parent row, so views can still unnest.

A repeated node inside a table that is not marked as a table (`subtitles/[*]/name` in a watch-history table) becomes a list cell ("2 items"). Its `unnest` setting chooses the default: `count` shows the number of items, `longer` gives one row per item and repeats the parent's values, and `wider` puts the first few items in their own columns. Two unnested sibling lists would cross-multiply, so only one of them can be `longer`, the same rule as in [visualization.md](visualization.md#trees-and-tables).

## HTML

In JSON the keys say what a value is. In HTML the structure is positional and the labels are often values themselves: "Gezocht naar", a link and "5 mrt 2024" sit next to each other as text in one `div.content-cell`. The current shape makes this worse. Sibling elements with the same tag and classes merge without a count, so 3000 `div.outer-cell`s look like one, and all `#text` siblings merge into one node.

We handle HTML in three layers. Each produces a tree, so decisions, tables and aliases work the same afterwards. We start with layers 1 and 2 and look at real exports before deciding how much to automate further.

**Layer 1: normalisation (automatic).** A normalised view on top of the parsed tree. The raw tree is unchanged.

- **Implicit lists.** When an element has three or more children with the same signature (tag plus classes, without layout-only classes such as `mdl-cell--6-col`), they become a virtual list `div.outer-cell[*]` with a count bucket.
- **Positional text.** Text nodes are split at `<br>` and numbered among their siblings: `#text[0]`, `#text[1]`. Inferred types are kept per position, so the shape says "text 1 is date-like".
- **Semantic HTML.** A `<table>` with header cells becomes a list of maps keyed by header. A `<dl>` becomes a map from `dt` to `dd`. Header text is only used as a key when it matches a label or alias in the project tree, because the participant's shape never contains text (see the privacy note below).
- **Wrapper folding.** Chains of single-child elements without meaningful classes fold into one step.

After normalisation, Google My Activity is a list of `outer-cell` rows with leaves such as `content-cell[0]/#text[0]` (string), `content-cell[0]/a/@href` (url-like) and `content-cell[0]/#text[1]` (date-like). That is a table with typed but unnamed columns.

**Layer 2: labels from the researcher.** The researcher works on their own export in the researcher UI, so they see the values next to the positions. They label the date-like text `date` and the link `url`. Types do most of the work, since there is usually one date-like and one url-like position per row. Participants only see labels.

**Layer 3: lifters.** For formats that resist (large old Google, Facebook or Instagram HTML exports), a `lifter` on the row node is a QuickJS function from a row subtree to a map, run in the existing sandbox with the same limits as importer scripts. Only the researcher who writes the lifter needs to understand the HTML.

**Privacy note.** Text that is the same in every row ("Producten:", "Gezocht naar") is structure in practice, but it can also be personal, such as a header with an account name. So participant shapes never include text, not even constant text. The client can match constant text locally against labels and aliases in the project tree, which come from the researcher's own exports.

Layer 1 needs changes to `extractShape` (counts for repeated siblings, positional text) and a normalisation pass in `@combray/core`. Signatures and the "layout-only class" rule need tuning on real exports.

## Upload points and the nameless root

A project defines **upload points**, each for one platform: "TikTok (zip or JSON)", "Google Takeout (zip)". An upload point says what it accepts (a file, a folder or zips) and in which formats.

- **The upload is a nameless root.** The name of the uploaded file or folder is never recorded or sent. `kaspers_tiktok.csv` and `mygoogledata/` reveal nothing, and renaming does not create a new tree.
- **There are no file nodes.** Files and folders inside the root are ordinary nodes, matched by name and aliases like keys inside a file. Paths start at the root: `Takeout/YouTube and YouTube Music/history/watch-history.json/[*]/title`, or `[*]/Date` for a single CSV.
- **The format comes from sniffing the content**, with the extension as a hint, not from the name.
- **Split archives merge.** Google Takeout can come as `takeout-…-001.zip`, `-002.zip`. An upload point accepts several and merges them into one root.
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

## What happens to importer specs

A project tree is saved as YAML (structure, decisions and node properties), versioned with synthetic fixtures like the current importers. The researcher UI edits it, and hand-editing stays possible. Current specs convert mechanically:

| Current spec | Project tree |
| --- | --- |
| `match.file` with `{a,b}` | Nodes under the root, with aliases |
| `select.rows` | A table node |
| `fields.*.path` | Donated or shown leaves, with labels |
| `as`, `format`, `transform`, `script` | The same, on the leaf |
| `from` (derived fields), `where` | Derived fields and filter on the table |
| `display` | `role` on leaves |
| `nth`, `all`, `join` | Positional text and `unnest` |

The current runner stays until the derivation covers all platform packs. Datasets keep recording which project tree version produced them.

## Feasibility

- **JSON, JSON Lines, CSV**: straightforward. Lists and maps already say where rows and keys are. The work is the decision model, table derivation, aliases and the researcher UI.
- **Directories and zips**: straightforward once the root is nameless and split archives merge.
- **HTML**: feasible with normalisation and researcher labels. The risk is in tuning: class noise, inconsistent nesting between rows, and very large files (an open question already in [universal-importer.md](universal-importer.md#open-questions)). Lifters cover the cases that resist.
- **Performance**: matching a participant tree against a project tree is one pass and runs in the data worker. Deriving tables reuses the unfold planned for views.

## Implementation plan

1. **Core.** Project tree types, effective decisions, alias matching, and comparing a participant shape with a project tree (known, unknown, missing) in `@combray/core`, with tests on the existing fixtures.
2. **Nameless root and upload points.** Root without a name, content sniffing, merging split zips, upload points in the project config.
3. **Table derivation.** Table nodes, implicit tables, shortest unique suffix, nested tables, `unnest`. Shared with the planned unfold for views.
4. **HTML normalisation.** Implicit lists, positional text, `<table>` and `<dl>`, wrapper folding; matching changes in `extractShape`. Try it on the Google My Activity fixtures and on team members' own exports before tuning further.
5. **Researcher UI.** Tree with decisions, table markers, labels, merging and suggestions, "view as participant".
6. **Participant UI.** Collections, other data, breadcrumbs with folding, nested table navigation.
7. **Consent flows.** Sending unknown paths, then missing-field requests in the donation step.
8. **Conversion.** Convert the platform packs to project trees and retire the row/field runner once the outputs match.

## Open questions

- Should a leaf be able to sit in a table other than its nearest table ancestor, for example to pull a parent's value into a nested table? The unnest already repeats parent values in `longer` mode, so possibly not needed.
- How are layout-only classes recognised: a built-in list per known export, or a heuristic (classes that differ between rows with the same structure)?
- Does a lifter's output need its own shape in the project tree, or is it enough to record the shape after lifting?
- What does the researcher see when two participants' trees disagree on whether a node is a leaf or an inner node (a string in one version, an object in another)? Probably two nodes with the same name and different kinds, as `mergeAll` already does.
- Export format for sharing project trees between projects, and whether sharing goes through a registry.
