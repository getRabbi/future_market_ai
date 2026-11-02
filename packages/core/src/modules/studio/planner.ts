import { type CardTemplate, PALETTE_IDS, type PaletteId } from '@futuregrow/visuals';
import type { Objective } from './compose.js';
import { type CurriculumPack, challengeUnit, packUnits, type Segment, type Unit, unitById } from './curriculum.js';

/**
 * Seven-day content calendar (D-040). Deterministic and explainable: a weekly lesson rotation,
 * review quizzes on recently taught words, a Friday challenge, app mentions capped per rolling
 * week, and conservative adaptation: a lesson type gains a slot only when at least three measured
 * posts of two types differ by 25% or more; with fewer posts it keeps exploring.
 */

export type PlanKind = Unit['kind'] | 'feature';

export interface HistoryItem {
  day: string;
  kind: PlanKind;
  unitId: string | null;
  objective: Objective;
  template: string;
  palette: string;
  variant: number;
  hookId: string | null;
  promptId: string | null;
  status: string;
  /** Observed engagement (reactions + 2·comments + 3·shares) of the published post; null if unread. */
  engagement: number | null;
}

export interface PlannedItem {
  day: string;
  kind: PlanKind;
  unitId: string | null;
  objective: Objective;
  segment: Segment | 'app_user';
  template: CardTemplate;
  palette: PaletteId;
  variant: 0 | 1;
  rationale: string;
}

export interface PlanOptions {
  /** Approved claims exist for app mentions. */
  appClaims: boolean;
  /** A verified store listing link may be posted. */
  appLink: boolean;
  /** App mentions (DISCOVER and later) per rolling 7 days. */
  appCtaPerWeek: number;
  /** Posts with the store link per rolling 7 days. */
  linkPerWeek: number;
}

export const DEFAULT_PLAN_OPTIONS: PlanOptions = { appClaims: false, appLink: false, appCtaPerWeek: 2, linkPerWeek: 1 };
const DAY = 86_400_000;
const REUSE_AFTER_DAYS = 120;
const KIND_TEMPLATE: Record<PlanKind, CardTemplate> = { vocab: 'vocab', hangul: 'hangul', grammar: 'grammar', quiz: 'quiz', mistake: 'mistake', dialogue: 'dialogue', reading: 'reading', challenge: 'challenge', feature: 'feature' };
const KIND_NAME: Record<PlanKind, string> = { vocab: 'vocabulary', hangul: 'Hangul letter', grammar: 'grammar point', quiz: 'review quiz', mistake: 'common mistake', dialogue: 'conversation', reading: 'notice-reading question', challenge: 'weekly challenge', feature: 'app capability' };

export const dayOffset = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
/** Calendar day in Bangladesh (UTC+6), where the audience is. */
export const localDay = (d: Date) => new Date(d.getTime() + 6 * 3_600_000).toISOString().slice(0, 10);
const weekday = (day: string) => new Date(`${day}T00:00:00Z`).getUTCDay();

const PUBLISHED = new Set(['drafted', 'submitted', 'published']);

export interface Learning {
  measuredPosts: number;
  phase: 'exploring' | 'adapting';
  byKind: { kind: string; posts: number; mean: number; lift: number | null }[];
  notes: string[];
}

