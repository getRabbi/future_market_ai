import { differenceHash, rasterize } from './raster.js';
import { type Box, type TextLayout, Typesetter } from './typeset.js';

/**
 * Branded learning cards (D-040): a small layout engine (vertical stacks, panels, rows, chips) over
 * the HarfBuzz typesetter, nine templates, four palettes and two layout variants. Every render is
 * checked before it can become an asset: glyph coverage, overflow and clipping, overlaps,
 * minimum type size, WCAG contrast, safe margins and output size.
 */

export const CARD_WIDTH = 1080;
export const CARD_HEIGHT = 1350;
const MARGIN = 64;
const MIN_TEXT_PX = 30;

export const PALETTES = {
  navy: { bg: '#0F1E45', deco: '#1A2F68', ink: '#FFFFFF', sub: '#C9D3EE', card: '#FFFFFF', cardInk: '#0F1E45', cardSub: '#4A5A80', accent: '#FF6B78', onAccent: '#0F1E45', good: '#0B7A5C', bad: '#C8102E', tint: '#F3F6FD' },
  cream: { bg: '#FBF5EC', deco: '#F0E1CB', ink: '#1A2240', sub: '#4F5874', card: '#FFFFFF', cardInk: '#1A2240', cardSub: '#4F5874', accent: '#C8102E', onAccent: '#FFFFFF', good: '#0B7A5C', bad: '#C8102E', tint: '#FBF1E3' },
  green: { bg: '#0B4A3C', deco: '#126450', ink: '#FFFFFF', sub: '#CBE7DD', card: '#FFFDF7', cardInk: '#0B3A2F', cardSub: '#46655B', accent: '#FFC845', onAccent: '#0B3A2F', good: '#0B7A5C', bad: '#C8102E', tint: '#F2F8F4' },
  sky: { bg: '#E9F1FF', deco: '#D2E1FF', ink: '#0E1A3A', sub: '#44527A', card: '#FFFFFF', cardInk: '#0E1A3A', cardSub: '#44527A', accent: '#2B50E6', onAccent: '#FFFFFF', good: '#0B7A5C', bad: '#C8102E', tint: '#F1F5FF' },
} as const;
export type PaletteId = keyof typeof PALETTES;
type Palette = (typeof PALETTES)[PaletteId];
type ColorKey = keyof Palette;
export const PALETTE_IDS = Object.keys(PALETTES) as PaletteId[];

type Align = 'left' | 'center';
type Node =
  | { t: 'text'; text: string; size: number; min?: number; weight?: number; color: ColorKey; align?: Align; maxLines?: number; lh?: number }
  | { t: 'panel'; fill: ColorKey; children: Node[]; pad?: number; gap?: number; radius?: number; minH?: number; mark?: { kind: 'check' | 'cross' | 'dot'; color: ColorKey } }
  | { t: 'row'; children: Node[]; gap?: number }
  | { t: 'chip'; text: string; fill: ColorKey; color: ColorKey; size?: number; align?: Align }
  | { t: 'space'; h: number }
  | { t: 'rule'; color: ColorKey };

/* ------------------------------------------------------------------ */
/* Card specs (what the content engine asks for)                       */
/* ------------------------------------------------------------------ */

export interface Pair {
  ko: string;
  bn: string;
}

interface Common {
  palette: PaletteId;
  variant: 0 | 1;
  /** Header chip, e.g. "আজকের শব্দ". */
  label: string;
  footerLeft: string;
  footerRight?: string;
}

