import { describe, expect, it } from 'vitest';
import type { PostResult } from '../src/modules/m16-social/index.js';
import { engagementScore, learningScore, measurePost } from '../src/modules/studio/measurement.js';
import { localDay } from '../src/modules/studio/planner.js';

const published = new Date('2026-10-01T12:00:00Z');
const at = (hours: number) => new Date(published.getTime() + hours * 3_600_000);
const observation = (hours: number, metrics: Partial<PostResult['metrics']> = {}): PostResult => ({
  postId: 'post',
  externalPostId: 'page_post',
  url: 'https://example.com/post',
  verifiedAt: published.toISOString(),
  observedAt: at(hours).toISOString(),
  evidenceId: 'evidence',
  metrics: { reactions: 3, comments: 2, shares: 1, ...metrics },
});

describe('Studio evidence-backed measurement windows', () => {
  it.each(['reactions', 'comments', 'shares'] as const)('keeps missing %s unavailable and out of learning', (missing) => {
    const result = measurePost({}, observation(168, { [missing]: null }), published, at(168))!;
    expect(result.engagement).toBeNull();
    expect(result.metrics).toMatchObject({ observationComplete: false, missingMetrics: [missing], [missing]: null });
    expect(learningScore(result.metrics)).toBeNull();
  });

  it('accepts genuine zero counters and saves their evidence', () => {
    const result = measurePost({}, observation(168, { reactions: 0, comments: 0, shares: 0 }), published, at(168))!;
    expect(result.engagement).toBe(0);
    expect(result.metrics).toMatchObject({ observationComplete: true, missingMetrics: [], evidenceId: 'evidence', ageHours: 168, frozenAt: at(168).toISOString() });
    expect(learningScore(result.metrics)).toBe(0);
  });

  it('scores complete provisional observations but excludes them from learning', () => {
    const result = measurePost({}, observation(24), published, at(25))!;
    expect(result.engagement).toBe(10);
    expect(result.metrics.ageHours).toBe(24);
    expect(learningScore(result.metrics)).toBeNull();
  });

  it('retains counters without manufacturing a score from an incomplete snapshot', () => {
    const snapshot = observation(24);
    snapshot.metrics = { reactions: 3 } as PostResult['metrics'];
    const result = measurePost({}, snapshot, published, at(24))!;
    expect(result.metrics).toMatchObject({ reactions: 3, comments: null, shares: null, missingMetrics: ['comments', 'shares'] });
    expect(result.engagement).toBeNull();
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid counters (%s)', (shares) => {
    expect(measurePost({}, observation(24, { shares }), published, at(24))!.engagement).toBeNull();
  });

  it('does not refresh an observation when replayed or replace it with older data', () => {
    const saved = measurePost({ attempts: ['retained'] }, observation(48), published, at(48))!.metrics;
    expect(measurePost(saved, observation(48, { shares: 100 }), published, at(72))).toBeNull();
    expect(measurePost(saved, observation(24), published, at(72))).toBeNull();
    expect(saved.attempts).toEqual(['retained']);
  });

  it('does not combine missing counters with a previous snapshot', () => {
    const saved = measurePost({}, observation(24), published, at(24))!.metrics;
    const next = measurePost(saved, observation(48, { shares: null }), published, at(48))!;
    expect(next.engagement).toBeNull();
    expect(next.metrics.shares).toBeNull();
  });

  it('uses observation time, rejecting too-young, future and unbacked readings', () => {
    expect(measurePost({}, observation(23), published, at(48))).toBeNull();
    expect(measurePost({}, observation(48), published, at(24))).toBeNull();
    expect(measurePost({}, { ...observation(24), evidenceId: null }, published, at(24))).toBeNull();
    expect(measurePost({}, observation(24), null, at(24))).toBeNull();
  });

  it('freezes the last in-window observation even after a worker delay, without using late counters', () => {
    const saved = measurePost({}, observation(150), published, at(150))!.metrics;
    const frozen = measurePost(saved, observation(200, { shares: 1000 }), published, at(200))!;
    expect(frozen.engagement).toBe(10);
    expect(frozen.metrics).toMatchObject({ ageHours: 150, observedAt: at(150).toISOString(), frozenAt: at(200).toISOString() });
    expect(learningScore(frozen.metrics)).toBe(10);
    expect(measurePost(frozen.metrics, observation(220), published, at(220))).toBeNull();
  });

  it('closes unobserved windows and excludes stale early readings from comparisons', () => {
    const empty = measurePost({}, observation(169), published, at(169))!;
    expect(empty.engagement).toBeNull();
    expect(empty.metrics.frozenAt).toBe(at(169).toISOString());
    const saved = measurePost({}, observation(24), published, at(24))!.metrics;
    const frozen = measurePost(saved, undefined, published, at(168))!;
    expect(frozen.engagement).toBe(10);
    expect(learningScore(frozen.metrics)).toBeNull();
  });

  it('preserves frozen historical records and excludes unversioned zero-filled scores', () => {
    const legacy = { reactions: 3, comments: 2, shares: null, frozenAt: at(168).toISOString(), evidenceId: 'old', observedAt: at(168).toISOString(), ageHours: 168 };
    const original = structuredClone(legacy);
    expect(measurePost(legacy, observation(168), published, at(168))).toBeNull();
    expect(engagementScore(legacy)).toBeNull();
    expect(learningScore(legacy)).toBeNull();
    expect(legacy).toEqual(original);
  });
});

it('uses the Dhaka calendar across UTC midnight and the local day boundary', () => {
  expect(localDay(new Date('2026-10-01T17:59:59Z'))).toBe('2026-10-01');
  expect(localDay(new Date('2026-10-01T18:00:00Z'))).toBe('2026-10-02');
  expect(localDay(new Date('2026-10-02T00:00:00Z'))).toBe('2026-10-02');
});