/** What the measured posts say, by lesson type; nothing is extrapolated beyond observed counters. */
export function learnFrom(history: HistoryItem[]): Learning {
  const measured = history.filter((h) => h.status === 'published' && h.engagement !== null);
  const overall = measured.length ? measured.reduce((s, h) => s + h.engagement!, 0) / measured.length : 0;
  const kinds = [...new Set(measured.map((h) => h.kind))];
  const byKind = kinds
    .map((k) => {
      const xs = measured.filter((h) => h.kind === k).map((h) => h.engagement!);
      const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
      return { kind: k, posts: xs.length, mean: Math.round(mean * 100) / 100, lift: xs.length >= 3 && overall > 0 ? Math.round(((mean - overall) / overall) * 100) / 100 : null };
    })
    .sort((a, b) => b.posts - a.posts);
  const qualified = byKind.filter((k) => k.lift !== null);
  const phase = measured.length >= 8 && qualified.length >= 2 ? 'adapting' : 'exploring';
  const notes =
    phase === 'exploring'
      ? [`${measured.length} measured post${measured.length === 1 ? '' : 's'}; lesson types need three measured posts each (and eight in total) before the mix changes, so the calendar keeps exploring.`]
      : qualified.map((k) => `${KIND_NAME[k.kind as PlanKind] ?? k.kind}: ${k.posts} posts, mean engagement ${k.mean} (${k.lift! >= 0 ? '+' : ''}${Math.round(k.lift! * 100)}% vs all posts).`);
  return { measuredPosts: measured.length, phase, byKind, notes };
}

function baseRotation(days: string[], lettersLeft: boolean): PlanKind[] {
  // By weekday (the BD weekend is Friday): Fri challenge, Sat vocabulary, Sun Hangul (vocabulary
  // once every letter is taught), Mon vocabulary, Tue review quiz, Wed grammar, Thu a conversation,
  // a common mistake or a notice to read, in a three-week cycle.
  return days.map((d) => {
    switch (weekday(d)) {
      case 5:
        return 'challenge';
      case 6:
      case 1:
        return 'vocab';
      case 0:
        return lettersLeft ? 'hangul' : 'vocab';
      case 2:
        return 'quiz';
      case 3:
        return 'grammar';
      default:
        return (['dialogue', 'mistake', 'reading'] as const)[Math.floor(Date.parse(`${d}T00:00:00Z`) / (7 * DAY)) % 3]!;
    }
  });
}

