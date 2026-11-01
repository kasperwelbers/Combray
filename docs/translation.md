# Translation

Everything participants see is in English and Dutch. Researcher tools and documents are English only. This page says where the text lives, how to add or change it, and how to translate it, by hand or with an AI model.

## Where the text lives

`apps/web/src/locales/{language}/{feature}.json`, one file per feature. Each file holds the keys under that feature's name: `lock.json` holds everything the code reads as `t('lock.…')`. `apps/web/src/i18n.ts` loads every file it finds, so a new feature only needs a new pair of files.

| Folder | Who reads it | Languages |
| --- | --- | --- |
| `locales/en/`, `locales/nl/` (all files except `studio.json`) | Participants | English and Dutch, always both |
| `locales/en/studio.json` | Researchers, in the workspace at `/studio/` | English only |

`apps/web/test/locales.test.ts` checks that every participant file exists in both languages, with the same keys, the same `{{placeholders}}` and the same tags. A missing or half-translated string fails the tests.

## Writing strings

- **Write whole sentences.** Never glue a sentence together from several keys: word order differs between languages. Use placeholders (`{{count}}`) for values.
- **Inline markup goes in the string.** Bold text and links use tags, `"Choose <b>Lock</b>."`, rendered with `<Trans components={{ b: <b /> }}>`. They become React elements, never HTML. The code decides which tags exist; translations only move them.
- **Plurals** use i18next's suffixes: `wait_one`, `wait_other`. Dutch and English have the same forms.
- **Longer answers** (the Questions page) are arrays of paragraphs.
- **Tone** follows [design-identity.md](design-identity.md#tone-of-voice): warm, plain, second person, never judgemental.

## Dutch

- **Je, not u.** Combray speaks to participants as a friendly person sitting next to them.
- Write Dutch natively. Translate what is meant, not word by word, and prefer short sentences.
- Keep the same terms everywhere:

| English | Dutch |
| --- | --- |
| data | gegevens |
| data key | gegevenssleutel |
| box (the wrapped key) | kistje |
| donation, share | donatie, delen |
| donation key | donatiesleutel |
| withdraw | intrekken |
| password | wachtwoord |
| lock (verb, button) | vergrendelen |
| delete everything | alles verwijderen |
| study | onderzoek |
| researcher | onderzoeker |
| personal link | persoonlijke link |
| Questions (page) | Vragen |
| Combray package | Combray-pakket |

## Translating with an AI model

The file format is made for this: one small JSON file per feature, stable keys, and a test that catches mistakes.

1. Give the model the English file, the Dutch file if it exists, and this page as context.
2. Ask it to return the complete Dutch file with exactly the same keys, placeholders and tags, translating only the changed or missing strings.
3. Run `pnpm --filter @combray/web test`. The locale test reports any key, placeholder or tag that does not match.
4. Read the result once, as a participant would. A native speaker checks new screens before a study uses them.

## Adding a language

Add the code to `LANGUAGES` in `apps/web/src/i18n.ts` and to the test, copy `locales/en` without `studio.json` to the new folder, and translate.
