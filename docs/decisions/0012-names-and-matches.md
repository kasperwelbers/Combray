# ADR 0012: Names and matches

- **Status:** accepted; points 2, 6 and 11 amended by [ADR 0013](0013-names-labels-versions.md) (names are ids, labels are texts, versions are kept); point 8 amended by [ADR 0015](0015-raw-paths-and-relational-export.md) (raw paths, names matched on export); files and folders are no longer nodes, see [ADR 0016](0016-file-groups.md) (file groups)
- **Date:** 2026-11-04
- **Plan:** [plans/2026-11-04-names-and-matches.md](../plans/2026-11-04-names-and-matches.md)

## Context

Until now one tree did two jobs. The project tree was both the record of what real exports look like and the researcher's configuration. A node's name was the key seen in the data and also what matching used, with extra spellings as aliases (globs or regexes). Merging two nodes rewrote the tree: one name became an alias of the other, the children were combined, and the other node was gone. The configuration could damage the record of the data, merges could not be undone, and a merged node had one set of settings even when its variants needed different ones (Dutch and English dates are written differently, an HTML and a JSON version of the same history have different structures).

## Decision

1. **Seen structures are facts.** Every structure we have seen (test packages, bundled packs, later participants' reports) is kept as it is. The researcher's work never changes them. What the studio shows as "the seen tree" is computed: the union of the seen structures.
2. **The researcher's tree is configuration.** A config node has a stable random `id`, a `kind`, one `match` list (exact keys and regular expressions; no globs), an optional name (`nameId`) and the settings we had before. Real nodes that no config node matches are *unmatched*: the studio shows them as virtual rows, and doing anything with one adds a config node for it. Nodes nobody configured are not stored.
3. **Two explicit ways to join real nodes.**
   - **Combine into one node:** one config node with several matches, for variants that need the same settings (a Dutch and an English file). Their children are one subtree. Only siblings of the same kind can be combined.
   - **Give the same name:** separate config nodes that share a name, for things that mean the same but need their own settings or have different structures. Participants see one table or one column.
   - In the studio both start from a name (2026-11-05, [plan](../plans/2026-11-05-researcher-experience.md#names-always)): giving a part a name another part has asks whether to merge into that node or make a new node with the same name.
   - Settings belong to the node, never to one match. Splitting is the reverse: take a match off (the real node becomes unmatched again), or give a node its own name.
4. **Every config node that matches a real node gets its data.** Overlapping matches duplicate the data. This allows the same value read in two ways, or the same table twice with different filters, and it removes all priority rules. The studio shows "also matched by" on such rows.
5. **One node never matches two keys that sit side by side in one structure** (which value would go in the column?). The studio refuses such a match and flags a regular expression that does this.
6. **Labels and descriptions live on names.** A name has a text (the default label in every language), and per-language overrides. To label a node, you give it a name.
7. **Decisions stay on the node.** Each node's decision applies to its own data. When nodes that share a name have different decisions, the studio warns; a column that holds both is marked as requested.
8. **Donations carry the matched data, not the processed tables.** A donation is a long list of values, each with the path of its row in the export, the table and field it was matched to, and its value. Nodes with a transform donate the transformed value, and also the raw value when the node says so (`raw`). The key page pivots the values into tables, and can also give the long list. The configuration can change after donations were made without making them unreadable.
9. **Clients get the seen tree.** A published upload point carries the configuration and the seen tree (structure only). The client uses the seen tree to tell parts it has never seen (new) from parts that are seen but not configured. This changes the earlier rule that clients only get decided paths; see [security.md](../security.md#structure-metadata-and-consent).
10. **Repetition instead of count ranges.** Shapes say whether a list (or a map whose keys are data) was ever seen with more than one entry (`repeat: 'once' | 'many'`), not how many entries it had. Fixed-length lists are parked.
11. **No versions.** Nothing is live yet, so the file formats change in place (`combray-importer@1`, `combray-structure@1`, `combray-donation/1`). Old drafts are not read.

## Consequences

- Joining and splitting are cheap and undoable, and the configuration stays small: only nodes someone touched.
- New parts in a participant's export are simply unmatched real nodes.
- Column and table ids are stable across language variants: the name's id when there is one, else the config node's id.
- Researchers have two ways to join; the studio offers them as two plain actions.
- Regular expressions run in participants' browsers. They are checked for validity, they only see key names (never values), and names are short.
- More data is donated than before (raw paths and, where asked, raw values next to transformed ones). Compression of the payload is left for later.
