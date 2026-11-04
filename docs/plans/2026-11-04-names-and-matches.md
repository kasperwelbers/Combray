# Plan: names and matches (separating the researcher's tree from the seen structures)

Status: **planned, not started.** Written 2026-11-04 with Kasper, to be picked up later (for example by Claude Code in the cloud). Read this whole file first, then [CLAUDE.md](../../CLAUDE.md), [tree-decisions.md](../tree-decisions.md) and [structure-versions.md](../structure-versions.md). Kasper's working preference: commit and push directly to `main`, no PRs.

## Why

Today one tree does two jobs. The project tree (`ProjectNode` in `packages/core/src/decisions.ts`) is both **what we have seen** in real exports and **what the researcher configured**:

- A node's `name` is the key seen in the data, and is also what matching uses. Extra spellings go in `aliases` (globs or regexes).
- Merging two nodes (`mergeNodes`) rewrites the tree: one node's name becomes an alias of the other, children are combined, and the other node is gone. So the configuration changes, and partly destroys, our record of what the data looked like. Merges cannot be undone cleanly, and a merged node can only have one set of settings, even when the two variants need different ones (Dutch and English dates are written differently).
- `structure.json` in a platform draft is a union of everything seen, edited by those merges.

What Kasper wants:

1. **The seen structures are facts and stay untouched.** We keep every unique real structure we have seen (from test packages now, from participants' structure reports later). The researcher's configuration can never corrupt them.
2. **The researcher's tree is configuration**, informed by the seen structures but not dependent on them. It decides how real nodes map onto researcher nodes, and that mapping can be changed and undone at any time: real nodes can be joined and split again.
3. **One setting for matching.** A node has one `match` setting, a list of exact keys and/or regexes. There is no separate "name used for matching" plus "aliases".
4. **Names join nodes.** A `name` is something several nodes can share, to say "these are the same thing" for participants (one table, one column), while each node keeps its own settings.

## The two ways to join real nodes

Example: an English export has `watch-history.json`, a Dutch one `kijkgeschiedenis.json`, with the same structure except for the field names.

**A. One node with several matches.** For variants that need the same settings. One researcher node matches both keys; the children of everything it matches are seen as its children, so the editor shows one subtree:

```
Watch history   [match: watch-history.json | kijkgeschiedenis.json]
  - url         [match: url]
  - timestamp   [match: timestamp]
  - tijdstip    [match: tijdstip]
```

The researcher then joins `timestamp` and `tijdstip` the same way (one node, two matches) or with a name (B).

**B. Two nodes with the same name.** For things that mean the same but need their own settings or have different structures, such as `kijkgeschiedenis.html` (HTML, Dutch dates) and `watch-history.json`. They stay two nodes, each with its own matches, settings and subtree; participants see one table (or column) because they share the name. In the editor, nodes with the same name are shown together (sorted next to each other where they are siblings, and grouped by name in the "tables and fields" view).

Splitting is the reverse: take a match off a node (the real node it matched becomes unmatched and shows up on its own again), or give a node its own name.

## Model

### Seen structures (facts, read only)

- A **structure** is a `Shape` (`packages/core/src/shape.ts`) of one export: names, kinds, types, formats, repetition. No values.
- The server already keeps one copy per unique structure per platform, in `test_packages` (`shape`, `structure_hash`; see `apps/server/src/projects.ts`, `testPackages`). Participants' structure reports ([structure-versions.md](../structure-versions.md)) will add more later, in the same spirit: unique structures with a count.
- Bundled platform packs (`importers/*/structure.json`) are seen structures too.
- **Nothing the researcher does changes them.** The studio never edits a stored structure. The "seen tree" shown in the editor is computed: the union of all structures (`mergeShape`-like, but on shapes only).
- The hash should be computed from a canonical form (sorted keys) so that the same structure always gets the same hash. Today the server hashes `JSON.stringify(shape)` as received; make the client send canonical shapes, or canonicalise on the server.

### The researcher's tree (configuration)

A new `ConfigNode` replaces `ProjectNode` as the stored configuration:

```ts
interface ConfigNode {
  id: string;            // stable, generated (short random); never derived from data
  kind: NodeKind;        // what it matches: map key, list item, element, file, ...
  match: Match[];        // one setting: exact keys and/or regexes; [] only for the root and `[*]`
  name?: string;         // id of a Name; nodes with the same name are one thing for participants
  // settings, as today on ProjectNode: decision, raw, transform, as, format, role, filter,
  // headerRow, required, newChildren, lifter, collapsed ("keys are data"), find/undecided (root)
  children?: ConfigNode[];
}
type Match = string | { regex: string; flags?: string };   // exact key, or a regex

interface Name {
  id: string;
  text: string;                     // the researcher's name, e.g. "Watch history"
  label?: Record<string, string>;   // per-language overrides, for participants only
  description?: Record<string, string>;
}
```

- **Exact keys are exact**: no globs. Globs (`*`) in today's aliases become regexes in the migration.
- **`[*]` (list items) and `{*}` (keys that are data)** keep their special meaning; they have no match.
- **Labels and descriptions live on names only.** To label one node, give it a name. A name's text is the default label in every language; `label` overrides it per language. Labels change what participants see, never how nodes are grouped.
- **Undecided/show stays as it is for now** (Kasper, 2026-11-04): giving a node a name does *not* make it shown. The decision stays a node setting. Whether it should move to the name, or whether naming should mean "show", is an open question (see below).

### Resolving: real nodes to researcher nodes

One pure function in core, used by the studio and the participant client alike:

```ts
resolve(config: ConfigNode, structure: Shape): Resolution
// for every node of the structure: the ConfigNode it maps to, or none (unmatched)
```

Rules, per level (children of one matched parent):

1. A real key is matched by a config node with that exact key; exact beats regex.
2. Otherwise by the first config node whose regex matches, in tree order.
3. Two config nodes with the same exact key at one level is a configuration error (the studio prevents it). Two regexes matching the same key: the first wins, and the studio flags it.
4. A config node that matches **two keys present side by side in one structure** is a conflict (which value goes in the column?). This is today's "two nodes that occur together are never the same node" rule (`seenTogether` in `packages/core/src/together.ts`), now checked against the seen structures. The studio refuses to add such a match, and flags it if new data creates it.
5. Real nodes that no config node matches are **unmatched**. In the studio they appear as *virtual* rows (undecided, styled as not yet configured). Doing anything with a virtual row (deciding, naming, setting a conversion) **materialises** it: a config node with one exact match is added. This keeps the configuration small and makes "new parts" (structure-versions) natural: they are simply unmatched real nodes.
6. The participant client gets only the published configuration. Parts of a participant's data that nothing matches are unmatched, which today means "undecided, new" (`mergeShape(..., { skipClosed })` and the `added` paths in `apps/web/src/worker/derived.ts`). `newChildren: 'skip'` keeps working on config nodes.

### What participants see

- `deriveTables` works on the resolved tree. Tables and columns are **grouped by name**: config nodes that share a name (B) become one table or column, with the rows of all of them. Nodes joined by matches (A) are already one node.
- Without a name, a node is its own table or column, named by its first match (as today, the shortest unique suffix for columns).
- **Column and table ids must be stable** and must not depend on which language variant a participant has: use the name id when there is a name, else the config node id. Today column ids are paths from the row (`ColumnDef.id`). Check everything that stores or sends column ids (participant store manifests, views and queries in `apps/web/src/worker/`, donations in `packages/seal` and `apps/keys`) and migrate.
- When nodes joined by a name have different decisions, the studio warns; for participants the column takes the strongest (donate over show), until the open question below is settled.

## Files and migration

- **New importer file format** (`combray-importer@2`, `packages/core/src/projectFiles.ts`): `{ format, names: Name[], root: ConfigNode }`. The structure file no longer belongs to the configuration: seen structures live on the server (test packages, later reports) and in packs.
- **Migration from `@1`** (`structure.json` + `importer.json`, joined by `joinProjectTree`):
  - every node becomes a config node with a new id; `match = [name, ...aliases]`, with glob aliases turned into regexes;
  - a `label` or `description` becomes a `Name` (text: the English label, or the key) that the node points to;
  - all other settings carry over;
  - nodes nobody has configured (undecided, no settings) can be dropped from the config: they come back as unmatched real nodes from the seen structures. Keep this optional, to keep diffs readable.
- **Platform drafts on the server** (`project_platforms.structure` and `.importer`, `apps/server/src/projects.ts`): store the v2 configuration; keep reading v1 and migrating on load. The published project config (`publish`) carries v2. Participant clients must accept both until all published projects are v2.
- **Bundled packs** (`importers/*/importer.json`, `structure.json`, `importers/packs.ts`, `packTree`): migrate to v2 configuration plus a seen structure. `importers/test` checks packs against the YAML importers; keep that working.
- **An ADR** (`docs/decisions/0012-names-and-matches.md`): this changes the importer file format and how participants' data is matched, which is hard to reverse.

## Studio (editor)

Current editor: `apps/web/src/studio/` (`Studio.tsx`, `DecisionTree.tsx`, `NodeDetails.tsx`, `Popover.tsx`, `model.ts`). Rows have a decision menu and a popover with sections; see [exploration.md](../exploration.md).

- **Rows show**, in order: the name as a badge (a stable colour per name; clicking it opens the name's settings: text, labels per language, description), then the match (`watch-history.json | kijkgeschiedenis.json`, regexes marked as such), then indicators, then buttons, then the decision pill.
- **Per-row buttons instead of one popover with tabs**, so different node types show different buttons:
  - **Name**: the badge, or "+ name". Choosing an existing name joins the node to it (B).
  - **Match**: edit the match list; add an exact key or a regex; shows which seen keys each match covers.
  - **Read as**: leaves only (today's `Conversion.tsx`).
  - **Filter**: tables only (today's `RowFilters.tsx`, plus "first row holds the column names").
  - **Values**: leaves, when test packages with values are loaded (today's `FieldValues.tsx`).
- **Indicators from the seen structures**: "not seen in any structure" on a config node nothing matches; "matches N different keys" on a regex, with a **Split** action (one node per seen key, as exact matches); a warning on rule-4 conflicts.
- **Joining**: select two or more rows (checkboxes appear in a "select" mode) and choose **Combine**: (A) "one node, all their matches" (offered when their structures are the same; children are joined by the same rules), or (B) "keep them, give them the same name". Suggestions (`packages/core/src/suggest.ts`, `Suggestions.tsx`) propose these instead of today's merges.
- **Same-name nodes together**: siblings sorted so that same-named nodes are adjacent; in "tables and fields" (`outline` in `packages/core/src/derive.ts`), tables with the same name are shown as one group with their variants below.
- Virtual (unmatched) rows look like today's undecided rows, with a subtle "not configured yet" mark.

## Repetition instead of count ranges (separate, smaller part)

Today shapes have `count?: CountBucket` (`'1' | '2-10' | '11-100' | ...`, `packages/core/src/shape.ts`), shown as "× 2-10". That is confusing next to the participant view's "rows × columns", and it leaks rough sizes (a history marked "101-1k") in shared structures. Replace it with the kind of repetition, treated like types:

- `once`: one value or one record; `list`: repeated, no fixed length; `fixed n`: always exactly n (such as `[lat, lon]`).
- Inference: one item is `once` until any structure shows more; `list` wins when structures are merged (as types merge). `fixed n` only for a list inside repeated rows with the same length in at least 5 rows; a top-level list is only ever `once` or `list`.
- Show real row counts only from loaded test packages with values. Migrate `count` in stored shapes and packs.
- Kasper agreed with this direction on 2026-11-04; it is independent of names and matches and can be done first or in parallel.

## Steps

Each step ends with tests passing (`pnpm test`, `pnpm typecheck`) and the docs updated. Commit per step.

1. **ADR and doc** — write `docs/decisions/0012-names-and-matches.md` from this plan; update [tree-decisions.md](../tree-decisions.md) (aliases and merging sections) to point to it. Get Kasper's OK on the open questions below before step 3.
2. **Repetition** (independent) — core shapes, packs, UI badges ("list", "once", "2 values"), row counts from test data only.
3. **Core model** — `ConfigNode`, `Name`, `Match`, `resolve`, the v2 file format with v1 migration, `deriveTables` grouping by name with stable ids. Thorough unit tests: exact over regex, rule 4 conflicts, migration of aliases and globs, A and B joins, splitting.
4. **Participant client** — `apps/web/src/worker/derived.ts` and `pointTree` on v2; accept v1 published configs; check ids in stored tables and donations.
5. **Server** — drafts store v2 (read v1); canonical structure hash; an endpoint or reuse of `test-packages` GET `shapes` to give the studio all seen structures of a platform. HTTP tests.
6. **Studio** — seen tree from stored structures (+ loaded packages), virtual rows, per-row buttons, name badges and grouping, Match editor, Combine and Split, indicators. Remove `mergeNodes`, aliases UI and the "Matching" popover section.
7. **Packs** — migrate bundled packs; keep `importers/test` green.
8. **End-to-end check** — as in the last session: a throwaway server (`COMBRAY_*` env in a temp dir, port 8091, `node apps/server/src/cli.ts researcher add …`), Playwright with a CDP virtual passkey (see `apps/keys/test/e2e.test.ts`, `researcherBrowser` and `setUp`), create a project, add Google Takeout, load the English and Dutch examples, combine the two watch histories (A), name timestamp/tijdstip (B), check "View as participant" with each package.

## Open questions (ask Kasper)

1. **Decision on the node or on the name?** Kept on the node for now. If two nodes share a name, should they be forced to share show/donate? (Likely yes eventually: one column cannot be half donated.)
2. **Does naming mean "show"?** Discussed and parked on 2026-11-04: keep undecided/show separate from names for now.
3. **Combining tables with different structures under one node (A)**: allowed, with their children joined by the usual rules, or only offered when the structures are the same?
4. **Unconfigured nodes in the stored configuration**: drop them (they come back from seen structures) or keep them for readability?
5. **Regex scope**: per level only (as today), or should a match be able to span levels (for example a file in any folder)? `find` on the root already covers finding the export.

## Not in this plan

- Participants' structure reports and the consent flow (structure-versions.md); this plan only makes room for them as more seen structures.
- Bulk actions beyond Combine (Kasper: "later").
- An AI helper suggesting names or matches.
