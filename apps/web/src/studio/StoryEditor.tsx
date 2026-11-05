/**
 * The story editor: slides that walk participants through their own data and ask about it
 * (docs/plans/2026-11-05-stories-and-exploration.md). Researchers build slides from blocks
 * (text, a view of a table, a question), starting from templates for the questions people ask
 * about their data. Tables and columns are picked from the project's platforms and kept by
 * their ids, which stay when their names change.
 *
 * The preview uses made-up numbers: the studio never sees participants' data.
 */
import {
  buildTree,
  DATA_VIEWS,
  deriveTables,
  localize,
  parseImporterFile,
  parseStory,
  parseStructureFile,
  QUESTION_KINDS,
  slideFromTemplate,
  STORY_LIMITS,
  type DataBlock,
  type DataViewKind,
  type Localized,
  type QuestionBlock,
  type QuestionKind,
  type Slide,
  type SlideTemplate,
  type Story,
  type StoryBlock,
} from '@combray/core';
import { packs } from '@combray/importers';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Block } from '../components/StoryBlocks';
import type { StoryView } from '../worker/api';
import { fromFiles } from './model';
import { storyTables, type StoryTable } from './storyTables';
import { PlayOverlay, PreviewBar, previewViews, useStoryPreview, type PlatformFiles } from './StoryPreview';
import { ApiFailure, useProjectApi, type Draft, type ProjectApi } from './projectApi';
import { textIn } from './text';

/** Every platform of the project as its draft has it, with its tables. */
async function loadPlatforms(projectApi: ProjectApi, draft: Draft): Promise<{ platforms: PlatformFiles[]; tables: StoryTable[] }> {
  const platforms: PlatformFiles[] = [];
  const tables: StoryTable[] = [];
  for (const summary of draft.platforms) {
    try {
      const platform = await projectApi.platform(draft.id, summary.id);
      const pack = packs.find((p) => p.id === platform.pack);
      const structure = platform.structure ?? pack?.structure;
      const importer = platform.importer ?? pack?.importer;
      if (!structure || !importer) continue;
      const { config, seen } = fromFiles(parseStructureFile(structure), parseImporterFile(importer));
      tables.push(...storyTables(summary.id, summary.name, deriveTables(buildTree(config, seen).tree)));
      platforms.push({ platform: summary.id, name: summary.name, ...(platform.pack ? { pack: platform.pack } : {}), structure, importer });
    } catch {
      // A platform that cannot be read offers no tables; the data explorer says why.
    }
  }
  return { platforms, tables };
}

const tableKey = (platform: string, table: string) => JSON.stringify([platform, table]);

const NO_SLIDES: Slide[] = [];

const TEMPLATES: SlideTemplate[] = ['amount', 'top', 'over-time', 'rhythm', 'question'];

