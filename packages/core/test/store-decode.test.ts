import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodeReport, parseDelimited, parseReportDate, parseReportedNumber, ReportFormatError } from '../src/modules/m19-app-growth/store/decode.js';
import { APPLE_FAMILIES, PLAY_FAMILIES } from '../src/modules/m19-app-growth/store/definitions.js';
import { dayDigest, parseAppleReport, parsePlayReport } from '../src/modules/m19-app-growth/store/parse.js';

const installs = PLAY_FAMILIES.find((f) => f.family === 'play.installs')!;
const country = installs.dimensions.find((d) => d.key === 'country')!;

describe('untrusted report decoding', () => {
  it('detects UTF-16 LE/BE, UTF-8 BOM and gzip', () => {
    const text = 'Date,Package Name\n2026-10-01,com.example.app\n';
    expect(decodeReport(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]))).toMatchObject({ text, encoding: 'utf-16le' });
    const be = Buffer.from(text, 'utf16le');
    be.swap16();
    expect(decodeReport(Buffer.concat([Buffer.from([0xfe, 0xff]), be]))).toMatchObject({ text, encoding: 'utf-16be' });
    expect(decodeReport(Buffer.from(`﻿${text}`, 'utf8'))).toMatchObject({ text, encoding: 'utf-8' });
    expect(decodeReport(gzipSync(Buffer.from(text)))).toMatchObject({ text, gzipped: true });
  });

  it('refuses archives, decompression bombs, NULs and invalid bytes', () => {
    expect(() => decodeReport(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]))).toThrow(/zip/);
    expect(() => decodeReport(gzipSync(Buffer.alloc(4096, 'a')), 1024)).toThrow(ReportFormatError);
    expect(() => decodeReport(Buffer.from([0xc3, 0x28]))).toThrow(/UTF-8/);
    expect(() => decodeReport(Buffer.from('a\u0000b,c\n', 'utf8'))).toThrow(/NUL/);
  });

  it('parses quoted CSV and TSV with bounds', () => {
    expect([...parseDelimited('a,"b,c","d ""q"""\r\n1,2,3\n')]).toEqual([
      ['a', 'b,c', 'd "q"'],
      ['1', '2', '3'],
    ]);
    expect([...parseDelimited('a\tb\n1\t2\n')]).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(() => [...parseDelimited('"unterminated\n')]).toThrow(/unterminated/);
    expect(() => [...parseDelimited(`${'x,'.repeat(70)}x\n`)]).toThrow(/columns/);
    expect(() => [...parseDelimited(`a\n${'b\n'.repeat(5)}`, { maxRows: 3 })]).toThrow(/rows/);
  });

  it('treats "not available" as null and malformed numbers as errors, never zero', () => {
    expect(parseReportedNumber('')).toEqual({ ok: true, value: null });
    expect(parseReportedNumber('NA')).toEqual({ ok: true, value: null });
    expect(parseReportedNumber('0')).toEqual({ ok: true, value: 0 });
    expect(parseReportedNumber('12.5%')).toEqual({ ok: true, value: 0.125 });
    expect(parseReportedNumber('1,234')).toEqual({ ok: true, value: 1234 });
    expect(parseReportedNumber('ten')).toEqual({ ok: false });
    expect(parseReportDate('2026-02-30')).toBeNull();
    expect(parseReportDate('10/01/2026')).toBeNull();
  });
});

describe('Play statistics parsing', () => {
  it('matches columns by name, lists unknown columns and accepts a renamed dimension only when unambiguous', () => {
    const p = parsePlayReport('Package Name,Date,Country/region,Daily User Installs,New Google column\ncom.example.app,2026-10-01,BD,5,9\n', installs, country, 'com.example.app');
    expect(p.unmappedColumns).toEqual(['New Google column']);
    expect(p.days.get('2026-10-01')).toEqual([{ metricKey: 'play.daily_user_installs', sourceMetric: 'Daily User Installs', dims: { country: 'BD' }, dimsKey: '[["country","BD"]]', value: 5 }]);
    const renamed = parsePlayReport('Date,Package Name,Territory,Daily User Installs\n2026-10-01,com.example.app,BD,5\n', installs, country, 'com.example.app');
    expect(renamed.days.get('2026-10-01')![0]!.dims).toEqual({ country: 'BD' });
    expect(() => parsePlayReport('Date,Package Name,Territory,Region,Daily User Installs\n', installs, country, 'com.example.app')).toThrow(/country column/);
    expect(() => parsePlayReport('Date,Package Name,Country,Something\n', installs, country, 'com.example.app')).toThrow(/none of the documented/);
  });

  it('rejects duplicate rows and keeps day digests order-independent', () => {
    const p = parsePlayReport('Date,Package Name,Country,Daily User Installs\n2026-10-01,com.example.app,BD,5\n2026-10-01,com.example.app,BD,6\n2026-10-01,com.example.app,IN,2\n', installs, country, 'com.example.app');
    expect(p.rejectReasons).toEqual({ duplicate_row: 1 });
    const rows = p.days.get('2026-10-01')!;
    expect(dayDigest(rows)).toBe(dayDigest([...rows].reverse()));
  });
});

describe('Apple analytics parsing', () => {
  it('sums additive counts over dropped columns; an unknown part makes the sum unknown', () => {
    const f = APPLE_FAMILIES.find((x) => x.family === 'asc.installs')!;
    const h = 'Date\tApp Name\tApp Apple Identifier\tEvent\tDownload Type\tApp Version\tDevice\tPlatform Version\tSource Type\tPage Type\tApp Download Date\tTerritory\tCounts\tUnique Devices';
    const r = (event: string, device: string, counts: string) => `2026-10-01\tA\t1\t${event}\tFirst-time download\t1.0\t${device}\tiOS 26\tApp Store search\tProduct page\t\tBD\t${counts}\t1`;
    const p = parseAppleReport([`${h}\n${r('Install', 'iPhone', '3')}\n${r('Install', 'iPad', '2')}\n${r('Delete', 'iPhone', '1')}\n${r('Delete', 'iPad', '')}\n`], f, '1');
    const day = Object.fromEntries(p.days.get('2026-10-01')!.map((x) => [x.metricKey, x.value]));
    expect(day).toEqual({ 'asc.installations': 5, 'asc.deletions': null });
    expect(p.unmappedColumns).toEqual(expect.arrayContaining(['Unique Devices', 'Device']));
  });

  it('refuses segments whose columns differ', () => {
    const f = APPLE_FAMILIES.find((x) => x.family === 'asc.crashes')!;
    expect(() => parseAppleReport(['Date\tApp Apple Identifier\tCrashes\n', 'Date\tApp Apple Identifier\tCrashes\tExtra\n'], f, '1')).toThrow(/different columns/);
  });
});