export type CardSpec = Common &
  (
    | { template: 'vocab'; word: string; romanization: string; pronunciationBn: string; meaningBn: string; example?: Pair }
    | { template: 'hangul'; letter: string; nameLine: string; soundBn: string; examples: Pair[] }
    | { template: 'grammar'; pattern: string; titleBn: string; rules: { when: string; use: string }[]; examples: Pair[] }
    | { template: 'quiz'; questionBn: string; prompt?: string; options: string[]; footnoteBn: string }
    | { template: 'mistake'; titleBn: string; wrong: Pair; right: Pair; tipBn: string }
    | { template: 'dialogue'; titleBn: string; lines: (Pair & { speaker: 'A' | 'B' })[] }
    | { template: 'reading'; titleBn: string; notice: string; questionBn: string; options: string[] }
    | { template: 'challenge'; titleBn: string; items: Pair[]; footnoteBn: string }
    | { template: 'feature'; headlineBn: string; bodyBn: string; points: string[]; footnoteBn: string }
  );

export type CardTemplate = CardSpec['template'];
export const CARD_TEMPLATES: readonly CardTemplate[] = ['vocab', 'hangul', 'grammar', 'quiz', 'mistake', 'dialogue', 'reading', 'challenge', 'feature'];

const OPTION_MARKS = ['①', '②', '③', '④'];

