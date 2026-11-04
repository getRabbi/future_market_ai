/**
 * Uncertainty-aware comparison of observed outcomes (D-043). Each arm (a lesson type, palette, hook…)
 * gets a Gamma–Poisson posterior of its mean outcome per post, widened by the pooled overdispersion
 * (quasi-Poisson), and arms are compared by Monte Carlo with a deterministic seed. A difference is
 * acted on only when it is both well-sampled and decisive; everything else keeps exploring.
 *
 * These are associations between what was posted and what was observed. Calendar slots are not
 * randomized (lesson types follow the weekday), so they are not causal effects.
 */

export interface ArmSummary {
  arm: string;
  posts: number;
  mean: number;
  /** 90% credible interval of the mean outcome per post. */
  low: number;
  high: number;
  /** Posterior probability that this arm has the highest mean among compared arms. */
  pBest: number | null;
}

export type Verdict = 'insufficient_data' | 'no_clear_difference' | 'clear_difference';

export interface Comparison {
  dimension: string;
  verdict: Verdict;
  arms: ArmSummary[];
  best: string | null;
  worst: string | null;
  /** P(best arm's mean > worst arm's mean). */
  pBestOverWorst: number | null;
  dispersion: number;
  note: string;
}

export const MIN_POSTS_PER_ARM = 4;
export const MIN_POSTS_TOTAL = 12;
export const DECISIVE = 0.95;
const DRAWS = 4000;

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normal(rand: () => number): number {
  let u = 0;
  while (u === 0) u = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

/** Gamma(shape, rate) by Marsaglia–Tsang (shape boosted below 1). */
function gamma(rand: () => number, shape: number, rate: number): number {
  if (shape < 1) return gamma(rand, shape + 1, rate) * rand() ** (1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = normal(rand);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rand();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return (d * v) / rate;
  }
}

function seedOf(values: string): number {
  let h = 2166136261;
  for (let i = 0; i < values.length; i++) h = Math.imul(h ^ values.charCodeAt(i), 16777619);
  return h >>> 0;
}

const round = (x: number) => Math.round(x * 100) / 100;

/** Compare arms of one dimension; observations with an unknown (null) outcome are ignored. */
export function compareArms(dimension: string, observations: { arm: string; value: number | null }[]): Comparison {
  const xs = observations.filter((o): o is { arm: string; value: number } => typeof o.value === 'number' && Number.isFinite(o.value) && o.value >= 0);
  const groups = new Map<string, number[]>();
  for (const o of xs) groups.set(o.arm, [...(groups.get(o.arm) ?? []), o.value]);
  const total = xs.length;
  const pooledMean = total ? xs.reduce((s, o) => s + o.value, 0) / total : 0;
  // Pooled dispersion within arms (variance / mean), at least 1 (Poisson).
  let ss = 0;
  let df = 0;
  for (const g of groups.values()) {
    const m = g.reduce((s, v) => s + v, 0) / g.length;
    ss += g.reduce((s, v) => s + (v - m) ** 2, 0);
    df += g.length - 1;
  }
  const dispersion = df > 0 && pooledMean > 0 ? Math.max(1, ss / df / pooledMean) : 1;
  // Weak prior centred on the pooled mean, worth one post.
  const a0 = Math.max(pooledMean, 0.5);
  const b0 = 1;
  const rand = mulberry32(
    seedOf(
      `${dimension}|${[...groups.entries()]
        .map(([k, v]) => `${k}:${v.join(',')}`)
        .sort()
        .join('|')}`,
    ),
  );
  const eligible = [...groups.entries()].filter(([, v]) => v.length >= MIN_POSTS_PER_ARM);
  const samples = new Map<string, Float64Array>();
  const arms: ArmSummary[] = [...groups.entries()].map(([arm, v]) => {
    const shape = (a0 + v.reduce((s, x) => s + x, 0)) / dispersion;
    const rate = (b0 + v.length) / dispersion;
    const draws = new Float64Array(DRAWS);
    for (let i = 0; i < DRAWS; i++) draws[i] = gamma(rand, shape, rate);
    samples.set(arm, draws);
    const sorted = Float64Array.from(draws).sort();
    return { arm, posts: v.length, mean: round(v.reduce((s, x) => s + x, 0) / v.length), low: round(sorted[Math.floor(0.05 * DRAWS)]!), high: round(sorted[Math.floor(0.95 * DRAWS)]!), pBest: null };
  });
  const base = { dimension, arms: arms.sort((a, b) => b.posts - a.posts || a.arm.localeCompare(b.arm)), dispersion: round(dispersion) };
  if (eligible.length < 2 || total < MIN_POSTS_TOTAL) {
    return { ...base, verdict: 'insufficient_data', best: null, worst: null, pBestOverWorst: null, note: `${total} measured post${total === 1 ? '' : 's'}; comparing needs ${MIN_POSTS_TOTAL} in total and ${MIN_POSTS_PER_ARM} in each of at least two groups.` };
  }
  const names = eligible.map(([k]) => k);
  const wins = new Map(names.map((n) => [n, 0]));
  for (let i = 0; i < DRAWS; i++) {
    let top = names[0]!;
    for (const n of names) if (samples.get(n)![i]! > samples.get(top)![i]!) top = n;
    wins.set(top, wins.get(top)! + 1);
  }
  for (const a of base.arms) if (wins.has(a.arm)) a.pBest = round(wins.get(a.arm)! / DRAWS);
  const ranked = [...names].sort((x, y) => wins.get(y)! - wins.get(x)!);
  const best = ranked[0]!;
  const worst = [...names].sort((x, y) => {
    const mx = samples.get(x)!.reduce((s, v) => s + v, 0);
    const my = samples.get(y)!.reduce((s, v) => s + v, 0);
    return mx - my;
  })[0]!;
  let over = 0;
  for (let i = 0; i < DRAWS; i++) if (samples.get(best)![i]! > samples.get(worst)![i]!) over++;
  const pBestOverWorst = round(over / DRAWS);
  const clear = best !== worst && pBestOverWorst >= DECISIVE;
  return {
    ...base,
    verdict: clear ? 'clear_difference' : 'no_clear_difference',
    best: clear ? best : null,
    worst: clear ? worst : null,
    pBestOverWorst,
    note: clear ? `${best} outperformed ${worst} with ${Math.round(pBestOverWorst * 100)}% posterior probability (association, not a causal effect).` : `No group is ahead with ${Math.round(DECISIVE * 100)}% probability yet (best ${best}: ${Math.round(pBestOverWorst * 100)}% vs ${worst}); keep exploring.`,
  };
}
