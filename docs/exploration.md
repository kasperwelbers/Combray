# Exploring data: formats, the researcher's view, queries and charts

Status: **partly built** (2026-10-29). Value formats, the researcher's tables-and-fields view, the query pipeline and a first chart builder in the researcher workspace exist. Charts for participants, saved views and the AI helper writing queries are next.

This picks up from [tree-decisions.md](tree-decisions.md): once a project tree says which fields are shown and donated, and tables are inferred from the structure, researchers and participants need to explore what is in them. [visualization.md](visualization.md) describes the participant-facing views and probes; this document is about the machinery underneath, and about what researchers see while they set up a project.

## Contents

1. [What researchers can see](#what-researchers-can-see)
2. [Value formats](#value-formats)
3. [The researcher's view of the tree](#the-researchers-view-of-the-tree)
4. [Queries](#queries)
5. [Charts](#charts)
6. [Next steps](#next-steps)
7. [Open questions](#open-questions)

## What researchers can see

Researchers set up a project from two sources:

- **Their own exports**, loaded in the researcher workspace. Values are shown, because they are the researcher's own; they stay in the workspace's worker (see [security.md](security.md#researcher-workspace)).
- **Structure metadata from participants**, sent only with consent and only for paths the server has not seen (see [security.md](security.md#structure-metadata-and-consent)). This never has values. A donation would have values, but only the researcher's key tool can decrypt it, and a donation contains only what was asked for.

The gap is structure the researcher's own exports do not have: a field that is a date in another language, or a map whose keys are people's names. The structure metadata has to carry enough to set up parsing and views without seeing a value. That is what value formats are for.

## Value formats

A **format** says how a value is written, without the value: `2010-12-05` is `YYYY-MM-DD`, `Mar 4, 2021, 9:20:30 PM CET` is `MMM D, YYYY, H:mm:ss A Z`, and `1709284500` is `epoch-s`. Shapes keep the formats seen at each position (at most 8), next to the inferred types (`packages/core/src/formats.ts`).

- **Tokens only.** A format is built from tokens (`YYYY MMM MM M DD D HH H mm ss SSS A Z X`) and separators. If any part of a value is not a known token, such as a word that is not a month name, there is no format. So no text from a value can end up in one. Structure files are validated against the same grammar (`isFormat`), so a crafted file cannot smuggle values in either.
- **Dates** in ISO 8601, day-month-year with any separator, and written dates with month names in English, Dutch, German and French. Times, AM/PM, zone abbreviations and offsets are tokens too.
- **Day or month.** `4/3/2021` could be either; such a value is `X/X/YYYY`. `dateFormats` resolves it from other values at the same position (one `24/3/2021` settles it), or else offers both, day first.
- **Timestamps.** Whole numbers that would fall between 2001 and 2100 as seconds, milliseconds or microseconds since 1970 get `epoch-s`, `epoch-ms` or `epoch-us`. The type stays `int`; the format is a hint that it could be a time.
- **Keys that are data.** A collapsed map (`{*}`) keeps the types and formats of its keys (`keyTypes`, `keyFormats`), not the keys: "the keys are dates, written `YYYY-MM-DD`" or "the keys are text".
- The formats are the ones `parseDate` reads, so a researcher (or the AI helper) can use one as is to parse a field.

### Fake examples, later

Kasper suggested a local model that, given many real values, makes up a few that look like them, so a researcher sees what kind of thing is in a field. This is promising but needs care: a model shown real values can copy them, and "looks like" is exactly what makes a value identifying (a rare name, a street). If we build it, it runs on the participant's device, its output is checked against the real values (no exact or near copies, no rare tokens) and it is sent only with the same specific consent as structure metadata, shown to the participant first. Until then, formats, types and bucketed counts are what is shared.

## The researcher's view of the tree

The decision tree in the workspace has two views:

- **Tables and fields** (the default): only the inferred tables and the fields in them, named as their columns will be (labels, or the shortest unique suffix of the path). Objects, folders and HTML structure in between are left out: `stats/likes` is just `likes` in the tweets table when nothing else is called `likes`. Hovering a field shows its full path (`tweets / each item / stats / likes`). HTML element names keep only the classes that tell them apart (`div.mdl-cell--6-col` next to `div.mdl-cell--12-col`).
- **Full tree**: everything, for ignoring a whole folder or HTML block, labelling an object or merging renamed keys.

Both views colour rows by their state rather than putting buttons on every row: shown fields get a green tint and donated ones a warm tint, ignored rows are greyed out, and undecided fields have a dashed "Undecided" pill. The pill says the state in words too, so colour is never the only cue. Icons tell tables (▦), lists of values (⋮), objects (`{ }`), HTML elements and folders apart, and leaves show their type (text, number, date, link). A selected row's decision is changed in the side panel, or with keys 1 to 4 (undecided, ignore, show, donate). The side panel can also set every field inside a group at once, and shows the formats seen. "Hide what is ignored" and "only what is still undecided" make long trees short.

## Queries

A **query** is a small pipeline of verbs, inspired by dplyr and tidyr, that runs locally on derived tables (`packages/core/src/query.ts`). It is plain JSON, so a project can ship queries for its views and the AI helper can write them from the structure alone ([ai-helper.md](ai-helper.md)); they only ever run in the browser.

```json
{
  "from": 0,
  "steps": [
    { "unnest": 1 },
    { "mutate": "month", "from": "created_at", "fn": { "datePart": "month" } },
    { "filter": "comments/[*]/by", "test": { "empty": false } },
    { "group": ["month", "comments/[*]/by"] },
    { "summarise": [{ "name": "n", "fn": "count" }] },
    { "arrange": "month" }
  ]
}
```

| Verb | Does |
| --- | --- |
| `from` | Starts at a table. Its columns are named by their ids (the path from the row, `stats/likes`). |
| `unnest` | One row per row of a nested table, with the parent row's columns alongside (an inner join; `keepEmpty` keeps parents without nested rows). Nested columns are prefixed with the path to them: `comments/[*]/by`. Chains down: unnest comments, then their likes. |
| `unnestList` | One row per item of a list cell (`tags`), like `unnest_longer`. |
| `filter` | Keeps rows where a column is (not) empty, equals a value or one of several, contains text, or lies in a range (numbers as numbers, ISO dates as text). `not` negates. |
| `mutate` | A new column from another: `date` (parse, with an optional format), `datePart` (year, month, week starting Monday, day, weekday, hour), `number`, `lowercase`, `domain`, `words`, `length`. |
| `select` | Keeps some columns. |
| `group` + `summarise` | Count rows, count distinct values, or sum, mean, min or max per group. |
| `arrange`, `limit` | Sort and cut. |

This is where nested data is unnested: the tables stay nested ([tree-decisions.md](tree-decisions.md#nested-tables)), and a view decides which level it counts. Not built yet: `join` (two tables on a shared column), `pivot` (longer and wider), and windows (running totals, ranks).

Dates are kept as the export wrote them. Times with a zone become UTC, times without one stay "floating" as written (see `parseDate`). Grouping by day or hour uses that text, so a UTC timestamp is grouped in UTC for now; see the open questions.

## Charts

The workspace has a first chart builder below the preview (`apps/web/src/studio/ChartBuilder.tsx`). It turns a few choices into a query (`chartQuery` in `packages/core/src/chart.ts`):

- **Rows of** a table, nested or not. A nested table is unnested from the top, so columns of the tables above it can be used: comments over the time of their tweet.
- **Along** a column. A date or timestamp makes a timeline per year, month, week, day, day of the week or hour of the day, with empty periods as zero. Anything else makes ranked bars of the 15 largest values (items of a list cell count separately).
- **Show** the number of rows, the number of different values of a column, or the sum, average, lowest or highest of a number.
- **Split by** a column into at most 5 series (lines, or stacked bars).

The query runs in the workspace's worker on all loaded exports; only the counts come back to the page. The chart is SVG drawn by React, so labels are text, never HTML. It follows the project's chart rules: one axis, thin marks with rounded ends, a validated colour order for series (separately stepped for dark mode), a legend from two series, a crosshair and tooltip on timelines, a tooltip per bar, keyboard focus showing the same, and a table view of every value.

The same builder is meant for participants, on their own data, inside the participant views ([visualization.md](visualization.md)). Researchers would then save charts in the project (as chart specs in `importer.json`) as the views participants start from.

## Next steps

1. **Charts for participants**: the builder in the participant views, on the fields the project shows, with the researcher's saved charts as starting points.
2. **Saved views**: chart specs and queries in `importer.json`, with labels and descriptions, validated like the rest of the file.
3. **Parsing settings per field**: the format a field is parsed with (picked from the formats seen), used by charts, the preview and donations.
4. **The AI helper writes queries and chart specs** from the structure, formats and the question asked ("how often did I watch at night?"). It returns a spec; the client runs it.
5. **More verbs**: `join`, `pivot`, windows.

## Open questions

- **Time zones.** Should participant views show times in the participant's own zone (from the browser), and what do we do with floating times from exports that do not say their zone?
- **Formats beyond dates.** Decimal commas (`3,14`), durations (`PT1H2M`, `1:02:03`) and currencies are candidates. Each needs a token grammar that cannot carry text.
- **Fake examples.** Is a local generator worth its risk (see above), or are formats and types enough in practice?
- **How much of the query language do researchers see?** The builder covers the common cases. A text form of queries (for researchers who know R) could come later, as long as it compiles to the same JSON.
