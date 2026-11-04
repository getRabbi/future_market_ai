import { type CardSpec, type PaletteId, toBengaliDigits } from '@futuregrow/visuals';
import { seedOf, type Unit } from './curriculum.js';

/**
 * Captions and card specs (D-040). Bangla copy is written from educator-authored phrase banks and
 * the verified unit, never by a model, so the Korean is always the bank's and the Bangla reads
 * like a teacher rather than an advert. Wording avoids the copy-lint scope and promise terms
 * (সব, প্রতিটি, সবসময়, সহজেই …) and the BD brand rules; tests run every combination through lint.
 */

/** What a post is for (D-040 funnel). Only DISCOVER and later stages mention the app. */
export const OBJECTIVES = ['EDUCATE', 'ENGAGE', 'DISCOVER', 'VISIT_APP', 'INSTALL_APP', 'RETAIN'] as const;
export type Objective = (typeof OBJECTIVES)[number];

/** App capabilities a call to action may mention, each backed by an approved claim found by its wording. */
export const FEATURE_MATCHERS = {
  audio: /অডিও/u,
  games: /Word Match/u,
  hangul: /হাঙ্গুল/u,
  grammar: /গ্রামার/u,
  quiz: /Daily Quiz/u,
  modelTest: /মডেল টেস্ট/u,
  sync: /Google Account/u,
  offline: /অফলাইনে/u,
  free: /বিনামূল্যে/u,
  android: /Android/u,
} as const;
export type Feature = keyof typeof FEATURE_MATCHERS;

const FEATURES_FOR: Record<Unit['kind'] | 'feature', Feature[]> = {
  vocab: ['audio', 'games'],
  hangul: ['hangul', 'games'],
  grammar: ['grammar', 'quiz'],
  mistake: ['grammar', 'quiz'],
  quiz: ['quiz', 'modelTest'],
  reading: ['quiz', 'modelTest'],
  dialogue: ['audio'],
  challenge: ['sync', 'games', 'offline'],
  feature: ['hangul', 'grammar', 'audio', 'games', 'quiz', 'modelTest', 'offline', 'sync'],
};

export interface ClaimRef {
  id: string;
  text: string;
}

export function claimFor(feature: Feature, claims: ClaimRef[]): ClaimRef | null {
  return claims.find((c) => FEATURE_MATCHERS[feature].test(c.text)) ?? null;
}

/** The first feature this unit can mention that an approved claim backs. */
export function featureFor(kind: Unit['kind'] | 'feature', claims: ClaimRef[], salt: string): { feature: Feature; claim: ClaimRef } | null {
  const options = FEATURES_FOR[kind].map((f) => ({ feature: f, claim: claimFor(f, claims) })).filter((x): x is { feature: Feature; claim: ClaimRef } => Boolean(x.claim));
  if (!options.length) return null;
  return options[seedOf(salt) % options.length]!;
}

/* ------------------------------------------------------------------ */
/* Phrase banks                                                        */
/* ------------------------------------------------------------------ */

type Fill = Record<string, string>;
const fill = (s: string, f: Fill) => s.replace(/\{(\w+)\}/g, (_, k: string) => f[k] ?? '');

