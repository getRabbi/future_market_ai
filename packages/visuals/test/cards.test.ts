import { describe, expect, it } from 'vitest';
import { CARD_HEIGHT, CARD_WIDTH, type CardSpec, contrastRatio, hammingDistance, PALETTE_IDS, PALETTES, renderCard, typesetter } from '../src/index.js';

const base = { palette: 'navy', variant: 0, label: 'আজকের শব্দ', footerLeft: 'বিষয়: কর্মক্ষেত্রের নিরাপত্তা', footerRight: '#১' } as const;
const vocab: CardSpec = { ...base, template: 'vocab', word: '안전모', romanization: 'an-jeon-mo', pronunciationBn: 'আনজনমো', meaningBn: 'হেলমেট (সুরক্ষা টুপি)', example: { ko: '공장에서는 안전모를 쓰세요.', bn: 'কারখানায় হেলমেট পরুন।' } };
const SPECS: CardSpec[] = [
  vocab,
  {
    ...base,
    template: 'hangul',
    letter: 'ㄱ',
    nameLine: 'নাম: 기역 (গিয়ক)',
    soundBn: 'শুরুতে ‘ক/গ’, শেষে ‘ক্’',
    examples: [
      { ko: '가방', bn: 'ব্যাগ' },
      { ko: '고기', bn: 'মাংস' },
      { ko: '국', bn: 'স্যুপ' },
    ],
  },
  {
    ...base,
    template: 'grammar',
    pattern: 'N + 은/는',
    titleBn: 'বাক্যের বিষয় বোঝাতে',
    rules: [
      { when: 'শেষ অক্ষরে 받침 থাকলে', use: '은 → 책은' },
      { when: 'স্বরে শেষ হলে', use: '는 → 저는' },
    ],
    examples: [{ ko: '저는 학생이에요.', bn: 'আমি ছাত্র।' }],
  },
  { ...base, template: 'quiz', questionBn: 'নিচের শব্দটির অর্থ কী?', prompt: '병원', options: ['স্কুল', 'হাসপাতাল', 'ব্যাংক', 'বাজার'], footnoteBn: 'উত্তর কমেন্টে লিখুন' },
  { ...base, template: 'mistake', titleBn: 'স্বরের পরে 를', wrong: { ko: '커피을 마셔요.', bn: '커피 স্বরে শেষ' }, right: { ko: '커피를 마셔요.', bn: 'কফি পান করি।' }, tipBn: '받침 থাকলে 을, স্বরে শেষ হলে 를।' },
  {
    ...base,
    template: 'dialogue',
    titleBn: 'প্রথম পরিচয়',
    lines: [
      { speaker: 'A', ko: '안녕하세요? 저는 민수예요.', bn: 'হ্যালো! আমি মিনসু।' },
      { speaker: 'B', ko: '안녕하세요. 저는 라힘이에요.', bn: 'হ্যালো। আমি রহিম।' },
    ],
  },
  { ...base, template: 'reading', titleBn: 'নোটিশটি পড়ুন', notice: '흡연 금지\n이곳에서 담배를 피우지 마세요.', questionBn: 'এখানে কী করা যাবে না?', options: ['খাবার খাওয়া', 'ধূমপান করা', 'ছবি তোলা', 'বসে থাকা'] },
  {
    ...base,
    template: 'challenge',
    titleBn: '৫টি শব্দ, ৫টি বাক্য',
    items: [
      { ko: '안전모', bn: 'হেলমেট' },
      { ko: '장갑', bn: 'হাতমোজা' },
      { ko: '병원', bn: 'হাসপাতাল' },
      { ko: '시간', bn: 'সময়' },
      { ko: '물', bn: 'পানি' },
    ],
    footnoteBn: 'শব্দগুলো দিয়ে বাক্য লিখুন',
  },
  { ...base, template: 'feature', headlineBn: 'শুনে শুনে উচ্চারণ অনুশীলন', bodyBn: 'কোরিয়ান শব্দ ও বাক্যের অডিও শুনে উচ্চারণ অনুশীলন করা যায়।', points: ['শব্দের অডিও', 'বাক্যের অডিও'], footnoteBn: 'আপনার পছন্দের অনুশীলন কোনটা?' },
];

