import {
  dateFormats,
  deriveTables,
  localize,
  queryColumns,
  rootTable,
  type ChartData,
  type ChartSpec,
  type DatePart,
  type FrameColumn,
  type ProjectNode,
  type Scalar,
  type SummaryFn,
} from '@combray/core';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Chart } from '../components/Chart';
import { studio } from './client';

const PARTS: DatePart[] = ['year', 'month', 'week', 'day', 'weekday', 'hour'];
const MEASURES: Exclude<SummaryFn, 'count'>[] = ['sum', 'mean', 'min', 'max', 'distinct'];
const DELAY_MS = 250;

interface Props {
  tree: ProjectNode;
  hasExports: boolean;
}

const isTime = (c: FrameColumn) =>
  c.def?.types?.includes('date-like') === true || c.def?.formats?.some((f) => f.startsWith('epoch-')) === true;
const isNumber = (c: FrameColumn) =>
  c.def?.type === 'table' || (c.def?.types?.some((t) => t === 'int' || t === 'float') === true && !isTime(c));

/**
 * A first chart builder: count the rows of a table over time or per category, or summarise a
 * number, optionally split into series. It runs on the loaded exports in the studio worker;
 * only the counts come back. See docs/exploration.md#charts.
 */
export function ChartBuilder({ tree, hasExports }: Props) {
  const { t, i18n } = useTranslation();
  const tables = useMemo(() => deriveTables(tree), [tree]);
  const [table, setTable] = useState<number>();
  const [x, setX] = useState('');
  const [part, setPart] = useState<DatePart>('month');
  const [format, setFormat] = useState('');
  const [measure, setMeasure] = useState<'count' | Exclude<SummaryFn, 'count'>>('count');
  const [measureColumn, setMeasureColumn] = useState('');
  const [split, setSplit] = useState('');
  const [data, setData] = useState<ChartData>();
  const [failed, setFailed] = useState(false);

  // Start with the first table that has rows, rather than the record of loose fields.
  const first = Math.max(0, tables.findIndex((t) => t.rows !== undefined));
  const current = table !== undefined && table < tables.length ? table : first;
  const columns = useMemo(() => {
    if (tables.length === 0) return [];
    return queryColumns(tables, rootTable(tables, current), current);
  }, [tables, current]);
  const tableName = (i: number) => localize(tables[i]!.name, i18n.language) || t('studio.unnamedTable');
  const columnName = (c: FrameColumn) => {
    const own =
      c.def?.type === 'key'
        ? t('studio.keyColumn')
        : localize(c.name, i18n.language) || t('studio.valueColumn');
    return c.table === current ? own : `${tableName(c.table!)} › ${own}`;
  };

  const xColumn = columns.find((c) => c.id === x) ?? columns.find(isTime) ?? columns.find((c) => c.def?.type !== 'table');
  const time = xColumn !== undefined && isTime(xColumn);
  const formats = xColumn?.def?.formats ? dateFormats(xColumn.def.formats) : [];
  const usedFormat = time ? (formats.includes(format) ? format : formats[0]) : undefined;
  const numeric = columns.filter(isNumber);
  const usedMeasure = measure !== 'count' && measure !== 'distinct' && numeric.length === 0 ? 'count' : measure;
  const measureCol =
    usedMeasure === 'count'
      ? undefined
      : ((usedMeasure === 'distinct' ? columns : numeric).find((c) => c.id === measureColumn) ??
        (usedMeasure === 'distinct' ? columns : numeric)[0]);
  const splitColumn = columns.find((c) => c.id === split && c.id !== xColumn?.id && !isTime(c));

  const spec = useMemo<ChartSpec | undefined>(() => {
    if (!xColumn) return undefined;
    return {
      table: current,
      x: { column: xColumn.id, ...(time ? { time: part } : {}), ...(usedFormat ? { format: usedFormat } : {}) },
      ...(measureCol && usedMeasure !== 'count' ? { y: { fn: usedMeasure, column: measureCol.id } } : {}),
      ...(splitColumn ? { split: splitColumn.id } : {}),
    };
  }, [current, xColumn, time, part, usedFormat, measureCol, usedMeasure, splitColumn]);

  useEffect(() => {
    if (!spec || !hasExports) return setData(undefined);
    let cancelled = false;
    const timer = setTimeout(() => {
      studio.chart(tree, spec).then(
        (d) => {
          if (cancelled) return;
          setData(d);
          setFailed(false);
        },
        () => !cancelled && setFailed(true),
      );
    }, DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [tree, spec, hasExports]);

  if (!hasExports) return <p className="meta">{t('studio.previewEmpty')}</p>;
  if (tables.length === 0) return <p className="meta">{t('studio.noTables')}</p>;

  const locale = i18n.resolvedLanguage ?? 'en';
  const formatX = (value: Scalar): string => {
    if (value === null) return '–';
    if (!time) return String(value);
    const s = String(value);
    const day = (d: string, options: Intl.DateTimeFormatOptions) =>
      new Date(`${d}T12:00:00Z`).toLocaleDateString(locale, { ...options, timeZone: 'UTC' });
    switch (part) {
      case 'year':
        return s;
      case 'month':
        return day(`${s}-01`, { month: 'short', year: 'numeric' });
      case 'week':
        return t('chart.weekOf', { date: day(s, { day: 'numeric', month: 'short', year: 'numeric' }) });
      case 'day':
        return day(s, { day: 'numeric', month: 'short', year: 'numeric' });
      case 'weekday':
        // 2024-01-01 was a Monday.
        return day(`2024-01-0${Number(value)}`, { weekday: 'long' });
      case 'hour':
        return `${String(value).padStart(2, '0')}:00`;
    }
  };
  const measureLabel =
    usedMeasure === 'count' || !measureCol
      ? t('chart.rowsOf', { table: tableName(current) })
      : t(`chart.measure.${usedMeasure}`, { column: columnName(measureCol) });

  return (
    <div className="chart-builder">
      <div className="chart-controls">
        <label className="field">
          <span>{t('chart.count')}</span>
          <select value={current} onChange={(e) => setTable(Number(e.target.value))}>
            {tables.map((_, i) => (
              <option key={i} value={i}>
                {tables[i]!.parent !== undefined ? `${tableName(tables[i]!.parent!)} › ${tableName(i)}` : tableName(i)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t('chart.along')}</span>
          <select value={xColumn?.id ?? ''} onChange={(e) => setX(e.target.value)}>
            {columns
              .filter((c) => c.def?.type !== 'table')
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {isTime(c) ? `◷ ${columnName(c)}` : columnName(c)}
                </option>
              ))}
          </select>
        </label>
        {time && (
          <label className="field">
            <span>{t('chart.per')}</span>
            <select value={part} onChange={(e) => setPart(e.target.value as DatePart)}>
              {PARTS.map((p) => (
                <option key={p} value={p}>
                  {t(`chart.part.${p}`)}
                </option>
              ))}
            </select>
          </label>
        )}
        {time && formats.length > 1 && (
          <label className="field">
            <span>{t('chart.format')}</span>
            <select value={usedFormat} onChange={(e) => setFormat(e.target.value)}>
              {formats.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="field">
          <span>{t('chart.show')}</span>
          <select value={usedMeasure} onChange={(e) => setMeasure(e.target.value as typeof measure)}>
            <option value="count">{t('chart.measure.count')}</option>
            {MEASURES.filter((m) => m === 'distinct' || numeric.length > 0).map((m) => (
              <option key={m} value={m}>
                {t(`chart.measure.${m}`, { column: '…' })}
              </option>
            ))}
          </select>
        </label>
        {measureCol && (
          <label className="field">
            <span>{t('chart.of')}</span>
            <select value={measureCol.id} onChange={(e) => setMeasureColumn(e.target.value)}>
              {(usedMeasure === 'distinct' ? columns : numeric).map((c) => (
                <option key={c.id} value={c.id}>
                  {columnName(c)}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="field">
          <span>{t('chart.split')}</span>
          <select value={splitColumn?.id ?? ''} onChange={(e) => setSplit(e.target.value)}>
            <option value="">{t('chart.noSplit')}</option>
            {columns
              .filter((c) => c.id !== xColumn?.id && !isTime(c) && c.def?.type !== 'table')
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {columnName(c)}
                </option>
              ))}
          </select>
        </label>
      </div>
      {failed && <p className="message error">{t('chart.failed')}</p>}
      {data && (
        <Chart
          data={data}
          measure={measureLabel}
          formatX={formatX}
          formatSeries={(s) => (s === null ? t('chart.none') : String(s))}
        />
      )}
    </div>
  );
}