export const HOOKS: Record<Unit['kind'] | 'feature', { id: string; text: string }[]> = {
  vocab: [
    { id: 'v1', text: 'আজকের শব্দ: {ko} — {gloss} ✍️' },
    { id: 'v2', text: '“{gloss}” কোরিয়ানে কী বলে জানেন? 🤔' },
    { id: 'v3', text: 'খাতায় লিখে রাখুন, আজকের শব্দ {ko}।' },
    { id: 'v4', text: 'একটা শব্দ, একটা বাক্য — আজকের ছোট্ট পাঠ 📘' },
    { id: 'v5', text: '{topic} নিয়ে একটা দরকারি শব্দ শিখি 👇' },
  ],
  hangul: [
    { id: 'h1', text: 'হাঙ্গুল শিখি, এক অক্ষর করে 🔤' },
    { id: 'h2', text: 'আজকের অক্ষর {letter} — চিনে রাখুন 👇' },
    { id: 'h3', text: 'কোরিয়ান পড়া শুরু হয় অক্ষর চেনা দিয়ে। আজ {letter}।' },
  ],
  grammar: [
    { id: 'g1', text: 'আজকের গ্রামার: {pattern} 📌' },
    { id: 'g2', text: '{pattern} কখন বসে? ছোট করে বুঝে নিই 👇' },
    { id: 'g3', text: 'একটা নিয়ম, দুটো উদাহরণ — আজ {pattern}।' },
  ],
  quiz: [
    { id: 'q1', text: 'ছোট্ট কুইজ! 🧠' },
    { id: 'q2', text: 'নিজেকে একবার যাচাই করুন 👇' },
    { id: 'q3', text: 'আগের পাঠ মনে আছে? দেখা যাক 😊' },
  ],
  mistake: [
    { id: 'm1', text: 'অনেকেই এই ভুলটা করেন — আপনি করছেন না তো? 👀' },
    { id: 'm2', text: 'ভুল থেকে শিখি: {title}' },
    { id: 'm3', text: 'এক মিনিটে একটা সাধারণ ভুল ঠিক করে নিই ✅' },
  ],
  dialogue: [
    { id: 'd1', text: 'ছোট্ট কথোপকথন: {title} 💬' },
    { id: 'd2', text: '{situation} কী বলবেন? শিখে নিই 👇' },
    { id: 'd3', text: 'এই কথাগুলো জোরে পড়ে অনুশীলন করুন 🗣️' },
  ],
  reading: [
    { id: 'r1', text: 'নোটিশটা পড়তে পারছেন? 🪧' },
    { id: 'r2', text: 'কোরিয়ান নোটিশ পড়ার অনুশীলন 👇' },
    { id: 'r3', text: 'চারপাশের লেখা পড়তে পারা দরকারি। আজকের নোটিশ:' },
  ],
  challenge: [
    { id: 'c1', text: 'এই সপ্তাহের শব্দগুলো মনে আছে? 💪' },
    { id: 'c2', text: 'সাপ্তাহিক চ্যালেঞ্জ: শব্দগুলো দিয়ে বাক্য বানান ✍️' },
  ],
  feature: [
    { id: 'f1', text: 'পড়ার পর অনুশীলনও দরকার 📱' },
    { id: 'f2', text: 'অনুশীলনের জন্য একটা সুবিধা জেনে রাখুন 👇' },
  ],
};

