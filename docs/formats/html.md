# HTML and XML

*Part of [How Combray reads files](README.md). Covers `.html` and `.htm` files, such as Google Takeout's "My Activity" pages and Instagram's or Facebook's HTML exports, and `.xml` files.*

## In short

HTML is made for showing, not for data. The same kind of information is written in many ways, and which text is a name and which is a value is often only clear to a person reading the page. Combray tidies the page up into a tree that compares well across rows and people (this is called *normalising*), uses what the HTML itself says about names (table headers, definition lists), and keeps everything else as values. Where names are written as text, you say so in the studio.

## How it becomes a tree

| In the file | In the tree | In the studio |
| --- | --- | --- |
| an element `<div class="content-cell">` | named by its tag and its stable classes: `div.content-cell` | a group |
| two or more siblings with the same tag and classes | a list | a table, with **each item** as its rows |
| text | a value named by its position among the texts of its element: `#text[0]`, `#text[1]` | a field |
| `href`, `src`, `datetime`, `title`, `alt`, `value`, `content` attributes | values named `@href`, `@src`, … | a field (a link, an image) |
| other attributes (`style`, `class`, `id`, …) | names of elements only, or dropped | |
| `<table>` | a list of rows, each with one field per column | a table |
| `<dl>` | one field per term | a group |
| `<script>`, `<style>`, empty elements, `<br>` | left out | |

Classes that differ between rows (layout classes such as `mdl-cell--6-col` in one row and `--12-col` in the next) are dropped, so one kind of thing keeps one position.

## Tables

HTML shows tables in three ways, and Combray reads each:

1. **A real `<table>`.** Rows are rows, cells are columns, named by the header (H3, H4).
2. **Repeated blocks.** A `<div>` per activity, a `<li>` per item: every repeated element is a row, and what is inside it are the columns (H1). This is how most HTML exports look.
3. **Labels and values written out.** A block per item with a label before each value (H6), or the labels in one place and the values in another (H7). Combray reads these once you mark them.

## Hard cases

### H1 Repeated elements

**Looks like:** `<div class="outer-cell">…</div>` once per activity.

**What you see:** a table of `div.outer-cell`, one row per activity. Two siblings with the same tag only count as a list when they have a class, there are three or more of them, they are list items by nature (`li`, `tr`, `option`, `article`), or they hold the same kind of content. Otherwise they are two different things, numbered: `div[0]`, `div[1]`. An element that occurs once in one row and several times in another is still one position. **Status:** handled.

### H2 Text between links and other inline elements

**Looks like:** `Watched <a href="…">A video</a><br><a href="…">A channel</a><br>3 Jan 2024, 10:00:00 CET`

**What you see:** the pieces by position: `#text[0]` (Watched), `a[0]` (the video), `a[1]` (the channel), `#text[1]` (the time). Each is a field you can name: `title`, `channel`, `time`. **Status:** handled.

### H3 Tables with a header

**Looks like:** `<table><thead><tr><th>Date</th><th>Title</th></tr></thead>…</table>`, or a first row of only `<th>` cells.

**What you see:** columns named `Date` and `Title`. On a participant's device a header becomes a name only when your extractor knows it; a header you have never seen becomes `#cell[2]`. **Status:** handled.

### H4 Tables whose header is a normal row

**Looks like:** a first row of ordinary `<td>` cells with the column names.

**What you see:** Combray takes the first row as the header only when it is clearly one: every cell is short, plain text, used once, not repeated as a value further down, and the row is set apart (bold, or a class no other row has) or sits above values of another type (`Date` above dates). Otherwise columns are named by position (`#cell[0]`) and the names are the first row of data.

**What to do:** on the table, **Filter rows** › **The first row holds the column names**. Participants then see that row as the column names. The data, and what is donated, keep the row as it is. **Status:** handled; you can correct.

### H5 Definition lists

**Looks like:** `<dl><dt>URL</dt><dd>https://example.com</dd><dt>Title</dt><dd>A page</dd></dl>`

**What you see:** fields `URL` and `Title`. A term your extractor does not know keeps a position on a participant's device: the term as `#dt[0]`, its description as `#dd[0]`. **Status:** handled.

### H6 Labels and values that take turns

**Looks like:** a label followed by its value, with nothing in the HTML that says which is which:

```html
<div class="entry">
  <span>url</span><span>https://example.com/1</span>
  <span>title</span><span>A page</span>
</div>
```

or a block per field: `<div><span>url</span><span>https://…</span></div><div><span>title</span><span>A page</span></div>`, or `<p><b>url</b> <a href="https://…">link</a></p>` once per field.

**What you see:** the spans are repeated siblings, so they become a list, and labels and values end up in one column: `url`, `https://example.com/1`, `title`, `A page`.