export function planDays(pack: CurriculumPack, days: string[], history: HistoryItem[], opts: PlanOptions): { items: PlannedItem[]; learning: Learning; notes: string[] } {
  const all = packUnits(pack);
  const today = days[0]!;
  const done = history.filter((h) => PUBLISHED.has(h.status));
  const recentlyUsed = new Map<string, string>();
  for (const h of done) if (h.unitId && daysBetween(h.day, today) < REUSE_AFTER_DAYS) recentlyUsed.set(h.unitId, h.day);
  const lettersLeft = all.some((u) => u.kind === 'hangul' && !recentlyUsed.has(u.id));
  const base = baseRotation(days, lettersLeft);
  const kinds = [...base];
  const learning = learnFrom(history);
  const notes: string[] = [...learning.notes];

  // Adapt: one slot moves from the weakest to the strongest qualified lesson type.
  if (learning.phase === 'adapting') {
    const q = learning.byKind.filter((k) => k.lift !== null && k.kind !== 'feature');
    const best = q[0] && [...q].sort((a, b) => b.lift! - a.lift!)[0]!;
    const worst = [...q].filter((k) => kinds.includes(k.kind as PlanKind) && k.kind !== 'challenge').sort((a, b) => a.lift! - b.lift!)[0];
    if (best && worst && best.kind !== worst.kind && best.lift! >= 0.25 && worst.lift! <= -0.25 && kinds.filter((k) => k === best.kind).length < 2) {
      const i = kinds.indexOf(worst.kind as PlanKind);
      if (i >= 0) {
        kinds[i] = best.kind as PlanKind;
        notes.push(`Moved one ${KIND_NAME[worst.kind as PlanKind]} slot to ${KIND_NAME[best.kind as PlanKind]}: measured engagement ${Math.round(best.lift! * 100)}% above vs ${Math.round(worst.lift! * 100)}% below the average.`);
      }
    }
  }
  // A capability post every 14 days once a week of lessons has gone out.
  const lastFeature = done.filter((h) => h.kind === 'feature').sort((a, b) => b.day.localeCompare(a.day))[0];
  if (opts.appClaims && done.length >= 7 && (!lastFeature || daysBetween(lastFeature.day, today) >= 14)) {
    const i = kinds.findIndex((k) => k === 'dialogue' || k === 'mistake' || k === 'reading');
    if (i >= 0) {
      kinds[i] = 'feature';
      notes.push('One lesson slot this fortnight presents an app capability backed by an approved claim.');
    }
  }

  const items: PlannedItem[] = [];
  const taken = new Set<string>();
  const pickUnit = (kind: PlanKind, day: string): Unit | null => {
    if (kind === 'feature') return null;
    if (kind === 'challenge') {
      const words = [...done.filter((h) => h.kind === 'vocab' && daysBetween(h.day, day) <= 14 && daysBetween(h.day, day) > 0).map((h) => h.unitId!), ...items.filter((i) => i.kind === 'vocab' && i.day < day).map((i) => i.unitId!)];
      const uniq = [...new Set(words)].slice(-5);
      if (uniq.length >= 3) return challengeUnit(pack, uniq);
      return null;
    }
    if (kind === 'quiz') {
      // Review: a word taught 1–21 days earlier that has not been quizzed yet.
      const quizzed = new Set(done.filter((h) => h.kind === 'quiz').map((h) => h.unitId!.replace(/^q-(meaning|word)-/, '')));
      const taught = [...done.filter((h) => h.kind === 'vocab' && daysBetween(h.day, day) >= 1 && daysBetween(h.day, day) <= 21).map((h) => ({ id: h.unitId!, day: h.day })), ...items.filter((i) => i.kind === 'vocab' && i.day < day).map((i) => ({ id: i.unitId!, day: i.day }))];
      const form = done.filter((h) => h.kind === 'quiz').length % 2 ? 'word' : 'meaning';
      for (const t of taught.sort((a, b) => a.day.localeCompare(b.day))) {
        const id = `q-${form}-${t.id}`;
        if (!quizzed.has(t.id) && !taken.has(id)) return unitById(pack, id);
      }
      // Nothing taught recently enough to review: teach a word instead.
      return null;
    }
    const pool = all.filter((u) => u.kind === kind && !taken.has(u.id));
    const fresh = pool.filter((u) => !recentlyUsed.has(u.id));
    if (kind === 'vocab') {
      const lastTopic = [...done, ...items]
        .filter((h) => h.kind === 'vocab')
        .map((h) => (h.unitId ? unitById(pack, h.unitId)?.topic : null))
        .pop();
      fresh.sort((a, b) => a.level - b.level || Number(a.topic === lastTopic) - Number(b.topic === lastTopic));
    }
    if (fresh.length) return fresh[0]!;
    // Everything was taught recently: reuse the one taught longest ago.
    return pool.sort((a, b) => (recentlyUsed.get(a.id) ?? '').localeCompare(recentlyUsed.get(b.id) ?? ''))[0] ?? null;
  };

  // Rolling-week caps on app mentions and links, counting what already went out.
  const inWindow = (day: string) => [...done.filter((h) => daysBetween(h.day, day) < 7 && daysBetween(h.day, day) > 0), ...items.filter((i) => daysBetween(i.day, day) < 7 && i.day < day)];
  const appStages: Objective[] = ['DISCOVER', 'VISIT_APP', 'INSTALL_APP', 'RETAIN'];
  const firstWeek = done.length < 7;
  /** A capability post planned within the next six days keeps one app mention free for itself. */
  const featureAhead = (n: number) => kinds.some((k, j) => k === 'feature' && j > n && daysBetween(days[n]!, days[j]!) < 7);

  for (const [n, day] of days.entries()) {
    let kind = kinds[n]!;
    const win = inWindow(day);
    const appUsed = win.filter((h) => appStages.includes(h.objective)).length;
    const linkUsed = win.filter((h) => h.objective === 'VISIT_APP' || h.objective === 'INSTALL_APP').length;
    const cap = firstWeek ? Math.min(1, opts.appCtaPerWeek) : opts.appCtaPerWeek;
    // A capability post counts against the weekly app mentions like any other; over the cap it stays a lesson.
    if (kind === 'feature' && appUsed >= cap) kind = base[n]!;
    let unit = pickUnit(kind, day);
    if (!unit && kind === 'challenge') {
      kind = 'quiz';
      unit = pickUnit('quiz', day);
    }
    if (!unit && kind === 'quiz') {
      kind = 'vocab';
      unit = pickUnit('vocab', day);
    }
    if (!unit && kind !== 'feature') {
      kind = 'vocab';
      unit = pickUnit('vocab', day);
    }
    if (unit) taken.add(unit.id);
    let objective: Objective = kind === 'quiz' || kind === 'reading' || kind === 'challenge' ? 'ENGAGE' : 'EDUCATE';
    let why = objective === 'ENGAGE' ? 'asks for an answer in the comments; no app mention' : 'teaches only; no app mention, to build trust';
    if (kind === 'feature') {
      objective = opts.appLink && linkUsed < opts.linkPerWeek ? 'VISIT_APP' : 'DISCOVER';
      why = 'presents one approved app capability';
    } else if (opts.appClaims && appUsed + (featureAhead(n) ? 1 : 0) < cap && ['vocab', 'grammar', 'hangul', 'dialogue'].includes(kind)) {
      // Fixed weekdays keep the plan stable when it is refreshed: Monday may carry the weekly store
      // link (one app capability while links are not allowed), Wednesday one app capability; the
      // first week mentions the app at most once, on Wednesday.
      const wd = weekday(day);
      if (wd === 1 && !firstWeek && opts.appLink && linkUsed < opts.linkPerWeek) {
        objective = 'VISIT_APP';
        why = 'ends with a practice invitation and the tagged store link (weekly link slot)';
      } else if (wd === 3 || (wd === 1 && !firstWeek)) {
        objective = 'DISCOVER';
        why = 'ends with one approved app capability that fits the lesson';
      }
    }
    const segment: PlannedItem['segment'] = unit?.segment ?? 'app_user';
    // Palette: never yesterday's, and avoid repeating a template+palette pair from the last 14 days.
    const prev = [...done.map((h) => ({ day: h.day, template: h.template, palette: h.palette })), ...items].filter((h) => daysBetween(h.day, day) <= 14 && h.day < day);
    const yesterday = prev.filter((h) => daysBetween(h.day, day) === 1).map((h) => h.palette);
    const template = KIND_TEMPLATE[kind];
    const palette =
      [...PALETTE_IDS].filter((p) => !yesterday.includes(p)).sort((a, b) => prev.filter((h) => h.template === template && h.palette === a).length - prev.filter((h) => h.template === template && h.palette === b).length || prev.filter((h) => h.palette === a).length - prev.filter((h) => h.palette === b).length)[0] ??
      PALETTE_IDS[0]!;
    const variant = (prev.filter((h) => h.template === template).length % 2) as 0 | 1;
    const what = unit ? describeUnit(pack, unit) : 'an app capability';
    items.push({ day, kind, unitId: unit?.id ?? null, objective, segment, template, palette, variant, rationale: `${what} for ${segment.replaceAll('_', ' ')}s; ${why}.` });
  }
  return { items, learning, notes };
}

export function describeUnit(pack: CurriculumPack, u: Unit): string {
  switch (u.kind) {
    case 'vocab':
      return `Word ${u.data.ko} (${u.data.gloss}, ${pack.topics[u.data.topic] ?? u.data.topic}, level ${u.data.level})`;
    case 'hangul':
      return `Hangul ${u.data.kind} ${u.data.letter}`;
    case 'grammar':
      return `Grammar ${u.data.pattern}`;
    case 'quiz':
      return `Review quiz on ${u.data.vocab.ko} (${u.data.form === 'meaning' ? 'meaning' : 'word'})`;
    case 'mistake':
      return `Common mistake: ${u.data.right.ko}`;
    case 'dialogue':
      return `Conversation: ${u.data.titleBn}`;
    case 'reading':
      return `Notice reading: ${u.data.notice.split('\n')[0]}`;
    case 'challenge':
      return `Weekly challenge on ${u.data.items.map((i) => i.ko).join(', ')}`;
  }
}
