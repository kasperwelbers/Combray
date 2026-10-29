import { localize } from '@combray/core';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { PreviewTable, PreviewValue } from './api';

interface Props {
  tables: PreviewTable[];
  hasExports: boolean;
}

interface Open {
  table: number;
  /** For nested tables: the parent row the rows belong to. */
  parentRow?: number;
}

/** "View as participant": the tables the current decisions produce from the loaded exports. */
export function Preview({ tables, hasExports }: Props) {
  const { t, i18n } = useTranslation();
  const [stack, setStack] = useState<Open[]>([]);
  const name = (table: PreviewTable) => localize(table.name, i18n.language) || t('studio.unnamedTable');

  if (!hasExports) return <p className="meta">{t('studio.previewEmpty')}</p>;
  // Tables with requested fields first, the record of loose fields last.
  const rank = (t: PreviewTable) => (t.state === 'donate' ? 0 : t.record ? 2 : 1);
  const top = tables
    .map((table, index) => ({ table, index }))
    .filter(({ table }) => table.parent === undefined)
    .sort((a, b) => rank(a.table) - rank(b.table) || a.index - b.index);
  if (top.length === 0) return <p className="meta">{t('studio.noTables')}</p>;
  const current = stack.at(-1) ?? { table: top[0]!.index };
  const table = tables[current.table];
  if (!table) return null;
  const rows =
    current.parentRow === undefined ? table.rows : table.rows.filter((r) => r.parent === current.parentRow);

  return (
    <>
      <div className="tabs" role="tablist" aria-label={t('studio.tables')}>
        {top.map(({ table: tab, index }) => (
          <button
            key={index}
            type="button"
            role="tab"
            aria-selected={(stack[0]?.table ?? top[0]!.index) === index}
            onClick={() => setStack([{ table: index }])}
          >
            {name(tab)} <span className="meta">({tab.rowCount})</span>
            {tab.state === 'donate' && <span className="tag donate-tag">{t('studio.requested')}</span>}
          </button>
        ))}
      </div>
      {stack.length > 1 && (
        <nav aria-label={t('explore.breadcrumbs')}>
          <ol className="crumbs">
            {stack.map((open, i) => (
              <li key={i}>
                {i < stack.length - 1 ? (
                  <button type="button" className="link-button" onClick={() => setStack(stack.slice(0, i + 1))}>
                    {name(tables[open.table]!)}
                  </button>
                ) : (
                  <strong>{name(tables[open.table]!)}</strong>
                )}
              </li>
            ))}
          </ol>
        </nav>
      )}
      <p className="meta">
        {table.implicit ? t('studio.implicitTable') : t('studio.markedTable')} ·{' '}
        {current.parentRow === undefined
          ? t('studio.rowsShown', { shown: rows.length, count: table.rowCount })
          : t('datasets.items', { count: rows.length })}
      </p>
      <div className="preview-scroll">
        <table className="preview-table">
          <thead>
            <tr>
              {table.columns.map((c) => (
                <th key={c.id} scope="col" title={c.id}>
                  {localize(c.name, i18n.language)}
                  {c.state === 'donate' && (
                    <>
                      {' '}
                      <span className="tag donate-tag">{t('studio.requested')}</span>
                    </>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.index}>
                {table.columns.map((c) => (
                  <td key={c.id}>
                    {c.type === 'table' ? (
                      <button
                        type="button"
                        className="link-button"
                        disabled={!row.values[c.id]}
                        onClick={() =>
                          setStack([...(stack.length > 0 ? stack : [current]), { table: c.table!, parentRow: row.index }])
                        }
                      >
                        {t('datasets.items', { count: Number(row.values[c.id] ?? 0) })}
                      </button>
                    ) : (
                      <Cell value={row.values[c.id] ?? null} />
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Cell({ value }: { value: PreviewValue }) {
  const { t } = useTranslation();
  if (value === null) return <span className="meta">–</span>;
  if (typeof value === 'object') {
    if (value.total === 0) return <span className="meta">{t('datasets.items', { count: 0 })}</span>;
    return (
      <details>
        <summary>{t('datasets.items', { count: value.total })}</summary>
        <ul className="cell-items">
          {value.items.map((item, i) => (
            <li key={i}>{item ?? '–'}</li>
          ))}
          {value.total > value.items.length && <li className="meta">…</li>}
        </ul>
      </details>
    );
  }
  return <>{String(value)}</>;
}