describe('branded learning cards (D-040)', () => {
  it('renders every template in every palette and both layouts as a 1080×1350 PNG that passes QA', async () => {
    const ts = await typesetter();
    for (const spec of SPECS) {
      for (const palette of PALETTE_IDS) {
        for (const variant of [0, 1] as const) {
          const r = await renderCard({ ...spec, palette, variant }, ts);
          const at = `${spec.template}/${palette}/${variant}`;
          expect(r.qa.problems, at).toEqual([]);
          expect(r.qa.passed, at).toBe(true);
          expect([r.width, r.height], at).toEqual([CARD_WIDTH, CARD_HEIGHT]);
          expect(Buffer.from(r.png.subarray(0, 8)).toString('hex'), at).toBe('89504e470d0a1a0a');
          expect(r.qa.minTextPx, at).toBeGreaterThanOrEqual(30);
          expect(r.qa.minContrast, at).toBeGreaterThanOrEqual(4.5);
          expect(r.dhash, at).toMatch(/^[0-9a-f]{16}$/);
        }
      }
    }
  }, 120_000);

  it('draws Korean and Bangla as shaped glyph outlines, never as font-dependent text', async () => {
    const r = await renderCard(vocab);
    expect(r.svg).not.toMatch(/<text/);
    expect(r.text).toEqual(expect.arrayContaining(['안전모', 'হেলমেট (সুরক্ষা টুপি)', '공장에서는 안전모를 쓰세요.', 'কারখানায় হেলমেট পরুন।']));
    // Conjuncts shape to single glyphs: ক্ষ is narrower than ক + ্ + ষ drawn separately.
    const ts = await typesetter();
    const joined = ts.shape('ক্ষ', { size: 100, weight: 700 });
    const apart = ts.shape('ক ষ', { size: 100, weight: 700 });
    expect(joined.missing).toEqual([]);
    expect(joined.glyphs.length).toBeLessThan(3);
    expect(joined.width).toBeLessThan(apart.width);
  });

  it('fails QA for characters no bundled font can draw and for text that cannot fit', async () => {
    const emoji = await renderCard({ ...vocab, meaningBn: 'হেলমেট 🪖' });
    expect(emoji.qa.passed).toBe(false);
    expect(emoji.qa.checks.glyphs).toBe(false);
    expect(emoji.qa.problems.join(' ')).toMatch(/glyphs missing/);
    const long = await renderCard({ ...vocab, word: '안전모안전모안전모안전모안전모' });
    expect(long.qa.passed).toBe(false);
    expect(long.qa.checks.overflow).toBe(false);
    const tooMuch = await renderCard({ ...base, template: 'feature', headlineBn: 'অনেক লম্বা শিরোনাম '.repeat(12), bodyBn: 'বাক্য '.repeat(80), points: ['এক', 'দুই', 'তিন'], footnoteBn: 'শেষ' });
    expect(tooMuch.qa.passed).toBe(false);
  });

  it('is deterministic, and different lessons or palettes look different at feed size', async () => {
    const a = await renderCard(vocab);
    const b = await renderCard(vocab);
    expect(Buffer.from(a.png).equals(Buffer.from(b.png))).toBe(true);
    const other = await renderCard({ ...SPECS[3]! });
    expect(hammingDistance(a.dhash, other.dhash)).toBeGreaterThanOrEqual(6);
    const recolored = await renderCard({ ...vocab, palette: 'cream' });
    expect(hammingDistance(a.dhash, recolored.dhash)).toBeGreaterThan(0);
  });

  it('keeps every palette’s text colours above WCAG AA contrast on their backgrounds', () => {
    for (const [id, p] of Object.entries(PALETTES)) {
      for (const [fg, bg] of [
        ['ink', 'bg'],
        ['sub', 'bg'],
        ['cardInk', 'card'],
        ['cardSub', 'card'],
        ['onAccent', 'accent'],
        ['cardInk', 'tint'],
        ['bad', 'card'],
        ['good', 'card'],
      ] as const) {
        expect(contrastRatio(p[fg], p[bg]), `${id} ${fg}/${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
