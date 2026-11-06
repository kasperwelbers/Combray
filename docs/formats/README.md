# How Combray reads files

*For researchers who build extractors in the studio, for reviewers, and for developers of the parser. The first part of each page is for everyone; the "For developers" part at the end points into the code.*

Data download packages come as JSON, HTML, CSV, plain text, media files, and folders and zips that hold them. Combray reads all of them into one **tree**: folders hold files, files hold their contents, and every piece of data sits at the end of a path, such as `YouTube/history/watch-history.json / each item / title`. The studio shows you that tree. You name the tables and fields you want, and decide what participants see and donate.

One page per format:

- [JSON](json.md), also JSON Lines and the JavaScript files some platforms use
- [HTML and XML](html.md)
- [CSV and TSV](csv.md)
- [Plain text, media, folders and zips](files.md)

## Names and values

Everything in the tree is either a **name** or a **value**. Names are the structure: the keys of a JSON object, the column names of a CSV, the tags and classes of HTML, folder and file names. Values are the data: what is written in them.

This split matters more than anything else, because Combray treats the two very differently:

- **Names are shared.** The structure (names only, never values) is what the studio compares across packages, what is published to participants' devices so they can spot new parts, and what participants may share with you when their package has something new.
- **Values stay with the participant** unless they choose to donate them.

Export formats do not always put things on the right side. That is where almost every hard case on these pages comes from, and they come in two directions.

### Data in names

A name that is really data: `{"anna": "great video!", "bob": "nice"}`, where the keys are the people who commented, or a folder per conversation partner. If Combray kept those as names, people's names would end up in the structure that is shared.

**What Combray does.** Names that look like data are replaced by what they are: emails, links, dates, numbers, ids and long tokens become `<email>`, `<url>`, `<date>`, `<number>`, `<id>`, `<token>` everywhere a structure goes. Maps whose keys look like data (many different keys, or keys that differ from row to row) become one position, **each key**, with the key as a value.

**What you do.** When Combray did not notice, open **More** on the part and choose **The keys are data**. Each key then becomes a row with a key and a value column. The keys are left out of everything published from then on.

### Names in data

A value that is really a name: an HTML page where the label "url" is written as text next to the link. Combray keeps it as a value, because in a participant's file any text could be data. You then see the labels in your data, mixed in with what you want.

**What Combray does.** Where the format says what a name is, Combray uses it: table headers in HTML (`<th>`), terms in definition lists (`<dt>`), the header row of a CSV. Text everywhere else stays a value.

