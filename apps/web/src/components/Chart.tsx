import type { ChartData, Scalar } from '@combray/core';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';

interface Props {
  data: ChartData;
  /** What the numbers are, for the axis and the table: "Rows", "Sum of likes". */
  measure: string;
  formatX: (x: Scalar) => string;
  formatSeries: (s: Scalar) => string;
}

const MARGIN = { top: 12, right: 16, bottom: 28, left: 52 };
const HEIGHT = 260;
const BAR = 22;
const BAR_GAP = 6;
const MAX_LABEL = 28;

/** 4 or 5 round ticks from 0 to at least `max`. */
function ticks(max: number): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / 4;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * power).find((s) => s >= raw)!;
  const out: number[] = [];
  for (let v = 0; v < max + step; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

const formatNumber = (n: number, locale: string) =>
  n.toLocaleString(locale, { maximumFractionDigits: Math.abs(n) < 10 ? 2 : 0 });

/** A bar with its data end rounded and its base square, from (x, y) to (x + w, y + h). */
function barPath(x: number, y: number, w: number, h: number, end: 'top' | 'right'): string {
  const r = Math.max(0, Math.min(4, (end === 'top' ? w : h) / 2, end === 'top' ? h : w));
  if (end === 'top') {
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  }
  return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`;
}

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(280, Math.floor(entry!.contentRect.width))));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

const truncate = (s: string) => (s.length > MAX_LABEL ? `${s.slice(0, MAX_LABEL - 1)}…` : s);

/**
 * A timeline or a ranked bar chart, drawn as SVG. Labels are rendered as text by React, never
 * as HTML. Every value is also in the table view, and hover and keyboard focus show the same.
 */
export function Chart({ data, measure, formatX, formatSeries }: Props) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? 'en';
  const [asTable, setAsTable] = useState(false);
  const [hover, setHover] = useState<number>();
  const { ref, width } = useWidth();
  const split = data.series.length > 1 || (data.series.length === 1 && data.series[0] !== null);

  const value = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of data.points) m.set(JSON.stringify([p.x, p.series]), p.y);
    return (x: Scalar, s: Scalar) => m.get(JSON.stringify([x, s])) ?? 0;
  }, [data]);
  const total = (x: Scalar) => data.series.reduce<number>((sum, s) => sum + value(x, s), 0);

  if (data.points.length === 0) return <p className="meta">{t('chart.empty')}</p>;

  const legend = split && (
    <ul className="chart-legend">
      {data.series.map((s, i) => (
        <li key={i}>
          <span className={`swatch ${data.kind === 'time' && drawLines() ? 'line' : 'box'} series-${i + 1}`} aria-hidden="true" />
          {formatSeries(s)}
        </li>
      ))}
    </ul>
  );

  function drawLines() {
    return split || data.xs.length > 90;
  }

  const tooltip = (x: Scalar) => (
    <div className="chart-tooltip" role="status">
      <div className="meta">{formatX(x)}</div>
      {data.series.map((s, i) => (
        <div key={i} className="tooltip-row">
          {split && <span className={`swatch line series-${i + 1}`} aria-hidden="true" />}
          <strong>{formatNumber(value(x, s), locale)}</strong>
          {split && <span className="meta"> {formatSeries(s)}</span>}
        </div>
      ))}
    </div>
  );

  let chart: React.ReactNode;
  if (data.kind === 'time') {
    const n = data.xs.length;
    const plotW = width - MARGIN.left - MARGIN.right;
    const plotH = HEIGHT - MARGIN.top - MARGIN.bottom;
    const band = plotW / n;
    const lines = drawLines();
    const max = Math.max(0, ...data.xs.flatMap((x) => data.series.map((s) => value(x, s))));
    const yTicks = ticks(max);
    const top = yTicks.at(-1)!;
    const y = (v: number) => MARGIN.top + plotH - (v / top) * plotH;
    const cx = (i: number) => MARGIN.left + (i + 0.5) * band;
    const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / 90))));
    const pick = (event: PointerEvent<SVGRectElement>) => {
      const box = event.currentTarget.getBoundingClientRect();
      const i = Math.floor(((event.clientX - box.left) / box.width) * n);
      setHover(Math.max(0, Math.min(n - 1, i)));
    };
    const keys = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      setHover((h) => Math.max(0, Math.min(n - 1, (h ?? -1) + (event.key === 'ArrowRight' ? 1 : -1))));
    };
    chart = (
      <svg width={width} height={HEIGHT} role="img" aria-label={t('chart.timeline', { measure })}>
        {yTicks.map((v) => (
          <g key={v}>
            <line className="grid" x1={MARGIN.left} x2={width - MARGIN.right} y1={y(v)} y2={y(v)} />
            <text className="axis-label" x={MARGIN.left - 8} y={y(v)} dy="0.32em" textAnchor="end">
              {formatNumber(v, locale)}
            </text>
          </g>
        ))}
        {data.xs.map((x, i) =>
          i % every === 0 ? (
            <text key={i} className="axis-label" x={cx(i)} y={HEIGHT - 8} textAnchor="middle">
              {formatX(x)}
            </text>
          ) : null,
        )}
        {lines
          ? data.series.map((s, si) => (
              <g key={si} className={`series-${si + 1}`}>
                <polyline
                  className="chart-line"
                  points={data.xs.map((x, i) => `${cx(i)},${y(value(x, s))}`).join(' ')}
                />
                {n <= 30 &&
                  data.xs.map((x, i) => <circle key={i} className="chart-dot" cx={cx(i)} cy={y(value(x, s))} r={4} />)}
              </g>
            ))
          : data.xs.map((x, i) => {
              const v = value(x, data.series[0] ?? null);
              const w = Math.max(1, band - 2);
              return v > 0 ? (
                <path
                  key={i}
                  className={`chart-bar series-1${hover === i ? ' active' : ''}`}
                  d={barPath(MARGIN.left + i * band + 1, y(v), w, MARGIN.top + plotH - y(v), 'top')}
                />
              ) : null;
            })}
        {hover !== undefined && (
          <line className="crosshair" x1={cx(hover)} x2={cx(hover)} y1={MARGIN.top} y2={MARGIN.top + plotH} />
        )}
        <rect
          className="hit-area"
          x={MARGIN.left}
          y={MARGIN.top}
          width={plotW}
          height={plotH}
          tabIndex={0}
          aria-label={t('chart.explore')}
          onPointerMove={pick}
          onPointerLeave={() => setHover(undefined)}
          onFocus={() => setHover((h) => h ?? 0)}
          onBlur={() => setHover(undefined)}
          onKeyDown={keys}
        />
      </svg>
    );
    if (hover !== undefined) {
      const left = Math.min(width - 180, Math.max(0, cx(hover) + 12));
      chart = (
        <div className="chart-frame">
          {chart}
          <div className="chart-tooltip-anchor" style={{ left }}>
            {tooltip(data.xs[hover]!)}
          </div>
        </div>
      );
    }
  } else {
    const labelW = Math.min(200, Math.floor(width * 0.35));
    const plotW = width - labelW - MARGIN.right - 56;
    const max = Math.max(0, ...data.xs.map(total));
    const height = data.xs.length * (BAR + BAR_GAP) + 8;
    const x = (v: number) => (max > 0 ? (v / max) * plotW : 0);
    chart = (
      <div className="chart-frame">
        <svg width={width} height={height} role="img" aria-label={t('chart.bars', { measure })}>
          {data.xs.map((cat, i) => {
            const top = i * (BAR + BAR_GAP) + 4;
            let offset = labelW;
            const segments = data.series.map((s, si) => {
              const w = x(value(cat, s));
              const start = offset;
              offset += w;
              const last = si === data.series.length - 1 || data.series.slice(si + 1).every((r) => value(cat, r) === 0);
              if (w <= 0) return null;
              const drawn = Math.max(1, w - (last ? 0 : 2));
              return (
                <path
                  key={si}
                  className={`chart-bar series-${si + 1}`}
                  d={last ? barPath(start, top, drawn, BAR, 'right') : `M${start},${top}h${drawn}v${BAR}h${-drawn}Z`}
                />
              );
            });
            return (
              <g
                key={i}
                className={`bar-row${hover === i ? ' active' : ''}`}
                tabIndex={0}
                onPointerEnter={() => setHover(i)}
                onPointerLeave={() => setHover(undefined)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(undefined)}
              >
                <rect className="hit" x={0} y={top - BAR_GAP / 2} width={width} height={BAR + BAR_GAP} />
                <text className="bar-label" x={labelW - 8} y={top + BAR / 2} dy="0.32em" textAnchor="end">
                  {truncate(formatX(cat))}
                </text>
                {segments}
                <text className="value-label" x={offset + 6} y={top + BAR / 2} dy="0.32em">
                  {formatNumber(total(cat), locale)}
                </text>
              </g>
            );
          })}
        </svg>
        {hover !== undefined && (
          <div className="chart-tooltip-anchor" style={{ left: labelW, top: hover * (BAR + BAR_GAP) + BAR + 8 }}>
            {tooltip(data.xs[hover]!)}
          </div>
        )}
      </div>
    );
  }

  return (
    <figure className="chart">
      {legend}
      <div ref={ref} className="chart-body">
        {asTable ? (
          <div className="preview-scroll">
            <table className="preview-table">
              <thead>
                <tr>
                  <th scope="col">{t('chart.along')}</th>
                  {data.series.map((s, i) => (
                    <th key={i} scope="col">
                      {split ? formatSeries(s) : measure}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.xs.map((x, i) => (
                  <tr key={i}>
                    <th scope="row">{formatX(x)}</th>
                    {data.series.map((s, si) => (
                      <td key={si}>{formatNumber(value(x, s), locale)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          chart
        )}
      </div>
      <figcaption className="meta">
        {measure}
        {data.more.xs > 0 && ` · ${t('chart.moreCategories', { count: data.more.xs })}`}
        {data.more.series > 0 && ` · ${t('chart.moreSeries', { count: data.more.series })}`}{' '}
        <button type="button" className="link-button" onClick={() => setAsTable(!asTable)}>
          {asTable ? t('chart.showChart') : t('chart.showTable')}
        </button>
      </figcaption>
    </figure>
  );
}
