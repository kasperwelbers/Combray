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
| backup (file) | reservekopie |

## Translating with an AI model

The file format is made for this: one small JSON file per feature, stable keys, and a test that catches mistakes.

1. Give the model the English file, the Dutch file if it exists, and this page as context.
2. Ask it to return the complete Dutch file with exactly the same keys, placeholders and tags, translating only the changed or missing strings.
3. Run `pnpm --filter @combray/web test`. The locale test reports any key, placeholder or tag that does not match.
4. Read the result once, as a participant would. A native speaker checks new screens before a study uses them.

## Project texts

A study can have texts of its own for participants, on the **Texts** page of the studio ([ADR 0013](decisions/0013-names-labels-versions.md)). They are stored with the project (`ProjectTexts` in `packages/core/src/texts.ts`) and published with it:

- **Languages**: which of the app's languages participants can choose, the main one first.
- **Labels and descriptions** of tables and fields, per platform. Without one, participants see the platform pack's label, or the name with spaces.
- **App texts** the study words its own way, by `group:key` (`donate:title` for `donate.title` in `locales/{language}/donate.json`). Only texts of the screens inside a study can be changed (`PROJECT_GROUPS` in `apps/web/src/appTexts.ts`). Texts about privacy, keys and donating can be changed too, with a warning: they must stay true.

The story and the information and consent texts are on their own pages, and are multilingual the same way.

**Export for translation** gives one YAML file (`packages/core/src/translations.ts`) with every text participants read: languages, labels, the story, consent, and the app texts the study changed. Every text is a map by language:

```yaml
languages: [en, nl]
tables:
  takeout:
    youtube_watch_history:
      label: { en: YouTube watch history, nl: YouTube-kijkgeschiedenis }
story:
  intro:
    title: { en: A year on YouTube }
```

Give it to a translator or an AI model with the instructions above ("Translating with an AI model"), asking for the same file with the missing languages filled in, and read it back with **Read a translated file**. Reading changes only texts: entries for tables, fields, slides or blocks that are not in the project are left out, and the structure of the story stays as it is.

## Adding a language

Add the code to `LANGUAGES` in `apps/web/src/i18n.ts` and to the test, copy `locales/en` without `studio.json` to the new folder, and translate.
