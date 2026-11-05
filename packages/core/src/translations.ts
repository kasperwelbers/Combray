/**
 * All of a project's texts for participants in one document, to translate outside Combray (by
 * hand, or with an AI) and read back in (docs/translation.md#project-texts): table and field
 * labels and descriptions, the story, the information and consent statements, and the app texts
 * the project words its own way. As YAML, with every text by language:
 *
 * ```yaml
 * languages: [en, nl]
 * tables:
 *   takeout:
 *     youtube_watch_history:
 *       label: { en: YouTube watch history, nl: YouTube-kijkgeschiedenis }
 *       fields:
 *         time: { label: { en: Time, nl: Tijd } }
 * story:
 *   intro:
 *     title: { en: A year on YouTube }
 *     blocks:
 *       hello: { text: { en: Welcome! } }
 * ```
 *
 * Reading one back changes only texts: what the story or the tables are stays as it is, and
 * entries for slides, blocks, tables or fields that are not there are left out.
 */
import { parse as parseYaml, stringify } from 'yaml';

import type { Localized } from './importer/spec';
import { defaultLabel, isName } from './names';
import type { Story } from './story';
import { APP_KEY, checkTranslations, LANGUAGE, TextsError, type PlatformTexts, type ProjectTexts, type TableTexts, type Translations } from './texts';

export interface TableEntry {
  label?: Translations;
  description?: Translations;
  fields?: Record<string, { label?: Translations; description?: Translations }>;
}

export interface BlockEntry {
  text?: Translations;
  empty?: Translations;
  prompt?: Translations;
  options?: Translations[];
}

export interface TranslationDocument {
  languages?: string[];
  /** By platform, then by table name. */
  tables?: Record<string, Record<string, TableEntry>>;
  /** By slide id. */
  story?: Record<string, { title?: Translations; blocks?: Record<string, BlockEntry> }>;
  consent?: { information?: Translations; statements?: Translations[] };
  /** By `namespace:key`. */
  app?: Record<string, Translations>;
}

/** The project's texts and the parts of the draft that hold texts of their own. */
export interface TextSources {
  texts: ProjectTexts;
  story?: Story | null;
  consent?: { information?: Localized; statements?: Localized[] };
}

/** The tables and fields participants see, per platform, to list even those without a label yet. */
export type ShownTables = Record<string, { table: string; fields: string[] }[]>;

/** A text in one or more languages as translations: a plain string is in the project's main language. */
const asTranslations = (text: Localized | undefined, main: string): Translations | undefined =>
  text === undefined ? undefined : typeof text === 'string' ? (text === '' ? undefined : { [main]: text }) : Object.keys(text).length > 0 ? { ...text } : undefined;

const put = <T extends object>(target: T, key: keyof T, value: unknown) => {
  if (value !== undefined) (target as Record<PropertyKey, unknown>)[key as PropertyKey] = value;
};

/**
 * Every text of a project as one document. Tables and fields participants see are listed with
 * their label, or the label they get by default (their name with spaces), so a translator sees
 * all of them; app texts only where the project words them its own way.
 */
