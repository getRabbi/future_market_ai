import { gunzipSync } from 'node:zlib';

/**
 * Decoding and parsing of untrusted report files. Bounded at every step: compressed size (by the
 * caller), expanded size, rows, columns and cell length. Nothing in a file is ever executed or used
 * as a path; values become typed strings/numbers only.
 */

export const REPORT_LIMITS = {
  /** Largest compressed/raw object downloaded. */
  maxDownloadBytes: 32 * 1024 * 1024,
  /** Largest expanded text. */
  maxDecodedBytes: 128 * 1024 * 1024,
  maxRows: 500_000,
  maxColumns: 64,
  maxCellLength: 1_000,
} as const;

export class ReportFormatError extends Error {
  constructor(
    message: string,
    readonly code: 'unsupported_format' | 'too_large' | 'encoding' | 'csv' | 'schema',
  ) {
    super(message);
    this.name = 'ReportFormatError';
  }
}

/** Expands gzip (bounded) and decodes UTF-16 (Play bulk reports) or UTF-8 text. */
export function decodeReport(bytes: Uint8Array, maxDecoded: number = REPORT_LIMITS.maxDecodedBytes): { text: string; encoding: string; gzipped: boolean } {
  let buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let gzipped = false;
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    try {
      buf = gunzipSync(buf, { maxOutputLength: maxDecoded });
    } catch (err) {
      const tooBig = err instanceof RangeError || /maxOutputLength|buffer/i.test(String((err as Error).message));
      throw new ReportFormatError(tooBig ? `report expands beyond ${maxDecoded} bytes` : 'report is not valid gzip', tooBig ? 'too_large' : 'encoding');
    }
    gzipped = true;
  } else if (buf.length > maxDecoded) {
    throw new ReportFormatError(`report exceeds ${maxDecoded} bytes`, 'too_large');
  }
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) throw new ReportFormatError('zip archives are not a supported statistics format', 'unsupported_format');
  let encoding: string;
  let text: string;
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    encoding = 'utf-16le';
    text = new TextDecoder('utf-16le', { fatal: true }).decode(buf.subarray(2));
  } else if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    encoding = 'utf-16be';
    const swapped = Buffer.from(buf.subarray(2));
    swapped.swap16();
    text = new TextDecoder('utf-16le', { fatal: true }).decode(swapped);
  } else if (buf.length >= 4 && buf[1] === 0 && buf[3] === 0 && buf[0] !== 0) {
    encoding = 'utf-16le';
    text = new TextDecoder('utf-16le', { fatal: true }).decode(buf.length % 2 ? buf.subarray(0, buf.length - 1) : buf);
  } else {
    encoding = 'utf-8';
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch {
      throw new ReportFormatError('report is not valid UTF-8 or UTF-16', 'encoding');
    }
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  }
  if (text.includes('\u0000')) throw new ReportFormatError('report contains NUL characters', 'encoding');
  return { text, encoding, gzipped };
}

/**
 * RFC 4180 parser (quotes, doubled quotes, CRLF/LF). The delimiter is detected from the header:
 * Apple segments are tab-separated, Play statistics are comma-separated.
 */
export function* parseDelimited(text: string, opts: { delimiter?: string; maxRows?: number; maxColumns?: number; maxCellLength?: number } = {}): Generator<string[], void, unknown> {
  const maxRows = opts.maxRows ?? REPORT_LIMITS.maxRows;
  const maxColumns = opts.maxColumns ?? REPORT_LIMITS.maxColumns;
  const maxCell = opts.maxCellLength ?? REPORT_LIMITS.maxCellLength;
  const firstLine = text.slice(0, Math.max(0, text.search(/\r?\n/)) || text.length);
  const delimiter = opts.delimiter ?? (firstLine.includes('\t') ? '\t' : ',');
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let rows = 0;
  let i = 0;
  const pushCell = () => {
    if (cell.length > maxCell) throw new ReportFormatError(`a cell exceeds ${maxCell} characters`, 'csv');
    row.push(cell);
    cell = '';
    if (row.length > maxColumns) throw new ReportFormatError(`a row exceeds ${maxColumns} columns`, 'csv');
  };
  while (i < text.length) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      cell += ch;
      if (cell.length > maxCell) throw new ReportFormatError(`a cell exceeds ${maxCell} characters`, 'csv');
      i++;
      continue;
    }
    if (ch === '"' && cell.length === 0) {
      quoted = true;
      i++;
      continue;
    }
    if (ch === delimiter) {
      pushCell();
      i++;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      pushCell();
      if (!(row.length === 1 && row[0] === '')) {
        if (++rows > maxRows + 1) throw new ReportFormatError(`report exceeds ${maxRows} rows`, 'too_large');
        yield row;
      }
      row = [];
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    cell += ch;
    i++;
  }
  if (quoted) throw new ReportFormatError('unterminated quoted cell', 'csv');
  if (cell.length || row.length) {
    pushCell();
    if (!(row.length === 1 && row[0] === '')) yield row;
  }
}

/** Header normalisation for matching (case, inner whitespace, stray BOM). */
export const normHeader = (h: string) => h.replace(/^﻿/, '').trim().replace(/\s+/g, ' ').toLowerCase();

/** Printable, bounded dimension value. */
export function cleanValue(v: string | undefined): string {
  return (v ?? '')
    .replace(/\p{Cc}/gu, ' ')
    .trim()
    .slice(0, 200);
}

/**
 * A reported number, or null when the report says it is not available ("", "NA", "-"). A value
 * that is present but not a number is a format error, not a zero.
 */
export function parseReportedNumber(raw: string | undefined): { ok: true; value: number | null } | { ok: false } {
  const v = (raw ?? '').trim();
  if (v === '' || /^(na|n\/a|-|null|none)$/i.test(v)) return { ok: true, value: null };
  const pct = v.endsWith('%');
  const n = Number((pct ? v.slice(0, -1) : v).replace(/,(?=\d{3}(\D|$))/g, ''));
  if (!Number.isFinite(n)) return { ok: false };
  return { ok: true, value: pct ? n / 100 : n };
}

/** Accepts YYYY-MM-DD (Play, Apple) and returns it, or null. */
export function parseReportDate(raw: string | undefined): string | null {
  const v = (raw ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v ? v : null;
}
