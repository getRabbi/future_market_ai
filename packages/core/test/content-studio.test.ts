import { randomUUID } from 'node:crypto';
import { contentStudio, evidence, knowledge } from '@futuregrow/core';
import { withTenant } from '@futuregrow/db';
import { renderCard } from '@futuregrow/visuals';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CoreHarness, createCoreHarness } from '../../../test/helpers/core.js';
import { type ClaimRef, compose, type Objective, taggedListingUrl } from '../src/modules/studio/compose.js';
import { PACKS, packUnits, packVersion, unitById, verifyCurriculumText } from '../src/modules/studio/curriculum.js';
import { dayOffset, type HistoryItem, nextPostingSlot, planDays, postingWindow } from '../src/modules/studio/planner.js';

/*
 * D-040 content studio: the verified curriculum composes into captions and cards that pass the
 * real copy lint (with the live BD brand rules), quote only the unit's Korean, and render cards
 * that pass QA; the planner rotates lessons, caps app mentions and adapts only on enough data.
 */

const pack = PACKS['eps-topik-bn']!;
const CLAIM_TEXTS = [
  'EPS Topik Bangla অ্যাপটি Android ফোনের জন্য Google Play-তে পাওয়া যায়।',
  'অ্যাপটি Google Play-তে বিনামূল্যে ইনস্টল করা যায়; অ্যাপে বিজ্ঞাপন আছে।',
  'Google Account দিয়ে লগইন করে শেখার অগ্রগতি সংরক্ষণ করা যায় এবং অন্য ডিভাইসে ফিরে পাওয়া যায়।',
  'অফলাইনে উপলব্ধ লেসন ও অনুশীলন ইন্টারনেট ছাড়াও ব্যবহার করা যায়।',
  'Word Match, Hangul Builder ও Sentence Puzzle গেম খেলে কোরিয়ান শেখা যায়।',
  'কোরিয়ান শব্দ ও বাক্যের অডিও শুনে উচ্চারণ অনুশীলন করা যায়।',
  'অ্যাপে Daily Quiz, Reading Practice ও Grammar Quiz দিয়ে অনুশীলন করা যায়।',
  'EPS-TOPIK প্রস্তুতির জন্য অ্যাপে ৫টি মডেল টেস্ট আছে।',
  'অ্যাপে হাঙ্গুল বর্ণমালা ও উচ্চারণ শেখার লেসন আছে।',
  'EPS Topik Bangla অ্যাপে বাংলা ব্যাখ্যাসহ কোরিয়ান গ্রামার শেখা যায়।',
];
// The BD brand rules live on the EPS Page's organization (2026-11-01).
const BD_RULES = [
  { kind: 'banned_regex', pattern: 'পাস নিশ্চিত|নিশ্চিত পাস|গ্যারান্টি|\\bguarantee', severity: 'block', description: 'No guaranteed exam results.' },
  { kind: 'banned_regex', pattern: 'অফিসিয়াল|সরকারি|\\bofficial\\b|HRD ?Korea', severity: 'block', description: 'No official status or endorsement.' },
  { kind: 'banned_regex', pattern: 'চাকরি|চাকুরি|ভিসা|বেতন|অভিবাসন|বিদেশে|কাজের সুযোগ|এজেন্সি|দালাল|রিক্রুট|নিয়োগ|BOESL|BMET|\\bjobs?\\b|\\bvisas?\\b|\\bsalar(y|ies)\\b|\\brecruit', severity: 'block', description: 'No overseas employment, recruitment or migration content.' },
];
const PRODUCT = /অ্যাপ|\bapps?\b|play\.google|google play|প্লে স্টোর|ডাউনলোড|\bdownload|ইনস্টল|\binstall/iu;
const LISTING = 'https://play.google.com/store/apps/details?id=com.rabbi.eps_topik_bangla';

let h: CoreHarness;
const claims: ClaimRef[] = [];
const tx = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(h.t.handle.db, { tenantId: h.tenantId, actor: 'user:test' }, fn);

