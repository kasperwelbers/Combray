# Researcher experience: examples, names, the tree editor and help

Agreed with Kasper on 2026-11-05. Goal: make building the extractor and the story intuitive for researchers without programming experience.

## Example projects

- An example project is the real project screens over an in-memory project API (`apps/web/src/studio/exampleApi.ts`), chosen through a React context (`useProjectApi`). The server's API and the examples share every screen.
- It opens without an account at `/studio/example/{id}/` and is listed on the studio's start page. Changes are kept in the browser tab (`sessionStorage`) and reset when the tab closes; "Start over now" resets it at once. It cannot be published, and has no researchers or donations (those tabs say so in one line).
- Its test packages are the platform packs' synthetic fixtures. Packages a researcher adds keep their structure in the tab and their values in the page's memory only.
- One example for now: Google Takeout and TikTok with the YouTube story (`deploy/examples/projects/example.json`).
- It replaces the practice page (`/studio/learn/`). Without researcher accounts, the studio shows the examples.
- **Not** done: starting a project from an example. Examples contain data. Sharing extractor scripts and slide templates is for later.

## Names always

- Every matched part has a name: its own name (a `Name`, which participants see and donations are exported under) or, until it gets one, its key. Matched = named = decided. Parts nothing matches are "not matched", in a quiet style: nobody looked yet. "Ignore" stays a decision: someone looked and did not want it.
- Keys are not stored as names. A part named by its key has no `nameId`, so tables, columns, their ids, header rows and HTML column names work exactly as before. Only a name that differs from the key becomes a `Name`.
- One match dialog, opened from a row's name: the values in the test packages, the name (suggesting names that exist, and hints from the structure suggestions: "possibly the same as …"), the decision, and under "Advanced" the matches and regular expressions. A shared name can be renamed for all, or given to this part only.
- A name another part has asks: **merge into that node** (the same data: one node, both keys; only for a part next to it, and refused when both keys are in one package side by side) or **a new node with the same name** (own settings; participants see one column or table).
- This replaces the select mode, "Combine into one node", "Give the same name" and the suggestions card. The core functions (`combineNodes`, `setName`, `suggestCombines`) are unchanged; the studio's naming logic is in `apps/web/src/studio/naming.ts`.

## The tree editor

- One small panel per action, next to its button: the name (match dialog), "Read as", "Filter rows" and "More" (labels per language and a description, required, skip new parts, keys that are data). The tabbed settings panel is gone.
- Settings that are set show on the row: "Read as date", "2 filters", always visible and highlighted.
- Rows stay where they are: the studio lays the configuration over the seen data in the structure's order (`buildTree(…, { structureOrder: true })`), not config nodes first and unmatched parts after them. Shapes sort keys, so that order is by key, and stable. Participants' devices keep the configuration's order.
- A row shows its name first, then the keys behind it in a quiet style when they differ: `Video title ← title, titleText`.
- Keys on a row: 1 ignore, 2 show, 3 donate.

## Help

- No help text on the screens. One help dialog (`apps/web/src/studio/Help.tsx`) holds every explanation, grouped (the basics, matching, reading the values, test packages, the platform, notes on rows). A "?" next to a setting opens it at that setting; a "Help" button above the tree opens it at the start.
- The basics are the terminology: seen data, the extractor, names, decisions, merge or the same name.

## Next

- Discuss how to show tables to researchers (the "Tables and fields" view and "View as participant" overlap).
- Renaming a column changes its id (from its path to its name), so story blocks and exports that referred to the old id need the new one. Worth a warning in the match dialog when a story uses the column.
