import { localize, type FieldValue, type Row } from '@combray/core';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { safeHref } from '../security';
import type { ColumnInfo, RowFilter, TableSummary } from '../worker/api';
import { data } from '../worker/client';
import { localTime } from '../worker/tables';

const PAGE = 50;
const MAX_TEXT = 400;

/** A column's name for participants: the label, or words for the key and value of a pair. */
export function columnName(column: ColumnInfo, language: string, t: (key: string) => string): string {
  const name = localize(column.name, language);
  if (name) return name;
  return column.type === 'key' ? t('table.key') : t('table.value');
}

/** The label of a field, also of a field in a nested table (`subtitles/[*]/name`). */
export function fieldLabel(
  table: TableSummary,
  field: string,
  language: string,
  t: (key: string, options?: { defaultValue: string }) => string,
): string {
  const find = (columns: ColumnInfo[], rest: string): ColumnInfo | undefined => {
    for (const c of columns) {
      if (c.id === rest) return c;
      if (c.type === 'table' && rest.startsWith(`${c.id}/`)) return find(c.columns ?? [], rest.slice(c.id.length + 1));
    }
    return undefined;
  };
  const column = table.derived && find(table.derived.columns, field);
  return column ? columnName(column, language, t) : t(`fields.${field}`, { defaultValue: field });
}

function text(value: FieldValue | undefined): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  const s = String(value);
  return s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}…` : s;
}

/** A date and time in the participant's own words, from the ISO text values are read as. */
function formatDate(value: string, language: string): string {
  const local = localTime(value);
  if (!local) return value;
  const date = new Date(`${local.slice(0, 19)}`);
  if (Number.isNaN(date.getTime())) return value;
  const time = local.slice(11, 19) !== '00:00:00';
  return date.toLocaleString(language, time ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' });
}

function Cell({ value, column, onOpen }: { value: FieldValue | undefined; column: ColumnInfo; onOpen: () => void }) {
  const { t, i18n } = useTranslation();
  if (column.type === 'table') {
    const rows = Array.isArray(value) ? (value as Row[]) : [];
    if (rows.length === 0) return <span className="meta">–</span>;
    // One nested row (a video's channel) shows its first value; more show how many there are.
    const first = column.columns?.find((c) => c.type !== 'table');
    const label = rows.length === 1 && first ? text(rows[0]![first.id]) : '';
    return (
      <button type="button" className="link-button" onClick={onOpen}>
        {label || t('table.rows', { count: rows.length })}
      </button>
    );
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="meta">–</span>;
    return (
      <ul className="cell-items">
        {value.map((v, i) => (
          <li key={i}>{text(v)}</li>
        ))}
      </ul>
    );
  }
  const s = text(value);
  if (column.as === 'datetime' && typeof value === 'string') return <>{formatDate(value, i18n.language)}</>;
  const href = column.role === 'url' || column.as === 'url' ? safeHref(s) : undefined;
  if (href) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {s}
      </a>
    );
  }
  return <>{s}</>;
}

interface Level {
  title: string;
  columns: ColumnInfo[];
  rows: Row[];
}

function Grid({ level, onOpen }: { level: Level; onOpen: (row: Row, column: ColumnInfo) => void }) {
  const { t, i18n } = useTranslation();
  return (
    <div className="preview-scroll">
      <table className="preview-table">
        <caption className="visually-hidden">{level.title}</caption>
        <thead>
          <tr>
            {level.columns.map((c) => (
              <th key={c.id} scope="col">
                {columnName(c, i18n.language, t)}
                {c.state === 'donate' && <span className="tag">{t('table.requested')}</span>}
                {c.new && (
                  <span className="tag" title={t('table.newHelp')}>
                    {t('table.new')}
                  </span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {level.rows.map((row, i) => (
            <tr key={i}>
              {level.columns.map((c) => (
                <td key={c.id}>
                  <Cell value={row[c.id]} column={c} onOpen={() => onOpen(row, c)} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * A derived table as a table: one row per item, nested tables as a number of rows you can
 * open, with a way back. Nested rows come with their parent row, so opening one needs no query.
 */
export function TableView({ table, filter }: { table: TableSummary; filter: RowFilter }) {
  const { t, i18n } = useTranslation();
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState<number>();
  const [stack, setStack] = useState<Level[]>([]);
  const columns = table.derived?.columns ?? table.fields.map((id): ColumnInfo => ({ id, name: id, type: 'value', state: 'show' }));
  const title = localize(table.name, i18n.language);

  useEffect(() => {
    let cancelled = false;
    setStack([]);
    void data.getRows(table.id, filter, 0, PAGE).then((page) => {
      if (cancelled) return;
      setRows(page.items);
      setTotal(page.total);
    });
    return () => {
      cancelled = true;
    };
  }, [table.id, filter]);

  async function more() {
    const page = await data.getRows(table.id, filter, rows.length, PAGE);
    setRows((current) => [...current, ...page.items]);
  }

  const open = (parent: Level) => (row: Row, column: ColumnInfo) => {
    const nested = (row[column.id] as Row[] | undefined) ?? [];
    setStack((s) => [
      ...s,
      { title: `${parent.title} › ${columnName(column, i18n.language, t)}`, columns: column.columns ?? [], rows: nested },
    ]);
  };

  if (total === undefined) return null;
  if (total === 0) return <p className="meta">{t('views.nothing')}</p>;
  const top: Level = { title, columns, rows };
  const current = stack.at(-1);
  if (current) {
    return (
      <section aria-live="polite">
        <p>
          <button type="button" className="link-button" onClick={() => setStack((s) => s.slice(0, -1))}>
            ← {t('table.back', { name: stack.length > 1 ? stack.at(-2)!.title : title })}
          </button>
        </p>
        <h2 className="nested-title">{current.title}</h2>
        <Grid level={current} onOpen={open(current)} />
      </section>
    );
  }
  return (
    <section>
      <Grid level={top} onOpen={open(top)} />
      {rows.length < total && (
        <p>
          <button className="button quiet" type="button" onClick={more}>
            {t('explore.more')} ({rows.length} / {total})
          </button>
        </p>
      )}
    </section>
  );
}
