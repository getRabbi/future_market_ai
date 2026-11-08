import { describe, expect, it } from 'vitest';
import { compareArms, MIN_POSTS_PER_ARM, MIN_POSTS_TOTAL } from '../src/modules/studio/learning.js';
import { type HistoryItem, learnFrom } from '../src/modules/studio/planner.js';

const obs = (arm: string, values: (number | null)[]) => values.map((value) => ({ arm, value }));

describe('uncertainty-aware learning (D-043)', () => {
  it('needs enough posts per group and in total before comparing', () => {
    const c = compareArms('kind', [...obs('quiz', [9, 10, 11]), ...obs('vocab', [1, 2, 1, 2, 1, 2, 1, 2, 1, 2])]);
    expect(c.verdict).toBe('insufficient_data');
    expect(c.best).toBeNull();
    expect(c.note).toMatch(new RegExp(`${MIN_POSTS_TOTAL} in total and ${MIN_POSTS_PER_ARM} in each`));
  });

  it('does not declare a winner from noise, even with many posts', () => {
    const a = [3, 7, 1, 9, 4, 2, 8, 5, 6, 3, 2, 7];
    const b = [4, 2, 8, 6, 3, 9, 1, 5, 7, 2, 6, 4];
    const c = compareArms('kind', [...obs('a', a), ...obs('b', b)]);
    expect(c.verdict).toBe('no_clear_difference');
    expect(c.pBestOverWorst).toBeLessThan(0.95);
  });

  it('finds a clear, well-sampled difference and reports intervals and P(best)', () => {
    const c = compareArms('kind', [...obs('quiz', [12, 14, 11, 13, 12]), ...obs('grammar', [1, 2, 1, 0, 1]), ...obs('vocab', [4, 5, 3, 4, 4])]);
    expect(c).toMatchObject({ verdict: 'clear_difference', best: 'quiz', worst: 'grammar' });
    const quiz = c.arms.find((x) => x.arm === 'quiz')!;
    expect(quiz.low).toBeLessThan(quiz.mean);
    expect(quiz.high).toBeGreaterThan(quiz.mean);
    expect(quiz.pBest).toBeGreaterThan(0.9);
  });

  it('is robust to one viral outlier: overdispersion widens the intervals', () => {
    const c = compareArms('kind', [...obs('a', [1, 1, 2, 1, 60]), ...obs('b', [3, 4, 3, 4, 3]), ...obs('c', [2, 3, 2, 3, 2])]);
    expect(c.dispersion).toBeGreaterThan(1);
    expect(c.best === 'a' && c.verdict === 'clear_difference').toBe(false);
  });

  it('ignores unknown outcomes instead of counting them as zero, and is deterministic', () => {
    const input = [...obs('a', [5, 6, 5, 6, null, null]), ...obs('b', [1, 1, 2, 1, null]), ...obs('c', [3, 3, 3, 4])];
    const c1 = compareArms('kind', input);
    expect(c1.arms.find((x) => x.arm === 'a')!.posts).toBe(4);
    expect(compareArms('kind', input)).toEqual(c1);
  });

  it('reports Google-reported store results as their own comparison, never as engagement or a calendar driver (P1-05)', () => {
    const base = { unitId: null, objective: 'INSTALL_APP', template: 'feature', palette: 'navy', variant: 0, hookId: null, promptId: null, status: 'published', engagement: null } as const;
    const hist: HistoryItem[] = Array.from({ length: 6 }, (_, i) => ({ ...base, day: `2026-08-${10 + i}`, kind: i % 2 ? 'quiz' : 'vocab', storeAcquisitions: i === 5 ? null : i % 2 ? 9 : 1 }));
    const l = learnFrom(hist);
    expect(l).toMatchObject({ measuredPosts: 0, phase: 'exploring' });
    const store = l.comparisons.find((c) => c.dimension.startsWith('store listing acquisitions'));
    // Five reported values (the null one is unknown, not zero) are far below the sample a comparison needs.
    expect(store).toMatchObject({ verdict: 'insufficient_data', best: null });
    expect(store!.arms.reduce((n, a) => n + a.posts, 0)).toBe(5);
    expect(l.comparisons[0]!.dimension).toBe('lesson type');
    // Posts without a per-post campaign add no store comparison at all.
    expect(learnFrom(hist.map(({ storeAcquisitions: _, ...h }) => h)).comparisons.some((c) => c.dimension.startsWith('store'))).toBe(false);
  });
});