function body(spec: CardSpec): { nodes: Node[]; valign: 'center' | 'top' } {
  const c = spec.variant === 0 ? 'center' : 'left';
  switch (spec.template) {
    case 'vocab':
      return {
        valign: 'center',
        nodes: [
          { t: 'text', text: spec.word, size: 210, min: 120, weight: 800, color: 'ink', align: c, maxLines: 1, lh: 1.15 },
          { t: 'text', text: `[ ${spec.romanization} ]`, size: 44, weight: 500, color: 'sub', align: c, maxLines: 1 },
          { t: 'space', h: 8 },
          { t: 'text', text: spec.meaningBn, size: 92, min: 56, weight: 700, color: 'accent', align: c, maxLines: 2 },
          { t: 'text', text: `উচ্চারণ: ${spec.pronunciationBn}`, size: 40, weight: 500, color: 'sub', align: c, maxLines: 1 },
          ...(spec.example
            ? ([
                { t: 'space', h: 26 },
                {
                  t: 'panel',
                  fill: 'card',
                  pad: 40,
                  gap: 12,
                  children: [
                    { t: 'text', text: spec.example.ko, size: 50, min: 36, weight: 700, color: 'cardInk', align: c, maxLines: 2 },
                    { t: 'text', text: spec.example.bn, size: 40, min: 32, weight: 500, color: 'cardSub', align: c, maxLines: 2 },
                  ],
                },
              ] as Node[])
            : []),
        ],
      };
    case 'hangul':
      return {
        valign: 'center',
        nodes: [
          spec.variant === 0
            ? { t: 'text', text: spec.letter, size: 300, min: 200, weight: 800, color: 'ink', align: 'center', maxLines: 1, lh: 1.1 }
            : { t: 'panel', fill: 'card', pad: 20, children: [{ t: 'text', text: spec.letter, size: 260, min: 180, weight: 800, color: 'cardInk', align: 'center', maxLines: 1, lh: 1.1 }] },
          { t: 'text', text: spec.nameLine, size: 46, weight: 600, color: 'sub', align: 'center', maxLines: 1 },
          { t: 'text', text: spec.soundBn, size: 64, min: 44, weight: 700, color: spec.variant === 0 ? 'accent' : 'ink', align: 'center', maxLines: 2 },
          { t: 'space', h: 22 },
          {
            t: 'row',
            gap: 22,
            children: spec.examples.slice(0, 3).map(
              (e): Node => ({
                t: 'panel',
                fill: 'card',
                pad: 28,
                gap: 6,
                children: [
                  { t: 'text', text: e.ko, size: 58, min: 40, weight: 800, color: 'cardInk', align: 'center', maxLines: 1 },
                  { t: 'text', text: e.bn, size: 36, min: 30, weight: 500, color: 'cardSub', align: 'center', maxLines: 2 },
                ],
              }),
            ),
          },
        ],
      };
    case 'grammar':
      return {
        valign: 'center',
        nodes: [
          { t: 'text', text: spec.pattern, size: 104, min: 64, weight: 800, color: 'ink', align: c, maxLines: 1, lh: 1.2 },
          { t: 'text', text: spec.titleBn, size: 50, min: 36, weight: 700, color: 'accent', align: c, maxLines: 2 },
          { t: 'space', h: 14 },
          ...spec.rules.slice(0, 3).map(
            (r): Node => ({
              t: 'panel',
              fill: 'card',
              pad: 26,
              gap: 4,
              mark: { kind: 'dot', color: 'accent' },
              children: [
                { t: 'text', text: r.when, size: 36, min: 30, weight: 500, color: 'cardSub', align: 'left', maxLines: 2 },
                { t: 'text', text: r.use, size: 46, min: 34, weight: 800, color: 'cardInk', align: 'left', maxLines: 2 },
              ],
            }),
          ),
          { t: 'space', h: 6 },
          ...spec.examples.slice(0, 2).flatMap((e): Node[] => [
            { t: 'text', text: e.ko, size: 44, min: 34, weight: 700, color: 'ink', align: c, maxLines: 2 },
            { t: 'text', text: e.bn, size: 36, min: 30, weight: 500, color: 'sub', align: c, maxLines: 2 },
          ]),
        ],
      };
    case 'quiz':
      return {
        valign: 'center',
        nodes: [
          { t: 'text', text: spec.questionBn, size: 60, min: 40, weight: 700, color: 'ink', align: c, maxLines: 3 },
          ...(spec.prompt ? ([{ t: 'text', text: spec.prompt, size: 120, min: 70, weight: 800, color: 'accent', align: c, maxLines: 1, lh: 1.2 }] as Node[]) : []),
          { t: 'space', h: 18 },
          ...[0, 2].map(
            (i): Node => ({
              t: 'row',
              gap: 22,
              children: spec.options.slice(i, i + 2).map((o, j): Node => ({ t: 'panel', fill: 'card', pad: 30, children: [{ t: 'text', text: `${OPTION_MARKS[i + j]} ${o}`, size: 50, min: 34, weight: 700, color: 'cardInk', align: 'left', maxLines: 2 }] })),
            }),
          ),
          { t: 'space', h: 10 },
          { t: 'chip', text: spec.footnoteBn, fill: 'accent', color: 'onAccent', size: 38, align: 'center' },
        ],
      };
    case 'mistake':
      return {
        valign: 'center',
        nodes: [
          { t: 'text', text: spec.titleBn, size: 62, min: 42, weight: 800, color: 'ink', align: c, maxLines: 2 },
          { t: 'space', h: 12 },
          {
            t: 'panel',
            fill: 'card',
            pad: 32,
            gap: 8,
            mark: { kind: 'cross', color: 'bad' },
            children: [
              { t: 'text', text: spec.wrong.ko, size: 56, min: 38, weight: 700, color: 'bad', align: 'left', maxLines: 2 },
              { t: 'text', text: spec.wrong.bn, size: 36, min: 30, weight: 500, color: 'cardSub', align: 'left', maxLines: 2 },
            ],
          },
          {
            t: 'panel',
            fill: 'card',
            pad: 32,
            gap: 8,
            mark: { kind: 'check', color: 'good' },
            children: [
              { t: 'text', text: spec.right.ko, size: 56, min: 38, weight: 800, color: 'good', align: 'left', maxLines: 2 },
              { t: 'text', text: spec.right.bn, size: 36, min: 30, weight: 500, color: 'cardSub', align: 'left', maxLines: 2 },
            ],
          },
          { t: 'space', h: 8 },
          { t: 'text', text: spec.tipBn, size: 40, min: 32, weight: 600, color: 'sub', align: c, maxLines: 3 },
        ],
      };
    case 'dialogue':
      return {
        valign: 'center',
        nodes: [
          { t: 'text', text: spec.titleBn, size: 58, min: 40, weight: 800, color: 'ink', align: c, maxLines: 2 },
          { t: 'space', h: 10 },
          ...spec.lines.slice(0, 4).map(
            (l): Node => ({
              t: 'panel',
              fill: l.speaker === 'A' ? 'card' : 'tint',
              pad: 28,
              gap: 6,
              mark: { kind: 'dot', color: l.speaker === 'A' ? 'accent' : 'good' },
              children: [
                { t: 'text', text: l.ko, size: 48, min: 34, weight: 700, color: 'cardInk', align: 'left', maxLines: 2 },
                { t: 'text', text: l.bn, size: 34, min: 30, weight: 500, color: 'cardSub', align: 'left', maxLines: 2 },
              ],
            }),
          ),
        ],
      };
    case 'reading':
      return {
        valign: 'center',
        nodes: [
          { t: 'text', text: spec.titleBn, size: 52, min: 38, weight: 700, color: 'ink', align: c, maxLines: 2 },
          { t: 'panel', fill: 'card', pad: 40, gap: 6, children: [{ t: 'text', text: spec.notice, size: 58, min: 38, weight: 800, color: 'cardInk', align: 'center', maxLines: 4, lh: 1.4 }] },
          { t: 'text', text: spec.questionBn, size: 44, min: 34, weight: 700, color: 'ink', align: c, maxLines: 2 },
          ...[0, 2].map(
            (i): Node => ({
              t: 'row',
              gap: 20,
              children: spec.options.slice(i, i + 2).map((o, j): Node => ({ t: 'panel', fill: 'card', pad: 24, children: [{ t: 'text', text: `${OPTION_MARKS[i + j]} ${o}`, size: 40, min: 30, weight: 700, color: 'cardInk', align: 'left', maxLines: 2 }] })),
            }),
          ),
        ],
      };
    case 'challenge':
      return {
        valign: 'center',
        nodes: [
          { t: 'text', text: spec.titleBn, size: 66, min: 44, weight: 800, color: 'ink', align: c, maxLines: 2 },
          { t: 'space', h: 10 },
          {
            t: 'panel',
            fill: 'card',
            pad: 34,
            gap: 16,
            children: spec.items.slice(0, 6).map(
              (it, i): Node => ({
                t: 'row',
                gap: 16,
                children: [
                  { t: 'text', text: `${toBengaliDigits(i + 1)}. ${it.ko}`, size: 48, min: 34, weight: 800, color: 'cardInk', align: 'left', maxLines: 1 },
                  { t: 'text', text: it.bn, size: 40, min: 30, weight: 500, color: 'cardSub', align: 'left', maxLines: 1 },
                ],
              }),
            ),
          },
          { t: 'space', h: 6 },
          { t: 'chip', text: spec.footnoteBn, fill: 'accent', color: 'onAccent', size: 38, align: 'center' },
        ],
      };
    case 'feature':
      return {
        valign: 'center',
        nodes: [
          { t: 'text', text: spec.headlineBn, size: 76, min: 48, weight: 800, color: 'ink', align: c, maxLines: 3 },
          { t: 'text', text: spec.bodyBn, size: 42, min: 32, weight: 500, color: 'sub', align: c, maxLines: 3 },
          { t: 'space', h: 14 },
          ...spec.points.slice(0, 3).map((p): Node => ({ t: 'panel', fill: 'card', pad: 28, mark: { kind: 'check', color: 'good' }, children: [{ t: 'text', text: p, size: 42, min: 32, weight: 700, color: 'cardInk', align: 'left', maxLines: 2 }] })),
          { t: 'space', h: 8 },
          { t: 'chip', text: spec.footnoteBn, fill: 'accent', color: 'onAccent', size: 38, align: 'center' },
        ],
      };
  }
}

