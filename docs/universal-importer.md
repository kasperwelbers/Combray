# Universal tree importer

## Why

In data-donation-importers, a *recipe* names a file, a `rows_selector`, a list of column selectors and a list of transformers, with separate parsers per file type (JSON paths, CSV columns, CSS selectors for HTML). It worked well across several studies, but:

- Each file type had its own selector semantics, so recipe authors had to learn three systems.
- Recipes produced tables early, losing nesting that is often meaningful (a watch event with its list of channels, a message thread with its messages).
- When a platform changed its export, recipes broke silently, and researchers had no view of how formats varied across participants and languages.

Combray replaces this with one idea: **every input becomes a tree**, and an importer is a set of marked paths in that tree.

## The tree model

A DDP (a zip, a folder, or loose files) is parsed into a single tree.

| Source | Becomes |
| --- | --- |
| Zip archive / folder | `dir` nodes whose children are entries |
| JSON | objects → `map` nodes, arrays → `list` nodes, primitives → `value` nodes |
| JSON Lines / NDJSON | a `list` of parsed objects |
| CSV / TSV | a `list` of `map` nodes keyed by header (delimiter and encoding sniffed, as in `reparseAsUTF8`) |
| HTML | `element` nodes with `tag`, `id`, `class`, other attributes, and children; text as `text` nodes |
| XML | as HTML, with namespaces |
| Plain text | a `list` of lines |
| Images, video, other binaries | `blob` nodes with type and size only (contents not parsed by default) |

Each node has a kind, a name (key, index, tag or filename), and either a value or children. Values keep their raw string plus a lightweight inferred type (`int`, `float`, `bool`, `string`, `date-like`, `url-like`, `email-like`). The tree is stored compactly (arena of nodes with string interning) in `combray-core`, and the same structure is used in the browser (WASM) and the CLI.

Parsing is streaming where it can be: huge JSON arrays and CSVs are parsed incrementally and written to the encrypted store in chunks, so a multi-gigabyte Takeout does not need to fit in memory at once.

## Paths

One path language addresses nodes in any tree, whatever the source format.

```
Takeout/YouTube and YouTube Music/history/watch-history.json/[*]/subtitles/[0]/name
```

| Segment | Matches |
| --- | --- |
| `name` | child with this key, filename or tag |
| `[3]`, `[*]` | list element by index, or every element |
| `*` | any single child |
| `**` | any depth (for "this file wherever it is in the archive") |
| `{a,b,c}` | any of these names (language variants: `{watch-history.json,kijkgeschiedenis.json,Wiedergabeverlauf.json}`) |
| `div.content-cell` | HTML element by tag, class and id, CSS-like (`tag#id.class`) |
| `@href` | attribute of an HTML/XML element |
| `#text` | text content of an element |
| `[?type=url]` | filter on node properties |

Paths are relative where it helps: an importer selects a *row path* and then *field paths* relative to each row, like `rows_selector` and column selectors in the old recipes. HTML authors who prefer CSS selectors can embed one as a segment (`css(div.outer-cell > div.content-cell)`), so existing HTML recipes translate directly.

## Importers

An importer is a small YAML (or JSON) document. It **marks paths**, says how to **convert** them, and optionally runs a **script** for anything unusual.

```yaml
id: tiktok/watch-history
version: 3
name:
  en: TikTok watch history
  nl: TikTok kijkgeschiedenis
match:
  file: "**/{user_data.json,user_data_tiktok.json}"
  shape: tiktok-user-data@2      # optional: shape fingerprint(s) this importer is known to work with
select:
  rows: "{Activity,Your Activity}/{Video Browsing History,Watch History}/{VideoList,videoList}/[*]"
  fields:
    date:
      path: "{Date,date}"
      as: datetime
      format: "YYYY-MM-DD HH:mm:ss"
    url:
      path: "{Link,link}"
      as: url
    video_id:
      from: url
      script: |
        (url) => url.match(/video\/(\d+)/)?.[1] ?? null
derive:
  - field: profile_url
    from: url
    script: scripts/profile_from_video.js   # QuickJS, see below
enrich:
  - field: url
    enricher: tiktok-video
  - field: profile_url
    enricher: tiktok-profile
keep_tree: false                 # true keeps nested structure under each row
```

What an importer can express, roughly in order of how often it is needed:

