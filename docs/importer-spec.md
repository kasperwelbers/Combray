# Importer spec reference

An importer turns part of an imported tree into a dataset of rows. It is a YAML (or JSON) file in [`importers/`](../importers/), validated when it is loaded. The ideas behind it are in [universal-importer.md](universal-importer.md); this page is the reference for what is implemented now. The planned successor, where the importer is a set of decisions on the tree, is described in [tree-decisions.md](tree-decisions.md).

```yaml
id: google-takeout/youtube-watch-history   # unique, stable
version: 1                                   # bump when the output changes
platform: google-takeout                     # optional: the platform pack
name: { en: YouTube watch history, nl: YouTube-kijkgeschiedenis }
description: { en: ..., nl: ... }            # optional
match:
  file: "**/{watch-history.json,kijkgeschiedenis.json}"
select:
  rows: "[*]"                                # relative to each matched file
  fields:                                    # evaluated in order
    title:
      path: title                            # relative to the row
      transform:
        - replace: { pattern: "^Watched ", with: "" }
    url: { path: titleUrl, as: url }
    channel: { path: "subtitles/[0]/name" }
    date: { path: time, as: datetime }
    video_id:
      from: url                              # start from an earlier field
      transform:
        - match: { pattern: "[?&]v=([^&]+)", group: 1 }
where: "url != null"                         # optional row filter
display: { date: date, title: title, url: url, group_by: [channel] }
```

## Matching

`match.file` is a [path](universal-importer.md#paths) from the root of the import (the archive or folder). It usually starts with `**/` so the file is found wherever it sits, and lists language variants in `{a,b}`. Every matching file contributes rows. When a single file is imported, its own name can match.

`select.rows` is a path from the matched file to the rows: `[*]` for a JSON array or CSV file, `Browser History/[*]` for an array inside an object, `**/div.outer-cell` for HTML.

## Fields

Each field has exactly one of:

| Key | Meaning |
| --- | --- |
| `path` | A path relative to the row. Values become strings, `null` stays `null`, attributes (`@href`) give their value, elements give their text, maps and lists become JSON. |
| `from` | The value of an earlier field. |

And optionally:

| Key | Meaning |
| --- | --- |
| `nth` | Use the n-th match (0-based) instead of the first. |
| `all` | Collect every match as a list. |
| `join` | Join every match into one string with this separator. |
| `transform` | Built-in transforms, in order (below). |
| `script` | A JavaScript function `(value, row) => result`, run in the sandbox (below). |
| `as` | Convert to `string`, `int`, `float`, `bool`, `datetime`, `url`, `domain`, `duration` (seconds) or `json`. Values that do not convert become `null`. |
| `format` | For `datetime`: tokens `YYYY MMM MM M DD D HH H mm ss SSS A Z` (e.g. `YYYY-MM-DD HH:mm:ss`; `MMM` is a month name, `Z` a zone or offset), or `epoch-s`, `epoch-ms`, `epoch-us`. Without it, ISO 8601, `DD-MM-YYYY` and written dates in English, Dutch, German and French are recognised. |

Dates with a time zone become UTC (`2024-03-01T09:15:00.000Z`). Dates without one stay as written (`2024-03-04T10:20:30`), which is the participant's local time.

Order of operations for a field: extract (`path`/`from`), `transform`, `script`, `as`.

### Transforms

| Transform | Effect |
| --- | --- |
| `lowercase`, `uppercase`, `trim` | As named |
| `tokenize` | A list of lowercased words of at least two characters |
| `domain` | Host name of a URL, without `www.` |
| `replace: { pattern, with, ignore_case }` | Regular expression replace (all matches) |
| `match: { pattern, group, ignore_case }` | The matched text, or a capture group; `null` if no match |
| `split: { by }` | A list of parts |

Transforms apply to each item when the value is a list.

### Scripts

A script is the source of one JavaScript function. It runs in [QuickJS](https://bellard.org/quickjs/) compiled to WebAssembly, with no network, no DOM, no timers and no host functions, a memory limit (32 MiB per import) and a time limit (200 ms per call). Values go in and out as JSON. QuickJS has the standard ECMAScript library (`RegExp`, `Date`, `JSON`, `Math`) but no web APIs such as `URL`. A script that fails or runs too long gives `null` for that row, and the error is reported with the row number.

Use scripts only for what transforms cannot do.

## Filter

`where` keeps the rows for which an expression is true. Operators: `==`, `!=`, `<`, `<=`, `>`, `>=`, `~` (regular expression), `~*` (ignoring case), `!~`, `!~*`, `and`, `or`, `not`, and parentheses. Operands are field names, quoted strings, numbers, `null`, `true` and `false`. Numbers in strings compare as numbers.

```yaml
where: "caption !~* 'Google Ads' and date != null"
```

## Display hints

`display` tells the views which fields to use: `date` (timeline, memory lane), `title`, `url`, and `group_by` (fields worth counting in top items; list fields such as words count each item).

## Testing

Each importer needs a synthetic fixture in `importers/fixtures/`, see [importers/README.md](../importers/README.md).

## Converting old recipes

`convertRecipe()` in `@combray/core` turns a data-donation-importers recipe into a spec. It maps `file`, `rows_selector`, `columns`, `int_to_date`, `str_to_date`, `replace`, `url_to_domain`, `tokenize_string`, `filter_regex` and `filter`, and lists what it could not express (such as `@INNER`) as warnings.

## Not yet implemented

`css()` path segments, `keep_tree`, shape fingerprints in `match`, `enrich`, and `hash`.