**What you do.** For a table whose header was written as a normal row: **The first row holds the column names** (under **Filter rows** on a table). For labels written next to their values: **Texts here are names** (under **More**), see [HTML](html.md#names-written-as-text).

## Rules that hold for every format

1. **When in doubt, a value.** A name that is really data is a privacy problem; a value that is really a name is only an inconvenience. The parser accepts the inconvenience and lets you correct it.
2. **Text from a participant's file only becomes a name when your extractor already knows that name.** In the studio, any header or label in your own test packages may become a name; that is how names get into your extractor. On a participant's device, a header or label you have never seen keeps a position instead (`#cell[2]`, `#dt[0]`), and its text is never shared. *(Exception: CSV headers always become names, see [CSV](csv.md#for-developers).)*
3. **Corrections are settings in your extractor.** "The keys are data" and "Texts here are names" are applied the same way in the studio and on every participant's device. The structures you have seen stay as they were recorded; what is published goes through your corrections.
4. **New parts are asked about, nothing new is donated without you.** A part your extractor has not seen is shown to participants as new, and only donated after you decided on it.
5. **Nothing is guessed when a row does not fit.** A correction that does not line up in a row (an odd number of labels and values, say) leaves that row as it is.

## All hard cases

| Case | Format | Direction | Status |
| --- | --- | --- | --- |
| [J1 Keys that look like data](json.md#j1-keys-that-look-like-data) | JSON | data in names | handled |
| [J2 An object of people, dates or ids](json.md#j2-an-object-of-people-dates-or-ids) | JSON | data in names | handled; you can correct |
| [J3 A few keys that are data](json.md#j3-a-few-keys-that-are-data) | JSON | data in names | you correct |
| [J4 Lists of label and value objects](json.md#j4-lists-of-label-and-value-objects) | JSON | names in data | open |
| [J5 Empty objects and lists that are `null`](json.md#j5-empty-objects-and-lists-written-as-null) | JSON | | handled |
| [J6 JSON inside a JavaScript file](json.md#j6-json-inside-a-javascript-file) | JSON | | handled |
| [H1 Repeated elements](html.md#h1-repeated-elements) | HTML | | handled |
| [H2 Text between links](html.md#h2-text-between-links-and-other-inline-elements) | HTML | | handled |
| [H3 Tables with a header](html.md#h3-tables-with-a-header) | HTML | names in data | handled |
| [H4 Tables whose header is a normal row](html.md#h4-tables-whose-header-is-a-normal-row) | HTML | names in data | handled; you can correct |
| [H5 Definition lists](html.md#h5-definition-lists) | HTML | names in data | handled |
| [H6 Labels and values that take turns](html.md#h6-labels-and-values-that-take-turns) | HTML | names in data | you correct |
| [H7 A list of labels beside a list of values](html.md#h7-a-list-of-labels-beside-a-list-of-values) | HTML | names in data | you correct |
| [H8 Fixed words in running text](html.md#h8-fixed-words-in-running-text) | HTML | names in data | handled |
| [H9 Classes and ids that are data](html.md#h9-classes-and-ids-that-are-data) | HTML | data in names | handled |
| [H10 Field names from layout classes](html.md#h10-field-names-from-layout-classes) | HTML | | you name them |
| [X1 XML attributes](html.md#x1-xml-attributes) | XML | | open |
| [C1 Header row](csv.md#c1-the-header-row) | CSV | | handled |
| [C2 Two columns of field and value](csv.md#c2-two-columns-of-field-and-value) | CSV | names in data | open |
| [C3 Empty and repeated headers](csv.md#c3-empty-and-repeated-headers) | CSV | | handled |
| [F1 Folders and files named after data](files.md#f1-folders-and-files-named-after-data) | folders | data in names | handled; you can correct |
| [F2 The export inside a bigger upload](files.md#f2-the-export-inside-a-bigger-upload) | folders | | handled |
| [F3 Plain text](files.md#f3-plain-text) | text | | handled |
| [F4 Media and other files](files.md#f4-media-and-other-files) | media | | handled |
| [F5 Exports split over several zips](files.md#f5-exports-split-over-several-zips) | zips | | handled |

**Handled**: Combray reads it well without help. **You correct**: Combray cannot tell, and you say so in the studio. **Open**: known, not solved yet; the page says what to do for now.

## Adding a case

When you meet a structure these pages do not cover, add it to the page of its format with:

1. **Looks like**: a small, made-up example (never real data).
2. **What you see**: how it shows in the studio today.
3. **What to do**: what a researcher can do now.
4. **Status**, and where it was seen (platform, and roughly when).

Then add the example as a test in `packages/core/test/fileFormats.test.ts`, under the same id. A test that describes today's behaviour of an open case is fine: it changes when the case is solved. Features (such as a new correction, or a preprocessor or script for a format) are added when we decide a case needs them, not before.

## For developers

- The tree model: [universal-importer.md](../universal-importer.md#the-tree-model) and `packages/core/src/tree.ts`. Parsers are in `packages/core/src/parse/`; HTML is normalised in `normalize.ts`; shapes (structure only) are taken in `shape.ts`.
- Screening names that look like data: `screenName` in `shape.ts`. Keys that are data: `isDictionaryLike` and `collapseSparseKeys` in `shape.ts`, and the researcher's `collapsed` setting (`setKeysAreData` in `decisions.ts`).
- Corrections: `corrections.ts` (`correctedShape`, `applyTextNames`, `prepareTree`). `prepareTree` is how a participant's device reads a tree for a project: normalise with the names the project knows (`knownKeys`), then read texts that are names.
- Every case on these pages has a test in `packages/core/test/fileFormats.test.ts`, named by its id.
- Design background: [tree-decisions.md](../tree-decisions.md) (HTML normalisation, tables, names and matches) and [structure-versions.md](../structure-versions.md) (what is shared).