export function StoryEditor({ draft }: { draft: Draft }) {
  const { t } = useTranslation(undefined, { lng: 'en' });
  const [slides, setSlides] = useState<Slide[]>();
  const [tables, setTables] = useState<StoryTable[]>([]);
  const [platforms, setPlatforms] = useState<PlatformFiles[]>([]);
  const [playing, setPlaying] = useState<Story>();
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState<{ text: string; error?: boolean }>();
  const projectApi = useProjectApi();

  useEffect(() => {
    void projectApi.story(draft.id).then(
      (story) => {
        const s = story as { slides?: unknown } | null;
        // Kept as stored, so blocks that are not complete yet are not lost on the way.
        setSlides(s && Array.isArray(s.slides) ? (s.slides as Slide[]) : []);
      },
      () => setStatus({ text: t('studio.story.loadFailed'), error: true }),
    );
    void loadPlatforms(projectApi, draft).then((loaded) => {
      setTables(loaded.tables);
      setPlatforms(loaded.platforms);
    });
  }, [projectApi, draft, t]);

  const preview = useStoryPreview(draft.id, platforms, slides ?? NO_SLIDES);

  if (!slides) return status ? <p className="message error">{status.text}</p> : null;

  const update = (next: Slide[]) => {
    setSlides(next);
    setDirty(true);
    setStatus(undefined);
  };

  function addSlide(template: SlideTemplate) {
    const needsDate = template === 'over-time' || template === 'rhythm';
    const table = tables.find((x) => (needsDate ? x.date : template === 'top' ? x.columns.length > 0 : true));
    const column = template === 'top' ? (table?.columns.find((c) => !table.dates.some((d) => d.id === c.id))?.id ?? table?.columns[0]?.id) : undefined;
    update([...slides!, slideFromTemplate(template, table ? { platform: table.platform, table: table.id, ...(column ? { column } : {}) } : undefined)]);
  }

  // What participants get: what the check keeps. Blocks it would leave out are flagged.
  const checked = parseStory({ slides });
  const kept = new Set(checked?.slides.flatMap((s) => s.blocks.map((b) => `${s.id}\u0000${b.id}`)) ?? []);

  async function save() {
    try {
      await projectApi.saveStory(draft.id, slides!.length > 0 ? { slides } : null);
      setDirty(false);
      setStatus({ text: t('studio.story.saved') });
    } catch (error) {
      setStatus({ text: error instanceof ApiFailure && error.status === 400 ? t('studio.story.invalid') : t('studio.project.saveFailed'), error: true });
    }
  }

  return (
    <div className="story-editor">
      <section className="card">
        <h2>{t('studio.project.tab.story')}</h2>
        <p className="meta">{t('studio.story.intro')}</p>
        {tables.length === 0 && <p className="message">{t('studio.story.noTables')}</p>}
      </section>

      {platforms.length > 0 && <PreviewBar preview={preview} platforms={platforms} {...(checked ? { onPlay: () => setPlaying(checked) } : {})} />}
      {playing && <PlayOverlay story={playing} views={previewViews(playing, preview.viewOf)} onClose={() => setPlaying(undefined)} />}

      {slides.map((slide, i) => (
        <SlideEditor
          key={slide.id}
          slide={slide}
          index={i}
          count={slides.length}
          tables={tables}
          viewOf={preview.viewOf}
          incomplete={(b) => !kept.has(`${slide.id}\u0000${b.id}`)}
          onChange={(next) => update(slides.map((s, j) => (j === i ? next : s)))}
          onMove={(by) => {
            const next = [...slides];
            const [moved] = next.splice(i, 1);
            next.splice(i + by, 0, moved!);
            update(next);
          }}
          onRemove={() => update(slides.filter((_, j) => j !== i))}
        />
      ))}

      {slides.length < STORY_LIMITS.slides && (
        <section className="card story-add">
          <h3>{t('studio.story.addSlide')}</h3>
          <div className="story-templates">
            {TEMPLATES.map((template) => (
              <button key={template} type="button" className="story-template" onClick={() => addSlide(template)}>
                <strong>{t(`studio.story.template.${template}`)}</strong>
                <span className="meta">{t(`studio.story.templateHelp.${template}`)}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      <div className="story-save-bar">
        {status && (
          <p className={`message${status.error ? ' error' : ''}`} role={status.error ? 'alert' : 'status'}>
            {status.text}
          </p>
        )}
        <button type="button" className="button" disabled={!dirty} onClick={() => void save()}>
          {t('studio.story.save')}
        </button>
        {dirty && <span className="meta">{t('studio.story.unsaved')}</span>}
      </div>
    </div>
  );
}

function SlideEditor({
  slide,
  index,
  count,
  tables,
  viewOf,
  incomplete,
  onChange,
  onMove,
  onRemove,
}: {
  slide: Slide;
  index: number;
  count: number;
  tables: StoryTable[];
  viewOf: (b: DataBlock) => StoryView | undefined;
  incomplete: (b: StoryBlock) => boolean;
  onChange: (s: Slide) => void;
  onMove: (by: number) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation(undefined, { lng: 'en' });
  const [preview, setPreview] = useState(false);
  const setBlock = (i: number, block: StoryBlock) => onChange({ ...slide, blocks: slide.blocks.map((b, j) => (j === i ? block : b)) });
  const moveBlock = (i: number, by: number) => {
    const blocks = [...slide.blocks];
    const [moved] = blocks.splice(i, 1);
    blocks.splice(i + by, 0, moved!);
    onChange({ ...slide, blocks });
  };
  const addBlock = (type: StoryBlock['type']) => {
    const template = slideFromTemplate(
      type === 'question' ? 'question' : 'amount',
      tables[0] ? { platform: tables[0].platform, table: tables[0].id } : undefined,
    );
    const block: StoryBlock = type === 'text' ? { type: 'text', id: template.blocks[0]!.id.replace(/^d/, 't'), text: '' } : template.blocks[0]!;
    onChange({ ...slide, blocks: [...slide.blocks, block] });
  };
  const views = useMemo(
    () =>
      Object.fromEntries(
        slide.blocks.flatMap((b) => {
          const v = b.type === 'data' ? viewOf(b) : undefined;
          return v ? [[b.id, v]] : [];
        }),
      ),
    [slide.blocks, viewOf],
  );

  return (
    <section className="card story-slide-editor" aria-label={t('studio.story.slide', { n: index + 1 })}>
      <div className="story-slide-head">
        <h3>{t('studio.story.slide', { n: index + 1 })}</h3>
        <div className="story-slide-actions">
          <button type="button" className="button quiet" aria-pressed={preview} onClick={() => setPreview((p) => !p)}>
            {preview ? t('studio.story.edit') : t('studio.story.preview')}
          </button>
          <button type="button" className="link-button" disabled={index === 0} onClick={() => onMove(-1)}>
            {t('studio.story.moveUp')}
          </button>
          <button type="button" className="link-button" disabled={index === count - 1} onClick={() => onMove(1)}>
            {t('studio.story.moveDown')}
          </button>
          <button type="button" className="link-button" onClick={() => window.confirm(t('studio.story.confirmRemoveSlide')) && onRemove()}>
            {t('studio.story.removeSlide')}
          </button>
        </div>
      </div>

      {preview ? (
        <div className="story-preview">
          <p className="meta">{t('studio.story.previewNote')}</p>
          {slide.blocks.some((b) => b.type === 'data') && slide.blocks.every((b) => b.type !== 'data' || (!views[b.id] && !b.empty)) && (
            <p className="message">{t('studio.story.skippedInPreview')}</p>
          )}
          <div className="story-slide">
            {slide.title && <h2>{localize(slide.title, 'en')}</h2>}
            {slide.blocks.map((block) => (
              <Block key={block.id} block={block} views={views} answer={undefined} onAnswer={async () => undefined} />
            ))}
          </div>
        </div>
      ) : (
        <>
          <LocalizedInput
            label={t('studio.story.title')}
            help={t('studio.story.titleHelp')}
            value={slide.title}
            onChange={(title) => onChange(withOptional(slide, 'title', title))}
          />
          <ol className="story-blocks">
            {slide.blocks.map((block, i) => (
              <li key={block.id} className="story-block-editor">
                <div className="story-block-head">
                  <strong>{t(`studio.story.block.${block.type}`)}</strong>
                  {incomplete(block) && <span className="tag">{t('studio.story.incomplete')}</span>}
                  <span className="story-block-actions">
                    <button type="button" className="link-button" disabled={i === 0} onClick={() => moveBlock(i, -1)}>
                      {t('studio.story.moveUp')}
                    </button>
                    <button type="button" className="link-button" disabled={i === slide.blocks.length - 1} onClick={() => moveBlock(i, 1)}>
                      {t('studio.story.moveDown')}
                    </button>
                    <button type="button" className="link-button" onClick={() => onChange({ ...slide, blocks: slide.blocks.filter((_, j) => j !== i) })}>
                      {t('studio.story.removeBlock')}
                    </button>
                  </span>
                </div>
                {block.type === 'text' && (
                  <LocalizedInput
                    label={t('studio.story.text')}
                    multiline
                    value={block.text}
                    onChange={(text) => setBlock(i, { ...block, text: text ?? '' })}
                  />
                )}
                {block.type === 'data' && <DataEditor block={block} tables={tables} onChange={(b) => setBlock(i, b)} />}
                {block.type === 'question' && <QuestionEditor block={block} onChange={(b) => setBlock(i, b)} />}
              </li>
            ))}
          </ol>
          {slide.blocks.length < STORY_LIMITS.blocks && (
            <p className="story-add-block">
              <span className="meta">{t('studio.story.addBlock')}</span>
              {(['text', 'data', 'question'] as const).map((type) => (
                <button key={type} type="button" className="button quiet" onClick={() => addBlock(type)}>
                  {t(`studio.story.block.${type}`)}
                </button>
              ))}
            </p>
          )}
        </>
      )}
    </section>
  );
}

/** A copy with an optional field set, or left out when there is no value. */
function withOptional<T extends object, K extends keyof T>(value: T, key: K, next: T[K] | undefined): T {
  const copy = { ...value };
  if (next === undefined) delete copy[key];
  else copy[key] = next;
  return copy;
}

/** English and Dutch fields for one text. Typed text is kept as it is; empty languages are left out. */
function LocalizedInput({
  label,
  help,
  value,
  multiline,
  onChange,
}: {
  label: string;
  help?: string;
  value: Localized | undefined;
  multiline?: boolean;
  onChange: (value: Localized | undefined) => void;
}) {
  const set = (language: 'en' | 'nl', text: string) => {
    const next: Record<string, string> = { en: textIn(value, 'en'), nl: textIn(value, 'nl'), [language]: text };
    for (const k of Object.keys(next)) if (next[k] === '') delete next[k];
    onChange(Object.keys(next).length > 0 ? next : undefined);
  };
  return (
    <fieldset className="localized-input">
      <legend>{label}</legend>
      {help && <p className="meta">{help}</p>}
      {(['en', 'nl'] as const).map((language) => (
        <label key={language} className="field">
          {language === 'en' ? 'English' : 'Nederlands'}
          {multiline ? (
            <textarea rows={3} value={textIn(value, language)} onChange={(e) => set(language, e.target.value)} />
          ) : (
            <input value={textIn(value, language)} onChange={(e) => set(language, e.target.value)} />
          )}
        </label>
      ))}
    </fieldset>
  );
}

/** The values each view's sentence can use. */
const PLACEHOLDERS: Record<DataViewKind, string[]> = {
  amount: ['count', 'per_day', 'days'],
  top: ['top', 'top_count'],
  'over-time': ['peak', 'peak_count'],
  rhythm: ['peak', 'peak_count'],
};

function DataEditor({ block, tables, onChange }: { block: DataBlock; tables: StoryTable[]; onChange: (b: DataBlock) => void }) {
  const { t } = useTranslation(undefined, { lng: 'en' });
  const table = tables.find((x) => x.platform === block.platform && x.id === block.table);
  const byPlatform = [...new Set(tables.map((x) => x.platform))];

  function setView(view: DataViewKind) {
    const next: DataBlock = { type: 'data', id: block.id, platform: block.platform, table: block.table, view };
    if (block.text) next.text = block.text;
    if (block.empty) next.empty = block.empty;
    if (view === 'top') {
      next.top = block.top ?? 5;
      const column = table?.columns.find((c) => !table.dates.some((d) => d.id === c.id));
      if (column) next.column = column.id;
    }
    if (view === 'rhythm') next.by = 'hour';
    onChange(next);
  }

  return (
    <div className="story-data-editor">
      <div className="field-row">
        <label className="field">
          {t('studio.story.table')}
          <select
            value={table ? tableKey(table.platform, table.id) : ''}
            onChange={(e) => {
              const [platform, id] = JSON.parse(e.target.value) as [string, string];
              const { column: _c, date: _d, ...rest } = block;
              onChange({ ...rest, platform, table: id });
            }}
          >
            {!table && <option value="">{t('studio.story.chooseTable')}</option>}
            {byPlatform.map((platform) => {
              const list = tables.filter((x) => x.platform === platform);
              return (
                <optgroup key={platform} label={localize(list[0]!.platformName, 'en') || platform}>
                  {list.map((x) => (
                    <option key={x.id} value={tableKey(x.platform, x.id)}>
                      {localize(x.name, 'en') || x.id}
                    </option>
                  ))}
                </optgroup>
              );
            })}
          </select>
        </label>
        <label className="field">
          {t('studio.story.view')}
          <select value={block.view} onChange={(e) => setView(e.target.value as DataViewKind)}>
            {DATA_VIEWS.map((view) => (
              <option key={view} value={view}>
                {t(`studio.story.template.${view}`)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {!table && block.table && tables.length > 0 && <p className="message">{t('studio.story.unknownTable')}</p>}
      <p className="meta">{t(`studio.story.viewHelp.${block.view}`)}</p>

      {block.view === 'top' && (
        <div className="field-row">
          <label className="field">
            {t('studio.story.column')}
            <select value={block.column ?? ''} onChange={(e) => onChange({ ...block, column: e.target.value })}>
              {!block.column && <option value="">{t('studio.story.chooseColumn')}</option>}
              {(table?.columns ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            {t('studio.story.howMany')}
            <input
              type="number"
              min={3}
              max={10}
              value={block.top ?? 5}
              onChange={(e) => onChange({ ...block, top: Math.min(10, Math.max(3, Number(e.target.value) || 5)) })}
            />
          </label>
        </div>
      )}

      {(block.view === 'over-time' || block.view === 'rhythm') && (
        <div className="field-row">
          <label className="field">
            {t('studio.story.date')}
            <select value={block.date ?? ''} onChange={(e) => onChange(withOptional(block, 'date', e.target.value || undefined))}>
              <option value="">
                {table?.date
                  ? t('studio.story.tableDate', { name: table.dates.find((d) => d.id === table.date)?.name ?? table.date })
                  : t('studio.story.noDate')}
              </option>
              {(table?.dates ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          {block.view === 'rhythm' && (
            <label className="field">
              {t('studio.story.by')}
              <select value={block.by ?? 'hour'} onChange={(e) => onChange({ ...block, by: e.target.value as 'hour' | 'weekday' })}>
                <option value="hour">{t('studio.story.byHour')}</option>
                <option value="weekday">{t('studio.story.byWeekday')}</option>
              </select>
            </label>
          )}
        </div>
      )}

      <LocalizedInput
        label={t('studio.story.sentence')}
        help={t('studio.story.sentenceHelp', { values: PLACEHOLDERS[block.view].map((p) => `{${p}}`).join(', ') })}
        value={block.text}
        onChange={(text) => onChange(withOptional(block, 'text', text))}
      />
      <details className="story-empty">
        <summary>{t('studio.story.emptyTitle')}</summary>
        <LocalizedInput
          label={t('studio.story.empty')}
          help={t('studio.story.emptyHelp')}
          value={block.empty}
          onChange={(empty) => onChange(withOptional(block, 'empty', empty))}
        />
      </details>
    </div>
  );
}

function QuestionEditor({ block, onChange }: { block: QuestionBlock; onChange: (b: QuestionBlock) => void }) {
  const { t } = useTranslation(undefined, { lng: 'en' });
  const [id, setId] = useState(block.id);
  const validId = /^[A-Za-z0-9_-]{1,64}$/.test(id);

  function setKind(kind: QuestionKind) {
    const next: QuestionBlock = { type: 'question', id: block.id, kind, prompt: block.prompt };
    if (block.required) next.required = true;
    if (kind === 'choice')
      next.options = block.options ?? [
        { en: 'Yes', nl: 'Ja' },
        { en: 'No', nl: 'Nee' },
      ];
    onChange(next);
  }

  const options = block.options ?? [];
  const bound = (key: 'min' | 'max', text: string) =>
    onChange(withOptional(block, key, text.trim() === '' || Number.isNaN(Number(text)) ? undefined : Number(text)));

  return (
    <div className="story-question-editor">
      <div className="field-row">
        <label className="field">
          {t('studio.story.kind')}
          <select value={block.kind} onChange={(e) => setKind(e.target.value as QuestionKind)}>
            {QUESTION_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {t(`studio.story.kinds.${kind}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          {t('studio.story.answerId')}
          <input
            value={id}
            aria-invalid={!validId}
            onChange={(e) => setId(e.target.value)}
            onBlur={() => (validId ? onChange({ ...block, id }) : setId(block.id))}
          />
        </label>
      </div>
      <p className="meta">{t('studio.story.answerIdHelp')}</p>
      <LocalizedInput label={t('studio.story.prompt')} value={block.prompt} onChange={(prompt) => onChange({ ...block, prompt: prompt ?? '' })} />
      {block.kind === 'choice' && (
        <fieldset>
          <legend>{t('studio.story.options')}</legend>
          <p className="meta">{t('studio.story.optionsHelp')}</p>
          <ol className="statement-list">
            {options.map((option, i) => (
              <li key={i}>
                <LocalizedInput
                  label={t('studio.story.option', { n: i + 1 })}
                  value={option}
                  onChange={(value) => onChange({ ...block, options: options.map((o, j) => (j === i ? (value ?? '') : o)) })}
                />
                <button type="button" className="link-button" onClick={() => onChange({ ...block, options: options.filter((_, j) => j !== i) })}>
                  {t('studio.story.removeOption')}
                </button>
              </li>
            ))}
          </ol>
          {options.length < STORY_LIMITS.options && (
            <button type="button" className="button quiet" onClick={() => onChange({ ...block, options: [...options, ''] })}>
              {t('studio.story.addOption')}
            </button>
          )}
        </fieldset>
      )}
      {block.kind === 'number' && (
        <div className="field-row">
          <label className="field">
            {t('studio.story.min')}
            <input type="number" value={block.min ?? ''} onChange={(e) => bound('min', e.target.value)} />
          </label>
          <label className="field">
            {t('studio.story.max')}
            <input type="number" value={block.max ?? ''} onChange={(e) => bound('max', e.target.value)} />
          </label>
        </div>
      )}
      <label className="check">
        <input
          type="checkbox"
          checked={block.required === true}
          onChange={(e) => onChange(withOptional(block, 'required', e.target.checked ? true : undefined))}
        />
        {t('studio.story.required')}
      </label>
    </div>
  );
}