export function translationDocument(sources: TextSources, shown: ShownTables = {}): TranslationDocument {
  const main = sources.texts.languages?.[0] ?? 'en';
  const doc: TranslationDocument = {};
  if (sources.texts.languages) doc.languages = [...sources.texts.languages];

  const tables: NonNullable<TranslationDocument['tables']> = {};
  const platforms = new Set([...Object.keys(shown), ...Object.keys(sources.texts.platforms ?? {})]);
  for (const platform of platforms) {
    const own = sources.texts.platforms?.[platform]?.tables ?? {};
    const out: Record<string, TableEntry> = {};
    const names = new Map<string, Set<string>>();
    for (const { table, fields } of shown[platform] ?? []) names.set(table, new Set([...(names.get(table) ?? []), ...fields]));
    for (const [table, texts] of Object.entries(own)) names.set(table, new Set([...(names.get(table) ?? []), ...Object.keys(texts.fields ?? {})]));
    for (const [table, fields] of names) {
      const texts = own[table] ?? {};
      const entry: TableEntry = { label: texts.label ?? (table === '' ? undefined : { [main]: defaultLabel(table) }) } as TableEntry;
      if (entry.label === undefined) delete entry.label;
      put(entry, 'description', texts.description);
      const f: NonNullable<TableEntry['fields']> = {};
      for (const field of fields) {
        const own = texts.fields?.[field] ?? {};
        f[field] = { label: own.label ?? { [main]: defaultLabel(field) }, ...(own.description ? { description: own.description } : {}) };
      }
      if (Object.keys(f).length > 0) entry.fields = f;
      out[table === '' ? '_' : table] = entry;
    }
    if (Object.keys(out).length > 0) tables[platform] = out;
  }
  if (Object.keys(tables).length > 0) doc.tables = tables;

  if (sources.story?.slides.length) {
    const story: NonNullable<TranslationDocument['story']> = {};
    for (const slide of sources.story.slides) {
      const blocks: Record<string, BlockEntry> = {};
      for (const block of slide.blocks) {
        const entry: BlockEntry = {};
        if (block.type === 'text') put(entry, 'text', asTranslations(block.text, main));
        if (block.type === 'data') {
          put(entry, 'text', asTranslations(block.text, main));
          put(entry, 'empty', asTranslations(block.empty, main));
        }
        if (block.type === 'question') {
          put(entry, 'prompt', asTranslations(block.prompt, main));
          if (block.options?.length) entry.options = block.options.map((o) => asTranslations(o, main) ?? {});
        }
        if (Object.keys(entry).length > 0) blocks[block.id] = entry;
      }
      const title = asTranslations(slide.title, main);
      story[slide.id] = { ...(title ? { title } : {}), ...(Object.keys(blocks).length > 0 ? { blocks } : {}) };
    }
    doc.story = story;
  }

  const consent = sources.consent;
  if (consent && (consent.information !== undefined || consent.statements?.length)) {
    doc.consent = {};
    put(doc.consent, 'information', asTranslations(consent.information, main));
    if (consent.statements?.length) doc.consent.statements = consent.statements.map((s) => asTranslations(s, main) ?? {});
  }
  if (sources.texts.app && Object.keys(sources.texts.app).length > 0) doc.app = structuredClone(sources.texts.app);
  return doc;
}

const HEADER = `# Texts of a Combray project, for participants, by language.
# Translate the texts and add languages next to the ones there (en, nl, ...);
# keep the keys and names as they are. Read this file back on the Texts page.
`;