export const toBengaliDigits = (n: number | string) => String(n).replace(/[0-9]/g, (d) => '০১২৩৪৫৬৭৮৯'[Number(d)]!);

/* ------------------------------------------------------------------ */
/* Layout                                                             */
/* ------------------------------------------------------------------ */

interface Placed {
  kind: 'text';
  text: string;
  size: number;
  color: ColorKey;
  bg: ColorKey;
  ink: Box | null;
  container: Box;
  overflow: boolean;
}

interface Ctx {
  ts: Typesetter;
  pal: Palette;
  scale: number;
  svg: string[];
  placed: Placed[];
  draw: boolean;
}

const MARK_W = 44;

function textLayout(ctx: Ctx, n: Extract<Node, { t: 'text' }>, width: number): { l: TextLayout; size: number; overflow: boolean } {
  const min = Math.max(MIN_TEXT_PX, n.min ?? Math.round(n.size * 0.7));
  let size = Math.max(min, Math.round(n.size * ctx.scale));
  for (;;) {
    const l = ctx.ts.layout(n.text, { size, weight: n.weight ?? 600, maxWidth: width, lineHeight: n.lh });
    const fits = !l.wordTooWide && l.lines.length <= (n.maxLines ?? 99);
    if (fits || size <= min) return { l, size, overflow: !fits };
    size = Math.max(min, Math.floor(size * 0.94));
  }
}

