import { sha256Hex } from '@futuregrow/observability';
import { cleanValue, normHeader, parseDelimited, parseReportDate, parseReportedNumber, ReportFormatError } from './decode.js';
import { type AppleFamily, type MetricDefinition, PLAY_VITALS, type PlayDimension, type PlayFamily } from './definitions.js';

export interface NormalizedRow {
  metricKey: string;
  sourceMetric: string;
  dims: Record<string, string>;
  dimsKey: string;
  value: number | null;
}

export interface ParsedReport {
  family: string;
  dimension: string;
  header: string[];
  unmappedColumns: string[];
  schemaFingerprint: string;
  timezone: string | null;
  rowsTotal: number;
  rowsRejected: number;
  rejectReasons: Record<string, number>;
  /** Values seen in a split column that no documented metric covers (kept out, listed). */
  skippedValues: string[];
  days: Map<string, NormalizedRow[]>;
}

export const dimsKeyOf = (dims: Record<string, string>) =>
  JSON.stringify(
    Object.keys(dims)
      .sort()
      .map((k) => [k, dims[k]]),
  );

/** Order-independent digest of one day's normalized rows (revision detection). */
export function dayDigest(rows: NormalizedRow[]): string {
  return sha256Hex(
    rows
      .map((r) => `${r.metricKey}\t${r.dimsKey}\t${r.value === null ? 'null' : r.value}`)
      .sort()
      .join('\n'),
  );
}

function empty(family: string, dimension: string, header: string[], timezone: string | null): ParsedReport {
  return { family, dimension, header, unmappedColumns: [], schemaFingerprint: sha256Hex(header.map(normHeader).join('|')), timezone, rowsTotal: 0, rowsRejected: 0, rejectReasons: {}, skippedValues: [], days: new Map() };
}

const reject = (p: ParsedReport, reason: string) => {
  p.rowsRejected++;
  p.rejectReasons[reason] = (p.rejectReasons[reason] ?? 0) + 1;
};

/**
 * One Play bulk statistics file → normalized rows. Columns are matched by name (Google: "don't
 * rely on the number of columns"); unknown columns are listed, never guessed into metrics. Rows for
 * a different package than the file name are rejected.
 */
export function parsePlayReport(text: string, family: PlayFamily, dimension: PlayDimension, packageName: string): ParsedReport {
  const it = parseDelimited(text);
  const first = it.next();
  if (first.done) throw new ReportFormatError('report is empty (no header)', 'schema');
  const header = first.value.map((h) => h.trim());
  const p = empty(family.family, dimension.key, header, null);
  const idx = new Map(header.map((h, i) => [normHeader(h), i] as const));
  if (idx.size !== header.length) throw new ReportFormatError('report has duplicate column names', 'schema');
  const iDate = idx.get('date');
  const iPkg = idx.get('package name');
  if (iDate === undefined || iPkg === undefined) throw new ReportFormatError('report has no Date / Package name column', 'schema');
  const metricCols = Object.entries(family.metrics)
    .map(([col, m]) => ({ col, m, i: idx.get(normHeader(col)) }))
    .filter((x): x is { col: string; m: MetricDefinition; i: number } => x.i !== undefined);
  if (!metricCols.length) throw new ReportFormatError(`report has none of the documented ${family.label} columns`, 'schema');
  const used = new Set<number>([iDate, iPkg, ...metricCols.map((m) => m.i)]);
  const fields: { name: string; i: number }[] = [];
  for (const f of dimension.fields) {
    const i = f.columns.map((c) => idx.get(normHeader(c))).find((x) => x !== undefined);
    if (i !== undefined) {
      fields.push({ name: f.name, i });
      used.add(i);
    }
  }
  const leftovers = header.map((_, i) => i).filter((i) => !used.has(i));
  if (dimension.fields.length && !fields.length) {
    // A renamed dimension column: accept it only when it is unambiguous.
    if (dimension.fields.length === 1 && leftovers.length === 1) {
      fields.push({ name: dimension.fields[0]!.name, i: leftovers[0]! });
      used.add(leftovers[0]!);
    } else {
      throw new ReportFormatError(`report has no recognisable ${dimension.key} column`, 'schema');
    }
  }
  p.unmappedColumns = header.filter((_, i) => !used.has(i));
  const seen = new Map<string, number | null>();
  for (const row of it) {
    p.rowsTotal++;
    const date = parseReportDate(row[iDate]);
    if (!date) {
      reject(p, 'invalid_date');
      continue;
    }
    if ((row[iPkg] ?? '').trim() !== packageName) {
      reject(p, 'package_mismatch');
      continue;
    }
    const dims: Record<string, string> = {};
    for (const f of fields) dims[f.name] = cleanValue(row[f.i]);
    const dimsKey = dimsKeyOf(dims);
    const values: NormalizedRow[] = [];
    let bad = false;
    for (const mc of metricCols) {
      const n = parseReportedNumber(row[mc.i]);
      if (!n.ok) {
        bad = true;
        break;
      }
      values.push({ metricKey: mc.m.key, sourceMetric: mc.col, dims, dimsKey, value: n.value });
    }
    if (bad) {
      reject(p, 'invalid_number');
      continue;
    }
    const k = `${date}\u0000${dimsKey}`;
    if (seen.has(k)) {
      reject(p, 'duplicate_row');
      continue;
    }
    seen.set(k, null);
    const day = p.days.get(date) ?? [];
    day.push(...values);
    p.days.set(date, day);
  }
  return p;
}

