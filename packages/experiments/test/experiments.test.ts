import { describe, expect, it } from 'vitest';
import { assignVariant, bucket, gammaQ, inHoldout, srmChiSquare } from '../src/index.js';

describe('deterministic assignment', () => {
  it('is stable and approximately proportional to weights', () => {
    expect(assignVariant('s', 'u1', [{ key: 'a', weight: 1 }, { key: 'b', weight: 1 }])).toBe(assignVariant('s', 'u1', [{ key: 'a', weight: 1 }, { key: 'b', weight: 1 }]));
    const counts = { a: 0, b: 0, c: 0 };
    for (let i = 0; i < 30000; i++) counts[assignVariant('exp-1', `user-${i}`, [{ key: 'a', weight: 2 }, { key: 'b', weight: 1 }, { key: 'c', weight: 1 }]) as 'a']++;
    expect(counts.a / 30000).toBeCloseTo(0.5, 1);
    expect(counts.b / 30000).toBeCloseTo(0.25, 1);
    const sr = srmChiSquare([counts.a, counts.b, counts.c], [2, 1, 1]);
    expect(sr.pValue).toBeGreaterThan(0.001); // a correct assigner shows no SRM
  });

  it('salts decorrelate experiments and holdouts', () => {
    let same = 0;
    for (let i = 0; i < 5000; i++) if ((bucket('e1', `u${i}`) < 0.5) === (bucket('e2', `u${i}`) < 0.5)) same++;
    expect(same / 5000).toBeCloseTo(0.5, 1);
    let held = 0;
    for (let i = 0; i < 20000; i++) if (inHoldout('e1', `u${i}`, 0.1)) held++;
    expect(held / 20000).toBeCloseTo(0.1, 1);
  });
});

describe('SRM chi-square', () => {
  it('matches known chi-square tail probabilities', () => {
    expect(gammaQ(0.5, 3.841 / 2)).toBeCloseTo(0.05, 3); // chi2(1) critical value
    expect(gammaQ(1, 5.991 / 2)).toBeCloseTo(0.05, 3); // chi2(2)
    const bad = srmChiSquare([5000, 4200], [1, 1]);
    expect(bad.pValue).toBeLessThan(1e-6);
  });
});