1. **Select**: one row path and named field paths (with language alternatives via `{a,b}`).
2. **Convert**: `as:` types such as `int`, `float`, `bool`, `datetime` (format string, epoch units like the old `int_to_date`, or "any date" parsing), `url`, `domain`, `duration`.
3. **Filter**: simple expressions (`where: "url ~ 'google\\.com/search'"`), ported from the old `filter_regex` and filtrex use.
4. **Built-in transforms**: replace, tokenize, url-to-domain, split, lowercase, hash (all from the old transformer list).
5. **Keep tree**: instead of flattening, keep nested children under each row as a subtree, so views can unfold them later (see [visualization.md](visualization.md#trees-and-tables)).
6. **Script**: a JavaScript function, run in QuickJS, for whatever the declarative parts cannot do.
7. **Enrich**: which fields can be sent for enrichment, and by which enricher (still subject to participant consent).

Old recipes from data-donation-importers can be converted mechanically: `file` → `match.file`, `rows_selector` → `select.rows`, `columns[].selector` → `fields.*.path`, `transformers` → `as`/`where`/built-ins. A converter is a good first test of the path language.

### Scripts in QuickJS

Custom JavaScript runs in [QuickJS](https://bellard.org/quickjs/) compiled to WASM (`quickjs-emscripten`), inside the sandbox worker:

- No network, no DOM, no `fetch`, no timers beyond a bounded budget. Only the values passed in and a small standard library (dates, regex, string helpers).
- Memory and CPU limits per call; a runaway script is killed and the importer reports which row failed.
- Scripts are pure functions of their input (a value, a row, or a subtree), which makes them testable and cacheable.

This lets researchers share importers with confidence that an importer cannot quietly send data anywhere, even if its author was careless or malicious.

### Importer Studio

The data-donation-importers GUI showed that researchers write recipes fastest when they can see their own data. Importer Studio is part of Combray Studio, the local researcher tool:

- Drop in a DDP (your own, or a synthetic one). It stays local, like everything else.
- Browse the tree. Click a node to mark it as rows or as a field; Combray proposes the path, generalised over siblings (`[3]` → `[*]`) and language variants it has seen in shapes.
- See a live preview of the resulting dataset as a tree and as a table.
- Add conversions and scripts with immediate feedback.
- Export the importer YAML plus a synthetic fixture generated from the shape (values replaced with fake data), so tests can be committed without real data.
- Work from **shapes only**: researchers can draft an importer from donated structure metadata without ever seeing a real file.

### Testing and versioning

- Every importer in `importers/` has synthetic fixtures and expected outputs. `combray importer test` runs them in CI.
- Importers are versioned; donations record importer ids and versions.
- When a participant's file does not match any known shape, Combray tells the facilitator and (with consent) records the shape so the importer can be updated.

## Structure metadata

When a donation is made, Combray can (with consent, as its own item in the donation preview) include the **shape** of every file in the DDP. Shapes help researchers see how formats vary by platform version, language and account type, and keep importers working.

A shape keeps only structure:

- Directory and file names, node kinds, keys, list lengths in coarse buckets (`0`, `1`, `2-10`, `11-100`, `101-1k`, `>1k`), inferred value types, and for HTML the tag, `id` and `class` values.
- No values: no strings, numbers, dates or URLs.

Names can be data too, so the shape extractor detects and collapses them:

- **Dictionary-like maps.** If a map has many keys that look like values (high cardinality, keys that look like dates, numbers, emails, usernames, or that differ across siblings with the same structure), its keys are collapsed to `{*}` and only the shape of the values is kept. Example: Instagram `messages/inbox/johnsmith_1234/` becomes `messages/inbox/{*}/`.
- **Name screening.** Keys, filenames, ids and classes are checked against patterns (email, phone, long digit runs, URL, base64/hex tokens) and replaced with a type marker if they match.
- **Allowlist mode.** For stricter studies, only names that also appear in a public reference shape (from synthetic or researcher-owned DDPs) are kept; everything else is replaced with a marker.

### Researcher decisions and new paths

Researchers decide per leaf of a project's tree whether it is `ignore`d, `show`n to the participant, or requested for `donate` (which implies show); inner nodes can be ignored as a whole, and tables are inferred from the structure. Leaves nobody has decided on yet are `undecided`, and the client shows them. The full design, including how tables are inferred, HTML normalisation, aliases and the nameless upload root, is in [tree-decisions.md](tree-decisions.md). To decide well, researchers need to see structure their own test export did not have, so the server keeps each project's known structure metadata and sends it to the client. After an import, the client compares locally and, only when it finds paths the server has not seen, asks the participant whether it may send just those paths. The request shows exactly the paths, says that no content is sent, and offers "yes", "no, these contain private information" and "no, another reason". See [security.md](security.md#structure-metadata-and-consent).

Shapes are hashed into **fingerprints** so importers can declare which variants they support and Combray can pick the right importer automatically. The participant sees the shape in the donation preview in readable form ("the structure of 214 files, without any of your content").

## Open questions

- YAML or JSON for importer specs? YAML is friendlier to write by hand; JSON is simpler to generate. Recommendation: YAML on disk, JSON schema for validation, both accepted.
- How should importers handle very large HTML exports (e.g. old Google Takeout `MyActivity.html`)? A streaming HTML tokenizer in Rust may be needed instead of `DOMParser`.
- Should we keep the "cookbook" concept (groups of recipes per platform) as a "platform pack" with instructions, importers, default views and enrichers together? Recommendation: yes.
- Should there be a public importer registry that deployments can pull from, and how are importers reviewed before inclusion?
- Exact thresholds for dictionary detection need tuning on real-world shapes from consenting team members.