const ENGAGE: Record<Unit['kind'] | 'feature', { id: string; text: string }[]> = {
  // Each prompt is one question (quiz and notice prompts ask for the answer to the card's question).
  vocab: [
    { id: 've1', text: '✍️ {ko} দিয়ে নিজে একটা বাক্য বানাতে পারবেন? কমেন্টে লিখুন।' },
    { id: 've2', text: '💬 শব্দটা মনে রাখতে আপনার কোনো কৌশল আছে? কমেন্টে জানান।' },
    { id: 've3', text: '💬 শব্দটা আগে জানতেন? কমেন্টে হ্যাঁ বা না লিখুন।' },
  ],
  hangul: [
    { id: 'he1', text: '✍️ {letter} দিয়ে আর কোন শব্দ জানেন? কমেন্টে লিখুন।' },
    { id: 'he2', text: '💬 {letter} পড়া না লেখা — কোনটা বেশি কঠিন লাগে? কমেন্টে জানান।' },
  ],
  grammar: [
    { id: 'ge1', text: '✍️ এই নিয়মে নিজে একটা বাক্য বানাতে পারবেন? কমেন্টে লিখুন।' },
    { id: 'ge2', text: '💬 কোন অংশটা কঠিন লাগছে? কমেন্টে জানান।' },
  ],
  quiz: [
    { id: 'qe1', text: '💬 আপনার উত্তর (১/২/৩/৪) কমেন্টে লিখুন।' },
    { id: 'qe2', text: '💬 কোনটা ঠিক মনে হচ্ছে? নম্বরটা কমেন্টে লিখুন।' },
  ],
  mistake: [
    { id: 'me1', text: '💬 এই ভুলটা আগে করেছেন? কমেন্টে জানান।' },
    { id: 'me2', text: '💬 এমন আর কোন ভুল আপনার প্রায়ই হয়? কমেন্টে লিখুন।' },
  ],
  dialogue: [
    { id: 'de1', text: '💬 এই কথোপকথনের কোন বাক্যটা আগে জানতেন? কমেন্টে লিখুন।' },
    { id: 'de2', text: '💬 এই পরিস্থিতিতে আর কী বলা যায়? কমেন্টে লিখুন।' },
  ],
  reading: [
    { id: 're1', text: '💬 আপনার উত্তর (১/২/৩/৪) কমেন্টে লিখুন।' },
    { id: 're2', text: '💬 কোনটা ঠিক মনে হচ্ছে? নম্বরটা কমেন্টে লিখুন।' },
  ],
  challenge: [
    { id: 'ce1', text: '✍️ কয়টা শব্দ দিয়ে বাক্য বানাতে পারলেন? কমেন্টে লিখুন।' },
    { id: 'ce2', text: '💬 কোন শব্দটা ভুলে গিয়েছিলেন? কমেন্টে জানান।' },
  ],
  feature: [{ id: 'fe1', text: '💬 কোন বিষয়ের অনুশীলন বেশি দরকার? কমেন্টে জানান।' }],
};

const HASHTAGS: Record<Unit['kind'] | 'feature', string> = {
  vocab: '#কোরিয়ান_শব্দ',
  hangul: '#হাঙ্গুল',
  grammar: '#কোরিয়ান_গ্রামার',
  mistake: '#কোরিয়ান_গ্রামার',
  quiz: '#কুইজ',
  reading: '#EPSTOPIK',
  dialogue: '#কোরিয়ান_কথোপকথন',
  challenge: '#কোরিয়ান_শব্দ',
  feature: '#EPSTOPIK',
};

const FEATURE_HEADLINES: Record<Feature, string> = {
  audio: 'শুনে শুনে উচ্চারণ অনুশীলন',
  games: 'খেলতে খেলতে কোরিয়ান',
  hangul: 'হাঙ্গুল দিয়ে শুরু',
  grammar: 'বাংলায় গ্রামার',
  quiz: 'নিয়মিত কুইজ অনুশীলন',
  modelTest: 'পরীক্ষার আগে মডেল টেস্ট',
  sync: 'অগ্রগতি থাকুক সংরক্ষিত',
  offline: 'ইন্টারনেট ছাড়াও অনুশীলন',
  free: 'Google Play-তে EPS Topik Bangla',
  android: 'Google Play-তে EPS Topik Bangla',
};

const LABELS: Record<Unit['kind'] | 'feature', string> = {
  vocab: 'আজকের শব্দ',
  hangul: 'হাঙ্গুল',
  grammar: 'গ্রামার',
  quiz: 'কুইজ',
  mistake: 'সাধারণ ভুল',
  dialogue: 'কথোপকথন',
  reading: 'নোটিশ পড়া',
  challenge: 'সাপ্তাহিক চ্যালেঞ্জ',
  feature: 'অ্যাপে অনুশীলন',
};

/** Least recently used phrase (ties broken by the seed), so hooks and prompts rotate. */
export function pickPhrase<T extends { id: string }>(pool: T[], recent: string[], salt: string): T {
  const age = (id: string) => {
    const i = recent.indexOf(id);
    return i === -1 ? Number.POSITIVE_INFINITY : i;
  };
  return [...pool].sort((a, b) => age(b.id) - age(a.id) || (seedOf(`${salt}:${a.id}`) % 997) - (seedOf(`${salt}:${b.id}`) % 997))[0]!;
}

const MARKS = ['১', '২', '৩', '৪'];
const ANSWER_LATER = '🔎 সঠিক উত্তর থাকবে পরের পোস্টে।';

