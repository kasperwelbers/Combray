# JSON

*Part of [How Combray reads files](README.md). Covers `.json`, JSON Lines (`.jsonl`, `.ndjson`) and the `.js` files some platforms wrap their JSON in.*

## In short

JSON is the easiest format: it already is a tree. Objects become groups of named fields, arrays become lists, and the rest are values. Almost every hard case is a key that is really data.

## How it becomes a tree

| In the file | In the tree | In the studio |
| --- | --- | --- |
| an object `{"title": …, "time": …}` | a map: one child per key, named by the key | a group, or a row of a table |
| an array `[…]` | a list: its items are positions, not names | a table, with **each item** as its rows |
| a string, number, `true`/`false` | a value, with its type recognised (text, number, date, link, email) | a field |
| `null` | an empty value | an empty field |
| a JSON Lines file | a list, one item per line | a table |

The file itself is the top of the tree, named after the file: `watch-history.json / each item / title`.

## Tables

A table in JSON is almost always **an array of objects**: each object is a row, each key a column.

```json
[
  {"title": "Watched a video", "time": "2024-01-03T10:00:00Z", "subtitles": [{"name": "A channel"}]},
  {"title": "Watched another", "time": "2024-01-04T11:00:00Z"}
]
```

- Keys that are missing in some rows are columns with empty cells.
- An array inside a row (`subtitles`) is a **nested table**: each row has its own little table. Combray keeps it nested and never flattens it silently; participants see a count, and charts can unnest it.
- An object inside a row adds its keys as columns of the same table.
- An object whose keys are data (J2, J3) is a table of its own with a key column and a value column.

## Hard cases

### J1 Keys that look like data

**Looks like:** `{"jan@example.org": {…}, "2024-01-03": {…}, "1700000000": {…}}`

**What you see:** the keys are replaced by what they are: `<email>`, `<date>`, `<number>`, also `<url>`, `<id>` (`name_1234`) and `<token>` (long random strings). File names too: `jansmith_1234.json` is `<id>.json`. The real text never reaches a structure. When at least half of an object's keys look like data, all of its keys are treated as data (J2).

**What to do:** nothing. **Status:** handled.

### J2 An object of people, dates or ids

**Looks like:** an object where every key is something different but every value has the same shape:

```json
{"conversations": {"anna": {"messages": […]}, "bob": {"messages": […]}, "carol": {"messages": […]}, "dave": {…}, "eve": {…}}}
```

**What you see:** Combray notices that the keys are data when at least half of them look like data (J1), or when there are five or more keys whose values are objects or lists of (nearly) the same shape. Keys with plain values (`{"anna": "hi", "bob": "hey"}`) are not enough on their own: see J3. The keys become one position, **each key**: a table with a key column (`anna`, `bob`) and the value's fields as columns.

**What to do:** check that it happened. If it did not, open **More** and choose **The keys are data**. **Status:** handled; you can correct.

### J3 A few keys that are data

**Looks like:** few keys per object, but different ones in every row:

```json
[{"text": "First post", "comments": {"anna": "hi"}}, {"text": "Second", "comments": {"bob": "hey", "carol": "yo"}}]
```

**What you see:** across many rows (five or more different keys, none in more than half the rows), Combray treats them as data on its own. With few rows, or a single small object (`{"anna": …, "bob": …}` in one file), it cannot tell names from data, and you see `anna` and `bob` as fields.

**What to do:** **More** › **The keys are data** on `comments`. The names you saw are then left out of the structure that is published, and a participant whose package has other people in it does not get asked about "new parts". **Status:** you correct.

### J4 Lists of label and value objects

**Looks like:** the names of fields written as values, in a list of small objects:

```json
{"label_values": [{"label": "URL", "value": "https://example.com"}, {"label": "Title", "value": "A page"}]}
```

**What you see:** a table with two columns, `label` and `value`, one row per field. The fields (URL, Title) are rows, not columns.

**What to do for now:** show or donate it as the two-column table; analysis turns it around (in R: `tidyr::pivot_wider`). **Status:** open. It is the JSON form of [H6](html.md#h6-labels-and-values-that-take-turns); "Texts here are names" could cover it once we have seen enough real packages with it. Reported in Meta (Facebook, Instagram) exports; to be checked.

### J5 Empty objects and lists written as null

**Looks like:** `"subtitles": null` in one row and `"subtitles": [{…}]` in another.

**What you see:** one position, `subtitles`, with a nested table that is empty in some rows. **Status:** handled.

### J6 JSON inside a JavaScript file

**Looks like:** `window.YTD.tweets.part0 = [ … ]` in a `.js` file.

**What you see:** the JSON after the `=`, as if the file held only that. **Status:** handled.

## Tips

- Load at least two or three test packages from different people. Keys that are data (J2, J3) are much easier to spot across packages, for Combray and for you.
- When you see a field named after a person, a date or a number, it is a key that is data: correct it before you publish, so those names never reach participants' devices.
- A nested table you do not need can stay nested; you decide per column what participants see.

## For developers

- Parser: `packages/core/src/parse/json.ts` (`jsonToTree`, `parseJson` with the script prefix, `parseJsonLines`). Files are picked by extension, or sniffed (`{` or `[`) when the extension says nothing (`parse/index.ts`).
- Value types: `infer.ts`; formats of dates and numbers: `formats.ts`.
- J1: `screenName` in `shape.ts`. J2: `isDictionaryLike`. J3: `collapseSparseKeys` (`SPARSE_MIN_KEYS`, `SPARSE_MAX_SHARE`), and the `collapsed` setting set by `setKeysAreData` (`decisions.ts`). The published structure goes through `correctedShape` (`corrections.ts`), and new keys below a collapsed map compare as `{*}` in `buildTree`.
- J5: `isNullOnly` in `decisions.ts`.
- Tests: `fileFormats.test.ts` (J1 to J6).
