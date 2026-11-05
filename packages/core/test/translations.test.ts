import { describe, expect, it } from 'vitest';

import { applyTranslations, checkProjectTexts, readTranslations, TextsError, translationDocument, translationsToYaml, type Story, type TextSources } from '../src';

const story: Story = {
  slides: [
    {
      id: 'intro',
      title: 'A year on YouTube',
      blocks: [
        { type: 'text', id: 'hello', text: { en: 'Welcome!' } },
        { type: 'question', id: 'often', kind: 'choice', prompt: 'How often?', options: ['Often', 'Rarely'] },
      ],
    },
  ],
};

const sources: TextSources = {
  texts: { languages: ['en'], platforms: { takeout: { tables: { watch_history: { label: { en: 'YouTube watch history' } } } } }, app: { 'donate:title': { en: 'Share' } } },
  story,
  consent: { information: 'We study memories.', statements: ['I am 16 or older.'] },
};
const shown = { takeout: [{ table: 'watch_history', fields: ['time', 'video_title'] }, { table: 'searches', fields: ['query'] }] };

describe('project texts', () => {
  it('are checked: languages, labels per platform, and app texts by namespace and key', () => {
    expect(checkProjectTexts({ languages: ['nl', 'en', 'nl'], app: { 'donate:title': { nl: 'Delen', en: '' } }, platforms: {} })).toEqual({
      languages: ['nl', 'en'],
      app: { 'donate:title': { nl: 'Delen' } },
    });
    expect(() => checkProjectTexts({ languages: ['Dutch'] })).toThrow(TextsError);
    expect(() => checkProjectTexts({ app: { title: { en: 'x' } } })).toThrow('not an app text');
    expect(() => checkProjectTexts({ platforms: { takeout: { tables: { 'Watch history': {} } } } })).toThrow('not a name');
  });
});

describe('the translation document', () => {
  it('lists every text, with the labels tables and fields get by default', () => {
    const doc = translationDocument(sources, shown);
    expect(doc.tables!.takeout!.watch_history).toEqual({
      label: { en: 'YouTube watch history' },
      fields: { time: { label: { en: 'Time' } }, video_title: { label: { en: 'Video title' } } },
    });
    expect(doc.tables!.takeout!.searches!.label).toEqual({ en: 'Searches' });
    expect(doc.story!.intro).toEqual({
      title: { en: 'A year on YouTube' },
      blocks: { hello: { text: { en: 'Welcome!' } }, often: { prompt: { en: 'How often?' }, options: [{ en: 'Often' }, { en: 'Rarely' }] } },
    });
    expect(doc.consent).toEqual({ information: { en: 'We study memories.' }, statements: [{ en: 'I am 16 or older.' }] });
    expect(doc.app).toEqual({ 'donate:title': { en: 'Share' } });
  });

  it('goes to YAML and back, and lays translations over the texts', () => {
    const yaml = translationsToYaml(translationDocument(sources, shown));
    expect(yaml).toContain('# Texts of a Combray project');
    // A translator adds Dutch next to the English.
    const translated = yaml
      .replace('en: YouTube watch history', 'en: YouTube watch history\n        nl: YouTube-kijkgeschiedenis')
      .replace('en: Time', 'en: Time\n            nl: Tijd')
      .replace('en: Welcome!', 'en: Welcome!\n          nl: Welkom!')
      .replace('en: Rarely', 'en: Rarely\n            nl: Zelden')
      .replace('en: I am 16 or older.', 'en: I am 16 or older.\n      nl: Ik ben 16 of ouder.')
      .replace('languages:\n  - en', 'languages:\n  - en\n  - nl');
    const doc = readTranslations(translated);
    const { sources: next, changed } = applyTranslations(sources, doc);
    expect(changed).toBe(6);
    expect(next.texts.languages).toEqual(['en', 'nl']);
    expect(next.texts.platforms!.takeout!.tables!.watch_history).toEqual({
      label: { en: 'YouTube watch history', nl: 'YouTube-kijkgeschiedenis' },
      fields: { time: { label: { en: 'Time', nl: 'Tijd' } } },
    });
    // Labels that only say the name are not stored.
    expect(next.texts.platforms!.takeout!.tables!.searches).toBeUndefined();
    const [hello, often] = next.story!.slides[0]!.blocks;
    expect(hello).toMatchObject({ text: { en: 'Welcome!', nl: 'Welkom!' } });
    expect(often).toMatchObject({ prompt: 'How often?', options: ['Often', { en: 'Rarely', nl: 'Zelden' }] });
    expect(next.consent!.statements).toEqual([{ en: 'I am 16 or older.', nl: 'Ik ben 16 of ouder.' }]);
    // Reading the same file again changes nothing.
    expect(applyTranslations(next, doc).changed).toBe(0);
  });

  it('only changes texts, and says where a file is wrong', () => {
    const doc = readTranslations('story:\n  outro:\n    title: { en: Bye }\n  intro:\n    blocks:\n      gone: { text: { en: x } }\n');
    const { sources: next, changed } = applyTranslations(sources, doc);
    expect(changed).toBe(0);
    expect(next.story).toEqual(story);
    expect(() => readTranslations('tables:\n  takeout:\n    Watch: {}\n')).toThrow('tables: takeout.Watch is not a name');
    expect(() => readTranslations('app:\n  title: { en: x }\n')).toThrow('app: title is not an app text');
    expect(() => readTranslations('story: [')).toThrow('not YAML');
  });
});