/**
 * The answer to a quiz or notice-reading post. It is not in that post's caption: the Page's next
 * post reveals it (one post a day, no automated comment replies).
 */
export function answerReveal(unit: Unit): string | null {
  if (unit.kind === 'quiz') {
    const q = unit.data;
    return `✅ আগের কুইজের উত্তর: ${MARKS[q.answer]}) ${q.options[q.answer]}\n${q.vocab.ko} (${q.vocab.rr}) = ${q.vocab.bn}`;
  }
  if (unit.kind === 'reading') {
    const r = unit.data;
    const ans = r.order.indexOf(r.answer);
    return `✅ আগের নোটিশের উত্তর: ${MARKS[ans]}) ${r.options[r.answer]}\n${r.explainBn}`;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Compose                                                             */
/* ------------------------------------------------------------------ */

export interface ComposeInput {
  unit: Unit | null;
  /** 'feature' posts present an app capability backed by an approved claim; they teach nothing. */
  kind: Unit['kind'] | 'feature';
  objective: Objective;
  topicNames: Record<string, string>;
  claims: ClaimRef[];
  /** Verified store listing, used only for VISIT_APP / INSTALL_APP. */
  appUrl: string | null;
  campaign: string;
  palette: PaletteId;
  variant: 0 | 1;
  serial: number;
  /** utm_content of a store link; defaults to `<kind>-<serial>`. The studio passes a per-day identity (D-041). */
  linkContent?: string;
  recentHooks: string[];
  recentPrompts: string[];
  salt: string;
  /** The Page's previous published lesson; a quiz or notice question gets its answer in this post. */
  previous?: Unit | null;
}

export interface Composition {
  caption: string;
  card: CardSpec;
  claimIds: string[];
  link: string | null;
  hookId: string;
  promptId: string;
  ctaFeature: Feature | null;
  /** Korean strings the card may show (the studio checks the rendered text against them). */
  cardKorean: string[];
  /** The earlier quiz or notice unit whose answer this caption reveals. */
  revealUnitId: string | null;
}

/** Play listing link tagged for Play Console's campaign (UTM) reports. */
export function taggedListingUrl(base: string, campaign: string, content: string): string {
  const u = new URL(base);
  for (const k of [...u.searchParams.keys()]) if (k !== 'id') u.searchParams.delete(k);
  u.searchParams.set('referrer', `utm_source=facebook&utm_medium=organic_social&utm_campaign=${campaign}&utm_content=${content}`);
  return u.toString();
}

export function compose(input: ComposeInput): Composition | null {
  const { unit, kind, objective } = input;
  const footerRight = `#${toBengaliDigits(input.serial)}`;
  const base = { palette: input.palette, variant: input.variant, label: LABELS[kind], footerRight } as const;
  const lines: string[] = [];
  let card: CardSpec;
  let fillVars: Fill = {};
  // The caption gives a hook, one short takeaway and one question; the card carries the lesson.
  let asksAnswer = false;
  let cardKorean: string[] = [];

  if (kind === 'feature') {
    const pick = featureFor('feature', input.claims, input.salt);
    if (!pick) return null;
    const android = claimFor('android', input.claims);
    const points = pick.claim.text
      .replace(/[।.]$/u, '')
      .split(/,|;| ও /u)
      .map((s) => s.trim())
      .filter((s) => s.length > 2 && s.length < 40)
      .slice(0, 3);
    card = { ...base, template: 'feature', footerLeft: android ? 'Google Play-তে EPS Topik Bangla' : 'EPS Topik Bangla', headlineBn: FEATURE_HEADLINES[pick.feature], bodyBn: pick.claim.text, points: points.length >= 2 ? points : [], footnoteBn: 'আপনার পছন্দের অনুশীলন কোনটা?' };
    lines.push(pick.claim.text);
    return finish(input, card, lines, false, pick, android ? [android] : [], fillVars, []);
  }
  if (!unit) return null;
  switch (unit.kind) {
    case 'vocab': {
      const v = unit.data;
      fillVars = { ko: v.ko, gloss: v.gloss, topic: input.topicNames[v.topic] ?? '' };
      lines.push(`📌 ${v.ko} (${v.rr}) — ${v.bn}`);
      card = { ...base, template: 'vocab', footerLeft: `বিষয়: ${input.topicNames[v.topic] ?? ''}`, word: v.ko, romanization: v.rr, pronunciationBn: v.bnSound, meaningBn: v.bn, example: v.example };
      cardKorean = [v.ko, v.example.ko];
      break;
    }
    case 'hangul': {
      const h = unit.data;
      fillVars = { letter: h.letter };
      lines.push(`🔤 ${h.letter} — উচ্চারণ: ${h.soundBn}`);
      card = { ...base, template: 'hangul', footerLeft: h.kind === 'consonant' ? 'হাঙ্গুল ব্যঞ্জনবর্ণ' : 'হাঙ্গুল স্বরবর্ণ', letter: h.letter, nameLine: `নাম: ${h.nameKo} (${h.nameBn})`, soundBn: h.soundBn, examples: h.examples };
      cardKorean = [h.letter, h.nameKo, h.soundBn, ...h.examples.map((e) => e.ko)];
      break;
    }
    case 'grammar': {
      const g = unit.data;
      fillVars = { pattern: g.pattern };
      // The card shows the rules and the first example; the caption adds the explanation and one more example.
      const more = g.examples[1];
      lines.push(`📌 ${g.pattern}: ${g.explainBn}`, ...(more ? ['', `আরেকটা উদাহরণ: ${more.ko} → ${more.bn}`] : []));
      card = { ...base, template: 'grammar', footerLeft: g.titleBn, pattern: g.pattern, titleBn: g.titleBn, rules: g.rules, examples: g.examples.slice(0, 1) };
      cardKorean = [g.pattern, ...g.rules.flatMap((r) => [r.when, r.use]), g.examples[0]!.ko];
      break;
    }
    case 'mistake': {
      const m = unit.data;
      fillVars = { title: m.titleBn };
      lines.push(`✅ ঠিক: ${m.right.ko} → ${m.right.bn}`, `💡 ${m.tipBn}`);
      card = { ...base, template: 'mistake', footerLeft: 'ভুল থেকে শিখি', titleBn: m.titleBn, wrong: m.wrong, right: m.right, tipBn: m.tipBn };
      cardKorean = [m.titleBn, m.wrong.ko, m.wrong.bn, m.right.ko, m.tipBn];
      break;
    }
    case 'dialogue': {
      const d = unit.data;
      fillVars = { title: d.titleBn, situation: `${d.situationBn},` };
      const first = d.lines[0]!;
      lines.push(`🗣️ ${first.ko} — ${first.bn}`);
      card = { ...base, template: 'dialogue', footerLeft: d.situationBn, titleBn: d.titleBn, lines: d.lines };
      cardKorean = d.lines.map((l) => l.ko);
      break;
    }
    case 'reading': {
      const r = unit.data;
      const opts = r.order.map((i) => r.options[i]!);
      lines.push(`🪧 ${r.notice.split('\n')[0]}`, `❓ ${r.questionBn}`);
      asksAnswer = true;
      card = { ...base, template: 'reading', footerLeft: 'নোটিশ পড়ার অনুশীলন', titleBn: 'নোটিশটি পড়ুন', notice: r.notice, questionBn: r.questionBn, options: opts };
      cardKorean = [r.notice];
      break;
    }
    case 'quiz': {
      const q = unit.data;
      const v = q.vocab;
      const question = q.form === 'meaning' ? `${v.ko} শব্দটির অর্থ কী?` : `“${v.gloss}” কোরিয়ানে কোনটি?`;
      // The options stay in the caption (a word quiz quotes the word only among them); the answer does not.
      lines.push(`❓ ${question}`, q.options.map((o, i) => `${MARKS[i]}) ${o}`).join('   '));
      asksAnswer = true;
      card =
        q.form === 'meaning'
          ? { ...base, template: 'quiz', footerLeft: 'EPS-TOPIK ধাঁচের অনুশীলন', questionBn: 'নিচের শব্দটির অর্থ কী?', prompt: v.ko, options: q.options, footnoteBn: 'উত্তর কমেন্টে লিখুন' }
          : { ...base, template: 'quiz', footerLeft: 'EPS-TOPIK ধাঁচের অনুশীলন', questionBn: `“${v.gloss}” কোরিয়ানে কোনটি?`, options: q.options, footnoteBn: 'উত্তর কমেন্টে লিখুন' };
      cardKorean = q.form === 'meaning' ? [v.ko] : q.options;
      break;
    }
    case 'challenge': {
      const items = unit.data.items;
      lines.push(`এই সপ্তাহের শব্দ: ${items.map((v) => v.ko).join(' · ')}`);
      card = { ...base, template: 'challenge', footerLeft: 'এই সপ্তাহের শব্দ', titleBn: `${toBengaliDigits(items.length)}টি শব্দ, ${toBengaliDigits(items.length)}টি বাক্য`, items: items.map((v) => ({ ko: v.ko, bn: v.gloss })), footnoteBn: 'শব্দগুলো দিয়ে বাক্য লিখুন' };
      cardKorean = items.map((v) => v.ko);
      break;
    }
  }
  const cta = objective === 'EDUCATE' || objective === 'ENGAGE' ? null : featureFor(unit.kind, input.claims, input.salt);
  const extra = objective === 'VISIT_APP' || objective === 'INSTALL_APP' ? [claimFor('android', input.claims), claimFor('free', input.claims)].filter((c): c is ClaimRef => Boolean(c)) : [];
  return finish(input, card, lines, asksAnswer, cta, extra, fillVars, cardKorean);
}

function finish(input: ComposeInput, card: CardSpec, lines: string[], asksAnswer: boolean, cta: { feature: Feature; claim: ClaimRef } | null, extra: ClaimRef[], fillVars: Fill, cardKorean: string[]): Composition {
  const hook = pickPhrase(HOOKS[input.kind], input.recentHooks, `${input.salt}:hook`);
  const prompt = pickPhrase(ENGAGE[input.kind], input.recentPrompts, `${input.salt}:prompt`);
  const out: string[] = [fill(hook.text, fillVars), '', ...lines, '', fill(prompt.text, fillVars), ...(asksAnswer ? [ANSWER_LATER] : [])];
  // Lesson posts (they carry a curriculum reference) reveal the previous quiz or notice answer.
  const reveal = input.unit && input.previous ? answerReveal(input.previous) : null;
  const claimIds: string[] = [];
  let link: string | null = null;
  const wantsLink = input.objective === 'VISIT_APP' || input.objective === 'INSTALL_APP';
  if (cta && input.kind !== 'feature') {
    out.push('', `📱 ${cta.claim.text}`);
    claimIds.push(cta.claim.id);
  } else if (cta) claimIds.push(cta.claim.id);
  if (wantsLink || input.kind === 'feature') {
    for (const c of extra) {
      out.push(c === extra[0] ? `\n📲 ${c.text}` : c.text);
      claimIds.push(c.id);
    }
    if (wantsLink && input.appUrl && extra.length) {
      link = taggedListingUrl(input.appUrl, input.campaign, input.linkContent ?? `${input.kind}-${input.serial}`);
      out.push(`👉 ${link}`);
    }
  }
  if (input.objective === 'RETAIN' && cta) out.push('আজকের অনুশীলন করেছেন? 😊');
  if (reveal) out.push('', reveal);
  out.push('', `#কোরিয়ান_শিখি ${HASHTAGS[input.kind]}`);
  return {
    caption: out
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
    card,
    claimIds: [...new Set(claimIds)],
    link,
    hookId: hook.id,
    promptId: prompt.id,
    ctaFeature: cta?.feature ?? null,
    cardKorean,
    revealUnitId: reveal ? input.previous!.id : null,
  };
}
