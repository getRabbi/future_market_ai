/**
 * Chart helpers (D-048). Rules every chart follows: unknown is not zero (a missing day is a gap,
 * never a 0), partial periods are marked, totals are only stated when every day of the period is
 * reported, and a change is only shown against a previous period that is itself complete.
 */

export interface ChartPoint {
  /** Day (YYYY-MM-DD) or period label. */
  x: string;
  /** null = not reported. A real zero stays 0. */
  value: number | null;
  /** The period has days not reported yet (e.g. a week with 4 of 7 days). */
  partial?: boolean;
  note?: string;
}

/** Up to `count` evenly spaced "nice" ticks from 0 to at least `max`. */
export function niceTicks(max: number, count = 4): number[] {
  if (!Number.isFinite(max) || max <= 0) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 0.999; v += step) ticks.push(Number(v.toFixed(10)));
  if (ticks.length < 2) ticks.push(step);
  return ticks;
}

/** Runs of consecutive known values: [[0,1,2],[5,6]]. Unknown values break the line. */
export function segments(values: (number | null)[]): number[][] {
  const out: number[][] = [];
  let cur: number[] = [];
  values.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) {
      if (cur.length) out.push(cur);
      cur = [];
    } else cur.push(i);
  });
  if (cur.length) out.push(cur);
  return out;
}

const DAY_MS = 86_400_000;
export const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** Every calendar day from `from` to `to` inclusive (YYYY-MM-DD, UTC). */
export function dayRange(from: string, to: string): string[] {
  const out: string[] = [];
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return out;
  for (let t = a; t <= b && out.length < 1500; t += DAY_MS) out.push(isoDay(new Date(t)));
  return out;
}

/** One value per day of the range; days without a value are null (unknown), never 0. */
export function fillDays(from: string, to: string, values: Map<string, number>): ChartPoint[] {
  return dayRange(from, to).map((x) => ({ x, value: values.has(x) ? values.get(x)! : null }));
}

export interface Coverage {
  total: number | null;
  daysWithData: number;
  expectedDays: number;
  complete: boolean;
  /** Last day with a value. */
  through: string | null;
}

/** A total only when every period is reported and complete; otherwise null with the coverage stated. */
export function coverage(points: ChartPoint[]): Coverage {
  const known = points.filter((p) => p.value !== null);
  const complete = points.length > 0 && known.length === points.length && !points.some((p) => p.partial);
  return {
    total: complete ? known.reduce((n, p) => n + (p.value ?? 0), 0) : null,
    daysWithData: known.length,
    expectedDays: points.length,
    complete,
    through: known.at(-1)?.x ?? null,
  };
}

/** Percent change, only when both sides are known and the previous is not zero. */
export function pctChange(current: number | null | undefined, previous: number | null | undefined): number | null {
  if (current === null || current === undefined || previous === null || previous === undefined || previous === 0) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

export function formatCompact(v: number | null | undefined, unit?: string): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  if (unit === 'ratio') return `${(v * 100).toFixed(2)}%`;
  if (unit === 'rating') return v.toFixed(2);
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 10_000) return `${Math.round(v / 1000)}K`;
  if (abs >= 1_000) return `${(v / 1000).toFixed(1)}K`;
  return Number.isInteger(v) ? v.toLocaleString('en-US') : v.toLocaleString('en-US', { maximumFractionDigits: 1 });
}

export function formatFull(v: number | null | undefined, unit?: string): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return 'Not reported';
  if (unit === 'ratio') return `${(v * 100).toFixed(2)}%`;
  if (unit === 'rating') return v.toFixed(2);
  return Math.round(v * 100) / 100 === Math.round(v) ? Math.round(v).toLocaleString('en-US') : v.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/** Indices of at most `max` evenly spread x labels (always the first and the last). */
export function labelIndices(n: number, max = 6): number[] {
  if (n <= 0) return [];
  if (n <= max) return [...Array(n).keys()];
  const step = (n - 1) / (max - 1);
  return [...new Set([...Array(max).keys()].map((i) => Math.round(i * step)))];
}

/** "2026-11-02" → "Nov 2" (the reported day, never shifted by the viewer's time zone). */
export function shortDay(x: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(x)) return x;
  return new Date(`${x}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** Daily totals from timestamped points (KPI series): several points on one day are summed, days without points stay unknown. */
export function dailyFromPoints(points: { ts: string; value: number }[], from: string, to: string): ChartPoint[] {
  const m = new Map<string, number>();
  for (const p of points) {
    const d = String(p.ts).slice(0, 10);
    if (d >= from && d <= to) m.set(d, (m.get(d) ?? 0) + Number(p.value));
  }
  return fillDays(from, to, m);
}