beforeAll(async () => {
  h = await createCoreHarness();
  for (const r of BD_RULES) await tx((t) => knowledge.addBrandRule(t, h.tenantId, h.users.owner, r));
  const ev = await tx((t) =>
    evidence.admitEvidence(
      t,
      h.tenantId,
      h.users.owner,
      {
        sourceType: 'primary',
        sourceOwner: 'google_play',
        sourceUriOrObjectId: LISTING,
        retrievedAt: h.clock.now().toISOString(),
        licenseOrUsageRights: 'public listing',
        schemaVersion: '1',
        piiClassification: 'none',
        confidence: 0.95,
        freshnessSlaHours: 24 * 90,
        permittedUses: ['publishing', 'creative_generation'],
        kind: 'document',
        summary: 'Play listing',
        content: { n: randomUUID() },
      } as never,
      { now: h.clock.now() },
    ),
  );
  for (const text of CLAIM_TEXTS) {
    const c = await tx((t) => knowledge.proposeClaim(t, h.deps, h.tenantId, h.users.operator, { text, claimType: 'product_capability', evidenceIds: [ev.evidenceId] }));
    await tx((t) => knowledge.reviewClaim(t, h.tenantId, h.users.approver, c.id, 'approved'));
    claims.push({ id: c.id, text });
  }
}, 180_000);

afterAll(async () => {
  await h?.close();
});

const OBJECTIVES: Objective[] = ['EDUCATE', 'ENGAGE', 'DISCOVER', 'VISIT_APP'];

