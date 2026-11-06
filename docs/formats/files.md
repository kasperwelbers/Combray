# Plain text, media, folders and zips

*Part of [How Combray reads files](README.md). Covers what holds the other formats (folders and zips), and the files that are not JSON, HTML or CSV.*

## In short

A data download package is usually a zip with folders and files in it. Folders become groups named after the folder, files become groups named after the file with their contents inside. Text files become a list of lines, and photos, videos and other media are kept as a reference only: their type and size, never their contents.

## How it becomes a tree

| In the upload | In the tree | In the studio |
| --- | --- | --- |
| a folder or a zip | a folder: one child per entry | 📁 a folder |
| a zip inside a zip | opened like a folder (up to three levels deep) | 📁 a folder |
| `.json`, `.html`, `.csv`, … | the file's contents, named after the file | see the page for the format |
| `.txt`, `.md`, `.log`, or text in an unknown format | a list of lines | a table of lines |
| a photo, video, audio file, PDF, or anything binary | a file reference: its type and size | a file |
| `__MACOSX`, `.DS_Store`, `Thumbs.db` | left out | |

The upload itself has no name in the tree: what participants call their zip never matters, and is never recorded.

## Tables

Folders do not make tables by themselves, with one exception: a folder per item (F1) is a table with a row per folder.

## Hard cases

### F1 Folders and files named after data

**Looks like:** `messages/inbox/anna_1234/message_1.json`, `messages/inbox/bob_5678/…`, or a file per day: `2024-01-03.json`.

**What you see:** as for JSON keys ([J1](json.md#j1-keys-that-look-like-data), [J2](json.md#j2-an-object-of-people-dates-or-ids)): names that look like data are replaced (`<id>`, `<date>`), and a folder whose entries are many differently named folders of the same shape becomes **each key**, a table with a row per folder.

**What to do:** when Combray did not notice, **More** › **The keys are data** on the folder. **Status:** handled; you can correct.

### F2 The export inside a bigger upload

**Looks like:** a participant picks their Downloads folder, or a zip that wraps a `Takeout` folder.

**What you see:** wrapper folders with one entry are stepped into by themselves. To find the export inside a bigger upload, give the platform's root name patterns (`Takeout`, `takeout-*.zip`) under **Platform settings**; parts you mark **Required** must be there for an upload to fit. Combray looks at names first and only opens what matches. **Status:** handled. Details: [tree-decisions.md](../tree-decisions.md#finding-the-export-in-an-upload).

### F3 Plain text

**Looks like:** a `.txt` file of notes or a log.

**What you see:** a table with a row per line. Text with structure in it (a chat log with `[date] name: message` on each line) is not split up. **Status:** handled as lines; splitting lines into fields is an open idea (a script per format).

### F4 Media and other files

**Looks like:** `photos/IMG_0001.jpg`.

**What you see:** a file with its type and size. Combray never reads or shows the contents, and they cannot be donated. **Status:** handled.

### F5 Exports split over several zips

**Looks like:** `takeout-001.zip`, `takeout-002.zip`.

**What you see:** participants pick all parts at once; folders with the same name are merged, as if it were one zip. **Status:** handled.

## Tips

- Load a whole package as a test package, not only the file you are interested in: the path from the top of the package is part of what your extractor matches.
- Mark the parts every package has as **Required**, so participants who pick the wrong folder are told right away.

## For developers

- Parsing per file and archives: `parse/index.ts` (`parseFile`, `parseEntries`, `parseZip`, `mergeDirs`, `isNoise`, `MIME`). Text: `parse/text.ts` (UTF-8, falling back to Windows-1252).
- Finding the export: `locate.ts`. Limits: `UPLOAD_LIMITS`.
- F1: `isDictionaryLike` in `shape.ts` applies to folders as to maps; `screenName` keeps file extensions (`<id>.json`).
- Tests: `fileFormats.test.ts` (F1 to F5).
