import { canonicalJson } from '@futuregrow/contracts';
import { sha256Hex } from '@futuregrow/observability';
import { EPS_TOPIK_BN } from './eps-topik-bn.js';

/**
 * Curriculum packs (D-040): verified lesson banks the content studio teaches from. A unit is what
 * one post teaches. Its `korean` list is every Korean string a post about it may contain, so M23
 * can check a post's Korean against the bank without trusting the composer.
 */

export interface Pair {
  ko: string;
  bn: string;
}

export interface VocabItem {
  id: string;
  ko: string;
  rr: string;
  bnSound: string;
  bn: string;
  gloss: string;
  topic: string;
  level: 1 | 2;
  example: Pair;
}

export interface LetterItem {
  id: string;
  letter: string;
  kind: 'consonant' | 'vowel';
  nameKo: string;
  nameBn: string;
  soundBn: string;
  examples: Pair[];
}

export interface GrammarItem {
  id: string;
  pattern: string;
  titleBn: string;
  explainBn: string;
  rules: { when: string; use: string }[];
  examples: Pair[];
}

export interface MistakeItem {
  id: string;
  titleBn: string;
  wrong: Pair;
  right: Pair;
  tipBn: string;
  grammarId?: string;
}

export interface DialogueItem {
  id: string;
  titleBn: string;
  situationBn: string;
  lines: (Pair & { speaker: 'A' | 'B' })[];
}

export interface ReadingItem {
  id: string;
  notice: string;
  questionBn: string;
  options: string[];
  answer: number;
  explainBn: string;
}

export interface CurriculumPack {
  id: string;
  title: string;
  language: 'bn';
  topics: Record<string, string>;
  vocab: VocabItem[];
  letters: LetterItem[];
  grammar: GrammarItem[];
  mistakes: MistakeItem[];
  dialogues: DialogueItem[];
  readings: ReadingItem[];
}

export const UNIT_KINDS = ['vocab', 'hangul', 'grammar', 'quiz', 'mistake', 'dialogue', 'reading', 'challenge'] as const;
export type UnitKind = (typeof UNIT_KINDS)[number];

/** Audience segments a unit is written for (the planner balances them). */
export const SEGMENTS = ['absolute_beginner', 'hangul_learner', 'vocab_grammar', 'eps_candidate', 'returning_learner'] as const;
export type Segment = (typeof SEGMENTS)[number];

export interface QuizData {
  form: 'meaning' | 'word';
  vocab: VocabItem;
  /** Shown options in order; `answer` indexes them. */
  options: string[];
  answer: number;
}

export type Unit = { id: string; level: 1 | 2; segment: Segment; topic: string | null; korean: string[]; core: string[] } & (
  | { kind: 'vocab'; data: VocabItem }
  | { kind: 'hangul'; data: LetterItem }
  | { kind: 'grammar'; data: GrammarItem }
  | { kind: 'mistake'; data: MistakeItem }
  | { kind: 'dialogue'; data: DialogueItem }
  | { kind: 'reading'; data: ReadingItem & { order: number[] } }
  | { kind: 'quiz'; data: QuizData }
  | { kind: 'challenge'; data: { items: VocabItem[] } }
);

export const PACKS: Record<string, CurriculumPack> = { [EPS_TOPIK_BN.id]: EPS_TOPIK_BN };

const versions = new Map<string, string>();
/** Content hash of a pack: a post composed from one version verifies only against that version. */
export function packVersion(pack: CurriculumPack): string {
  let v = versions.get(pack.id);
  if (!v) {
    v = sha256Hex(canonicalJson(pack)).slice(0, 16);
    versions.set(pack.id, v);
  }
  return v;
}

/** Stable pseudo-random integer from a string (option order, distractors). */
export function seedOf(s: string): number {
  return Number.parseInt(sha256Hex(s).slice(0, 8), 16);
}

const pairsKo = (ps: Pair[]) => ps.map((p) => p.ko);

/** A deterministic permutation of 0..n-1 for a key. */
function permutation(n: number, key: string): number[] {
  return [...Array(n).keys()].sort((a, b) => seedOf(`${key}:${a}`) - seedOf(`${key}:${b}`));
}

function quizUnit(pack: CurriculumPack, form: 'meaning' | 'word', v: VocabItem): Unit {
  // Distractors: other words, same topic first, never one whose gloss contains (or is contained in) the answer's.
  const others = pack.vocab
    .filter((o) => o.id !== v.id && !o.gloss.includes(v.gloss) && !v.gloss.includes(o.gloss))
    .sort((a, b) => Number(b.topic === v.topic) - Number(a.topic === v.topic) || seedOf(`${v.id}:${a.id}`) - seedOf(`${v.id}:${b.id}`))
    .slice(0, 3);
  const pick = (x: VocabItem) => (form === 'meaning' ? x.gloss : x.ko);
  const pool = [v, ...others];
  const order = permutation(4, `q-${form}-${v.id}`);
  const options = order.map((i) => pick(pool[i]!));
  return {
    id: `q-${form}-${v.id}`,
    kind: 'quiz',
    level: v.level,
    segment: 'eps_candidate',
    topic: v.topic,
    korean: form === 'meaning' ? [v.ko, v.example.ko] : [...pool.map((x) => x.ko), v.example.ko],
    core: [v.ko],
    data: { form, vocab: v, options, answer: order.indexOf(0) },
  };
}