describe('content studio curriculum and copy (D-040)', () => {
  it('composes every unit into captions that pass copy lint with the BD brand rules, quote only the unit’s Korean, and mention the app only with an approved claim', async () => {
    const version = packVersion(pack);
    const units = packUnits(pack);
    expect(units.length).toBeGreaterThan(200);
    const failures: string[] = [];
    let n = 0;
    for (const unit of units) {
      for (const objective of OBJECTIVES) {
        const c = compose({ unit, kind: unit.kind, objective, topicNames: pack.topics, claims, appUrl: LISTING, campaign: 'eps_daily', palette: 'navy', variant: 0, serial: ++n, recentHooks: [], recentPrompts: [], salt: `${unit.id}:${objective}` })!;
        const at = `${unit.id}/${objective}`;
        const lint = await tx((t) => knowledge.lintCopy(t, c.caption, { claimIds: c.claimIds, channel: 'facebook', now: h.clock.now() }));
        if (!lint.passed) failures.push(`${at}: ${lint.violations.map((v) => `${v.code} "${v.excerpt}"`).join('; ')}`);
        const check = verifyCurriculumText(c.caption, { pack: pack.id, version, unitId: unit.id });
        if (!check.verified) failures.push(`${at}: ${check.problems.join('; ')}`);
        if (objective === 'EDUCATE' || objective === 'ENGAGE') {
          if (c.claimIds.length || c.link || PRODUCT.test(c.caption)) failures.push(`${at}: an educational post mentions the app`);
        } else if (!c.claimIds.length || !c.claimIds.every((id) => claims.some((x) => x.id === id && c.caption.includes(x.text)))) failures.push(`${at}: app mention without its claim text`);
        if (objective === 'VISIT_APP' && !c.link?.startsWith(`${LISTING}&referrer=utm_source%3Dfacebook`)) failures.push(`${at}: link ${c.link}`);
        if (/#\S+/gu.test(c.caption) && (c.caption.match(/#\S+/gu) ?? []).length > 3) failures.push(`${at}: too many hashtags`);
      }
    }
    expect(failures).toEqual([]);
  }, 300_000);

  it('renders a card for every unit that passes QA and the copy lint, showing only the unit’s Korean', async () => {
    const failures: string[] = [];
    const seen = new Set<string>();
    for (const [i, unit] of packUnits(pack).entries()) {
      const c = compose({ unit, kind: unit.kind, objective: 'DISCOVER', topicNames: pack.topics, claims, appUrl: null, campaign: 'eps_daily', palette: (['navy', 'cream', 'green', 'sky'] as const)[i % 4]!, variant: (i % 2) as 0 | 1, serial: i + 1, recentHooks: [], recentPrompts: [], salt: unit.id })!;
      const card = await renderCard(c.card);
      if (!card.qa.passed) failures.push(`${unit.id}: ${card.qa.problems.join('; ')}`);
      const lint = await tx((t) => knowledge.lintCopy(t, card.text.join('\n'), { claimIds: c.claimIds, now: h.clock.now() }));
      if (!lint.passed) failures.push(`${unit.id} card: ${lint.violations.map((v) => v.code).join(', ')}`);
      const allowed = [...c.cardKorean, ...unit.korean, '한'];
      const foreign = card.text.flatMap((s) => s.match(/[㄰-㆏가-힣]+/gu) ?? []).filter((w) => !allowed.some((k) => k.includes(w)));
      if (foreign.length) failures.push(`${unit.id}: card Korean ${foreign.join(', ')}`);
      seen.add(card.dhash);
    }
    expect(failures).toEqual([]);
    expect(seen.size).toBeGreaterThan(150);
  }, 300_000);

  it('rejects Korean the unit does not contain, a changed pack and unknown units', () => {
    const version = packVersion(pack);
    const unit = unitById(pack, 'v-anjeonmo')!;
    const c = compose({ unit, kind: 'vocab', objective: 'EDUCATE', topicNames: pack.topics, claims: [], appUrl: null, campaign: 'x', palette: 'navy', variant: 0, serial: 1, recentHooks: [], recentPrompts: [], salt: 's' })!;
    expect(verifyCurriculumText(c.caption, { pack: pack.id, version, unitId: unit.id })).toEqual({ verified: true, problems: [] });
    expect(verifyCurriculumText(`${c.caption}\n비자 정보`, { pack: pack.id, version, unitId: unit.id }).problems.join()).toMatch(/not in the verified unit: 비자/);
    expect(verifyCurriculumText(c.caption.replaceAll('안전모', '장갑'), { pack: pack.id, version, unitId: unit.id }).verified).toBe(false);
    expect(verifyCurriculumText(c.caption, { pack: pack.id, version: 'stale', unitId: unit.id }).problems.join()).toMatch(/changed since/);
    expect(verifyCurriculumText(c.caption, { pack: pack.id, version, unitId: 'v-unknown' }).verified).toBe(false);
    expect(verifyCurriculumText(c.caption, null).verified).toBe(false);
  });
});

describe('seven-day content calendar (D-040)', () => {
  const opts = { appClaims: true, appLink: true, appCtaPerWeek: 2, linkPerWeek: 1 };
  /** Plans day by day for `days` days, treating each day's item as published. */
  function simulate(start: string, days: number, engagement: (h: HistoryItem) => number | null = () => null) {
    const history: HistoryItem[] = [];
    for (let i = 0; i < days; i++) {
      const window = [...Array(7).keys()].map((k) => dayOffset(start, i + k));
      const plan = planDays(pack, window, history, opts);
      expect(plan.items.map((x) => x.day)).toEqual(window);
      const it = plan.items[0]!;
      const item: HistoryItem = { day: it.day, kind: it.kind, unitId: it.unitId, objective: it.objective, template: it.template, palette: it.palette, variant: it.variant, hookId: null, promptId: null, status: 'published', engagement: null };
      item.engagement = engagement(item);
      history.push(item);
    }
    return history;
  }

  it('rotates lesson types, never repeats a lesson, reviews taught words, and caps app mentions and links per rolling week', () => {
    const hist = simulate('2026-11-02', 42);
    for (let i = 0; i + 7 <= hist.length; i++) {
      const week = hist.slice(i, i + 7);
      expect(new Set(week.map((x) => x.kind)).size, `week from ${week[0]!.day}`).toBeGreaterThanOrEqual(5);
      expect(week.filter((x) => ['DISCOVER', 'VISIT_APP', 'INSTALL_APP', 'RETAIN'].includes(x.objective)).length).toBeLessThanOrEqual(2);
      expect(week.filter((x) => x.objective === 'VISIT_APP' || x.objective === 'INSTALL_APP').length).toBeLessThanOrEqual(1);
      for (let d = 1; d < week.length; d++) expect(week[d]!.palette, `${week[d]!.day} palette`).not.toBe(week[d - 1]!.palette);
    }
    // Trust first: no store link in the first week; at most one app mention.
    const first = hist.slice(0, 7);
    expect(first.some((x) => x.objective === 'VISIT_APP')).toBe(false);
    expect(first.filter((x) => x.objective !== 'EDUCATE' && x.objective !== 'ENGAGE').length).toBeLessThanOrEqual(1);
    const units = hist.map((x) => x.unitId).filter(Boolean);
    expect(new Set(units).size).toBe(units.length);
    // Quizzes review words taught earlier; challenges list words of the last two weeks.
    for (const [i, x] of hist.entries()) {
      if (x.kind === 'quiz' && x.unitId!.startsWith('q-')) {
        const word = x.unitId!.replace(/^q-(meaning|word)-/, '');
        expect(
          hist.slice(0, i).some((p) => p.unitId === word),
          `${x.day} quiz on ${word}`,
        ).toBe(true);
      }
      if (x.kind === 'challenge')
        for (const w of x.unitId!.slice(2).split(','))
          expect(
            hist.slice(Math.max(0, i - 14), i).some((p) => p.unitId === w),
            `${x.day} challenge word ${w}`,
          ).toBe(true);
    }
    expect(hist.some((x) => x.kind === 'feature')).toBe(true);
    expect(hist.some((x) => x.objective === 'VISIT_APP' && x.kind !== 'feature')).toBe(true);
    expect(hist.filter((x) => x.objective === 'DISCOVER').length).toBeGreaterThanOrEqual(4);
  });

  it('keeps a day’s plan when the calendar is refreshed on a later day', () => {
    const hist = simulate('2026-11-02', 10);
    const days = [...Array(8).keys()].map((k) => dayOffset('2026-11-12', k));
    const a = planDays(pack, days.slice(0, 7), hist, opts).items;
    // The next day, the first day's post is history.
    const first = a[0]!;
    const b = planDays(pack, days.slice(1), [...hist, { ...first, hookId: null, promptId: null, status: 'published', engagement: null }], opts).items;
    for (const day of days.slice(1, 7)) {
      const x = a.find((i) => i.day === day)!;
      const y = b.find((i) => i.day === day)!;
      expect([y.kind, y.objective], day).toEqual([x.kind, x.objective]);
    }
  });

  it('keeps exploring with little data and moves one slot to a clearly better lesson type only with enough measured posts', () => {
    const quizLoved = (x: HistoryItem) => (x.kind === 'quiz' ? 12 : x.kind === 'grammar' ? 1 : 4);
    const early = planDays(
      pack,
      [...Array(7).keys()].map((k) => dayOffset('2026-11-09', k)),
      simulate('2026-11-02', 5, quizLoved),
      opts,
    );
    expect(early.learning.phase).toBe('exploring');
    expect(early.notes.join(' ')).toMatch(/keeps exploring/);
    // One sentence: no doubled post count and no stray full stop before the clause (the 'groups., so' typo).
    expect(early.notes.join(' ')).not.toMatch(/\.,|; \d+ measured posts?;/);
    const none = planDays(pack, [dayOffset('2026-11-09', 0)], [], opts);
    expect(none.notes).toEqual(['0 measured posts with complete counters; comparing needs 12 in total and 4 in each of at least two groups, so the calendar keeps exploring.']);
    const hist = simulate('2026-11-02', 28, quizLoved);
    const window = [...Array(7).keys()].map((k) => dayOffset('2026-11-30', k));
    const plan = planDays(pack, window, hist, opts);
    expect(plan.learning.phase).toBe('adapting');
    expect(plan.notes.join(' ')).toMatch(/Moved one grammar point slot to review quiz/);
    expect(plan.items.filter((x) => x.kind === 'quiz').length).toBe(2);
    expect(plan.items.some((x) => x.kind === 'grammar')).toBe(false);
  });
});

it('tags the verified Play listing with decodable campaign and lesson attribution', () => {
  const url = new URL(taggedListingUrl(LISTING + '&referrer=old&untrusted=1', 'eps_daily', 'v-safety-1'));
  expect(url.origin + url.pathname).toBe('https://play.google.com/store/apps/details');
  expect(url.searchParams.get('id')).toBe('com.rabbi.eps_topik_bangla');
  expect([...url.searchParams.keys()].sort()).toEqual(['id', 'referrer']);
  expect(Object.fromEntries(new URLSearchParams(url.searchParams.get('referrer')!))).toEqual({
    utm_source: 'facebook',
    utm_medium: 'organic_social',
    utm_campaign: 'eps_daily',
    utm_content: 'v-safety-1',
  });
});

describe('caption quality, answer reveal and posting time (D-040 follow-up)', () => {
  const base = { topicNames: pack.topics, claims, appUrl: null, campaign: 'eps_daily', palette: 'navy' as const, variant: 0 as const, serial: 1, recentHooks: [] as string[], recentPrompts: [] as string[] };
  const MARKS = ['১', '২', '৩', '৪'];

  it('captions give a hook, a short takeaway and one question, leave the lesson to the card, and never answer their own quiz or notice', () => {
    const failures: string[] = [];
    for (const unit of packUnits(pack)) {
      const c = compose({ ...base, unit, kind: unit.kind, objective: 'EDUCATE', salt: unit.id })!;
      const lines = c.caption.split('\n').filter((l) => l.trim());
      if (lines.length > 6) failures.push(`${unit.id}: ${lines.length} lines`);
      if (!c.caption.includes('?')) failures.push(`${unit.id}: no question`);
      if (/উত্তর:|\n\.\n/u.test(c.caption)) failures.push(`${unit.id}: answers itself`);
      const asks = unit.kind === 'quiz' || unit.kind === 'reading';
      if (asks !== c.caption.includes('সঠিক উত্তর থাকবে পরের পোস্টে')) failures.push(`${unit.id}: answer-later note`);
      if (unit.kind === 'vocab' && c.caption.includes(unit.data.example.ko)) failures.push(`${unit.id}: repeats the card's example`);
      if (unit.kind === 'grammar' && unit.data.rules.some((r) => c.caption.includes(`${r.when}: ${r.use}`))) failures.push(`${unit.id}: repeats the card's rules`);
      if (unit.kind === 'reading' && unit.data.options.some((o) => c.caption.includes(o))) failures.push(`${unit.id}: repeats the card's options`);
    }
    expect(failures).toEqual([]);
  });

  it('reveals the previous quiz or notice answer in the next lesson post, which passes copy lint and the curriculum check only with that unit referenced', async () => {
    const version = packVersion(pack);
    const vocab = packUnits(pack).filter((u) => u.kind === 'vocab')[3]!;
    const quiz = unitById(pack, 'q-word-v-anjeonmo')!;
    const reading = unitById(pack, 'r-no-smoking')!;
    if (quiz.kind !== 'quiz' || reading.kind !== 'reading') throw new Error('fixture units');
    expect(compose({ ...base, unit: quiz, kind: 'quiz', objective: 'EDUCATE', salt: 'q' })!.revealUnitId).toBeNull();

    const afterQuiz = compose({ ...base, unit: vocab, kind: 'vocab', objective: 'EDUCATE', salt: 'v', previous: quiz })!;
    expect(afterQuiz.revealUnitId).toBe(quiz.id);
    expect(afterQuiz.caption).toContain(`✅ আগের কুইজের উত্তর: ${MARKS[quiz.data.answer]}) 안전모\n안전모 (${quiz.data.vocab.rr}) = ${quiz.data.vocab.bn}`);
    const lint = await tx((t) => knowledge.lintCopy(t, afterQuiz.caption, { claimIds: afterQuiz.claimIds, channel: 'facebook', now: h.clock.now() }));
    expect(lint.passed, JSON.stringify(lint.violations)).toBe(true);
    expect(verifyCurriculumText(afterQuiz.caption, { pack: pack.id, version, unitId: vocab.id, revealUnitId: quiz.id })).toEqual({ verified: true, problems: [] });
    expect(verifyCurriculumText(afterQuiz.caption, { pack: pack.id, version, unitId: vocab.id }).problems.join()).toMatch(/not in the verified unit: 안전모/);
    expect(verifyCurriculumText(afterQuiz.caption, { pack: pack.id, version, unitId: vocab.id, revealUnitId: vocab.id }).problems.join()).toMatch(/answer-reveal unit/);

    // The revealed number is the one the notice card showed.
    const readingPost = compose({ ...base, unit: reading, kind: 'reading', objective: 'EDUCATE', salt: 'r' })!;
    const shown = (readingPost.card as { options: string[] }).options;
    const afterReading = compose({ ...base, unit: vocab, kind: 'vocab', objective: 'EDUCATE', salt: 'v', previous: reading })!;
    expect(afterReading.caption).toContain(`✅ আগের নোটিশের উত্তর: ${MARKS[shown.indexOf('ধূমপান করা')]}) ধূমপান করা\n${reading.data.explainBn}`);
    expect(verifyCurriculumText(afterReading.caption, { pack: pack.id, version, unitId: vocab.id, revealUnitId: reading.id }).verified).toBe(true);

    // Only quiz and notice questions are answered; app capability posts carry no curriculum reference and reveal nothing.
    expect(compose({ ...base, unit: vocab, kind: 'vocab', objective: 'EDUCATE', salt: 'v', previous: packUnits(pack).filter((u) => u.kind === 'vocab')[0]! })!.revealUnitId).toBeNull();
    expect(compose({ ...base, unit: null, kind: 'feature', objective: 'DISCOVER', salt: 'f', previous: quiz })!.revealUnitId).toBeNull();
  });

  it('posts in the Bangladesh evening window instead of when the cycle happens to run', () => {
    // 2026-11-04T19:00Z is 01:00 on 5 November in Bangladesh, when the 4 November post went out.
    expect(nextPostingSlot(new Date('2026-11-04T19:00:00Z'))?.toISOString()).toBe('2026-11-05T13:00:00.000Z');
    expect(nextPostingSlot(new Date('2026-11-05T13:30:00Z'))).toBeNull();
    expect(nextPostingSlot(new Date('2026-11-05T16:00:00Z'))?.toISOString()).toBe('2026-11-06T13:00:00.000Z');
    expect(postingWindow(new Date('2026-11-05T13:30:00Z'))).toEqual({ start: new Date('2026-11-05T13:00:00Z'), end: new Date('2026-11-05T16:00:00Z') });
  });

  it('does not review a word whose post never went out', () => {
    const opts = { appClaims: true, appLink: true, appCtaPerWeek: 2, linkPerWeek: 1 };
    const days = [...Array(7).keys()].map((k) => dayOffset('2026-11-10', k)); // Tuesday: review quiz day
    const taught = (status: string): HistoryItem[] => [{ day: '2026-11-08', kind: 'vocab', unitId: 'v-anjeonmo', objective: 'EDUCATE', template: 'vocab', palette: 'navy', variant: 0, hookId: null, promptId: null, status, engagement: null }];
    expect(planDays(pack, days, taught('published'), opts).items[0]!.unitId).toMatch(/^q-(meaning|word)-v-anjeonmo$/);
    expect(planDays(pack, days, taught('drafted'), opts).items[0]!.unitId).not.toMatch(/^q-.*v-anjeonmo$/);
  });
});

void contentStudio;
