import { localize, type ColumnDef } from '@combray/core';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { PreviewTable, PreviewValue } from './api';

interface Props {
  tables: PreviewTable[];
  hasExports: boolean;
}

interface Open {
  table: number;
  /** For nested tables opened from a cell: the parent row the rows belong to. */
  parentRow?: number;
}

/**
 * "View as participant": the tables inferred from the structure, filled with the loaded
 * exports. A map of all tables (nested ones under their parent) sits next to the open table;
 * nested tables also open from their cells, filtered to that row.
 */
export function Preview({ tables, hasExports }: Props) {
  const { t, i18n } = useTranslation();
  const [stack, setStack] = useState<Open[]>([]);
  const name = (table: PreviewTable) => localize(table.name, i18n.language) || t('studio.unnamedTable');

  if (!hasExports) return <p className="meta">{t('studio.previewEmpty')}</p>;
  if (tables.length === 0) return <p className="meta">{t('studio.noTables')}</p>;

  // Tables with requested fields first, the record of loose fields last.
  const rank = (table: PreviewTable) => (table.state === 'donate' ? 0 : table.record ? 2 : 1);
  const childrenOf = (parent: number | undefined) =>
    tables
      .map((table, index) => ({ table, index }))
      .filter(({ table }) => table.parent === parent)
      .sort((a, b) => rank(a.table) - rank(b.table) || a.index - b.index);
  const first = childrenOf(undefined)[0]?.index ?? 0;
  const current = stack.at(-1) ?? { table: first };
  const table = tables[current.table] ?? tables[0]!;
  const rows =
    current.parentRow === undefined ? table.rows : table.rows.filter((r) => r.parent === current.parentRow);

  const columnName = (c: ColumnDef) =>
    c.type === 'key'
      ? t('studio.keyColumn')
      : localize(c.name, i18n.language) || t('studio.valueColumn');

  function tableMap(parent?: number) {
    const items = childrenOf(parent);
    if (items.length === 0) return null;
    return (
      <ul>
        {items.map(({ table: item, index }) => (
          <li key={index}>
            <button
              type="button"
              className="link-button table-link"
              aria-current={current.table === index && current.parentRow === undefined}
              onClick={() => setStack([{ table: index }])}
            >
              {name(item)}
            </button>{' '}
            <span className="meta">{t('studio.size', { rows: item.rowCount, columns: item.columns.length })}</span>
            {item.state === 'donate' && <span className="tag donate-tag">{t('studio.requested')}</span>}
            {tableMap(index)}
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className="preview">
      <nav className="table-map" aria-label={t('studio.tables')}>
        {tableMap()}
      </nav>
      <div className="preview-main">
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
        <h3>{name(table)}</h3>
        <p className="meta">
          {table.record
            ? t('studio.recordTable')
            : current.parentRow === undefined
              ? t('studio.rowsShown', { shown: rows.length, count: table.rowCount })
              : t('datasets.items', { count: rows.length })}
        </p>
        <div className="preview-scroll">
          <table className="preview-table">
            <thead>
              <tr>
                {table.columns.map((c) => (
                  <th key={c.id} scope="col" title={c.id}>
                    {columnName(c)}
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
                          {t('studio.size', {
                            rows: Number(row.values[c.id] ?? 0),
                            columns: tables[c.table!]?.columns.length ?? 0,
                          })}
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
      </div>
    </div>
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