/** Every unit of a pack except weekly challenges (those are built from the week's words). */
export function packUnits(pack: CurriculumPack): Unit[] {
  const out: Unit[] = [];
  for (const v of pack.vocab) out.push({ id: v.id, kind: 'vocab', level: v.level, segment: v.level === 1 ? 'absolute_beginner' : 'vocab_grammar', topic: v.topic, korean: [v.ko, v.example.ko], core: [v.ko], data: v });
  for (const h of pack.letters) out.push({ id: h.id, kind: 'hangul', level: 1, segment: 'hangul_learner', topic: null, korean: [h.letter, h.nameKo, ...pairsKo(h.examples), h.soundBn], core: [h.letter], data: h });
  for (const g of pack.grammar) out.push({ id: g.id, kind: 'grammar', level: 1, segment: 'vocab_grammar', topic: null, korean: [g.pattern, g.explainBn, ...g.rules.flatMap((r) => [r.when, r.use]), ...pairsKo(g.examples)], core: [g.pattern.replace(/^[NV] \+ /, '').replace(/^안 \+ V$/, '안')], data: g });
  for (const m of pack.mistakes) out.push({ id: m.id, kind: 'mistake', level: 1, segment: 'vocab_grammar', topic: null, korean: [m.titleBn, m.wrong.ko, m.wrong.bn, m.right.ko, m.tipBn], core: [m.right.ko], data: m });
  for (const d of pack.dialogues) out.push({ id: d.id, kind: 'dialogue', level: 1, segment: 'absolute_beginner', topic: null, korean: pairsKo(d.lines), core: [d.lines[0]!.ko], data: d });
  for (const r of pack.readings) {
    const order = permutation(r.options.length, r.id);
    out.push({ id: r.id, kind: 'reading', level: 2, segment: 'eps_candidate', topic: null, korean: [r.notice, r.explainBn], core: [r.notice.split('\n')[0]!], data: { ...r, order } });
  }
  for (const v of pack.vocab) out.push(quizUnit(pack, 'meaning', v), quizUnit(pack, 'word', v));
  return out;
}

const unitCache = new Map<string, Map<string, Unit>>();

/** Resolves any unit id of a pack, including weekly challenges (`c:<vocab ids>`). */
export function unitById(pack: CurriculumPack, id: string): Unit | null {
  let byId = unitCache.get(pack.id);
  if (!byId) {
    byId = new Map(packUnits(pack).map((u) => [u.id, u]));
    unitCache.set(pack.id, byId);
  }
  const u = byId.get(id);
  if (u) return u;
  if (id.startsWith('c:')) return challengeUnit(pack, id.slice(2).split(','));
  return null;
}

export function challengeUnit(pack: CurriculumPack, vocabIds: string[]): Unit | null {
  const items = vocabIds.map((v) => pack.vocab.find((x) => x.id === v)).filter((x): x is VocabItem => Boolean(x));
  if (items.length < 3 || items.length !== vocabIds.length || items.length > 6) return null;
  return { id: `c:${items.map((i) => i.id).join(',')}`, kind: 'challenge', level: 1, segment: 'returning_learner', topic: null, korean: items.map((i) => i.ko), core: items.map((i) => i.ko), data: { items } };
}

/** Hangul syllables and jamo (compatibility and conjoining). */
const HANGUL_RUN = /[ᄀ-ᇿ㄰-㆏가-힣]+/gu;

export interface CurriculumRef {
  pack: string;
  version: string;
  unitId: string;
  /** An earlier quiz or notice-reading unit whose answer the post reveals. */
  revealUnitId?: string;
}

export interface CurriculumCheck {
  verified: boolean;
  problems: string[];
}

/**
 * M23's independent check of a post's educational content (D-040): the pack and version exist,
 * the unit exists, the post quotes the unit's core Korean, and every Korean word in it comes from
 * the unit. A post that fails is not pre-authorized as curriculum content.
 */
export function verifyCurriculumText(text: string, ref: CurriculumRef | null | undefined): CurriculumCheck {
  if (!ref) return { verified: false, problems: ['no curriculum reference'] };
  const pack = PACKS[ref.pack];
  if (!pack) return { verified: false, problems: [`unknown curriculum pack ${ref.pack}`] };
  if (packVersion(pack) !== ref.version) return { verified: false, problems: [`pack ${ref.pack} changed since the post was composed (${ref.version} → ${packVersion(pack)})`] };
  const unit = unitById(pack, ref.unitId);
  if (!unit) return { verified: false, problems: [`unknown unit ${ref.unitId}`] };
  const reveal = ref.revealUnitId ? unitById(pack, ref.revealUnitId) : null;
  if (ref.revealUnitId && (!reveal || (reveal.kind !== 'quiz' && reveal.kind !== 'reading'))) return { verified: false, problems: [`unknown answer-reveal unit ${ref.revealUnitId}`] };
  const t = text.normalize('NFC');
  const problems: string[] = [];
  for (const c of unit.core) if (!t.includes(c)) problems.push(`the post does not quote "${c}"`);
  const allowed = [...unit.korean, ...(reveal?.korean ?? [])].map((k) => k.normalize('NFC'));
  const foreign = [...new Set([...t.matchAll(HANGUL_RUN)].map((m) => m[0]))].filter((w) => !allowed.some((k) => k.includes(w)));
  if (foreign.length) problems.push(`Korean not in the verified unit: ${foreign.slice(0, 5).join(', ')}`);
  return { verified: problems.length === 0, problems };
}
