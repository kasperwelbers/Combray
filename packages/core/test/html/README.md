# Synthetic HTML examples

Small HTML files written to look like common data export formats, so HTML normalisation and
table inference are tested on the kinds of markup they will meet. They are made up: the
structure follows what these exports looked like when we wrote them, the names and values are
invented (Combray's usual cast). No real export was used or copied.

| File | Like | What it tests |
| --- | --- | --- |
| `my-activity-youtube.html` | Google Takeout, YouTube watch history (older HTML) | Rows of `div.outer-cell`, positional text, one or two links, removed videos, ad rows with an extra caption |
| `my-activity-search.html` | Google Takeout, My Activity searches | Text before or after the link, visits next to searches |
| `instagram-likes.html` | Instagram, liked posts (HTML) | Generated class names, a title with the account name, dates in their own `div` |
| `facebook-comments.html` | Facebook, comments (HTML) | Rows with an optional quoted text and an optional link |
| `snapchat-chats.html` | Snapchat, chat history | `<table>` with a header row, several tables on a page |
| `account-info.html` | An account page of any platform | `<dl>` with terms and descriptions, a `<table>` without a header |

Add a file here when a new kind of markup comes up, and a case to `test/html.test.ts`.