**What to do:** see [Names written as text](#names-written-as-text) below. **Status:** you correct. Seen in a researcher's example package (2026-11).

### H7 A list of labels beside a list of values

**Looks like:** the labels in one block and the values in the next, in the same order:

```html
<div class="entry">
  <div><h1>url</h1><h1>title</h1><h1>time</h1></div>
  <div><span>https://example.com/1</span><span>A page</span><span>3 Jan 2024</span></div>
</div>
```

**What you see:** two unrelated lists, `div[0] / h1` with the labels and `div[1] / span` with the values.

**What to do:** see [Names written as text](#names-written-as-text) below. **Status:** you correct. Seen in a researcher's example package (2026-11).

### H8 Fixed words in running text

**Looks like:** `Watched <a>…</a>`, `Searched for <a>…</a>`.

**What you see:** the fixed word is a value of its own (`#text[0]`), the same in every row of its kind. That is fine: it often says what kind of activity a row is, which is useful data. Use a row filter on it to keep only one kind. **Status:** handled.

### H9 Classes and ids that are data

**Looks like:** `<div id="post-1700000000">`, `<div class="user-jansmith_1234">`.

**What you see:** the data part is replaced, as for JSON keys: `div#<number>`, `div.<id>`. An id that differs in every row is dropped from the rows of a table. **Status:** handled.

### H10 Field names from layout classes

**Looks like:** `<div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">`.

**What you see:** fields you have not named yet are called after their position, which can be long: `div_mdl_cell_6_col_text_0`.

**What to do:** give the fields you use a name of your own (`title`, `time`); participants see your names. **Status:** you name them. Shorter automatic names are an open idea.

### X1 XML attributes

**Looks like:** `<Record type="StepCount" value="1200" startDate="2024-01-03 10:00:00"/>` (Apple Health's `export.xml` is written like this).

**What you see:** only the attributes that are data in HTML (`value`, `title`, `href`, …) are kept, as `@value`. Others, such as `type` and `startDate`, are dropped.

**What to do for now:** nothing in the studio; tell us when a study needs XML. **Status:** open. Keeping every attribute of XML files is a small change once there is a real package to test with.

## Names written as text

When the names of fields are written as text in the HTML (H6, H7), you tell Combray where:

1. Find the part that holds the labels and the values in the **Full tree** view. It is usually the table of entries (`div.entry`), or one block inside each entry.
2. Match it if it is not matched yet (only matched parts have settings).
3. Open **More** › **Names written as text** › **Texts here are names**. The button is there when the part has one list (labels and values taking turns, or a block per field) or two lists (labels beside values).

Each label then becomes the name of the value next to it: `url`, `title` and `time` appear as fields with their values, and the lists they were read from are gone. Name them and decide on them like any other field. **Read them as values again** undoes it.

What happens on a participant's device:

- The same reading is done, with one difference: a label only becomes a name when your extractor knows it. A label you have never seen (`duration`) keeps a position, the label as `#dt[3]` and its value as `#dd[3]`, and is shown as a new part. Its text is never shared, because it is text from the participant's file.
- In an entry where the labels and values do not line up (more labels than values, an odd number of spans), nothing is read as names; that entry keeps its lists, as before.

## Tips

- Use the **Full tree** view to understand an HTML export; the **Names** view only shows what you have named.
- Look at a few rows of every kind before you decide: HTML exports often mix kinds of activity in one list (a watched video, a search, a visited page), each with slightly different content.
- When a field holds two things (a link and its text), you get both: `@href` for the link and `#text[0]` for its text.
- Fixed words are useful for row filters (H8).

## For developers

- Parsing: `parse/html.ts` (htmlparser2, because `DOMParser` is not available in web workers). XML uses the same parser in XML mode.
- Normalising: `normalize.ts`. H1: `looksRepeated`, `stabilize`, `MIN_REPEATS`. H2: inline positions in `normalizeGeneric`, `unwrapLink`. H3/H4: `normalizeTable`, `firstRowIsHeader`; the `headerRow` setting is display only (`headerNames` in `derive.ts`). H5: `normalizeDl`. Header and term text becomes a key only through `NormalizeOptions.keys` (`knownKeys` on participants' devices, anything in the studio).
- H6/H7: `textNames` (`'pairs'` or `'beside'`, fixed by `textNamesOf` when the researcher marks it) and `applyTextNames` in `corrections.ts`, run after normalising by `prepareTree` and by the studio worker. Seen structures recorded before the mark lose the lists in `correctedShape`; the studio reads its loaded packages again when a mark changes.
- H9: `elementName` and `screenName` in `shape.ts`. X1: `DATA_ATTRIBUTES` in `normalize.ts`.
- Background: [tree-decisions.md](../tree-decisions.md#html).
- Tests: `fileFormats.test.ts` (H1 to H10, X1) and `corrections.test.ts`.