/** Lays out (and, when ctx.draw, draws) a node at (x, y) with the given width; returns its height. */
function place(ctx: Ctx, n: Node, x: number, y: number, w: number, bg: ColorKey): number {
  switch (n.t) {
    case 'space':
      return n.h * ctx.scale;
    case 'rule':
      if (ctx.draw) ctx.svg.push(`<rect x="${x}" y="${y}" width="${w}" height="3" fill="${ctx.pal[n.color]}"/>`);
      return 3;
    case 'text': {
      const { l, size, overflow } = textLayout(ctx, n, w);
      if (ctx.draw) {
        const style = { size, weight: n.weight ?? 600 };
        let ink: Box | null = null;
        l.lines.forEach((line, i) => {
          const lx = n.align === 'center' ? x + (w - line.width) / 2 : x;
          const by = y + i * l.lineHeight + l.lineHeight / 2 + size * 0.36;
          ctx.svg.push(`<path fill="${ctx.pal[n.color]}" d="${ctx.ts.linePath(line.glyphs, lx, by, style)}"/>`);
          const b = ctx.ts.inkBox(line.glyphs, lx, by, style);
          if (b) ink = ink ? { x0: Math.min(ink.x0, b.x0), y0: Math.min(ink.y0, b.y0), x1: Math.max(ink.x1, b.x1), y1: Math.max(ink.y1, b.y1) } : b;
        });
        ctx.placed.push({ kind: 'text', text: n.text, size, color: n.color, bg, ink, container: { x0: x, y0: y, x1: x + w, y1: y + l.height }, overflow: overflow || l.missing.length > 0 });
        if (l.missing.length) ctx.placed[ctx.placed.length - 1]!.text += ` [missing: ${l.missing.join('')}]`;
      }
      return l.height;
    }
    case 'chip': {
      const size = Math.max(MIN_TEXT_PX, Math.round((n.size ?? 36) * ctx.scale));
      const padX = size * 0.8;
      const l = ctx.ts.layout(n.text, { size, weight: 700, maxWidth: w - 2 * padX });
      const h = l.height + size * 0.7;
      const cw = Math.min(w, l.width + 2 * padX);
      if (ctx.draw) {
        const cx = n.align === 'center' ? x + (w - cw) / 2 : x;
        ctx.svg.push(`<rect x="${cx}" y="${y}" width="${cw}" height="${h}" rx="${h / 2}" fill="${ctx.pal[n.fill]}"/>`);
        place({ ...ctx }, { t: 'text', text: n.text, size, min: size, weight: 700, color: n.color, align: 'center', maxLines: 2 }, cx + padX, y + size * 0.35, cw - 2 * padX, n.fill);
      }
      return h;
    }
    case 'panel': {
      const pad = (n.pad ?? 32) * Math.max(0.75, ctx.scale);
      const gap = (n.gap ?? 10) * ctx.scale;
      const markW = n.mark ? MARK_W + 18 : 0;
      const innerW = w - 2 * pad - markW;
      const measure = { ...ctx, draw: false, svg: [], placed: [] };
      let inner = 0;
      n.children.forEach((ch, i) => {
        inner += place(measure, ch, 0, 0, innerW, n.fill) + (i ? gap : 0);
      });
      const h = Math.max(inner + 2 * pad, n.minH ?? 0);
      if (ctx.draw) {
        ctx.svg.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${n.radius ?? 28}" fill="${ctx.pal[n.fill]}"/>`);
        if (n.mark) ctx.svg.push(markSvg(n.mark.kind, x + pad + MARK_W / 2, y + pad + 26, ctx.pal[n.mark.color]));
        let cy = y + pad;
        n.children.forEach((ch, i) => {
          if (i) cy += gap;
          cy += place(ctx, ch, x + pad + markW, cy, innerW, n.fill);
        });
      }
      return h;
    }
    case 'row': {
      const gap = (n.gap ?? 20) * ctx.scale;
      const cols = n.children.length;
      const cw = (w - gap * (cols - 1)) / cols;
      const measure = { ...ctx, draw: false, svg: [], placed: [] };
      const h = Math.max(0, ...n.children.map((ch) => place(measure, ch, 0, 0, cw, bg)));
      // Panels stretch to the row height; other cells are centred vertically (mixed type sizes share a midline).
      if (ctx.draw) {
        for (const [i, ch] of n.children.entries()) place(ctx, ch.t === 'panel' ? { ...ch, minH: h } : ch, x + i * (cw + gap), ch.t === 'panel' ? y : y + (h - place(measure, ch, 0, 0, cw, bg)) / 2, cw, bg);
      }
      return h;
    }
  }
}