export function translationsToYaml(doc: TranslationDocument): string {
  return HEADER + stringify(doc, { lineWidth: 0 });
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
function check(ok: boolean, message: string): asserts ok {
  if (!ok) throw new TextsError(message);
}

/** Read a document back, checking every text; throws `TextsError` with where the problem is. */
export function readTranslations(text: string): TranslationDocument {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (e) {
    throw new TextsError(`not YAML: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
  }
  check(isObject(raw), 'the file must hold a map of texts');
  const doc: TranslationDocument = {};
  if (raw.languages !== undefined) {
    check(Array.isArray(raw.languages) && raw.languages.every((l) => typeof l === 'string' && LANGUAGE.test(l)), 'languages must be a list of language codes');
    doc.languages = raw.languages as string[];
  }
  if (raw.tables !== undefined) {
    check(isObject(raw.tables), 'tables must be a map of platforms');
    doc.tables = {};
    for (const [platform, tables] of Object.entries(raw.tables)) {
      check(isObject(tables), `tables: ${platform} must be a map of tables`);
      const out: Record<string, TableEntry> = {};
      for (const [table, entry] of Object.entries(tables)) {
        const at = `tables: ${platform}.${table}`;
        check(table === '_' || isName(table), `${at} is not a name`);
        check(isObject(entry), `${at} must be a map`);
        const e: TableEntry = {};
        put(e, 'label', checkTranslations(entry.label, `${at}: label`));
        put(e, 'description', checkTranslations(entry.description, `${at}: description`));
        if (entry.fields !== undefined) {
          check(isObject(entry.fields), `${at}: fields must be a map`);
          e.fields = {};
          for (const [field, f] of Object.entries(entry.fields)) {
            check(isName(field) && isObject(f), `${at}.${field} must be a field's name with its texts`);
            e.fields[field] = {};
            put(e.fields[field]!, 'label', checkTranslations(f.label, `${at}.${field}: label`));
            put(e.fields[field]!, 'description', checkTranslations(f.description, `${at}.${field}: description`));
          }
        }
        out[table] = e;
      }
      doc.tables[platform] = out;
    }
  }
  if (raw.story !== undefined) {
    check(isObject(raw.story), 'story must be a map of slides');
    doc.story = {};
    for (const [slide, entry] of Object.entries(raw.story)) {
      check(isObject(entry), `story: ${slide} must be a map`);
      const s: NonNullable<TranslationDocument['story']>[string] = {};
      put(s, 'title', checkTranslations(entry.title, `story: ${slide}: title`));
      if (entry.blocks !== undefined) {
        check(isObject(entry.blocks), `story: ${slide}: blocks must be a map`);
        s.blocks = {};
        for (const [block, b] of Object.entries(entry.blocks)) {
          const at = `story: ${slide}.${block}`;
          check(isObject(b), `${at} must be a map`);
          const out: BlockEntry = {};
          for (const key of ['text', 'empty', 'prompt'] as const) put(out, key, checkTranslations(b[key], `${at}: ${key}`));
          if (b.options !== undefined) {
            check(Array.isArray(b.options), `${at}: options must be a list`);
            out.options = b.options.map((o, i) => checkTranslations(o, `${at}: option ${i + 1}`) ?? {});
          }
          s.blocks[block] = out;
        }
      }
      doc.story[slide] = s;
    }
  }
  if (raw.consent !== undefined) {
    check(isObject(raw.consent), 'consent must be a map');
    doc.consent = {};
    put(doc.consent, 'information', checkTranslations(raw.consent.information, 'consent: information'));
    if (raw.consent.statements !== undefined) {
      check(Array.isArray(raw.consent.statements), 'consent: statements must be a list');
      doc.consent.statements = raw.consent.statements.map((s, i) => checkTranslations(s, `consent: statement ${i + 1}`) ?? {});
    }
  }
  if (raw.app !== undefined) {
    check(isObject(raw.app), 'app must be a map of texts');
    doc.app = {};
    for (const [key, t] of Object.entries(raw.app)) {
      check(APP_KEY.test(key), `app: ${key} is not an app text`);
      const checked = checkTranslations(t, `app: ${key}`);
      if (checked) doc.app[key] = checked;
    }
  }
  return doc;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Translations laid over what is there, language by language. */
const merged = (base: Localized | undefined, next: Translations | undefined, main: string): Localized | undefined => {
  if (!next) return base;
  const out = { ...(asTranslations(base, main) ?? {}), ...next };
  // Nothing new: the text stays as it was written (a plain string stays one).
  if (same(out, asTranslations(base, main))) return base;
  return Object.keys(out).length > 0 ? out : base;
};

/**
 * The project's texts, story and consent with a document's translations laid over them,
 * language by language, and how many texts changed. Only texts change: slides, blocks and
 * statements that are not there already are left out, and so are labels that say no more than
 * the name (`defaultLabel`).
 */
