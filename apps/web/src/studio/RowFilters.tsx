import { localize, type ColumnDef, type ProjectNode, type RowFilter } from '@combray/core';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { SectionHead } from './Popover';
import type { NodePatch } from './model';

type TestKind = 'empty' | 'filled' | 'contains' | 'matches';

function toFilter(column: string, kind: TestKind, text: string, exclude: boolean): RowFilter {
  const test: RowFilter['test'] =
    kind === 'empty' || kind === 'filled'
      ? { empty: kind === 'empty' }
      : kind === 'contains'
        ? { contains: text }
        : { matches: text, flags: 'i' };
  return { column, test, ...(exclude ? { not: true as const } : {}) };
}

function describe(filter: RowFilter, name: string, t: (key: string, options?: Record<string, unknown>) => string) {
  const test = filter.test;
  const what =
    'empty' in test
      ? t(test.empty ? 'studio.filterText.empty' : 'studio.filterText.filled', { name })
      : 'contains' in test
        ? t('studio.filterText.contains', { name, text: test.contains })
        : 'matches' in test
          ? t('studio.filterText.matches', { name, text: test.matches })
          : t('studio.filterText.other', { name });
  return filter.not ? t('studio.filterText.not', { what }) : what;
}

/**
 * Which rows of a table are imported: rows must meet every condition. For leaving out rows
 * that are not the participant's own activity, such as ads in a watch history.
 */
export function RowFilters({
  node,
  columns,
  onPatch,
}: {
  node: ProjectNode;
  columns: ColumnDef[];
  onPatch: (patch: NodePatch) => void;
}) {
  const { t, i18n } = useTranslation(undefined, { lng: 'en' });
  const usable = columns.filter((c) => c.type === 'value' || c.type === 'list' || c.type === 'key');
  const [picked, setColumn] = useState('');
  const column = usable.some((c) => c.id === picked) ? picked : (usable[0]?.id ?? '');
  const [kind, setKind] = useState<TestKind>('empty');
  const [text, setText] = useState('');
  const [exclude, setExclude] = useState(false);
  const [error, setError] = useState(false);
  const filters = node.filter ?? [];
  const nameOf = (id: string) => {
    const c = columns.find((col) => col.id === id);
    return c ? localize(c.name, i18n.language) || id : id;
  };
  const needsText = kind === 'contains' || kind === 'matches';

  function add(event: FormEvent) {
    event.preventDefault();
    if (!column || (needsText && text === '')) return;
    if (kind === 'matches') {
      try {
        new RegExp(text);
      } catch {
        setError(true);
        return;
      }
    }
    setError(false);
    setText('');
    onPatch({ filter: [...filters, toFilter(column, kind, text, exclude)] });
  }

  if (usable.length === 0) return null;
  return (
    <div className="panel-group">
      <SectionHead title={t('studio.filterTitle')} help={t('studio.filterHelp')} />
      {filters.length > 0 && (
        <ul className="item-list">
          {filters.map((f, i) => (
            <li key={`${JSON.stringify(f)}:${i}`}>
              <span>{describe(f, nameOf(f.column), t)}</span>
              <button
                type="button"
                className="link-button"
                onClick={() => onPatch({ filter: filters.filter((_, j) => j !== i) })}
              >
                {t('studio.remove')}
              </button>
            </li>
          ))}
        </ul>
      )}
      <form className="filter-form" onSubmit={add}>
        <label className="field">
          <span>{t('studio.filterColumn')}</span>
          <select value={column} onChange={(e) => setColumn(e.target.value)}>
            {usable.map((c) => (
              <option key={c.id} value={c.id}>
                {localize(c.name, i18n.language) || (c.type === 'key' ? t('studio.keyColumn') : t('studio.valueColumn'))}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t('studio.filterTest')}</span>
          <select value={kind} onChange={(e) => setKind(e.target.value as TestKind)}>
            {(['empty', 'filled', 'contains', 'matches'] as const).map((k) => (
              <option key={k} value={k}>
                {t(`studio.filterKind.${k}`)}
              </option>
            ))}
          </select>
        </label>
        {needsText && (
          <label className="field">
            <span>{kind === 'matches' ? t('studio.pattern') : t('studio.filterTextLabel')}</span>
            <input value={text} onChange={(e) => setText(e.target.value)} />
          </label>
        )}
        <label className="check">
          <input type="checkbox" checked={exclude} onChange={(e) => setExclude(e.target.checked)} />
          {t('studio.filterExclude')}
        </label>
        <button className="button quiet" type="submit">
          {t('studio.add')}
        </button>
      </form>
      {error && (
        <p className="message error" role="alert">
          {t('studio.badRegex')}
        </p>
      )}
    </div>
  );
}