function markSvg(kind: 'check' | 'cross' | 'dot', cx: number, cy: number, color: string): string {
  if (kind === 'dot') return `<circle cx="${cx}" cy="${cy}" r="12" fill="${color}"/>`;
  const ring = `<circle cx="${cx}" cy="${cy}" r="22" fill="${color}"/>`;
  const stroke = 'stroke="#FFFFFF" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" fill="none"';
  return kind === 'check' ? `${ring}<path d="M${cx - 10} ${cy + 1} L${cx - 3} ${cy + 8} L${cx + 11} ${cy - 8}" ${stroke}/>` : `${ring}<path d="M${cx - 8} ${cy - 8} L${cx + 8} ${cy + 8} M${cx + 8} ${cy - 8} L${cx - 8} ${cy + 8}" ${stroke}/>`;
}

function decorations(spec: CardSpec, pal: Palette): string {
  const d = pal.deco;
  if (spec.variant === 0) {
    return [`<circle cx="${CARD_WIDTH - 40}" cy="140" r="250" fill="${d}"/>`, `<circle cx="70" cy="${CARD_HEIGHT - 120}" r="150" fill="${d}"/>`].join('');
  }
  const dots: string[] = [];
  for (let i = 0; i < 6; i++) for (let j = 0; j < 4; j++) dots.push(`<circle cx="${CARD_WIDTH - 120 + j * 26}" cy="${CARD_HEIGHT - 300 + i * 26}" r="5" fill="${d}"/>`);
  return [`<path d="M0 0 H${CARD_WIDTH} V210 Q${CARD_WIDTH / 2} 300 0 210 Z" fill="${d}"/>`, ...dots].join('');
}

/* ------------------------------------------------------------------ */
/* QA                                                                  */
/* ------------------------------------------------------------------ */

function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const intersects = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

export interface CardQa {
  passed: boolean;
  problems: string[];
  checks: { glyphs: boolean; overflow: boolean; margins: boolean; overlaps: boolean; contrast: boolean; minSize: boolean; output: boolean };
  minTextPx: number;
  minContrast: number;
  textBlocks: number;
}

