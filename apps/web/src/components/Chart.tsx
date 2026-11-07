import { type KeyboardEvent, type PointerEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';
import { type ChartPoint, formatCompact, formatFull, labelIndices, niceTicks, segments, shortDay } from '../lib/chart.js';

/** Width of the element, following resizes (charts draw at real pixels so text stays crisp). */
function useWidth<T extends HTMLElement>(fallback = 640) {
  const ref = useRef<T | null>(null);
  const [w, setW] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setW(Math.max(220, Math.round(el.getBoundingClientRect().width)));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

export interface LineChartProps {
  points: ChartPoint[];
  /** Series name for screen readers and the table ("User installs"). */
  label: string;
  unit?: string;
  height?: number;
  /** Fill under the line. */
  area?: boolean;
  formatX?: (x: string) => string;
  /** Caption under the chart (source, coverage). */
  caption?: ReactNode;
}

/**
 * Line chart with honest gaps: unreported days break the line (never drawn as 0), partial
 * periods are hollow points, and every value is reachable by pointer, keyboard (arrow keys) and
 * an accessible table.
 */
export function LineChart({ points, label, unit, height = 200, area = true, formatX = shortDay, caption }: LineChartProps) {
  const [wrap, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const gid = useId().replace(/:/g, '');
  const values = points.map((p) => p.value);
  const known = values.filter((v): v is number => v !== null);
  const max = known.length ? Math.max(...known, 0) : 1;
  const ticks = useMemo(() => niceTicks(max, 4), [max]);
  const top = ticks.at(-1) || 1;
  const padL = Math.max(28, 10 + formatCompact(top, unit).length * 7);
  const padR = 12;
  const padT = 10;
  const padB = 26;
  const w = width;
  const h = height;
  const n = points.length;
  const x = (i: number) => (n <= 1 ? padL + (w - padL - padR) / 2 : padL + (i * (w - padL - padR)) / (n - 1));
  const y = (v: number) => padT + (1 - v / top) * (h - padT - padB);
  const runs = segments(values);
  const lineFor = (run: number[]) => run.map((i, k) => `${k ? 'L' : 'M'}${x(i).toFixed(1)},${y(values[i]!).toFixed(1)}`).join('');
  const areaFor = (run: number[]) => `${lineFor(run)}L${x(run.at(-1)!).toFixed(1)},${y(0).toFixed(1)}L${x(run[0]!).toFixed(1)},${y(0).toFixed(1)}Z`;
  const lastKnown = (() => {
    for (let i = n - 1; i >= 0; i--) if (values[i] !== null) return i;
    return -1;
  })();
  const xLabels = labelIndices(n, w < 420 ? 4 : 7);

  const pick = (e: PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * w;
    const i = n <= 1 ? 0 : Math.round(((px - padL) / (w - padL - padR)) * (n - 1));
    setActive(Math.min(n - 1, Math.max(0, i)));
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!n) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      setActive((cur) => {
        const c = cur ?? lastKnown;
        if (e.key === 'Home') return 0;
        if (e.key === 'End') return n - 1;
        return Math.min(n - 1, Math.max(0, c + (e.key === 'ArrowRight' ? 1 : -1)));
      });
    } else if (e.key === 'Escape') setActive(null);
  };
  const a = active !== null ? points[active] : null;
  const describe = (p: ChartPoint) => `${formatX(p.x)}: ${p.value === null ? 'not reported' : formatFull(p.value, unit)}${p.partial ? ' (partial period)' : ''}${p.note ? `, ${p.note}` : ''}`;
  const summary = known.length ? `${label}. ${known.length} of ${n} periods reported. Latest ${describe(points[lastKnown]!)}. Highest ${formatFull(Math.max(...known), unit)}.` : `${label}. No reported values in this period.`;

  if (!known.length) {
    return (
      <div className="chart-empty" role="img" aria-label={summary}>
        <span>No reported values in this period.</span>
        {caption ? <div className="chart-caption">{caption}</div> : null}
      </div>
    );
  }

  return (
    <figure className="chart">
      <div
        className="chart-plot"
        ref={wrap}
        tabIndex={0}
        role="slider"
        aria-label={`${summary} Use the left and right arrow keys to read each value.`}
        aria-valuemin={0}
        aria-valuemax={Math.max(0, n - 1)}
        aria-valuenow={active ?? Math.max(0, lastKnown)}
        aria-valuetext={describe(points[active ?? Math.max(0, lastKnown)]!)}
        onKeyDown={onKey}
        onBlur={() => setActive(null)}
      >
        <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true" onPointerMove={pick} onPointerLeave={() => setActive(null)}>
          <defs>
            <linearGradient id={`g${gid}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--chart-1)" stopOpacity="0.22" />
              <stop offset="100%" stopColor="var(--chart-1)" stopOpacity="0" />
            </linearGradient>
          </defs>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={padL} x2={w - padR} y1={y(t)} y2={y(t)} className={t === 0 ? 'chart-axis' : 'chart-grid'} />
              <text x={padL - 8} y={y(t)} className="chart-tick" textAnchor="end" dominantBaseline="middle">
                {formatCompact(t, unit)}
              </text>
            </g>
          ))}
          {xLabels.map((i) => (
            <text key={points[i]!.x} x={x(i)} y={h - 6} className="chart-tick" textAnchor={i === 0 && n > 1 ? 'start' : i === n - 1 && n > 1 ? 'end' : 'middle'}>
              {formatX(points[i]!.x)}
            </text>
          ))}
          {area ? runs.filter((r) => r.length > 1).map((r) => <path key={`a${r[0]}`} d={areaFor(r)} fill={`url(#g${gid})`} />) : null}
          {runs.map((r) => (r.length > 1 ? <path key={`l${r[0]}`} d={lineFor(r)} className="chart-line" /> : null))}
          {points.map((p, i) => (p.value === null ? null : r(i, runs) || p.partial || i === lastKnown ? <circle key={p.x} cx={x(i)} cy={y(p.value)} r={i === lastKnown ? 4 : 3} className={p.partial ? 'chart-dot partial' : i === lastKnown ? 'chart-dot last' : 'chart-dot'} /> : null))}
          {a ? (
            <g className="chart-hover">
              <line x1={x(active!)} x2={x(active!)} y1={padT} y2={h - padB} className="chart-guide" />
              {a.value !== null ? <circle cx={x(active!)} cy={y(a.value)} r={5} className={a.partial ? 'chart-dot partial' : 'chart-dot focus'} /> : null}
            </g>
          ) : null}
        </svg>
        {a ? (
          <div className="chart-tip" style={{ left: `${Math.min(Math.max(x(active!), 70), w - 70)}px` }}>
            <strong>{a.value === null ? 'Not reported' : formatFull(a.value, unit)}</strong>
            <span>{formatX(a.x)}</span>
            {a.partial ? <span className="chart-tip-note">Partial period</span> : null}
            {a.note ? <span className="chart-tip-note">{a.note}</span> : null}
          </div>
        ) : null}
        <span className="sr-only" aria-live="polite">
          {a ? describe(a) : ''}
        </span>
      </div>
      {caption ? <figcaption className="chart-caption">{caption}</figcaption> : null}
      <details className="chart-table">
        <summary>View as table</summary>
        <div className="table-wrap">
          <table>
            <caption className="sr-only">{label}</caption>
            <thead>
              <tr>
                <th scope="col">Period</th>
                <th scope="col">{label}</th>
              </tr>
            </thead>
            <tbody>
              {points.map((p) => (
                <tr key={p.x}>
                  <td>{formatX(p.x)}</td>
                  <td>
                    {p.value === null ? <span className="muted">Not reported</span> : formatFull(p.value, unit)}
                    {p.partial ? <span className="muted"> (partial)</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}

/** A lone known point between gaps is drawn as a dot (a line needs two points). */
function r(i: number, runs: number[][]): boolean {
  return runs.some((run) => run.length === 1 && run[0] === i);
}

/** Horizontal bars for a breakdown (countries, sources); values are as reported, unknown shown as a dash. */
export function BarList({ rows, unit, label }: { rows: { name: string; value: number | null }[]; unit?: string; label: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value ?? 0));
  if (!rows.length) return <p className="small muted">Not reported for this period.</p>;
  return (
    <ul className="barlist" aria-label={label}>
      {rows.map((row) => (
        <li key={row.name}>
          <span className="barlist-name">{row.name}</span>
          <span className="barlist-track" aria-hidden="true">
            <span style={{ width: `${row.value === null ? 0 : Math.max(2, (row.value / max) * 100)}%` }} />
          </span>
          <span className="barlist-value">{row.value === null ? '—' : formatCompact(row.value, unit)}</span>
        </li>
      ))}
    </ul>
  );
}