/**
 * One Apple report instance (all segments) → normalized rows. Only additive Counts-type measures
 * are kept; rows are summed over the columns not kept (device, OS version, …), which is valid for
 * counts. "Unique" columns are not additive and are not normalized. Rows of another app are
 * rejected. An unknown value in the split column is listed, not mapped.
 */
export function parseAppleReport(segments: string[], family: AppleFamily, appleAppId: string): ParsedReport {
  let header: string[] | null = null;
  let p: ParsedReport | null = null;
  const sums = new Map<string, { day: string; row: NormalizedRow }>();
  const skipped = new Set<string>();
  for (const text of segments) {
    const it = parseDelimited(text);
    const first = it.next();
    if (first.done) continue;
    const h = first.value.map((x) => x.trim());
    if (!header) {
      header = h;
      p = empty(family.family, 'standard', h, null);
    } else if (h.map(normHeader).join('|') !== header.map(normHeader).join('|')) {
      throw new ReportFormatError('report segments have different columns', 'schema');
    }
    const idx = new Map(h.map((x, i) => [normHeader(x), i] as const));
    for (const r of family.required) if (!idx.has(normHeader(r))) throw new ReportFormatError(`report is missing the ${r} column`, 'schema');
    const iDate = idx.get('date')!;
    const iApp = idx.get('app apple identifier')!;
    const iSplit = family.splitColumn ? idx.get(normHeader(family.splitColumn)) : undefined;
    const dimIdx = family.dims.map((d) => ({ name: d.name, i: idx.get(normHeader(d.column)) }));
    const measures = family.measures.map((m) => ({ ...m, i: idx.get(normHeader(m.column)) })).filter((m) => m.i !== undefined) as (AppleFamily['measures'][number] & { i: number })[];
    const usedCols = new Set([iDate, iApp, ...(iSplit !== undefined ? [iSplit] : []), ...dimIdx.flatMap((d) => (d.i === undefined ? [] : [d.i])), ...measures.map((m) => m.i)]);
    p!.unmappedColumns = h.filter((_, i) => !usedCols.has(i));
    for (const row of it) {
      p!.rowsTotal++;
      const day = parseReportDate(row[iDate]);
      if (!day) {
        reject(p!, 'invalid_date');
        continue;
      }
      if ((row[iApp] ?? '').trim() !== appleAppId) {
        reject(p!, 'app_mismatch');
        continue;
      }
      const dims: Record<string, string> = {};
      for (const d of dimIdx) dims[d.name] = d.i === undefined ? '' : cleanValue(row[d.i]);
      const dimsKey = dimsKeyOf(dims);
      const splitValue = iSplit !== undefined ? cleanValue(row[iSplit]).toLowerCase() : '*';
      const parsed: { m: MetricDefinition; col: string; v: number | null }[] = [];
      let bad = false;
      for (const ms of measures) {
        const metric = ms.split[splitValue] ?? ms.split['*'];
        if (!metric) {
          skipped.add(`${family.splitColumn}: ${splitValue}`);
          continue;
        }
        const n = parseReportedNumber(row[ms.i]);
        if (!n.ok) {
          bad = true;
          break;
        }
        parsed.push({ m: metric, col: ms.column, v: n.value });
      }
      if (bad) {
        reject(p!, 'invalid_number');
        continue;
      }
      for (const x of parsed) {
        const k = `${day}\u0000${x.m.key}\u0000${dimsKey}`;
        const cur = sums.get(k);
        // Unknown (null) contaminates the sum: an unknown part makes the total unknown.
        if (cur) cur.row.value = cur.row.value === null || x.v === null ? null : cur.row.value + x.v;
        else sums.set(k, { day, row: { metricKey: x.m.key, sourceMetric: x.col, dims, dimsKey, value: x.v } });
      }
    }
  }
  if (!p) throw new ReportFormatError('report instance has no data rows or header', 'schema');
  for (const { day, row } of sums.values()) {
    const list = p.days.get(day) ?? [];
    list.push(row);
    p.days.set(day, list);
  }
  p.skippedValues = [...skipped].sort();
  return p;
}

/** Play vitals query rows → one report per metric set (dimension crash_rate / anr_rate, Pacific days). */
export function parseVitals(rows: { date: string; metrics: Record<string, number | null> }[], requested: readonly string[], dimension: 'crash_rate' | 'anr_rate'): ParsedReport {
  const p = empty(PLAY_VITALS.family, dimension, ['date', ...requested], PLAY_VITALS.timezone);
  const defs = PLAY_VITALS.metrics as Record<string, MetricDefinition>;
  for (const r of rows) {
    p.rowsTotal++;
    if (!parseReportDate(r.date)) {
      reject(p, 'invalid_date');
      continue;
    }
    const list = p.days.get(r.date) ?? [];
    for (const name of requested) {
      const def = defs[name];
      if (!def) continue;
      list.push({ metricKey: def.key, sourceMetric: name, dims: {}, dimsKey: dimsKeyOf({}), value: r.metrics[name] ?? null });
    }
    p.days.set(r.date, list);
  }
  return p;
}
