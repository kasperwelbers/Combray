# Plan: stories, free exploration and what researchers learn

Status: **plan, for discussion** (written 2026-11-05 with Kasper). Only the donate step (phase 0) is being built now. The rest is for discussion with more people before we build it. It brings together ideas that were spread over [visualization.md](../visualization.md) (views, probes), [exploration.md](../exploration.md) (saved views, the chart builder for participants) and [ai-helper.md](../ai-helper.md).

## The idea in one paragraph

A participant who uploads their data first gets a **story**: a short series of slides, made by the researcher, that walks them through their own data, a bit like Spotify Wrapped. "You searched Google 4,312 times last year. Your busiest hour was 23:00." Slides show numbers in the text, charts, top lists and single memories, and they ask questions ("Which of these channels meant something to you?"). Next to the story, participants can always **explore freely**: browse, search and chart everything they uploaded. Before they donate, they **see exactly what would be sent and can remove anything**. Researchers get the donated data, the answers to their questions, and which version of the story was shown. That's all for now: no tracking of how people move through the app.

## The participant's path

1. **Arrive** through the study link, set a password (exists).
2. **Upload** each platform the study asks for (exists).
3. **The story.** It starts on its own after the first upload, and can be reopened. Slides about platforms the participant did not upload are skipped.
4. **Explore** at any moment: the processed tables, memory lane, timeline, top items, search (partly exists), and later the chart builder for participants.
5. **Review and remove.** The donation preview shows what would be sent, per table. Participants remove rows one by one, by search ("everything with 'doctor'") or by period. What they remove disappears from the preview and the donation, and stays removed if they come back.
6. **Donate**, with the consent text, and get a **receipt** with a way to withdraw.

In a lab session the interviewer walks through steps 3 to 5 with the participant. At home, the story carries the participant through on its own.

## Stories

A story belongs to a **project** (it can use every platform in it). Platform packs can ship ready-made slides that researchers add and edit. A story is a list of slides. A slide is a list of **blocks**:

| Block | What it shows |
| --- | --- |
| Text | A heading and a few sentences, with **values** inline (see below). Plain styling only: bold, italic, lists. No links to the outside, no HTML |
| Number | One big value with a caption ("4,312 searches"), counted up when the slide opens |
| Chart | A chart from the chart builder (timeline, ranked bars, by hour or weekday) |
| Top list | The top N of a column, with thumbnails once enrichment exists |
| Memory | One row from the data, picked at random or by a rule ("your first video", "a search from this day last year"), shown as a card |
| Table | A small slice of a table, to show what the data looks like |
| Question | Choice, scale, short text, or a question per item of a top list ("Which of these meant something to you?") |

Researchers build stories in a **block editor** in the studio, not by writing a text format. That matches researchers who have no programming background. A slide is the blocks stacked, with a few layouts (one block; big number + text; chart + question). **Templates** make it quick: "A year of YouTube", "Your searches", "A typical day". The editor previews the story on the loaded test packages, as on the "view as participant" tab today.

### Values in text, and references that stay put

Text refers to **summaries**: named results such as `searches.count`, `watch history.busiest hour` or `channels.top 1`. A summary is a small query on one table (count, distinct values, top N, sum or mean, first and last date, busiest hour or weekday, longest streak), built with the same JSON queries as the charts. Researchers make them in the editor, or the AI helper suggests them.

References must be simple and stable, without researchers having to invent ids. Tables and columns already have one: the **name id** from names and matches (ADR 0012). The editor inserts references as chips, which show the name's current text, so researchers never type an id, and spaces or other scripts in a name don't matter. When a name's text changes, its id stays, and so does every reference to it. One proposal: give new names a readable id made from their first text (`watch-history`, with `-2` if taken) instead of a random one, so stored stories and donations stay readable.

Values need care in text:

