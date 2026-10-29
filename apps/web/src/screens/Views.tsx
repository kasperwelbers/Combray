import { localize, type FieldValue, type Row } from '@combray/core';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { RowFilter, TableSummary, Timeline as TimelineData, TimeUnit, TopItems as TopItemsData } from '../worker/api';
import { data } from '../worker/client';
import { localTime } from '../worker/tables';

const PAGE = 100;

type ViewId = 'memories' | 'timeline' | 'top';

function text(value: FieldValue | undefined): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(text).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function useLocale() {
  const { i18n } = useTranslation();
  return i18n.resolvedLanguage ?? 'en';
}

/** A local `YYYY-MM-DD` day as a long date in the reader's language. */
function formatDay(day: string, locale: string, options: Intl.DateTimeFormatOptions = { dateStyle: 'full' }): string {
  return new Date(`${day}T12:00:00`).toLocaleDateString(locale, options);
}

function periodLabel(start: string, unit: TimeUnit, locale: string): string {
  if (unit === 'month') return formatDay(start, locale, { month: 'long', year: 'numeric' });
  if (unit === 'week') return formatDay(start, locale, { day: 'numeric', month: 'short', year: 'numeric' });
  return formatDay(start, locale, { dateStyle: 'medium' });
}

function FilterChip({ filter, onClear, locale }: { filter: RowFilter; onClear: () => void; locale: string }) {
  const { t } = useTranslation();
  if (!filter.value && !filter.from) return null;
  const label = filter.value
    ? filter.value
    : `${formatDay(filter.from!, locale, { dateStyle: 'medium' })} – ${formatDay(
        new Date(Date.parse(`${filter.to}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10),
        locale,
        { dateStyle: 'medium' },
      )}`;
  return (
    <p className="chip-row">
      {t('views.showingOnly')} <span className="chip">{label}</span>
      <button type="button" className="link-button" onClick={onClear}>
        {t('views.showAll')}
      </button>
    </p>
  );
}

function MemoryLane({ table, filter }: { table: TableSummary; filter: RowFilter }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [items, setItems] = useState<Row[]>([]);
  const [total, setTotal] = useState<number>();
  const { date: dateField, title, url, group_by: groups = [] } = table.display;

  useEffect(() => {
    let cancelled = false;
    void data.getRows(table.id, filter, 0, PAGE).then((page) => {
      if (cancelled) return;
      setItems(page.items);
      setTotal(page.total);
    });
    return () => {
      cancelled = true;
    };
  }, [table.id, filter]);

  async function more() {
    const page = await data.getRows(table.id, filter, items.length, PAGE);
    setItems((current) => [...current, ...page.items]);
  }

  const days = useMemo(() => {
    const grouped: { day: string; rows: Row[] }[] = [];
    for (const row of items) {
      const day = dateField ? (localTime(row[dateField])?.slice(0, 10) ?? '') : '';
      const last = grouped.at(-1);
      if (last && last.day === day) last.rows.push(row);
      else grouped.push({ day, rows: [row] });
    }
    return grouped;
  }, [items, dateField]);

  if (total === undefined) return null;
  if (total === 0) return <p className="meta">{t('views.nothing')}</p>;

  return (
    <section className="lane">
      {days.map(({ day, rows }, i) => (
        <section key={`${day}-${i}`} className="lane-day">
          <h3>{day ? formatDay(day, locale) : t('views.undated')}</h3>
          <ul>
            {rows.map((row, j) => {
              const time = dateField ? localTime(row[dateField])?.slice(11, 16) : undefined;
              const label = text(title ? row[title] : undefined) || text(url ? row[url] : undefined) || t('views.untitled');
              const link = url ? text(row[url]) : '';
              const extra = groups.map((g) => text(row[g])).filter(Boolean).join(' · ');
              return (
                <li key={j} className="lane-item">
                  {time && time !== '00:00' && <span className="lane-time">{time}</span>}
                  <span>
                    {link ? (
                      <a href={link} target="_blank" rel="noopener noreferrer">
                        {label}
                      </a>
                    ) : (
                      label
                    )}
                    {extra && <span className="meta lane-extra">{extra}</span>}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      {items.length < total && (
        <p>
          <button className="button quiet" type="button" onClick={more}>
            {t('explore.more')} ({items.length} / {total})
          </button>
        </p>
      )}
    </section>
  );
}

function Timeline({ table, filter, onPick }: { table: TableSummary; filter: RowFilter; onPick: (from: string, to: string) => void }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [unit, setUnit] = useState<TimeUnit>();
  const [timeline, setTimeline] = useState<TimelineData>();

  useEffect(() => {
    void data.getTimeline(table.id, filter, unit).then(setTimeline);
  }, [table.id, filter, unit]);

  if (!timeline) return null;
  if (timeline.buckets.length === 0) return <p className="meta">{t('views.noDates')}</p>;

  const max = Math.max(...timeline.buckets.map((b) => b.count), 1);
  const width = 760;
  const height = 220;
  const barWidth = width / timeline.buckets.length;
  const first = timeline.buckets[0]!;
  const last = timeline.buckets.at(-1)!;

  return (
    <section>
      <div className="toolbar">
        <label>
          {t('views.per')}{' '}
          <select value={timeline.unit} onChange={(e) => setUnit(e.target.value as TimeUnit)}>
            {(['day', 'week', 'month'] as const).map((u) => (
              <option key={u} value={u}>
                {t(`views.unit.${u}`)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <figure className="timeline">
        <svg viewBox={`0 0 ${width} ${height + 24}`} role="img" aria-labelledby="timeline-caption">
          {timeline.buckets.map((b, i) => {
            const h = (b.count / max) * height;
            const label = `${periodLabel(b.start, timeline.unit, locale)}: ${t('views.count', { count: b.count })}`;
            return (
              <g key={b.start}>
                <rect
                  className="bar"
                  x={i * barWidth + Math.min(1, barWidth * 0.1)}
                  y={height - h}
                  width={Math.max(barWidth - Math.min(2, barWidth * 0.2), 0.5)}
                  height={Math.max(h, b.count > 0 ? 1 : 0)}
                  tabIndex={b.count > 0 ? 0 : -1}
                  aria-label={label}
                  onClick={() => b.count > 0 && onPick(b.start, b.end)}
                  onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && b.count > 0 && onPick(b.start, b.end)}
                >
                  <title>{label}</title>
                </rect>
              </g>
            );
          })}
          <line x1={0} x2={width} y1={height} y2={height} className="axis" />
          <text x={0} y={height + 18} className="axis-label">
            {periodLabel(first.start, timeline.unit, locale)}
          </text>
          <text x={width} y={height + 18} className="axis-label" textAnchor="end">
            {periodLabel(last.start, timeline.unit, locale)}
          </text>
        </svg>
        <figcaption id="timeline-caption" className="meta">
          {t('views.timelineCaption', { max, unit: t(`views.unit.${timeline.unit}`) })}
          {timeline.undated > 0 && ` ${t('views.undatedCount', { count: timeline.undated })}`}
        </figcaption>
      </figure>
    </section>
  );
}

function TopItems({ table, filter, onPick }: { table: TableSummary; filter: RowFilter; onPick: (field: string, value: string) => void }) {
  const { t } = useTranslation();
  const fields = table.display.group_by ?? [];
  const [field, setField] = useState(fields[0]);
  const [top, setTop] = useState<TopItemsData>();

  useEffect(() => {
    if (field) void data.getTopItems(table.id, field, filter, 20).then(setTop);
  }, [table.id, field, filter]);

  if (!field || !top) return null;
  const max = top.items[0]?.count ?? 1;

  return (
    <section>
      {fields.length > 1 && (
        <div className="toolbar">
          <label>
            {t('views.groupBy')}{' '}
            <select value={field} onChange={(e) => setField(e.target.value)}>
              {fields.map((f) => (
                <option key={f} value={f}>
                  {t(`fields.${f}`, { defaultValue: f })}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      <ol className="top">
        {top.items.map((item) => (
          <li key={item.value}>
            <button type="button" className="top-item" onClick={() => onPick(field, item.value)}>
              <span className="top-label">{item.value}</span>
              <span className="top-bar" style={{ width: `${(item.count / max) * 100}%` }} aria-hidden="true" />
              <span className="top-count">{item.count}</span>
            </button>
          </li>
        ))}
      </ol>
      <p className="meta">{t('views.distinct', { count: top.distinct })}</p>
    </section>
  );
}

export function Views({ table, onBack }: { table: TableSummary; onBack: () => void }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const views: ViewId[] = ['memories', ...(table.display.date ? (['timeline'] as const) : []), ...(table.display.group_by?.length ? (['top'] as const) : [])];
  const [view, setView] = useState<ViewId>('memories');
  const [filter, setFilter] = useState<RowFilter>({});

  return (
    <>
      <p>
        <button type="button" className="link-button" onClick={onBack}>
          ← {t('explore.back')}
        </button>
      </p>
      <h1>{localize(table.name, locale)}</h1>
      <p className="meta">{t('datasets.items', { count: table.rowCount })}</p>
      {views.length > 1 && (
        <div className="tabs" role="tablist">
          {views.map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              id={`tab-${id}`}
              aria-selected={view === id}
              aria-controls={`panel-${id}`}
              onClick={() => setView(id)}
            >
              {t(`views.${id}`)}
            </button>
          ))}
        </div>
      )}
      <FilterChip filter={filter} onClear={() => setFilter({})} locale={locale} />
      <div role="tabpanel" id={`panel-${view}`} aria-labelledby={`tab-${view}`}>
        {view === 'memories' && <MemoryLane table={table} filter={filter} />}
        {view === 'timeline' && (
          <Timeline
            table={table}
            filter={filter}
            onPick={(from, to) => {
              setFilter((f) => ({ ...f, from, to }));
              setView('memories');
            }}
          />
        )}
        {view === 'top' && (
          <TopItems
            table={table}
            filter={filter}
            onPick={(field, value) => {
              setFilter((f) => ({ ...f, field, value }));
              setView('memories');
            }}
          />
        )}
      </div>
    </>
  );
}