function qaOf(placed: Placed[], pal: Palette, png: Uint8Array, width: number, height: number): CardQa {
  const problems: string[] = [];
  const missing = placed.filter((p) => p.text.includes('[missing:'));
  for (const p of missing) problems.push(`glyphs missing: ${p.text}`);
  const over = placed.filter((p) => p.overflow && !p.text.includes('[missing:'));
  for (const p of over) problems.push(`text does not fit its box: "${p.text.slice(0, 60)}"`);
  const safe: Box = { x0: MARGIN - 8, y0: MARGIN - 8, x1: CARD_WIDTH - MARGIN + 8, y1: CARD_HEIGHT - MARGIN + 8 };
  const outside = placed.filter((p) => p.ink && (p.ink.x0 < safe.x0 || p.ink.y0 < safe.y0 || p.ink.x1 > safe.x1 || p.ink.y1 > safe.y1));
  for (const p of outside) problems.push(`text outside the safe area: "${p.text.slice(0, 60)}"`);
  // Ink may exceed its line box a little (Bangla descenders); it must never reach another block's ink.
  let overlaps = 0;
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i]!.ink;
      const b = placed[j]!.ink;
      if (a && b && intersects(a, b)) {
        overlaps++;
        problems.push(`text blocks overlap: "${placed[i]!.text.slice(0, 30)}" / "${placed[j]!.text.slice(0, 30)}"`);
      }
    }
  }
  let minContrast = 99;
  for (const p of placed) {
    const ratio = contrastRatio(pal[p.color], pal[p.bg]);
    minContrast = Math.min(minContrast, ratio);
    const need = p.size >= 48 ? 3 : 4.5;
    if (ratio < need) problems.push(`contrast ${ratio.toFixed(2)} < ${need} for "${p.text.slice(0, 40)}"`);
  }
  const minTextPx = Math.min(...placed.map((p) => p.size));
  if (minTextPx < MIN_TEXT_PX) problems.push(`text smaller than ${MIN_TEXT_PX}px`);
  const outputOk = width === CARD_WIDTH && height === CARD_HEIGHT && png.byteLength > 10_000 && png.byteLength < 8_000_000;
  if (!outputOk) problems.push(`output ${width}x${height}, ${png.byteLength} bytes`);
  return {
    passed: problems.length === 0,
    problems,
    checks: { glyphs: missing.length === 0, overflow: over.length === 0, margins: outside.length === 0, overlaps: overlaps === 0, contrast: minContrast >= 3, minSize: minTextPx >= MIN_TEXT_PX, output: outputOk },
    minTextPx,
    minContrast: Math.round(minContrast * 100) / 100,
    textBlocks: placed.length,
  };
}

/* ------------------------------------------------------------------ */
/* Render                                                              */
/* ------------------------------------------------------------------ */

export interface RenderedCard {
  png: Uint8Array;
  svg: string;
  width: number;
  height: number;
  dhash: string;
  qa: CardQa;
  /** Every string drawn on the card, in reading order (the copy lint checks it like a caption). */
  text: string[];
}

let shared: Promise<Typesetter> | null = null;
export const typesetter = () => {
  if (!shared) {
    shared = Typesetter.load();
    shared.catch(() => {
      shared = null;
    });
  }
  return shared;
};

const BRAND = 'EPS TOPIK Bangla';

