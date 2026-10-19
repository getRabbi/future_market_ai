import { ProviderHttpError } from '../http.js';

/**
 * Money helpers. All internal amounts are integer micros (1e-6 of the major unit).
 * Provider minor-unit offsets are only applied for currencies whose offset is known; anything
 * else is refused *before* a request is sent, rather than guessing and mis-spending.
 */

const OFFSET_100 = new Set(['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'NZD', 'CHF', 'SEK', 'NOK', 'DKK', 'SGD', 'HKD', 'MXN', 'BRL', 'INR', 'PLN', 'ZAR']);
const OFFSET_1 = new Set(['JPY', 'KRW']);

export function metaMinorUnitOffset(currency: string): number {
  const c = currency.toUpperCase();
  if (OFFSET_100.has(c)) return 100;
  if (OFFSET_1.has(c)) return 1;
  throw new ProviderHttpError(`currency ${c} minor-unit offset is unverified for Meta budgets; refusing to send`, { status: null, phase: 'rejected' });
}

export function microsToMinor(micros: number, offset: number): number {
  const minor = (micros * offset) / 1_000_000;
  if (!Number.isInteger(minor)) {
    throw new ProviderHttpError(`amount ${micros} micros is not representable in minor units (offset ${offset})`, { status: null, phase: 'rejected' });
  }
  return minor;
}

export function minorToMicros(minor: number, offset: number): number {
  return Math.round((minor * 1_000_000) / offset);
}

/** Parse a decimal string in major units ("12.34") into micros without float drift. */
export function majorToMicros(value: string | number): number {
  const s = typeof value === 'number' ? value.toFixed(6) : value.trim();
  const m = s.match(/^(-?)(\d+)(?:\.(\d{0,6})\d*)?$/);
  if (!m) throw new Error(`invalid decimal amount: ${s}`);
  const sign = m[1] === '-' ? -1 : 1;
  const whole = Number(m[2]);
  const frac = Number((m[3] ?? '').padEnd(6, '0'));
  return sign * (whole * 1_000_000 + frac);
}

export function microsToDecimalString(micros: number, decimals = 2): string {
  const neg = micros < 0;
  const abs = Math.abs(micros);
  const whole = Math.floor(abs / 1_000_000);
  const frac = abs % 1_000_000;
  const fracStr = String(frac).padStart(6, '0').slice(0, decimals);
  return `${neg ? '-' : ''}${whole}${decimals > 0 ? `.${fracStr}` : ''}`;
}