export function applyTranslations(sources: TextSources, doc: TranslationDocument): { sources: TextSources; changed: number } {
  const main = doc.languages?.[0] ?? sources.texts.languages?.[0] ?? 'en';
  let changed = 0;
  const count = (before: unknown, after: unknown) => {
    if (!same(before, after)) changed++;
    return after;
  };
  const texts: ProjectTexts = structuredClone(sources.texts);
  if (doc.languages && !same(doc.languages, texts.languages)) {
    texts.languages = count(texts.languages, [...doc.languages]) as string[];
  }

  const onlyName = (t: Translations | undefined, name: string) => t !== undefined && Object.keys(t).length === 1 && t[main] === defaultLabel(name);
  for (const [platform, tables] of Object.entries(doc.tables ?? {})) {
    const p: PlatformTexts = texts.platforms?.[platform] ?? {};
    const out: Record<string, TableTexts> = { ...(p.tables ?? {}) };
    for (const [key, entry] of Object.entries(tables)) {
      const table = key === '_' ? '' : key;
      const was = out[table] ?? {};
      const next: TableTexts = { ...was };
      const label = merged(was.label, onlyName(entry.label, table) ? undefined : entry.label, main) as Translations | undefined;
      if (label) next.label = count(was.label, label) as Translations;
      const description = merged(was.description, entry.description, main) as Translations | undefined;
      if (description) next.description = count(was.description, description) as Translations;
      for (const [field, f] of Object.entries(entry.fields ?? {})) {
        const old = was.fields?.[field] ?? {};
        const fl = merged(old.label, onlyName(f.label, field) ? undefined : f.label, main) as Translations | undefined;
        const fd = merged(old.description, f.description, main) as Translations | undefined;
        const nf = { ...old, ...(fl ? { label: count(old.label, fl) as Translations } : {}), ...(fd ? { description: count(old.description, fd) as Translations } : {}) };
        if (Object.keys(nf).length > 0) next.fields = { ...(next.fields ?? {}), [field]: nf };
      }
      if (Object.keys(next).length > 0) out[table] = next;
    }
    if (Object.keys(out).length > 0) texts.platforms = { ...(texts.platforms ?? {}), [platform]: { ...p, tables: out } };
  }
  for (const [key, t] of Object.entries(doc.app ?? {})) {
    const next = { ...(texts.app?.[key] ?? {}), ...t };
    texts.app = { ...(texts.app ?? {}), [key]: count(texts.app?.[key], next) as Translations };
  }

  let story = sources.story ?? null;
  if (story && doc.story) {
    story = {
      ...story,
      slides: story.slides.map((slide) => {
        const entry = doc.story![slide.id];
        if (!entry) return slide;
        const title = merged(slide.title, entry.title, main);
        return {
          ...slide,
          ...(title !== undefined ? { title: count(slide.title, title) as Localized } : {}),
          blocks: slide.blocks.map((block) => {
            const b = entry.blocks?.[block.id];
            if (!b) return block;
            if (block.type === 'text') return { ...block, text: count(block.text, merged(block.text, b.text, main)) as Localized };
            if (block.type === 'data') {
              const text = merged(block.text, b.text, main);
              const empty = merged(block.empty, b.empty, main);
              return { ...block, ...(text !== undefined ? { text: count(block.text, text) as Localized } : {}), ...(empty !== undefined ? { empty: count(block.empty, empty) as Localized } : {}) };
            }
            const options = block.options?.map((o, i) => count(o, merged(o, b.options?.[i], main)) as Localized);
            return { ...block, prompt: count(block.prompt, merged(block.prompt, b.prompt, main)) as Localized, ...(options ? { options } : {}) };
          }),
        };
      }),
    };
  }

  let consent = sources.consent;
  if (consent && doc.consent) {
    const information = merged(consent.information, doc.consent.information, main);
    consent = {
      ...consent,
      ...(information !== undefined ? { information: count(consent.information, information) as Localized } : {}),
      ...(consent.statements ? { statements: consent.statements.map((s, i) => count(s, merged(s, doc.consent!.statements?.[i], main)) as Localized) } : {}),
    };
  }
  return { sources: { texts, ...(story ? { story } : {}), ...(consent ? { consent } : {}) }, changed };
}
