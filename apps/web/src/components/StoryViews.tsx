/**
 * The four views of a participant's data in a story, each the chart that people without a
 * research background read most easily: one big number, ranked bars, and columns over time or
 * over the day. Every chart is labelled directly (no legends), highlights the one thing the
 * slide's sentence is about, and has its numbers in a table for screen readers.
 *
 * Values are rendered as text by React, never as HTML.
 */
import type { StoryValues } from '@combray/core';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';

import type { StoryView, TimeUnit } from '../worker/api';

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Count up to a number when it appears, unless people prefer less motion. */
function useCountUp(target: number, ms = 900): number {
  const [value, setValue] = useState(() => (reducedMotion() ? target : 0));
  useEffect(() => {
    if (reducedMotion()) return setValue(target);
    let frame = 0;
    const start = performance.now();
    const step = (now: number) => {
      const p = Math.min(1, (now - start) / ms);
      setValue(Math.round(target * (1 - (1 - p) ** 3)));
      if (p < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target, ms]);
  return value;
}

const number = (n: number, locale: string) => n.toLocaleString(locale, { maximumFractionDigits: n < 10 ? 1 : 0 });

const day = (iso: string, locale: string, options: Intl.DateTimeFormatOptions = { dateStyle: 'long' }) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString(locale, {
    ...options,
    timeZone: 'UTC',
  });

/** A period of the over-time view, for people: "March 2024", "the week of 4 March 2024". */
export function periodName(start: string, unit: TimeUnit, locale: string, t: TFunction): string {
  if (unit === 'month') return day(start, locale, { month: 'long', year: 'numeric' });
  if (unit === 'week') return t('story.weekOf', { date: day(start, locale) });
  return day(start, locale);
}

const hourName = (hour: number, locale: string) =>
  new Date(Date.UTC(2024, 0, 1, hour)).toLocaleTimeString(locale, {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
  });

/** 2024-01-01 was a Monday: weekdays Monday first, as the view counts them. */
const weekdayName = (i: number, locale: string, width: 'long' | 'short' = 'long') =>
  new Date(Date.UTC(2024, 0, 1 + i)).toLocaleDateString(locale, {
    weekday: width,
    timeZone: 'UTC',
  });

const peakOf = (counts: number[]) => counts.reduce((best, c, i) => (c > counts[best]! ? i : best), 0);

/** The values a block's sentence can use (`{count}`, `{top}`, `{peak}`, …), formatted for the language. */
export function storyValues(view: StoryView, locale: string, t: TFunction): StoryValues {
  if (view.view === 'amount') {
    return {
      count: number(view.count, locale),
      ...(view.days
        ? {
            per_day: number(view.count / view.days, locale),
            days: number(view.days, locale),
          }
        : {}),
    };
  }
  if (view.view === 'top') {
    const [top] = view.items;
    return { top: top!.value, top_count: number(top!.count, locale) };
  }
  if (view.view === 'over-time') {
    const peak = view.buckets[peakOf(view.buckets.map((b) => b.count))]!;
    return {
      peak: periodName(peak.start, view.unit, locale, t),
      peak_count: number(peak.count, locale),
    };
  }
  const peak = peakOf(view.counts);
  return {
    peak: view.by === 'hour' ? hourName(peak, locale) : weekdayName(peak, locale),
    peak_count: number(view.counts[peak]!, locale),
  };
}

/**
 * A view with the sentence that says what it shows: above the chart, or, for an amount, under
 * its big number.
 */
export function StoryViewChart({ view, message }: { view: StoryView; message?: string }) {
  const text = message ? <p className="story-message-text">{message}</p> : null;
  if (view.view === 'amount') return <Amount view={view} message={text} />;
  return (
    <>
      {text}
      {view.view === 'top' ? <Top view={view} /> : view.view === 'over-time' ? <OverTime view={view} /> : <Rhythm view={view} />}
    </>
  );
}

function Amount({ view, message }: { view: Extract<StoryView, { view: 'amount' }>; message: ReactNode }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? 'en';
  const shown = useCountUp(view.count);
  return (
    <div className="story-amount">
      <p className="story-number" aria-hidden="true">
        {shown.toLocaleString(locale)}
      </p>
      {/* The sentence says the number; without one, screen readers get it here. */}
      {message ?? <p className="visually-hidden">{view.count.toLocaleString(locale)}</p>}
      {view.first && view.last && view.days && (
        <p className="story-caption">
          {t('story.between', {
            first: day(view.first, locale),
            last: day(view.last, locale),
          })}
          {view.days > 1 && (
            <>
              {' '}
              ·{' '}
              {t('story.perDay', {
                amount: number(view.count / view.days, locale),
              })}
            </>
          )}
        </p>
      )}
    </div>
  );
}

function Top({ view }: { view: Extract<StoryView, { view: 'top' }> }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? 'en';
  const max = view.items[0]?.count ?? 1;
  const rest = view.distinct - view.items.length;
  return (
    <figure className="story-chart">
      <ol className="story-top">
        {view.items.map((item, i) => (
          <li key={item.value} className={i === 0 ? 'first' : undefined}>
            <span className="story-top-label">{item.value}</span>
            <span className="story-top-bar">
              <span
                className="story-bar-fill"
                style={{
                  width: `${Math.max(2, (item.count / max) * 100)}%`,
                  animationDelay: `${i * 80}ms`,
                }}
              />
              <span className="story-top-count">{item.count.toLocaleString(locale)}</span>
            </span>
          </li>
        ))}
      </ol>
      {rest > 0 && <figcaption className="story-caption">{t('story.otherValues', { count: rest })}</figcaption>}
    </figure>
  );
}

interface Column {
  /** Shown under the column, for some columns only. */
  tick?: string;
  /** The full name, for the table and the column's title. */
  name: string;
  count: number;
}

/**
 * Columns from a zero baseline, the highest one in the darker colour with its count above it.
 * Laid out with CSS, so they fit any width; each column's height is its share of the highest.
 */
function Columns({ columns, label }: { columns: Column[]; label: string }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? 'en';
  const peak = peakOf(columns.map((c) => c.count));
  const max = columns[peak]?.count || 1;
  return (
    <figure className="story-chart">
      <div className="story-columns" aria-hidden="true">
        {columns.map((c, i) => (
          <div key={i} className={`story-column${i === peak ? ' peak' : ''}`} title={`${c.name}: ${c.count.toLocaleString(locale)}`}>
            <div className="story-column-space">
              <span
                className="story-column-fill"
                style={{
                  height: `${(c.count / max) * 100}%`,
                  animationDelay: `${Math.min(i * 15, 400)}ms`,
                }}
              >
                {i === peak && <span className="story-column-count">{c.count.toLocaleString(locale)}</span>}
              </span>
            </div>
            <span className="story-column-tick">{c.tick ?? ''}</span>
          </div>
        ))}
      </div>
      <table className="visually-hidden">
        <caption>{t('story.chartTable')}</caption>
        <thead>
          <tr>
            <th scope="col">{label}</th>
            <th scope="col">{t('story.count')}</th>
          </tr>
        </thead>
        <tbody>
          {columns.map((c, i) => (
            <tr key={i}>
              <td>{c.name}</td>
              <td>{c.count.toLocaleString(locale)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

function OverTime({ view }: { view: Extract<StoryView, { view: 'over-time' }> }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? 'en';
  // Ticks where a year (months), a month (weeks) or a week (days) begins, and the first column.
  const columns = view.buckets.map((b, i): Column => {
    const previous = view.buckets[i - 1]?.start;
    let tick: string | undefined;
    if (view.unit === 'month') {
      if (!previous || previous.slice(0, 4) !== b.start.slice(0, 4)) tick = b.start.slice(0, 4);
    } else if (view.unit === 'week') {
      if (!previous || previous.slice(0, 7) !== b.start.slice(0, 7)) tick = day(b.start, locale, { month: 'short' });
    } else if (i % 7 === 0) {
      tick = day(b.start, locale, { day: 'numeric', month: 'short' });
    }
    return {
      name: periodName(b.start, view.unit, locale, t),
      count: b.count,
      ...(tick ? { tick } : {}),
    };
  });
  return <Columns columns={columns} label={t('story.period')} />;
}

function Rhythm({ view }: { view: Extract<StoryView, { view: 'rhythm' }> }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? 'en';
  const columns = view.counts.map(
    (count, i): Column =>
      view.by === 'hour'
        ? {
            name: hourName(i, locale),
            count,
            ...(i % 6 === 0 ? { tick: hourName(i, locale) } : {}),
          }
        : {
            name: weekdayName(i, locale),
            count,
            tick: weekdayName(i, locale, 'short'),
          },
  );
  return <Columns columns={columns} label={t('story.period')} />;
}