export async function renderCard(spec: CardSpec, ts?: Typesetter): Promise<RenderedCard> {
  const t = ts ?? (await typesetter());
  const pal = PALETTES[spec.palette];
  const { nodes, valign } = body(spec);
  const w = CARD_WIDTH - 2 * MARGIN;
  const headerH = 92;
  const footerH = 64;
  const top = MARGIN + headerH + 28;
  const bottom = CARD_HEIGHT - MARGIN - footerH - 24;
  const avail = bottom - top;
  const gap = 22;
  const stackHeight = (scale: number) => {
    const m: Ctx = { ts: t, pal, scale, svg: [], placed: [], draw: false };
    return nodes.reduce((s, n, i) => s + place(m, n, MARGIN, 0, w, 'bg') + (i ? gap * scale : 0), 0);
  };
  // Largest scale (≤ 1) at which the body fits; text never shrinks below its minimum size.
  let scale = 1;
  if (stackHeight(1) > avail) {
    let lo = 0.5;
    let hi = 1;
    for (let k = 0; k < 12; k++) {
      const mid = (lo + hi) / 2;
      if (stackHeight(mid) <= avail) lo = mid;
      else hi = mid;
    }
    scale = lo;
  }
  const height = stackHeight(scale);
  const ctx: Ctx = { ts: t, pal, scale, svg: [], placed: [], draw: true };
  const extra: Placed[] = [];
  if (height > avail) extra.push({ kind: 'text', text: 'card body', size: 99, color: 'ink', bg: 'bg', ink: null, container: { x0: 0, y0: 0, x1: 0, y1: 0 }, overflow: true });

  ctx.svg.push(`<rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="${pal.bg}"/>`, decorations(spec, pal));
  // Header: wordmark left, label chip right.
  const markX = MARGIN;
  ctx.svg.push(`<rect x="${markX}" y="${MARGIN + 14}" width="64" height="64" rx="18" fill="${pal.accent}"/>`);
  place(ctx, { t: 'text', text: '한', size: 40, min: 30, weight: 800, color: 'onAccent', align: 'center', maxLines: 1 }, markX, MARGIN + 14 + 4, 64, 'accent');
  place(ctx, { t: 'text', text: BRAND, size: 36, min: 30, weight: 800, color: 'ink', align: 'left', maxLines: 1 }, markX + 84, MARGIN + 22, 420, 'bg');
  const chipSize = 32;
  const chip = t.layout(spec.label, { size: chipSize, weight: 700, maxWidth: 420 });
  const chipW = Math.min(440, chip.width + chipSize * 1.6);
  place(ctx, { t: 'chip', text: spec.label, fill: 'accent', color: 'onAccent', size: chipSize, align: 'left' }, CARD_WIDTH - MARGIN - chipW, MARGIN + 18, chipW, 'bg');

  let y = valign === 'center' ? top + Math.max(0, (avail - height) / 2) : top;
  nodes.forEach((n, i) => {
    if (i) y += gap * scale;
    y += place(ctx, n, MARGIN, y, w, 'bg');
  });

  // Footer.
  const fy = CARD_HEIGHT - MARGIN - footerH;
  ctx.svg.push(`<rect x="${MARGIN}" y="${fy}" width="${w}" height="2" fill="${pal.sub}" opacity="0.35"/>`);
  place(ctx, { t: 'text', text: spec.footerLeft, size: 32, min: 30, weight: 600, color: 'sub', align: 'left', maxLines: 1 }, MARGIN, fy + 14, spec.footerRight ? w * 0.62 : w, 'bg');
  if (spec.footerRight) {
    const fr = t.layout(spec.footerRight, { size: 32, weight: 700, maxWidth: w * 0.36 });
    place(ctx, { t: 'text', text: spec.footerRight, size: 32, min: 30, weight: 700, color: 'sub', align: 'left', maxLines: 1 }, CARD_WIDTH - MARGIN - fr.width - 1, fy + 14, fr.width + 1, 'bg');
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}">${ctx.svg.join('')}</svg>`;
  const r = await rasterize(svg, CARD_WIDTH);
  const placed = [...ctx.placed, ...extra];
  return { png: r.png, svg, width: r.width, height: r.height, dhash: await differenceHash(svg), qa: qaOf(placed, pal, r.png, r.width, r.height), text: ctx.placed.map((p) => p.text) };
}
