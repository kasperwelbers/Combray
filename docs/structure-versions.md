# Structure versions: knowing which nodes occur together

Status: **designed, not built**. Agreed with Kasper on 2026-11-01. It extends the consent flow for new structure in [tree-decisions.md](tree-decisions.md#unknown-paths-and-consent) and [security.md](security.md#structure-metadata-and-consent).

## Why

Exports of one platform come in several real structures: the platform changes its format, and file and key names depend on the language of the account. On top of that, every person's export is a partial copy of one of those structures, because people only have the data they produced (someone who never uploaded a video has no uploads folder). So there are different structures (a, b, c) and different manifestations of one structure (a1, a2, b1).

Researchers combine the variants with [aliases](tree-decisions.md#aliases-and-merging): `kijkgeschiedenis.json` is `watch-history.json` in Dutch. Languages are the easy case, because whole sets of names switch together. A renamed key is harder: is `time` the new name of `watched_at`, or a second field? One rule settles most of it:

> **Two nodes that occur together in one export are never the same node.** They must not be merged.

Today `structure.json` is a plain union of every shape the project has seen, and [merge suggestions](tree-decisions.md#aliases-and-merging) (`suggest.ts`) only compare names and shapes. Nothing records which nodes were seen together, so nothing stops a wrong merge.

## What we rejected, and why

| Option | Why not |
| --- | --- |
| **Named versions per node**: the first branch seen at a split gets 1, the next gets 2 | It records when a branch was first seen, not which branches occur together. Splits in different places multiply, and per-node numbers cannot rebuild the combinations. |
| **Edges between every pair of nodes** | Quadratic in the size of a tree, and not needed: any pair can be checked on demand from stored trees. |
| **Telling versions apart by what is missing** | Absence is never evidence. A missing branch can be a platform change, a language, or a person without that data. Only presence counts. |
| **Reference trees sent to clients, reported as `{reference, diff}`** | The client would receive other people's structures, and a rare tree is a fingerprint. Picking the reference trees is also arbitrary. The diff plus the reference is the full tree anyway. |
| **Only the new paths plus their known siblings** | Too narrow: exports sometimes change radically, far from the new node. |

## The design

1. **Clients receive only identified structure.** A node is *identified* once the researcher has decided on it: `ignore`, `show` or `donate`. The project tree that clients receive, the **published tree**, holds only identified nodes (with their ancestors, labels and aliases). `structure.json` may hold paths that participants or the researcher's own exports added and that nobody has reviewed, and such a path could by accident carry data instead of structure. So it is researcher-only and never served to participants.
2. **Every identified path has a stable id**: a hash of the raw path (see [Path ids](#path-ids)). The client computes ids itself; they are not stored or assigned.
3. **When a participant's data has new paths**, the client asks once whether it may send a **structure report**: the new paths, plus the ids of the identified paths their data has. The participant reviews the new paths; the ids are parts the researcher already knows, and the consent text says they are sent (see [Consent](#consent)).
4. **The server stores each report as one tree**, without any link to the participant (see [Storage](#storage)).
5. **The researcher workspace checks merges against the stored trees**: two nodes that share a tree cannot be merged, and suggestions never propose them (see [In the researcher workspace](#in-the-researcher-workspace)).

Versions are not stored at all. They are a view the researcher workspace computes from the trees when it is useful.

### What counts as new

Compared with the published tree, a path in the participant's shape is:

- **identified** when every step matches an identified node, by canonical name or alias;
- **ignored** when it lies below an ignored node: it is neither shown nor reported, because the researcher said they do not need it;
- **new** otherwise. Undecided nodes in `structure.json` are new to the client too, because the client never sees them.

This changes what "unknown" means in [tree-decisions.md](tree-decisions.md#unknown-paths-and-consent): unknown now means *not identified*, instead of *not in `structure.json`*. A path some participant already reported, but the researcher has not decided on yet, is reported again by the next participant who has it. That is wanted: it gives the researcher more trees, and a count of how common the path is. It also means researchers should decide on new paths regularly. The workspace makes that quick: `show` is a safe default for a leaf, and a subtree can be ignored in one step.

### Path ids

```
id = base64url(first 12 bytes of SHA-256(JSON.stringify([[kind, name], ...])))
```

over the steps from the upload root to the node, where `name` is the **raw name the client matched**: the canonical name or the literal alias that was actually in the data. A regular expression alias contributes its pattern (`{"regex": "..."}` as JSON), and a node whose keys are data contributes `{*}`, so text from the participant's data never ends up inside an id.

Hash ids, rather than numbers the researcher workspace hands out, because:

- **They survive merges.** Merging `kijkgeschiedenis.json` into `watch-history.json` turns the name into an alias. A Dutch export still produces the id of `.../kijkgeschiedenis.json/...`, so trees recorded before the merge stay valid and still show that the two names never occurred together. Merges only change `importer.json`; the evidence is not touched.
- **No one has to assign them**, so two researchers editing a tree, or two projects sharing a pack, never conflict.
- **They are short.** 12 bytes make collisions practically impossible within one project (the workspace checks anyway when it publishes), and a report of 500 identified leaves is about 10 KB.

Combinations of aliases at different levels give ids that may never have been seen (`kijkgeschiedenis.json` inside the English folder name). That is fine: every name in them was approved by the researcher.

### Consent

The report needs consent, like any structure sent outside a donation. The prompt appears after an import when the data has new paths, or when it has an [alias conflict](#alias-conflicts). The participant-facing text (to be translated through i18n) is roughly:

> **Your data is set up a little differently from what the researchers have seen so far.**
> Would you send them a description of how it is set up? It helps them keep the study working for everyone.
>
> These parts are new to them: `uploads/[*]/visibility`, `history/[*]/time`
>
> We would also send which of the parts they already know are in your data, such as whether you have a watch history. *Show these parts*
>
> Only the names of the parts are sent. Nothing you watched, wrote or searched for.

The answers are the ones from [security.md](security.md#structure-metadata-and-consent): *Yes, send this*, *No, these names contain private information* (the refusal is recorded without the paths) and *No, for another reason*.

"Show these parts" opens the identified parts the report contains, grouped by file and with the researcher's labels where there are any, so a participant who wants to can check everything. The client caps the new paths at around 500, as now, and summarises long lists by file.

Presence is information. "Has an uploads folder" says something about a person, which is why the text names it. It is information about parts the researcher already designed the study around, it carries no values, and it is stored without a participant id.

### Alias conflicts

If a participant's data has two raw names that resolve to the same identified node, such as `date` and its alias `timestamp` side by side, an earlier merge was wrong, or the platform now has both. The client then treats the export as needing a report even without new paths. The prompt's first line becomes *"Your data has two parts that the researchers thought were the same"*. The report shows the conflict to the researcher through its ids alone; no extra field is needed.

### What is sent

One report per upload, per upload point:

```json
{
  "format": "combray-structure-report@1",
  "upload": "youtube",
  "present": ["k3Jd8sP0aQ1zT7wB", "..."],
  "added": [
    { "under": "Vb2nL5xW0cRq8sYe", "shape": { "kind": "map", "name": "[*]", "children": [] } }
  ]
}
```

- **`present`** lists the ids of the identified leaves in the data, plus identified inner nodes with no identified leaf below them (an ignored folder, an empty list). Inner nodes on the way to a leaf follow from it. Sorted, without duplicates.
- **`added`** lists each new subtree once, as a shape (structure only, as in [universal-importer.md](universal-importer.md#structure-metadata)), under the id of its deepest identified ancestor.
- Nothing else: no participant id, no project-tree version beyond what the URL says, no file sizes, no times. The server adds the month of arrival.

### Storage

The server keeps per project and upload point:

- **`structure.json`**, as now, extended with the added shapes. Undecided until the researcher reviews them.
- **`trees`**: each distinct report, as its sorted `present` ids plus the `added` paths turned into ids, with a count and the months it arrived in. Identical reports are stored once. Since trees share their paths through the ids, they stay small: a few hundred ids each.

The researcher workspace downloads both for review. Neither is ever sent to participants. A rare tree is a fingerprint, so trees have no participant id, no session and no exact time, and the server does not log reports beyond counts.

### In the researcher workspace

- **Seen together.** Two nodes were seen together when some tree contains an id of each, matched by raw name. Merging them is refused, with a short reason ("these occurred together in 3 exports"). Merge suggestions skip such pairs.
- **How strong the evidence is.** "Never seen together" rests on the trees the project has. Exports without new paths are never reported, so the workspace says how many trees a claim rests on ("never together, in 12 trees with either"), and treats a pair with very few trees as a guess.
- **The researcher's own exports count.** Each export loaded in the workspace is a tree, computed locally. A researcher who loads a Dutch and an English export already has the evidence for the language aliases.
- **Versions as a view.** Nodes that always switch together (all Dutch names appear in the same trees, never with the English ones) form a variant. The workspace can group them to suggest a whole language at once, and can show which variants a node occurs in. That is the a, b, c from [Why](#why), computed when needed and never stored.
- **Publishing.** Saving `importer.json` produces the published tree: identified nodes only. The workspace warns about donated or shown leaves whose ancestors are undecided, because they could not be published.

### Donated shapes

The opt-in shape item in a donation ([universal-importer.md](universal-importer.md#structure-metadata)) is a full structure too, but it is encrypted to the researcher's key and never readable by the server. The key tool can turn decrypted shapes into trees for the workspace, which adds evidence from exports without new paths. This is a later step.

## Privacy summary

| What | Who sees it | Why it is acceptable |
| --- | --- | --- |
| Published tree | Every participant's client | Only names the researcher identified; nothing from other participants that the researcher did not approve |
| New paths | The server and the researcher, after consent | Reviewed by the participant, structure only, screened by the shape extractor |
| Ids of identified parts present | The server and the researcher, after consent | Named in the consent text, viewable on request, no values, no participant id |
| Stored trees | The researcher | Deduplicated, unlinked, month only |

## Implementation plan

1. **Core** (`packages/core`): `pathId`, the published tree (`publishTree`), comparing a shape with a published tree (identified, ignored, new, alias conflicts), building a report, turning a report into a tree, and the seen-together index over trees. Tests on the Takeout and TikTok fixtures, including a Dutch and an English variant.
2. **Researcher workspace**: trees from the researcher's own exports, merges refused for nodes seen together, suggestions filtered, evidence counts, publishing with warnings.
3. **Participant client**: the consent prompt (NL and EN), "show these parts", sending the report.
4. **Server**: an endpoint that accepts a report for a project and upload point, merges `added` into `structure.json`, stores the tree, and serves both to the project's researchers only. Rate limited, counts-only logging.
5. **Later**: trees from donated shapes in the key tool; grouping variants in the workspace.

## Open questions

- Whether a participant whose export exactly matches identified structure should be asked to send a report anyway, to count how common each tree is. For now: no, counts come from donated shapes.
- The threshold below which "never seen together" is shown as a guess.
- Whether trees should expire, for example when a platform's old format has not been seen for a year.
