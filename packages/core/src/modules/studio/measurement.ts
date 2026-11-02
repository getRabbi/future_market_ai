import type { PostResult } from '../m16-social/index.js';

const HOUR = 3_600_000;
const COUNTERS = ['reactions', 'comments', 'shares'] as const;
export const MEASUREMENT_VERSION = 2;

/** Only explicit, nonnegative integer counters constitute an observation. */
function counter(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function engagementScore(metrics: Record<string, unknown>): number | null {
  if (metrics.measurementVersion !== MEASUREMENT_VERSION || !metrics.evidenceId || !metrics.observedAt) return null;
  const [reactions, comments, shares] = COUNTERS.map((key) => counter(metrics[key]));
  return reactions != null && comments != null && shares != null ? reactions + 2 * comments + 3 * shares : null;
}

/** Compare only closed windows observed in the same final 24-hour age band. */
export function learningScore(metrics: Record<string, unknown>): number | null {
  const age = metrics.ageHours;
  return metrics.frozenAt && typeof age === 'number' && age >= 144 && age <= 168 ? engagementScore(metrics) : null;
}

/**
 * Preserve raw historical records. New observations must be evidence-backed, newer than the
 * saved observation, and taken 24h–7d after verification. Sync time never extends that window.
 * Closing a window without an eligible observation leaves its score unavailable.
 */
export function measurePost(previous: Record<string, unknown>, result: PostResult | undefined, verifiedAt: Date | null, now: Date): { metrics: Record<string, unknown>; engagement: number | null } | null {
  if (previous.frozenAt || !verifiedAt) return null;
  const elapsed = now.getTime() - verifiedAt.getTime();
  const observed = result?.observedAt ? Date.parse(result.observedAt) : Number.NaN;
  const age = observed - verifiedAt.getTime();
  const previousTime = typeof previous.observedAt === 'string' ? Date.parse(previous.observedAt) : Number.NaN;
  const accept = Boolean(result?.evidenceId) && observed <= now.getTime() && age >= 24 * HOUR && age <= 168 * HOUR && (!Number.isFinite(previousTime) || observed > previousTime);
  if (!accept && elapsed < 168 * HOUR) return null;
  let metrics = { ...previous };
  if (accept && result) {
    const values = Object.fromEntries(COUNTERS.map((key) => [key, counter(result.metrics[key])]));
    const missingMetrics = COUNTERS.filter((key) => values[key] === null);
    metrics = {
      ...previous,
      ...values,
      measurementVersion: MEASUREMENT_VERSION,
      observationComplete: missingMetrics.length === 0,
      missingMetrics,
      observedAt: result.observedAt,
      evidenceId: result.evidenceId,
      url: result.url,
      ageHours: age / HOUR,
    };
  }
  if (elapsed >= 168 * HOUR) metrics.frozenAt = now.toISOString();
  return { metrics, engagement: engagementScore(metrics) };
}
