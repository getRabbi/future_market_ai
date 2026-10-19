import { createHash } from 'node:crypto';

/**
 * Deterministic, stateless assignment: the same (salt, unit) always maps to the same bucket, so
 * re-requests are stable and assignment cannot be gamed by retrying. Uses 52 bits of SHA-256.
 */
export function bucket(salt: string, unitId: string): number {
  const h = createHash('sha256').update(`${salt}:${unitId}`).digest();
  // 52-bit integer -> [0, 1)
  const hi = h.readUInt32BE(0) & 0xfffff;
  const lo = h.readUInt32BE(4);
  return (hi * 2 ** 32 + lo) / 2 ** 52;
}

export interface WeightedVariant {
  key: string;
  weight: number;
}

/** Map a unit to a variant proportional to weights. Weights need not sum to 1. */
export function assignVariant(salt: string, unitId: string, variants: readonly WeightedVariant[]): string {
  if (variants.length === 0) throw new Error('no variants');
  const total = variants.reduce((s, v) => s + Math.max(0, v.weight), 0);
  if (total <= 0) throw new Error('variant weights must be positive');
  const u = bucket(salt, unitId) * total;
  let acc = 0;
  for (const v of variants) {
    acc += Math.max(0, v.weight);
    if (u < acc) return v.key;
  }
  return variants[variants.length - 1]!.key;
}

/** Holdout units never enter the experiment (independent salt so holdout != a variant slice). */
export function inHoldout(salt: string, unitId: string, holdoutFraction: number): boolean {
  if (holdoutFraction <= 0) return false;
  return bucket(`${salt}:holdout`, unitId) < holdoutFraction;
}

/**
 * Two-sided chi-square goodness-of-fit for sample ratio mismatch. Returns the statistic and a
 * p-value from the chi-square survival function (regularised upper incomplete gamma).
 */
export function srmChiSquare(observed: readonly number[], weights: readonly number[]): { chi2: number; df: number; pValue: number } {
  const n = observed.reduce((a, b) => a + b, 0);
  const wt = weights.reduce((a, b) => a + b, 0);
  let chi2 = 0;
  observed.forEach((o, i) => {
    const e = (n * weights[i]!) / wt;
    if (e > 0) chi2 += ((o - e) * (o - e)) / e;
  });
  const df = observed.length - 1;
  return { chi2, df, pValue: n === 0 ? 1 : gammaQ(df / 2, chi2 / 2) };
}

/** Regularised upper incomplete gamma Q(a, x) (Numerical Recipes series / continued fraction). */
export function gammaQ(a: number, x: number): number {
  if (x < 0 || a <= 0) return Number.NaN;
  if (x === 0) return 1;
  const gln = lnGamma(a);
  if (x < a + 1) {
    let sum = 1 / a;
    let del = sum;
    let ap = a;
    for (let n = 0; n < 500; n++) {
      ap += 1;
      del *= x / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-15) break;
    }
    return 1 - sum * Math.exp(-x + a * Math.log(x) - gln);
  }
  let b = x + 1 - a;
  let c = 1 / 1e-300;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return Math.exp(-x + a * Math.log(x) - gln) * h;
}

function lnGamma(z: number): number {
  const g = 7;
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z);
  const x0 = z - 1;
  let x = c[0]!;
  for (let i = 1; i < g + 2; i++) x += c[i]! / (x0 + i);
  const t = x0 + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (x0 + 0.5) * Math.log(t) - t + Math.log(x);
}
