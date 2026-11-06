# CSV and TSV

*Part of [How Combray reads files](README.md). Covers `.csv` and `.tsv` files.*

## In short

A CSV file is one table: the first line holds the column names, every other line is a row. Combray recognises the separator (comma, semicolon, tab) by itself.

## How it becomes a tree

| In the file | In the tree | In the studio |
| --- | --- | --- |
| the file | a list of rows | a table, with **each item** as its rows |
| the first line | the names of the columns | the fields of the table |
| a cell | a value, with its type recognised | a field |

## Tables

There is only one way: the file is the table. A file that holds several tables one after the other (some spreadsheets exported as CSV) is read as one table with odd rows; tell us if you meet one.

## Hard cases

### C1 The header row

**Looks like:** `Date,Title,URL` on the first line.

**What you see:** fields `Date`, `Title` and `URL`. **Status:** handled.

### C2 Two columns of field and value

**Looks like:** account information written as a list of fields:

```csv
Field,Value
Username,jansmith
Created,2019-04-01
Country,NL
```

**What you see:** a table with columns `Field` and `Value`, one row per field.

**What to do for now:** show or donate the two-column table, and turn it around in your analysis (in R: `tidyr::pivot_wider`). If you only want some fields, filter the rows on `Field`. **Status:** open. It is the CSV form of [H6](html.md#h6-labels-and-values-that-take-turns).

### C3 Empty and repeated headers

**Looks like:** `Date,,Title,Title`.

**What you see:** an empty header becomes `column_2`; a repeated one gets a number: `Title`, `Title_2`. **Status:** handled.

## Tips

- Values are text in CSV; use **Read as** to read a column as a date, number or link when Combray did not recognise it.
- A file that opens as one long column of text has a separator Combray did not recognise; tell us which.

## For developers

- Parser: `parse/csv.ts` (Papa Parse, separator sniffed; `.tsv` is always tab).
- Unlike HTML table headers, CSV headers always become names, also on a participant's device, without checking them against the extractor (`knownKeys`). Headers are written by the platform, and a CSV whose header is data is very rare. Names that look like data are still screened (`screenName`). If we meet CSVs with data in their header, the parser can take `keys` as HTML does.
- Tests: `fileFormats.test.ts` (C1 to C3).