- **Zero, missing and one.** Every value has fallbacks: what to say when the participant has no such data (skip the sentence, the block or the slide, or show a replacement sentence), and plural forms per language ("1 search", "4,312 searches"; Dutch "1 zoekopdracht", "4.312 zoekopdrachten").
- **Formatting** follows the participant's language: numbers, dates, hours, durations.
- **Tone.** Numbers about someone's life can sting ("You watched 9 hours a day"). The design identity's tone rules apply. A template's wording is reviewed for this, and the editor can show a gentle reminder for values about time spent.

### Questions and answers

Answers are kept in the encrypted local store and go into the donation, shown in the preview like everything else (`answers` in the donation payload). A question about items ("Which of these channels meant something to you?") answers with the items themselves. That makes the answer data from the participant's export, so it gets the same review as donated values. Every answer records the question's id and the story's version, so researchers know exactly what was asked.

### Donating summaries instead of rows

Summaries are also a good way to donate less. A researcher who only needs "searches per week" can ask for that summary instead of every search. This is data minimisation that participants can easily understand, and the preview shows the numbers. We should make it possible to mark a summary `donate` like a column.

## Free exploration

What exists (processed tables, memory lane, timeline, top items, the raw data browser) becomes one place to wander through:

- **Search across everything** the participant uploaded, with results grouped by table.
- **Motion with a purpose.** Opening a table grows it out of its card, moving from a top list to its rows keeps the clicked item in place, and numbers count up. We'd use the View Transitions API and small FLIP animations, all off with `prefers-reduced-motion`.
- **Enrichment** ([enrichment.md](../enrichment.md)): titles and thumbnails for video and channel links, after the participant's consent. This makes the biggest difference to how much fun the data is to look at, because people recognise thumbnails, not ids.
- **The chart builder for participants** (exploration.md, next step 1), starting from the researcher's saved charts.
- **Remove from here too.** Every row has "leave this out of my donation", so participants don't have to wait for the review step.

## What researchers get

For now, only what we ask for, with consent: the donated values, donated summaries, answers, and the version of the configuration and story that was shown. Measuring the experience itself (time on slides, which tables were opened) is out of scope until we have a reason and a consent text for it.

## AI support

Two tracks, in this order:

1. **A remote helper for researchers** (ai-helper.md). It sees only structure (names, types, formats) and returns JSON that the studio checks: summaries, charts, draft slides, question wording, and suggestions for names and conversions. It never sees values, so researchers can use a strong model without a data agreement. This is the quickest way to make the studio easy.
2. **Local models on the participant's device**, as a research track. Small classifiers and extractors (topic of a video title, "is this search about health", detecting names for anonymisation) run in the browser (WebGPU or WASM) on the real data, and their output becomes new columns that researchers can use in summaries and donations. Because nothing leaves the device, these can see values. It needs a sandboxed plugin interface (privacy rule 6), measurements of speed and download size, and a validation story. It could start with one model, for example a topic classifier for YouTube titles.

A chat for participants is not planned: few people would use it, and we would have to tell them not to put their own information in their questions.

## Phases

0. **Donate step (now, for the pilot).** The donation preview built from the researcher's `donate` fields, removing rows, consent, the `#k=` key check, sending, a receipt with withdrawal. No story yet.
1. **Stories, first version.** Summaries, the text, number, chart and top list blocks, simple questions (choice, scale, text), answers in the donation, a default story per platform pack, and a block editor without templates.
2. **Exploration.** Search across everything, transitions, removing rows from anywhere, the chart builder for participants.
3. **Richer stories.** Memory and table blocks, questions per item, templates, donating summaries, enrichment thumbnails in slides.
4. **AI helper for researchers.**
5. **Local models**, as a spike first.

## Questions to discuss with others

- Which three or four slides would a typical study want? Collecting real examples from colleagues would give us the first templates.
- Should a story be one fixed path, or can a slide branch on an answer ("if they picked 'meaningful', ask why")? I'd start with one fixed path, plus slides that are skipped when their data is missing.
- How much freedom should the participant's own chart builder give before it becomes confusing?
- Do participants want to keep their story, as an image or a little booklet? (This is the "story export" question in visualization.md.) Anything that leaves the app has to stay on their device.
- Which local model would be worth a first try, and what would researchers trust it for?
