# Visualisation and reflection

Combray's interface exists to present data back to the participant and to prompt reflection. This is the part of the tool participants will remember, so it gets the most design attention.

## Design goals

- **As simple as possible on the surface.** A participant should never see a query builder. They see a few inviting views of their data and can move between them.
- **Many views underneath.** Researchers choose from a library of visualisations per study, and each view has sensible defaults.
- **Trees are first-class.** Data is shown as it is structured, and only flattened when a view needs it.
- **Everything local.** All filtering and aggregation happens in workers in the browser.
- **Reflection built in.** Views can carry questions and prompts, and participants can annotate items.

## Trees and tables

> The query pipeline and chart builder that views are built on are described in [exploration.md](exploration.md#queries). The view spec below predates inferred tables and will move to chart specs and queries.

Most charts assume a table: one row per observation, one column per variable. Combray datasets are trees: a list of watch events, each with a list of channels; a list of conversations, each with messages.

Each view declares the fields it needs **by path**, relative to the dataset root:

```yaml
view: timeline
dataset: youtube/watch-history
x: time            # path: [*]/time
color: channel     # path: [*]/subtitles/[*]/name
```

The query engine in `combray-core` then **unfolds** the tree automatically:

1. Find the deepest list on the paths of all requested fields (here `[*]/subtitles/[*]`). That list defines the grain: one row per channel per watch event.
2. Repeat values from ancestor levels (the watch time) onto each row, like `unnest` in tidyr or a lateral join.
3. Fields at sibling lists that would cause a cross product are flagged; the view either aggregates one of them first (e.g. "number of channels") or asks the researcher to choose.
4. Aggregate locally: counts, sums, distinct counts, time bucketing (hour, day, week, month), top-N, rolling windows.

The participant never sees this. The researcher sees the resulting grain in the Studio ("one row per channel per video watched") so the meaning of counts is clear.

Hot paths (unfolding, grouping, time bucketing over millions of nodes) are implemented in Rust compiled to WASM and run in the query worker. Results are small, so they are cheap to send to the main thread for rendering.

## View library

Rendering uses **Vega-Lite** for standard charts (continuity with DigitalFootprintsLab, declarative specs that studies and the AI helper can generate) and custom React/SVG/Canvas components for views that are about the items rather than the numbers. Candidate views:

**Overview and time**
- *Timeline*: activity over time, zoomable, with a brush to select a period that other views follow.
- *Calendar heatmap*: days and hours, good for routines ("you watch most on Sunday evenings").
- *Memory lane*: a vertically scrolling, chronological diary view of items with thumbnails, grouped by day or week. The default "just look through it" view.

**Items and people**
- *Top items*: ranked lists with thumbnails (channels, creators, searches, domains), with the option to annotate each item (successor of `AnnotateTopItems`).
- *Postcards*: random items from the past, one at a time ("do you remember this?"). Directly inspired by the madeleine: involuntary memory from a single trace.
- *Circle pack / treemap*: categories and their items (successor of the Vega circle pack).
- *Word cloud*: search queries or titles, with stopwords per language (successor of the existing word clouds).

**Structure and exploration**
- *Tree browser*: the raw tree, readable, with search. Useful for curious participants and for facilitators.
- *Table*: when needed, with column selection and search (successor of `DataTable`).
- *Network*: co-occurrence of creators, hashtags or topics (later).
- *Map*: for location history (later; needs extra care with privacy in the donation step).

Views link: selecting a period in the timeline filters memory lane and top items; clicking a creator opens their items in memory lane.

## Probes: questions attached to views

A **probe** is a view plus a question or prompt. project configs define probes, building on the question forms in DigitalFootprintsLab:

```yaml
probe: meaningful-creators
view: top-items
dataset: tiktok/watch-history
group_by: profile
top: 20
prompt:
  en: "Which of these creators meant something to you? Tell us why."
  nl: "Welke van deze makers betekenden iets voor je? Vertel ons waarom."
response:
  per_item: [choice: [important, neutral, unwanted], text]
```

Response types: single and multiple choice, scales, free text, per-item ratings, per-item notes, selecting items or periods in a view, and (later) audio notes. Responses are stored encrypted locally and included in the donation only if the participant agrees.

## Facilitated and self-guided modes

- **Facilitated**: the interviewer drives, the participant talks. Large type, few controls, an easy way to jump to a period or item, and a private notes field for the interviewer (stored separately from participant responses).
- **Self-guided / diary**: the participant works through a sequence of probes at their own pace, possibly over several sessions, with progress saved in the encrypted store.

## Removing and excluding

As in DigitalFootprintsLab, participants can remove items at any point (a search, a video, a whole period). Removal is recorded as an exclusion mask so it is fast and reversible until donation; the donation only ever includes items that are not excluded, and the preview makes that visible.

## Accessibility

- Every chart has a text alternative (summary sentence plus an accessible table).
- Colour palettes are tested for colour vision deficiencies and contrast in both light and dark themes.
- Keyboard navigation for all views; motion is reduced when `prefers-reduced-motion` is set.

## Open questions

- Vega-Lite, Observable Plot, or a smaller custom layer? Vega-Lite is the most declarative (good for project configs and the AI helper) but heavy; Plot is lighter but less specifiable. Recommendation: Vega-Lite, loaded lazily.
- Do we want a "story" export for participants (a personal summary they can keep, like a printed booklet of their year), and how does that interact with privacy?
- How far should views be configurable by researchers versus fixed per platform pack?
