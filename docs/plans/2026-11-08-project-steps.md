# Plan: clear steps for setting up a project

Status: **plan, for discussion** (written 2026-11-08, from Kasper's request in the thread "Split extractor editor into files and contents"). Only the numbered steps inside a platform's extractor are built (test packages, files, contents, view as participant; [ADR 0016](../decisions/0016-file-groups.md)). The rest is a proposal.

## The question

A researcher who opens a new project sees tabs (Details, Information & consent, Data explorer, Story, Texts, Researchers, Donations) and a short "Set up this project" checklist (encryption key, platforms, consent, publish). The tabs say what exists, not what to do first. Kasper's suggestion: clear steps, such as

1. Describe the project
2. Upload a few test packages
3. Select which files to extract
4. Select what data to extract
5. Make slides
6. Informed consent

not necessarily in this order or with these names.

## Proposal

**One numbered path, the tabs stay.** Researchers come back to a project many times and jump between parts, so the tabs stay as they are. The path is the existing setup checklist, grown into the steps of the whole project, each with its state, a one-line why, and a link that opens the right tab at the right place. It is shown on the project's first page until everything is done, and after that folds into the publish bar.

| # | Step | Done when | Opens |
| --- | --- | --- | --- |
| 1 | **Describe the study** | It has a title and a description for participants | Details |
| 2 | **Add platforms and test packages** | Every platform has at least one test package (or a pack's examples) | Data explorer › 1. Test packages |
| 3 | **Pick the files to read** | Every platform reads at least one file (skipped for one-file platforms) | Data explorer › 2. Files |
| 4 | **Decide what to show and ask for** | Every platform has a shown or donated field, and every donated table has a real name | Data explorer › 3. Contents |
| 5 | **Make the story** | The story has at least one slide (optional: a project can skip it) | Story |
| 6 | **Write the information and consent** | Information and at least one statement | Information & consent |
| 7 | **Check the texts** (optional) | Every label participants see has the project's languages | Texts |
| 8 | **Create the encryption key** | The project key exists | Key page |
| 9 | **Publish** | Published, nothing unpublished | Key page |

Recommendations:

- **Order follows the work, not the importance.** Data before story (slides need tables), story before consent (the consent describes what is asked for), the key and publishing last because they need a passkey and are done once. The key can be made at any time; it is listed late so a researcher can explore without one.
- **Optional steps say so** and can be marked "not needed" (a project without a story). They never block publishing.
- **Steps 2 to 4 repeat per platform.** The project step is done when every platform is; the line names the platform that still needs work ("TikTok: no field shown yet").
- **States come from the draft**, never from a separate "done" flag the researcher has to tick: what is on the server is what counts.
- **Blocking problems are the publish checks we already have** (donated tables without a real name, missing key); the steps link to them instead of repeating them.
- **Example projects** show the same path, all done, so a new researcher sees what a finished project looks like.

## Not proposed

- A wizard that forces the order. Researchers revisit steps; a wizard makes going back harder.
- Renaming or merging the tabs. Possible later, once we see which steps people get stuck on.

## Open questions

- Is the story optional for every study, or should a project say up front that it has none?
- Should "test packages" ask for packages in every language the study expects (an English and a Dutch Takeout), to catch files the files step would otherwise miss?
- Should step 4 also ask the researcher to check the view as participant once, before it counts as done?

## Effort

Small to medium: the checklist exists (`SetupSteps` in `apps/web/src/studio/Project.tsx`); the work is computing the new states from the draft and the platforms' configurations, deep links into the data explorer's steps, the "not needed" mark, and copy.
